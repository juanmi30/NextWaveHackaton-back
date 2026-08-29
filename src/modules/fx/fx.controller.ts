import { Controller, Get, Post } from '@nestjs/common';
import { FxService } from './fx.service.js';

@Controller('fx')
export class FxController {
  constructor(private readonly fx: FxService) {}

  @Get('rates')
  list() {
    return this.fx.list();
  }

  @Post('rates/seed')
  async seed() {
    const written = await this.fx.ensureSeeded();
    return { written };
  }
}
