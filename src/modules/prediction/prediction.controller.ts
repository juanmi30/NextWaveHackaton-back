import {
  Body,
  Controller,
  Post,
} from '@nestjs/common';

import { EvaluatePredictionDto } from './dto/evaluate-prediction.dto.js';
import { PredictionService } from './prediction.service.js';

import {
  EvaluateSegmentDto,
} from './dto/evaluate-segment.dto.js';

import type {
  SegmentPredictionResult,
} from './prediction.service.js';

@Controller('predictions')
export class PredictionController {
  constructor(
    private readonly predictionService: PredictionService,
  ) {}

  @Post('evaluate')
  evaluate(
    @Body() input: EvaluatePredictionDto,
  ) {
    return this.predictionService.evaluate(
      input,
    );
  }

  @Post('segment')
  evaluateSegment(
    @Body() input: EvaluateSegmentDto,
  ): Promise<SegmentPredictionResult> {
    return this.predictionService
      .evaluateSegment(input);
  }
}