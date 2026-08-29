import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { BaselinesService } from './baselines.service.js';
import { RebuildBaselinesDto } from './dto/rebuild-baselines.dto.js';

@Controller('baselines')
export class BaselinesController {
  constructor(private readonly baselines: BaselinesService) {}

  @Post('rebuild')
  rebuild(@Body() dto: RebuildBaselinesDto) {
    return this.baselines.rebuild(dto);
  }

  @Get()
  list(@Query('dimensionKey') dimensionKey?: string) {
    return this.baselines.list(dimensionKey);
  }

  @Get('count')
  async count() {
    return { count: await this.baselines.count() };
  }
}
