import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service.js';
import { AnalyzeRiskDto } from './dto/analyze-risk.dto.js';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('risk')
  analyze(@Query() query: AnalyzeRiskDto) {
    return this.analytics.analyze(query);
  }

  @Post('detect')
  detect(@Body() dto: AnalyzeRiskDto) {
    return this.analytics.detect(dto);
  }
}
