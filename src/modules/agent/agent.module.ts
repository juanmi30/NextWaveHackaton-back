import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { AgentController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
import { IncidentAutoAnalysisService } from './incident-auto-analysis.service.js';

@Module({
  imports: [IncidentsModule, AnalyticsModule],
  controllers: [AgentController],
  providers: [AgentService, IncidentAutoAnalysisService],
  exports: [IncidentAutoAnalysisService],
})
export class AgentModule {}
