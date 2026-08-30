import { Body, Controller, Delete, Get, Param, Post, Sse } from '@nestjs/common';
import { CreateLiveDegradationDto } from './dto/create-live-degradation.dto.js';
import { StartLiveMonitorDto } from './dto/start-live-monitor.dto.js';
import { LiveEventService } from './live-event.service.js';
import { LiveMonitoringService } from './live-monitoring.service.js';

@Controller('live')
export class LiveMonitoringController {
  constructor(
    private readonly live: LiveMonitoringService,
    private readonly events: LiveEventService,
  ) {}

  @Post('start')
  start(@Body() dto: StartLiveMonitorDto) {
    return this.live.start(dto);
  }

  @Post('stop')
  stop() {
    return this.live.stop();
  }

  @Get('status')
  status() {
    return this.live.status();
  }

  @Sse('events')
  eventsStream() {
    return this.events.events();
  }

  @Post('degradations')
  addDegradation(@Body() dto: CreateLiveDegradationDto) {
    return this.live.addDegradation(dto);
  }

  @Get('degradations')
  degradations() {
    return this.live.listDegradations();
  }

  @Delete('degradations/:id')
  removeDegradation(@Param('id') id: string) {
    return this.live.removeDegradation(id);
  }
}
