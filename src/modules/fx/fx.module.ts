import { Global, Module } from '@nestjs/common';
import { FxController } from './fx.controller.js';
import { FxRepository } from './fx.repository.js';
import { FxService } from './fx.service.js';

@Global()
@Module({
  controllers: [FxController],
  providers: [FxRepository, FxService],
  exports: [FxService, FxRepository],
})
export class FxModule {}
