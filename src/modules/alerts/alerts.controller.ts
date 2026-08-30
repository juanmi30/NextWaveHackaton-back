import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { AlertsDirectoryService } from './alerts-directory.service.js';
import { AlertsRepository } from './alerts.repository.js';
import { EscalationService } from './escalation.service.js';
import { AcknowledgeAlertDto } from './dto/acknowledge-alert.dto.js';
import { CreateRecipientDto } from './dto/create-recipient.dto.js';
import { PreviewRoutingDto } from './dto/preview-routing.dto.js';

@Controller('alerts')
export class AlertsController {
  constructor(
    private readonly directory: AlertsDirectoryService,
    private readonly escalation: EscalationService,
    private readonly repository: AlertsRepository,
  ) {}

  // --- Directorio ---

  @Post('seed')
  seed(@Query('resetRecipients') resetRecipients?: string) {
    return this.directory.seed({ resetRecipients: resetRecipients === 'true' });
  }

  @Get('recipients')
  listRecipients(@Query('includeInactive') includeInactive?: string) {
    return this.directory.listRecipients(includeInactive === 'true');
  }

  @Post('recipients')
  createRecipient(@Body() dto: CreateRecipientDto) {
    return this.directory.createRecipient(dto);
  }

  @Delete('recipients/:id')
  deactivateRecipient(@Param('id') id: string) {
    return this.directory.deactivateRecipient(id);
  }

  @Get('policies')
  listPolicies() {
    return this.directory.listPolicies();
  }

  // --- Enrutamiento ---

  /**
   * Simulacion sin efectos. Util para la demo: deja ver a quien le llegaria una
   * alerta y en que orden, sin tener que provocar el incidente.
   */
  @Post('preview')
  preview(@Body() dto: PreviewRoutingDto) {
    return this.escalation.preview(dto.fingerprint, dto.severity);
  }

  // --- Escalamientos ---

  @Get('escalations')
  listEscalations(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.repository.listEscalations(status, limit ? Number(limit) : 50);
  }

  @Get('escalations/:incidentId')
  findEscalation(@Param('incidentId') incidentId: string) {
    return this.repository.findEscalationByIncident(incidentId);
  }

  /**
   * Avanza los escalamientos vencidos.
   *
   * Existe como endpoint manual a proposito: en la demo no se puede esperar 5
   * minutos reales a que suba de nivel, y un temporizador oculto no se puede
   * enseñar. Aqui el jurado ve el paso ocurrir.
   */
  @Post('escalations/tick')
  tick(@Query('at') at?: string) {
    return this.escalation.tick(at ? new Date(at) : new Date());
  }

  @Post('escalations/:incidentId/acknowledge')
  acknowledge(@Param('incidentId') incidentId: string, @Body() dto: AcknowledgeAlertDto) {
    return this.escalation.acknowledge(incidentId, dto.recipientId);
  }
}
