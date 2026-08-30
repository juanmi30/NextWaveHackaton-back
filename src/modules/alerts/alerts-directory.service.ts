import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AlertsRepository, type AlertsPrisma } from './alerts.repository.js';
import { DEFAULT_POLICIES } from './escalation-policy.js';
import type { CreateRecipientDto } from './dto/create-recipient.dto.js';

/**
 * Directorio de personas y politicas. Separado de la maquinaria de
 * escalamiento a proposito: aqui vive el "quien existe", no el "que pasa".
 */
@Injectable()
export class AlertsDirectoryService {
  private readonly logger = new Logger(AlertsDirectoryService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly repository: AlertsRepository,
  ) {}

  private get prisma(): AlertsPrisma {
    return this.prismaService as unknown as AlertsPrisma;
  }

  listRecipients(includeInactive = false) {
    return this.repository.listRecipients(!includeInactive);
  }

  createRecipient(dto: CreateRecipientDto) {
    return this.repository.createRecipient({
      name: dto.name,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      role: dto.role,
      merchants: dto.merchants ?? [],
      providers: dto.providers ?? [],
      countries: dto.countries ?? [],
    });
  }

  deactivateRecipient(id: string) {
    return this.repository.deactivateRecipient(id);
  }

  listPolicies() {
    return this.repository.listPolicies();
  }

  /**
   * Carga las politicas por defecto y un equipo de ejemplo.
   *
   * Los correos y telefonos se toman de variables de entorno para que el equipo
   * pueda recibir las alertas de verdad durante la demo sin tocar codigo.
   */
  async seed(options: { resetRecipients?: boolean } = {}) {
    const policies = await this.seedPolicies();

    if (options.resetRecipients) {
      await this.prisma.recipient.deleteMany();
    }

    const existing = await this.prisma.recipient.count();
    let recipients = 0;
    if (existing === 0) {
      recipients = await this.seedRecipients();
    }

    return { policies, recipients, skippedRecipients: existing > 0 };
  }

  private async seedPolicies() {
    let written = 0;
    for (const definition of DEFAULT_POLICIES) {
      const policy = await this.prisma.escalationPolicy.upsert({
        where: { name: definition.name },
        create: {
          name: definition.name,
          description: definition.description,
          minSeverity: definition.minSeverity,
          maxSeverity: definition.maxSeverity,
        },
        update: {
          description: definition.description,
          minSeverity: definition.minSeverity,
          maxSeverity: definition.maxSeverity,
        },
      });

      for (const step of definition.steps) {
        await this.prisma.escalationStep.upsert({
          where: { policyId_level: { policyId: policy.id, level: step.level } },
          create: {
            policyId: policy.id,
            level: step.level,
            waitMinutes: step.waitMinutes,
            label: step.label,
            roles: step.roles as never,
            includeSpecialists: step.includeSpecialists,
            channels: step.channels as never,
          },
          update: {
            waitMinutes: step.waitMinutes,
            label: step.label,
            roles: step.roles as never,
            includeSpecialists: step.includeSpecialists,
            channels: step.channels as never,
          },
        });
      }
      written += 1;
    }
    this.logger.log(`Politicas de escalamiento cargadas: ${written}`);
    return written;
  }

  private async seedRecipients() {
    const demoEmail = process.env.ALERT_EMAIL_TO?.split(',')[0]?.trim() || null;
    const demoPhone = process.env.WHATSAPP_TO?.split(',')[0]?.trim() || null;

    const team = [
      { name: 'Checkout Engineer', role: 'CHECKOUT_ENGINEER' },
      { name: 'Integrations Engineer', role: 'INTEGRATIONS_ENGINEER' },
      { name: 'Provider Manager', role: 'PROVIDER_MANAGER' },
      { name: 'Risk Analyst', role: 'RISK_ANALYST' },
      { name: 'Merchant Success', role: 'MERCHANT_SUCCESS' },
      { name: 'Payments Ops (guardia)', role: 'PAYMENTS_OPS' },
      { name: 'Yuno Admin', role: 'ADMIN' },
    ];

    await this.prisma.recipient.createMany({
      data: team.map((member) => ({
        name: member.name,
        role: member.role as never,
        email: demoEmail,
        phone: demoPhone,
        merchants: [],
        providers: [],
        countries: [],
      })),
    });

    this.logger.log(`Destinatarios de ejemplo creados: ${team.length}`);
    return team.length;
  }
}
