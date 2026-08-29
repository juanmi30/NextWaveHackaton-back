import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { DetectionRepository } from './detection.repository.js';
import { DetectionService } from './detection.service.js';
import { RunDetectionDto } from './dto/run-detection.dto.js';

@Controller('detection')
export class DetectionController {
  constructor(
    private readonly detection: DetectionService,
    private readonly repository: DetectionRepository,
  ) {}

  @Post('run')
  run(@Body() dto: RunDetectionDto) {
    return this.detection.run(dto);
  }

  @Get('runs')
  runs(@Query('limit') limit?: string) {
    return this.repository.findRuns(limit ? Number(limit) : 50);
  }

  /** Evidencia de que el sistema vigila sin alertar de mas. */
  @Get('quiet-stats')
  quietStats(@Query('hours') hours?: string) {
    const since = new Date(Date.now() - (hours ? Number(hours) : 24) * 3_600_000);
    return this.repository.quietStats(since);
  }
}
