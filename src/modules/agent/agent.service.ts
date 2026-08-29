import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { run } from '@openai/agents';
import type { MessageEvent } from '@nestjs/common';
import { Observable, type Subscriber } from 'rxjs';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { createPaymentsConciergeAgent } from './agents/payments-concierge.agent.js';
import { AgentDiagnosisSchema } from './schemas/agent-diagnosis.schema.js';
import { createGetBreakdownTool } from './tools/get-breakdown.tool.js';
import { createGetDeclineReasonDistributionTool } from './tools/get-decline-reason-distribution.tool.js';
import { createGetIncidentHistoryTool } from './tools/get-incident-history.tool.js';
import { createGetIncidentTool } from './tools/get-incident.tool.js';
import { createGetTimeseriesTool } from './tools/get-timeseries.tool.js';
import { createListActiveIncidentsTool } from './tools/list-active-incidents.tool.js';
import { createClassifyResponseCodeTool } from './tools/classify-response-code.tool.js';
import {
  enforceCanonicalIncidentImpact,
  getCanonicalIncidentImpact,
} from './canonical-incident-impact.js';
import type { AgentDiagnosis } from './schemas/agent-diagnosis.schema.js';
import type { AgentStreamEvent } from './agent-stream.types.js';
import {
  advanceAgentPhase,
  mapSdkEventToPublicAgentEvents,
  type AgentStreamMappingState,
} from './agent-stream.mapper.js';

type LoadedIncident = Awaited<ReturnType<IncidentsService['findOne']>>;

@Injectable()
export class AgentService {
  private runAgent = run;

  constructor(
    private readonly config: ConfigService,
    private readonly incidents: IncidentsService,
    private readonly analytics: AnalyticsService,
  ) {}

  async analyzeIncident(incidentId: string) {
    const prepared = await this.prepareIncidentAnalysis(incidentId);

    let finalOutput: unknown;
    try {
      const result = await this.runAgent(prepared.agent, prepared.prompt);
      finalOutput = result.finalOutput;
    } catch (error) {
      throw new BadGatewayException({
        message: 'OpenAI failed to analyze the incident',
        providerError: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    return this.normalizeDiagnosis(finalOutput, incidentId, prepared.incident);
  }

  streamAnalyzeIncident(incidentId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const abortController = new AbortController();
      void this.executeStreamingAnalysis(incidentId, abortController.signal, subscriber);

      return () => abortController.abort();
    });
  }

  private async prepareIncidentAnalysis(incidentId: string) {
    const incident = await this.incidents.findOne(incidentId);
    const analysisAnchor = incident.lastSeenAt ?? incident.detectedAt;
    const latestDiagnosis = incident.diagnoses.at(-1);
    const canonicalContext = {
      impact: getCanonicalIncidentImpact(incident),
      incidentTotals: {
        expectedApprovals: incident.expectedApprovals,
        actualApprovals: incident.actualApprovals,
        lostApprovals: incident.lostApprovals,
        latestDiagnosisObservedAttempts: latestDiagnosis?.observedAttempts ?? null,
      },
    };

    if (!this.config.get<string>('OPENAI_API_KEY')) {
      throw new ServiceUnavailableException(
        'OPENAI_API_KEY is required to analyze an incident with the Payments Diagnostic Concierge',
      );
    }

    const tools = [
      createGetIncidentTool(this.incidents),
      createGetIncidentHistoryTool(this.incidents),
      createGetBreakdownTool(this.analytics, analysisAnchor),
      createGetDeclineReasonDistributionTool(this.analytics, analysisAnchor),
      createGetTimeseriesTool(this.analytics, analysisAnchor),
      createListActiveIncidentsTool(this.incidents),
      createClassifyResponseCodeTool(),
    ];
    const model = this.config.get<string>('OPENAI_MODEL')?.trim() || undefined;
    const agent = createPaymentsConciergeAgent(tools, model);
    const prompt =
      `Analyze payment incident ${incidentId}. Investigate the root cause using your tools. ` +
      `Use these authoritative stored incident metrics exactly: ${JSON.stringify(canonicalContext)}. ` +
      `Do not replace them with analytics breakdown or timeseries sample metrics. ` +
      `Return only the requested structured diagnosis.`;

    return { incident, agent, prompt };
  }

  private async executeStreamingAnalysis(
    incidentId: string,
    signal: AbortSignal,
    subscriber: Subscriber<MessageEvent>,
  ) {
    try {
      const prepared = await this.prepareIncidentAnalysis(incidentId);
      if (signal.aborted) return;

      this.emit(subscriber, { type: 'run_started', incidentId, timestamp: now() });
      this.emit(subscriber, { type: 'phase_changed', phase: 'OBSERVE', timestamp: now() });

      const stream = await this.runAgent(prepared.agent, prepared.prompt, { stream: true, signal });
      const mappingState: AgentStreamMappingState = {
        phase: 'OBSERVE',
        toolNamesByCallId: new Map(),
      };

      try {
        for await (const sdkEvent of stream) {
          if (signal.aborted) break;
          for (const event of mapSdkEventToPublicAgentEvents(sdkEvent, mappingState)) {
            this.emit(subscriber, event);
          }
        }
      } finally {
        await stream.completed;
      }
      if (signal.aborted) return;

      const diagnosis = this.normalizeDiagnosis(stream.finalOutput, incidentId, prepared.incident);
      const recommendPhase = advanceAgentPhase(mappingState, 'RECOMMEND');
      if (recommendPhase) this.emit(subscriber, recommendPhase);
      this.emit(subscriber, { type: 'diagnosis', diagnosis, timestamp: now() });
      const reportPhase = advanceAgentPhase(mappingState, 'REPORT');
      if (reportPhase) this.emit(subscriber, reportPhase);
      this.emit(subscriber, { type: 'run_completed', incidentId, timestamp: now() });
      subscriber.complete();
    } catch {
      if (signal.aborted || subscriber.closed) return;
      this.emit(subscriber, {
        type: 'error',
        message: 'Unable to complete incident analysis',
        timestamp: now(),
      });
      subscriber.complete();
    }
  }

  private normalizeDiagnosis(
    finalOutput: unknown,
    incidentId: string,
    incident: LoadedIncident,
  ): AgentDiagnosis {
    const parsed = AgentDiagnosisSchema.safeParse(finalOutput);
    if (!parsed.success) {
      throw new InternalServerErrorException('OpenAI returned an invalid structured diagnosis');
    }
    if (parsed.data.incidentId !== incidentId) {
      throw new InternalServerErrorException('OpenAI returned a diagnosis for a different incident');
    }

    return enforceCanonicalIncidentImpact(parsed.data, incident);
  }

  private emit(subscriber: Subscriber<MessageEvent>, event: AgentStreamEvent) {
    if (!subscriber.closed) subscriber.next({ data: event });
  }
}

function now() {
  return new Date().toISOString();
}
