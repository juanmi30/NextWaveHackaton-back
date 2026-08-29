import { Controller, Param, Post } from '@nestjs/common';
import { AgentService } from './agent.service.js';

@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('incidents/:incidentId/analyze')
  analyzeIncident(@Param('incidentId') incidentId: string) {
    return this.agent.analyzeIncident(incidentId);
  }
}
