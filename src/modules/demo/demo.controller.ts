import { Body, Controller, Post, Query } from '@nestjs/common';
import { DemoService } from './demo.service.js';
import { InjectIncidentDto } from './dto/inject-incident.dto.js';
import { InjectPredictiveRiskDto } from './dto/inject-predictive-risk.dto.js';

@Controller('demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Post('seed')
  seed(
    @Query('reset') reset?: string,
    @Query('historyHours') historyHours?: string,
    @Query('density') density?: string,
  ) {
    return this.demo.seed({
      reset: reset === 'true',
      historyHours: historyHours ? Number(historyHours) : undefined,
      density: density ? Number(density) : undefined,
    });
  }

  @Post('inject-incident')
  inject(@Body() dto: InjectIncidentDto) {
    return this.demo.injectIncident(dto);
  }

  @Post('reset')
  reset() {
    return this.demo.reset();
  }

  @Post('inject-predictive-risk')
  injectPredictiveRisk(
    @Body() dto: InjectPredictiveRiskDto,
  ) {
    return this.demo.injectPredictiveRisk(
      dto,
    );
  }

  @Post('run-incident-scenario')
  runIncidentScenario(
    @Body() dto: InjectIncidentDto,
  ) {
    return this.demo.runIncidentScenario(
      dto,
    );
  }
}
