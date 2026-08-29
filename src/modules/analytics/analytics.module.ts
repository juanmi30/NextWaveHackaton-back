import { Module } from '@nestjs/common';
import { DetectionModule } from '../detection/detection.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';

@Module({
  imports: [TransactionsModule, IncidentsModule, DetectionModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
