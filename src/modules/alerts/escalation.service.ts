import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AlertsRepository,
  type EscalationPolicyRow,
  type IncidentRow,
  type RecipientRow,
} from './alerts.repository.js';
import { AlertsService, type IncidentAlert } from './alerts.service.js';
import {
  DEFAULT_POLICIES,
  nextEscalationAt,
  rolesForStep,
  selectPolicy,
  stepAt,
  type EscalationPolicyDefinition,
  type EscalationStepDefinition,
  type NotificationChannel,
} from './escalation-policy.js';
import {
  coversScope,
  routeIncident,
  scopeFromFingerprint,
  type RecipientRole,
} from './routing.js';

@Injectable()
export class EscalationService {
  private readonly logger = new Logger(EscalationService.name);

  constructor(
    private readonly repository: AlertsRepository,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * Abre la cadena de escalamiento de un incidente y dispara el nivel 1.
   *
   * Es idempotente por incidente: si ya existe un escalamiento no se crea otro,
   * porque el detector puede refinar el diagnostico varias veces sobre el mismo
   * incidente y eso no debe reiniciar los relojes.
   */
  async openForIncident(
    incident: IncidentAlert,
    openedAt = new Date(),
  ): Promise<{ escalationId: string } | null> {
    const existing = await this.repository.findEscalationByIncident(
      incident.id,
    );
    if (existing) return { escalationId: existing.id };

    const scope = scopeFromFingerprint(incident.fingerprint);
    const decision = routeIncident(scope, incident.severity);
    const policy = await this.resolvePolicy(incident.severity);

    const escalation = await this.repository.createEscalation({
      incidentId: incident.id,
      policyId: policy.id,
      status: 'PENDING',
      currentLevel: 0,
      category: decision.category,
      actionability: decision.actionability,
      routedRoles: decision.roles,
      routingReason: decision.reason,
      nextEscalationAt: openedAt,
      createdAt: openedAt,
    });

    await this.fire(
      escalation.id,
      policy.definition,
      1,
      decision.roles,
      scope,
      incident,
      openedAt,
    );
    return { escalationId: escalation.id };
  }

  /**
   * Avanza los escalamientos vencidos. Se llama por temporizador y tambien a
   * mano desde `POST /api/alerts/escalations/tick`, que es lo que se usa en la
   * demo para no depender de esperar minutos reales.
   */
  async tick(now = new Date()) {
    const due = await this.repository.findDue(now);
    const processed: Array<Record<string, unknown>> = [];

    for (const escalation of due) {
      const incident = await this.repository.findIncidentForAlert(
        escalation.incidentId,
      );
      if (!incident) continue;

      // Si el incidente ya se cerro solo, la cadena muere con el.
      if (incident.status === 'RESOLVED') {
        await this.repository.updateEscalation(escalation.id, {
          status: 'RESOLVED',
          nextEscalationAt: null,
          closedAt: now,
        });
        processed.push({
          escalationId: escalation.id,
          action: 'CLOSED_BY_RESOLUTION',
        });
        continue;
      }
      if (incident.status === 'ACKNOWLEDGED') {
        await this.acknowledge(escalation.incidentId, undefined, now);
        processed.push({
          escalationId: escalation.id,
          action: 'CLOSED_BY_ACK',
        });
        continue;
      }

      const definition = toDefinition(escalation.policy);
      const nextLevel = escalation.currentLevel + 1;
      const step = stepAt(definition, nextLevel);

      if (!step) {
        await this.repository.updateEscalation(escalation.id, {
          status: 'EXHAUSTED',
          nextEscalationAt: null,
        });
        this.logger.warn(
          `Escalamiento agotado para el incidente ${escalation.incidentId}: nadie acuso recibo en ningun nivel.`,
        );
        processed.push({ escalationId: escalation.id, action: 'EXHAUSTED' });
        continue;
      }

      const scope = scopeFromFingerprint(incident.fingerprint);
      const result = await this.fire(
        escalation.id,
        definition,
        nextLevel,
        (escalation.routedRoles ?? []) as RecipientRole[],
        scope,
        toAlert(incident),
        escalation.createdAt,
        escalation.currentLevel,
      );

      processed.push({
        escalationId: escalation.id,
        action: 'ESCALATED',
        ...result,
      });
    }

    return { checkedAt: now, due: due.length, processed };
  }

  /** Acusar recibo detiene la cadena. Es el unico freno junto a resolver. */
  async acknowledge(
    incidentId: string,
    recipientId?: string,
    now = new Date(),
  ) {
    const escalation =
      await this.repository.findEscalationByIncident(incidentId);
    if (!escalation)
      throw new NotFoundException(
        `El incidente ${incidentId} no tiene escalamiento`,
      );

    return this.repository.updateEscalation(escalation.id, {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: now,
      acknowledgedById: recipientId ?? null,
      nextEscalationAt: null,
    });
  }

  async close(incidentId: string, now = new Date()) {
    const escalation =
      await this.repository.findEscalationByIncident(incidentId);
    if (!escalation) return null;
    return this.repository.updateEscalation(escalation.id, {
      status: 'RESOLVED',
      closedAt: now,
      nextEscalationAt: null,
    });
  }

  /** Simulacion sin efectos: a quien le llegaria y en que orden. */
  async preview(fingerprint: string, severity: number) {
    const scope = scopeFromFingerprint(fingerprint);
    const decision = routeIncident(scope, severity);
    const policy = await this.resolvePolicy(severity);
    const recipients = await this.repository.listRecipients(true);

    const levels = policy.definition.steps.map((step) => {
      const roles = rolesForStep(step, decision.roles);
      const targets = recipients.filter(
        (recipient) =>
          roles.includes(recipient.role as RecipientRole) &&
          coversScope(recipient, scope),
      );
      return {
        level: step.level,
        label: step.label,
        firesAfterMinutes: step.waitMinutes,
        roles,
        channels: step.channels,
        recipients: targets.map((target) => ({
          id: target.id,
          name: target.name,
          role: target.role,
        })),
      };
    });

    return { scope, routing: decision, policy: policy.definition.name, levels };
  }

  // --- interno ---

  private async fire(
    escalationId: string,
    definition: EscalationPolicyDefinition,
    level: number,
    specialistRoles: RecipientRole[],
    scope: ReturnType<typeof scopeFromFingerprint>,
    incident: IncidentAlert,
    openedAt: Date,
    escalatedFrom?: number,
  ) {
    const step = stepAt(definition, level);
    if (!step) return { level, notified: 0 };

    const roles = rolesForStep(step, specialistRoles);
    const candidates = await this.repository.findRecipientsByRoles(roles);
    const targets = candidates.filter((recipient) =>
      coversScope(recipient, scope),
    );

    const dueNext = nextEscalationAt(definition, level, openedAt);

    let notified = 0;
    for (const recipient of targets) {
      for (const channel of step.channels) {
        const target = channelTarget(recipient, channel);
        if (!target) {
          await this.repository.recordNotification({
            escalationId,
            recipientId: recipient.id,
            level,
            role: recipient.role,
            channel,
            status: 'SKIPPED',
            error: `El destinatario no tiene ${channel === 'EMAIL' ? 'correo' : 'telefono'}`,
          });
          continue;
        }

        const message = this.alerts.buildMessage(incident, {
          level,
          levelLabel: step.label,
          totalLevels: definition.steps.length,
          role: recipient.role as RecipientRole,
          recipientName: recipient.name,
          routingReason: describeRouting(
            specialistRoles,
            recipient.role as RecipientRole,
          ),
          escalatedFrom,
          nextEscalationAt: dueNext,
        });

        const result = await this.alerts.deliver(channel, target, message);
        await this.repository.recordNotification({
          escalationId,
          recipientId: recipient.id,
          level,
          role: recipient.role,
          channel,
          status: result.status,
          target,
          error: result.error ?? null,
        });
        if (result.status === 'SENT') notified += 1;
      }
    }

    if (targets.length === 0) {
      this.logger.warn(
        `Nivel ${level} sin destinatarios para los roles ${roles.join(', ')}. Se escalara al siguiente nivel.`,
      );
    }

    await this.repository.updateEscalation(escalationId, {
      currentLevel: level,
      nextEscalationAt: dueNext,
      ...(dueNext ? {} : { status: 'EXHAUSTED' }),
    });

    return {
      level,
      roles,
      notified,
      recipients: targets.length,
      nextEscalationAt: dueNext,
    };
  }

  private async resolvePolicy(severity: number) {
    const stored = await this.repository.findPolicyForSeverity(severity);
    if (stored && stored.steps.length > 0) {
      return { id: stored.id, definition: toDefinition(stored) };
    }
    throw new NotFoundException(
      'No hay politicas de escalamiento cargadas. Ejecuta POST /api/alerts/seed.',
    );
  }
}

function toDefinition(policy: EscalationPolicyRow): EscalationPolicyDefinition {
  return {
    name: policy.name,
    minSeverity: policy.minSeverity,
    maxSeverity: policy.maxSeverity,
    description: policy.description ?? '',
    steps: policy.steps
      .map((step): EscalationStepDefinition => ({
        level: step.level,
        waitMinutes: step.waitMinutes,
        label: step.label,
        roles: step.roles as RecipientRole[],
        includeSpecialists: step.includeSpecialists,
        channels: step.channels as NotificationChannel[],
      }))
      .sort((a, b) => a.level - b.level),
  };
}

function toAlert(incident: IncidentRow): IncidentAlert {
  return incident as unknown as IncidentAlert;
}

function channelTarget(
  recipient: RecipientRow,
  channel: NotificationChannel,
): string | null {
  if (channel === 'EMAIL') return recipient.email;
  return recipient.phone;
}

function describeRouting(
  specialistRoles: RecipientRole[],
  role: RecipientRole,
): string {
  if (specialistRoles.includes(role)) {
    return 'Te llega porque la causa raiz diagnosticada cae en tu especialidad.';
  }
  return 'Te llega por escalamiento: el nivel anterior no acuso recibo dentro de la ventana.';
}

export { DEFAULT_POLICIES, selectPolicy };
