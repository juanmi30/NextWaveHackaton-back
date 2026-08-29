import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service.js';
import { AnalyzeRiskDto } from './dto/analyze-risk.dto.js';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  summary(@Query('windowMinutes') windowMinutes?: string) {
    return this.analytics.summary(windowMinutes ? Number(windowMinutes) : 60);
  }

  @Get('breakdown')
  breakdown(@Query() query: AnalyzeRiskDto) {
    return this.analytics.breakdown(query);
  }

  @Get('timeseries')
  timeseries(
    @Query('minutes') minutes?: string,
    @Query('bucketMinutes') bucketMinutes?: string,
    @Query('provider') provider?: string,
    @Query('country') country?: string,
    @Query('merchant') merchant?: string,
    @Query('method') method?: string,
    @Query('issuingBank') issuingBank?: string,
  ) {
    return this.analytics.timeseries(
      minutes ? Number(minutes) : 120,
      bucketMinutes ? Number(bucketMinutes) : 5,
      { provider, country, merchant, method, issuingBank },
    );
  }
}
