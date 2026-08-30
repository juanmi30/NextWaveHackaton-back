import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module.js';
import { IncidentsController } from './incidents.controller.js';
import { IncidentsRepository } from './incidents.repository.js';
import { IncidentsService } from './incidents.service.js';

@Module({
  imports: [AlertsModule],
  controllers: [IncidentsController],
  providers: [IncidentsRepository, IncidentsService],
  exports: [IncidentsService, IncidentsRepository],
})
export class IncidentsModule {}
