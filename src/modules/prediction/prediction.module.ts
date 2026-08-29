import { Module } from '@nestjs/common';

import { TransactionsModule } from '../transactions/transactions.module.js';

import { PredictionController } from './prediction.controller.js';
import { PredictionFeaturesService } from './prediction-features.service.js';
import { PredictionService } from './prediction.service.js';

@Module({
  imports: [
    TransactionsModule,
  ],

  controllers: [
    PredictionController,
  ],

  providers: [
    PredictionFeaturesService,
    PredictionService,
  ],

  exports: [
    PredictionService,
    PredictionFeaturesService,
  ],
})
export class PredictionModule {}