import { Module } from '@nestjs/common';
import { BaselinesModule } from '../baselines/baselines.module.js';
import { DetectionModule } from '../detection/detection.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { GraphController } from './graph.controller.js';
import { GraphService } from './graph.service.js';

@Module({
  imports: [
    IncidentsModule,
    TransactionsModule,
    BaselinesModule,
    DetectionModule,
  ],
  controllers: [GraphController],
  providers: [GraphService],
})
export class GraphModule {}