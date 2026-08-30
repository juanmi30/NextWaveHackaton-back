import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller.js';
import { AlertsDirectoryService } from './alerts-directory.service.js';
import { AlertsRepository } from './alerts.repository.js';
import { AlertsService } from './alerts.service.js';
import { EscalationService } from './escalation.service.js';

@Module({
  controllers: [AlertsController],
  providers: [AlertsService, AlertsRepository, AlertsDirectoryService, EscalationService],
  exports: [AlertsService, EscalationService],
})
export class AlertsModule {}
