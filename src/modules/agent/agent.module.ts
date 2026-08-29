import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { AgentController } from './agent.controller.js';
import { AgentService } from './agent.service.js';

@Module({
  imports: [IncidentsModule, AnalyticsModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
