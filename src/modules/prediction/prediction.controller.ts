import {
  Body,
  Controller,
  Post,
  Get,
} from '@nestjs/common';

import { EvaluatePredictionDto } from './dto/evaluate-prediction.dto.js';
import {
  PredictionService,
  type PredictionResult,
  type PredictionScanResult,
  type SegmentPredictionResult,
} from './prediction.service.js';

import {
  EvaluateSegmentDto,
} from './dto/evaluate-segment.dto.js';

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

  @Get('scan')
  scan(): Promise<PredictionScanResult> {
    return this.predictionService.scan();
  }
}