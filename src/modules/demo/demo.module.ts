import { Module } from '@nestjs/common';
import { BaselinesModule } from '../baselines/baselines.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { DemoController } from './demo.controller.js';
import { DemoService } from './demo.service.js';

@Module({
  imports: [TransactionsModule, BaselinesModule, IncidentsModule],
  controllers: [DemoController],
  providers: [DemoService],
  exports: [DemoService],
})
export class DemoModule {}
