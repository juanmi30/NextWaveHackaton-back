import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { run } from '@openai/agents';
import type { MessageEvent } from '@nestjs/common';
import { Observable, type Subscriber } from 'rxjs';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { createPaymentsConciergeAgent } from './agents/payments-concierge.agent.js';
import { AgentDiagnosisSchema } from './schemas/agent-diagnosis.schema.js';
import {
  MultiIncidentAnalysisSchema,
  type MultiIncidentAnalysis,
} from './schemas/multi-incident-analysis.schema.js';
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
import { calculateIncidentPriority } from '../../common/detection-metrics.js';
import { buildDeterministicDiagnosis } from './deterministic-diagnosis.js';

type LoadedIncident = Awaited<ReturnType<IncidentsService['findOne']>>;
type ActiveIncident = Awaited<ReturnType<IncidentsService['findAll']>>[number];
type RankedIncident = ActiveIncident & { priorityRank: number; priorityScore: number };

@Injectable()
export class AgentService {
  private runAgent = run;

  constructor(
    private readonly config: ConfigService,
    private readonly incidents: IncidentsService,
    private readonly analytics: AnalyticsService,
  ) {}

  async analyzeIncident(incidentId: string) {
    const incident = await this.incidents.findOne(incidentId);
    if (!this.hasOpenAiKey()) return this.fallbackDiagnosis(incident);
    const prepared = this.prepareIncidentAnalysis(incidentId, incident);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.agentTimeoutMs());
    try {
      const result = await this.runAgent(prepared.agent, prepared.prompt, {
        signal: abortController.signal,
      });
      return this.normalizeDiagnosis(result.finalOutput, incidentId, incident);
    } catch {
      return this.fallbackDiagnosis(incident);
    } finally {
      clearTimeout(timeout);
    }
  }

  async analyzeActiveIncidents(limit = 10): Promise<MultiIncidentAnalysis> {
    const active = await this.incidents.findAll({ status: 'OPEN', limit });
    const ranked = rankActiveIncidents(active);

    if (ranked.length === 0) return createEmptyPortfolio();

    const concurrency = boundedConcurrency(
      this.config.get<string>('AGENT_ANALYSIS_CONCURRENCY'),
    );
    const analyses = await mapSettledWithConcurrency(
      ranked,
      concurrency,
      (incident) => this.analyzeIncident(incident.id),
    );

    const incidents = ranked.map((incident, index) => {
      const result = analyses[index];
      if (result.status === 'fulfilled') {
        return {
          incidentId: incident.id,
          priorityRank: incident.priorityRank,
          priorityScore: incident.priorityScore,
          severity: incident.severity,
          lossPerMinuteCents: incident.lossPerMinuteCents,
          analysisStatus: 'ANALYZED' as const,
          diagnosis: result.value,
          error: null,
        };
      }
      return {
        incidentId: incident.id,
        priorityRank: incident.priorityRank,
        priorityScore: incident.priorityScore,
        severity: incident.severity,
        lossPerMinuteCents: incident.lossPerMinuteCents,
        analysisStatus: 'FAILED' as const,
        diagnosis: null,
        error: 'Incident analysis failed',
      };
    });
    const successfullyAnalyzed = incidents.filter(
      (incident) => incident.analysisStatus === 'ANALYZED',
    ).length;
    const totalLossPerMinuteCents = ranked.reduce(
      (total, incident) => total + incident.lossPerMinuteCents,
      0,
    );
    const correlation = determineCorrelation(incidents);
    const summaries = buildPortfolioSummaries(
      incidents,
      totalLossPerMinuteCents,
      correlation.status,
    );

    return MultiIncidentAnalysisSchema.parse({
      generatedAt: now(),
      portfolio: {
        activeIncidentCount: ranked.length,
        successfullyAnalyzed,
        failedAnalyses: ranked.length - successfullyAnalyzed,
        totalLossPerMinuteCents,
        highestPriorityIncidentId: ranked[0].id,
      },
      incidents,
      correlation,
      summaries,
    });
  }

  streamAnalyzeIncident(incidentId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const abortController = new AbortController();
      void this.executeStreamingAnalysis(incidentId, abortController.signal, subscriber);

      return () => abortController.abort();
    });
  }

  private prepareIncidentAnalysis(incidentId: string, incident: LoadedIncident) {
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
    let incident: LoadedIncident | undefined;
    let runStarted = false;
    try {
      incident = await this.incidents.findOne(incidentId);
      if (signal.aborted) return;

      this.emit(subscriber, { type: 'run_started', incidentId, timestamp: now() });
      this.emit(subscriber, { type: 'phase_changed', phase: 'OBSERVE', timestamp: now() });
      runStarted = true;
      if (!this.hasOpenAiKey()) {
        await this.emitFallback(subscriber, incidentId, incident);
        return;
      }

      const prepared = this.prepareIncidentAnalysis(incidentId, incident);
      const runSignal = AbortSignal.any([signal, AbortSignal.timeout(this.agentTimeoutMs())]);

      const stream = await this.runAgent(prepared.agent, prepared.prompt, { stream: true, signal: runSignal });
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
      try {
        if (!incident) incident = await this.incidents.findOne(incidentId);
        if (!runStarted) {
          this.emit(subscriber, { type: 'run_started', incidentId, timestamp: now() });
          this.emit(subscriber, { type: 'phase_changed', phase: 'OBSERVE', timestamp: now() });
        }
        await this.emitFallback(subscriber, incidentId, incident);
      } catch {
        this.emit(subscriber, {
          type: 'error',
          message: 'Unable to complete incident analysis',
          timestamp: now(),
        });
        subscriber.complete();
      }
    }
  }

  private async fallbackDiagnosis(incident: LoadedIncident) {
    const history = await this.incidents.history(incident.id);
    return buildDeterministicDiagnosis(incident, history);
  }

  private async emitFallback(
    subscriber: Subscriber<MessageEvent>,
    incidentId: string,
    incident: LoadedIncident,
  ) {
    const diagnosis = await this.fallbackDiagnosis(incident);
    this.emit(subscriber, { type: 'phase_changed', phase: 'DIAGNOSE', timestamp: now() });
    this.emit(subscriber, { type: 'diagnosis', diagnosis, timestamp: now() });
    this.emit(subscriber, { type: 'phase_changed', phase: 'REPORT', timestamp: now() });
    this.emit(subscriber, { type: 'run_completed', incidentId, timestamp: now() });
    subscriber.complete();
  }

  private hasOpenAiKey() {
    return Boolean(this.config.get<string>('OPENAI_API_KEY')?.trim());
  }

  private agentTimeoutMs() {
    const configured = Number(this.config.get<string>('AGENT_TIMEOUT_MS'));
    return Number.isFinite(configured) && configured > 0 ? configured : 20_000;
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

function rankActiveIncidents(incidents: ActiveIncident[]): RankedIncident[] {
  return [...incidents]
    .sort((left, right) => {
      const leftDiagnosis = left.diagnoses[0];
      const rightDiagnosis = right.diagnoses[0];
      return (
        right.lossPerMinuteCents - left.lossPerMinuteCents ||
        right.severity - left.severity ||
        (rightDiagnosis?.confidence ?? 0) - (leftDiagnosis?.confidence ?? 0) ||
        right.lostApprovals - left.lostApprovals ||
        right.detectedAt.getTime() - left.detectedAt.getTime()
      );
    })
    .map((incident, index) => ({
      ...incident,
      priorityRank: index + 1,
      priorityScore: priorityScore(incident),
    }));
}

function priorityScore(incident: ActiveIncident) {
  const confidence = incident.diagnoses[0]?.confidence ?? 0;
  return calculateIncidentPriority({
    lossPerMinuteCents: incident.lossPerMinuteCents,
    severity: incident.severity,
    confidence,
    lostApprovals: incident.lostApprovals,
    evidenceSufficient: incident.diagnoses.length > 0,
  });
}

function boundedConcurrency(configured: string | undefined) {
  const parsed = Number(configured);
  return Number.isInteger(parsed) ? Math.min(5, Math.max(1, parsed)) : 3;
}

async function mapSettledWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = Array.from<PromiseSettledResult<R>>({ length: values.length });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await operation(values[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function determineCorrelation(incidents: MultiIncidentAnalysis['incidents']) {
  if (incidents.length < 2) {
    return {
      status: 'INDEPENDENT' as const,
      explanation: 'There are fewer than two active incidents to correlate.',
    };
  }
  const diagnoses = incidents.map((incident) => incident.diagnosis);
  if (
    diagnoses.some(
      (diagnosis) => !diagnosis || diagnosis.evidenceStatus === 'INSUFFICIENT',
    )
  ) {
    return {
      status: 'INSUFFICIENT_EVIDENCE' as const,
      explanation:
        'At least one incident lacks sufficient independent evidence, so no shared cause is inferred.',
    };
  }

  const keys = diagnoses.map((diagnosis) => discriminatingKey(diagnosis!));
  const related = keys.some(
    (key, index) => key !== null && keys.slice(index + 1).includes(key),
  );
  return related
    ? {
        status: 'POSSIBLY_RELATED' as const,
        explanation:
          'At least two independent diagnoses share multiple supported discriminating factors; Detection incident identities remain separate.',
      }
    : {
        status: 'INDEPENDENT' as const,
        explanation:
          'Detection separated these incidents and the diagnoses do not share enough supported discriminating factors to infer a common cause.',
      };
}

function discriminatingKey(diagnosis: AgentDiagnosis) {
  if (!diagnosis.rootCause) return null;
  const dimensions = Object.entries(diagnosis.rootCause.dimensions).filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  if (dimensions.length < 2) return null;
  return dimensions.map(([name, value]) => `${name}=${value}`).join('|');
}

function buildPortfolioSummaries(
  incidents: MultiIncidentAnalysis['incidents'],
  totalLossPerMinuteCents: number,
  correlation: MultiIncidentAnalysis['correlation']['status'],
) {
  const highest = incidents[0];
  const failed = incidents.filter((incident) => incident.analysisStatus === 'FAILED').length;
  const insufficient = incidents.some(
    (incident) => incident.diagnosis?.evidenceStatus === 'INSUFFICIENT',
  );
  const evidenceNote =
    failed > 0 || insufficient
      ? ` ${failed} analysis failed and/or at least one incident has insufficient evidence.`
      : '';
  return {
    operations:
      `${incidents.length} active payment incident(s) require human investigation. ` +
      `Review incident ${highest.incidentId} first at ${usdPerMinute(highest.lossPerMinuteCents)}; ` +
      `combined stored impact is ${usdPerMinute(totalLossPerMinuteCents)}. ` +
      `Correlation assessment: ${correlation}.` +
      evidenceNote,
    executive:
      `${incidents.length} active payment incident(s) have a combined stored impact of ` +
      `${usdPerMinute(totalLossPerMinuteCents)}, led by incident ${highest.incidentId}.`,
  };
}

function usdPerMinute(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}/min`;
}

function createEmptyPortfolio(): MultiIncidentAnalysis {
  return MultiIncidentAnalysisSchema.parse({
    generatedAt: now(),
    portfolio: {
      activeIncidentCount: 0,
      successfullyAnalyzed: 0,
      failedAnalyses: 0,
      totalLossPerMinuteCents: 0,
      highestPriorityIncidentId: null,
    },
    incidents: [],
    correlation: {
      status: 'INDEPENDENT',
      explanation: 'There are no active incidents to correlate.',
    },
    summaries: {
      operations: 'No open payment incidents require analysis.',
      executive: 'No active payment incidents are currently reporting stored economic impact.',
    },
  });
}
