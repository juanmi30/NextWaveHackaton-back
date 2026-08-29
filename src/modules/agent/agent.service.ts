import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { run } from '@openai/agents';
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
import {
  enforceCanonicalIncidentImpact,
  getCanonicalIncidentImpact,
} from './canonical-incident-impact.js';

@Injectable()
export class AgentService {
  constructor(
    private readonly config: ConfigService,
    private readonly incidents: IncidentsService,
    private readonly analytics: AnalyticsService,
  ) {}

  async analyzeIncident(incidentId: string) {
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
    ];
    const model = this.config.get<string>('OPENAI_MODEL')?.trim() || undefined;
    const agent = createPaymentsConciergeAgent(tools, model);

    let finalOutput: unknown;
    try {
      const result = await run(
        agent,
        `Analyze payment incident ${incidentId}. Investigate the root cause using your tools. ` +
          `Use these authoritative stored incident metrics exactly: ${JSON.stringify(canonicalContext)}. ` +
          `Do not replace them with analytics breakdown or timeseries sample metrics. ` +
          `Return only the requested structured diagnosis.`,
      );
      finalOutput = result.finalOutput;
    } catch (error) {
      throw new BadGatewayException({
        message: 'OpenAI failed to analyze the incident',
        providerError: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    const parsed = AgentDiagnosisSchema.safeParse(finalOutput);
    if (!parsed.success) {
      throw new InternalServerErrorException('OpenAI returned an invalid structured diagnosis');
    }
    if (parsed.data.incidentId !== incidentId) {
      throw new InternalServerErrorException('OpenAI returned a diagnosis for a different incident');
    }

    return enforceCanonicalIncidentImpact(parsed.data, incident);
  }
}
