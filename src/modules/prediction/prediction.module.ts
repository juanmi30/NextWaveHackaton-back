import { Module } from '@nestjs/common';

import { PredictionController } from './prediction.controller.js';
import { PredictionService } from './prediction.service.js';

@Module({
  controllers: [
    PredictionController,
  ],

  providers: [
    PredictionService,
  ],

  exports: [
    PredictionService,
  ],
})
export class PredictionModule {}