import { Module } from '@nestjs/common';
import { BaselinesModule } from '../baselines/baselines.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { DetectionController } from './detection.controller.js';
import { DetectionRepository } from './detection.repository.js';
import { DetectionService } from './detection.service.js';

@Module({
  imports: [TransactionsModule, BaselinesModule, IncidentsModule],
  controllers: [DetectionController],
  providers: [DetectionRepository, DetectionService],
  exports: [DetectionService, DetectionRepository],
})
export class DetectionModule {}
