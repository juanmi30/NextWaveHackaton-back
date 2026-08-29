import { Controller, Post, Query } from '@nestjs/common';
import { DemoService } from './demo.service.js';

@Controller('demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Post('seed')
  seed(@Query('reset') reset?: string) {
    return this.demo.seed(reset === 'true');
  }
}
