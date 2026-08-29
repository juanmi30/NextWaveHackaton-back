import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { BaselinesController } from './baselines.controller.js';
import { BaselinesRepository } from './baselines.repository.js';
import { BaselinesService } from './baselines.service.js';

@Module({
  imports: [TransactionsModule],
  controllers: [BaselinesController],
  providers: [BaselinesRepository, BaselinesService],
  exports: [BaselinesService],
})
export class BaselinesModule {}
