import { Controller, Param, Post, Sse } from '@nestjs/common';
import { AgentService } from './agent.service.js';

@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('incidents/:incidentId/analyze')
  analyzeIncident(@Param('incidentId') incidentId: string) {
    return this.agent.analyzeIncident(incidentId);
  }

  @Sse('incidents/:incidentId/analyze/stream')
  streamAnalyzeIncident(@Param('incidentId') incidentId: string) {
    return this.agent.streamAnalyzeIncident(incidentId);
  }
}
