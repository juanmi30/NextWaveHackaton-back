import { Body, Controller, Get, Param, Post, Sse } from '@nestjs/common';
import { AgentService } from './agent.service.js';
import { AnalyzeActiveIncidentsDto } from './dto/analyze-active-incidents.dto.js';
import { IncidentAutoAnalysisService } from './incident-auto-analysis.service.js';

@Controller('agent')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly autoAnalysis: IncidentAutoAnalysisService,
  ) {}

  @Post('incidents/analyze-active')
  analyzeActiveIncidents(@Body() body?: AnalyzeActiveIncidentsDto) {
    return this.agent.analyzeActiveIncidents(body?.limit);
  }

  @Post('incidents/:incidentId/analyze')
  analyzeIncident(@Param('incidentId') incidentId: string) {
    return this.autoAnalysis.analyzeManually(incidentId);
  }

  @Get('incidents/:incidentId/diagnosis')
  getDiagnosis(@Param('incidentId') incidentId: string) {
    return this.autoAnalysis.getDiagnosis(incidentId);
  }

  @Sse('incidents/:incidentId/analyze/stream')
  streamAnalyzeIncident(@Param('incidentId') incidentId: string) {
    return this.agent.streamAnalyzeIncident(incidentId);
  }
}
