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

@Injectable()
export class AgentService {
  constructor(
    private readonly config: ConfigService,
    private readonly incidents: IncidentsService,
    private readonly analytics: AnalyticsService,
  ) {}

  async analyzeIncident(incidentId: string) {
    await this.incidents.findOne(incidentId);

    if (!this.config.get<string>('OPENAI_API_KEY')) {
      throw new ServiceUnavailableException(
        'OPENAI_API_KEY is required to analyze an incident with the Payments Diagnostic Concierge',
      );
    }

    const tools = [
      createGetIncidentTool(this.incidents),
      createGetIncidentHistoryTool(this.incidents),
      createGetBreakdownTool(this.analytics),
      createGetDeclineReasonDistributionTool(this.analytics),
      createGetTimeseriesTool(this.analytics),
      createListActiveIncidentsTool(this.incidents),
    ];
    const model = this.config.get<string>('OPENAI_MODEL')?.trim() || undefined;
    const agent = createPaymentsConciergeAgent(tools, model);

    let finalOutput: unknown;
    try {
      const result = await run(
        agent,
        `Analyze payment incident ${incidentId}. Investigate the root cause using your tools. Return only the requested structured diagnosis.`,
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

    return parsed.data;
  }
}
