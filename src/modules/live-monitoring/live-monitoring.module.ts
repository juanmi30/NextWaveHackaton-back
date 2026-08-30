import { Module } from '@nestjs/common';
import { BaselinesModule } from '../baselines/baselines.module.js';
import { DemoModule } from '../demo/demo.module.js';
import { DetectionModule } from '../detection/detection.module.js';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { LiveEventService } from './live-event.service.js';
import { LiveMonitoringController } from './live-monitoring.controller.js';
import { LiveMonitoringService } from './live-monitoring.service.js';
import { LiveTransactionGeneratorService } from './live-transaction-generator.service.js';

@Module({
  imports: [TransactionsModule, BaselinesModule, DetectionModule, DemoModule],
  controllers: [LiveMonitoringController],
  providers: [LiveEventService, LiveMonitoringService, LiveTransactionGeneratorService],
  exports: [LiveMonitoringService],
})
export class LiveMonitoringModule {}
