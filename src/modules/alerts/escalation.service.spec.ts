import { beforeEach, describe, expect, it } from 'vitest';
import { EscalationService } from './escalation.service.js';
import { DEFAULT_POLICIES } from './escalation-policy.js';
import type { AlertsRepository, EscalationPolicyRow, RecipientRow } from './alerts.repository.js';
import type { AlertsService } from './alerts.service.js';

const T0 = new Date('2026-08-29T18:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function policyRows(): EscalationPolicyRow[] {
  return DEFAULT_POLICIES.map((definition, index) => ({
    id: `policy-${index}`,
    name: definition.name,
    description: definition.description,
    minSeverity: definition.minSeverity,
    maxSeverity: definition.maxSeverity,
    steps: definition.steps.map((step, stepIndex) => ({
      id: `step-${index}-${stepIndex}`,
      level: step.level,
      waitMinutes: step.waitMinutes,
      label: step.label,
      roles: [...step.roles],
      includeSpecialists: step.includeSpecialists,
      channels: [...step.channels],
    })),
  }));
}

function team(): RecipientRow[] {
  const base = { email: 'x@y.z', phone: '+100', active: true, merchants: [], providers: [], countries: [] };
  return [
    { id: 'r-checkout', name: 'Checkout', role: 'CHECKOUT_ENGINEER', ...base },
    { id: 'r-integr', name: 'Integraciones', role: 'INTEGRATIONS_ENGINEER', ...base },
    { id: 'r-risk', name: 'Riesgo', role: 'RISK_ANALYST', ...base },
    { id: 'r-ops', name: 'Guardia', role: 'PAYMENTS_OPS', ...base },
    { id: 'r-admin', name: 'Admin', role: 'ADMIN', ...base },
    { id: 'r-ops-br', name: 'Guardia Brasil', role: 'PAYMENTS_OPS', ...base, countries: ['BR'] },
  ] as RecipientRow[];
}

type Notified = { level: number; recipientId: string; channel: string };

function harness(incidentOverrides: Record<string, unknown> = {}) {
  const policies = policyRows();
  const recipients = team();
  const notifications: Notified[] = [];
  const escalations = new Map<string, Record<string, unknown>>();

  const incident = {
    id: 'inc-1',
    fingerprint: 'country=MX|failureReason=INVALID_CVV|provider=Stripe',
    anchorFingerprint: 'failureReason=INVALID_CVV',
    status: 'OPEN',
    severity: 4,
    expectedApprovals: 100,
    actualApprovals: 40,
    lostApprovals: 60,
    averageTicketCents: 5000,
    lossPerMinuteCents: 20000,
    summaryOps: 'ops',
    summaryExec: 'exec',
    recommendation: 'rec',
    startedAt: T0,
    detectedAt: T0,
    ...incidentOverrides,
  };

  const repository = {
    findEscalationByIncident: async (incidentId: string) => {
      const found = [...escalations.values()].find((e) => e.incidentId === incidentId);
      if (!found) return null;
      return { ...found, policy: policies.find((p) => p.id === found.policyId) };
    },
    createEscalation: async (data: Record<string, unknown>) => {
      const row = { id: `esc-${escalations.size + 1}`, ...data };
      escalations.set(row.id as string, row);
      return row;
    },
    updateEscalation: async (id: string, data: Record<string, unknown>) => {
      const row = { ...escalations.get(id), ...data };
      escalations.set(id, row);
      return row;
    },
    findDue: async (now: Date) =>
      [...escalations.values()]
        .filter(
          (e) =>
            e.status === 'PENDING' &&
            e.nextEscalationAt instanceof Date &&
            (e.nextEscalationAt as Date) <= now,
        )
        .map((e) => ({ ...e, policy: policies.find((p) => p.id === e.policyId) })),
    findRecipientsByRoles: async (roles: string[]) =>
      recipients.filter((r) => roles.includes(r.role)),
    listRecipients: async () => recipients,
    recordNotification: async (data: Record<string, unknown>) => {
      if (data.status === 'SENT') {
        notifications.push({
          level: data.level as number,
          recipientId: data.recipientId as string,
          channel: data.channel as string,
        });
      }
      return { id: 'n' };
    },
    findIncidentForAlert: async () => incident,
    findPolicyForSeverity: async (severity: number) =>
      policies.find((p) => severity >= p.minSeverity && severity <= p.maxSeverity) ?? null,
  } as unknown as AlertsRepository;

  const alerts = {
    buildMessage: () => ({ subject: 's', text: 't' }),
    deliver: async () => ({ status: 'SENT' as const }),
  } as unknown as AlertsService;

  return {
    service: new EscalationService(repository, alerts),
    notifications,
    escalations,
    incident,
    rolesNotifiedAt: (level: number) =>
      [
        ...new Set(
          notifications
            .filter((n) => n.level === level)
            .map((n) => recipients.find((r) => r.id === n.recipientId)!.role),
        ),
      ].sort(),
  };
}

describe('EscalationService', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('el nivel 1 avisa al especialista competente y a la guardia', async () => {
    await h.service.openForIncident(h.incident as never, T0);
    expect(h.rolesNotifiedAt(1)).toEqual(['CHECKOUT_ENGINEER', 'PAYMENTS_OPS']);
    expect(h.rolesNotifiedAt(1)).not.toContain('ADMIN');
  });

  it('no escala antes de que venza la ventana', async () => {
    await h.service.openForIncident(h.incident as never, T0);
    const result = await h.service.tick(minutes(3));
    expect(result.due).toBe(0);
    expect(h.rolesNotifiedAt(2)).toEqual([]);
  });

  it('escala a administracion cuando nadie acusa recibo', async () => {
    await h.service.openForIncident(h.incident as never, T0);
    await h.service.tick(minutes(6));
    expect(h.rolesNotifiedAt(2)).toContain('ADMIN');
  });

  it('el tercer nivel avisa a todo el equipo y agota la politica', async () => {
    await h.service.openForIncident(h.incident as never, T0);
    await h.service.tick(minutes(6));
    await h.service.tick(minutes(16));
    expect(h.rolesNotifiedAt(3).length).toBeGreaterThan(3);
    const escalation = [...h.escalations.values()][0]!;
    expect(escalation.status).toBe('EXHAUSTED');
    expect(escalation.nextEscalationAt).toBeNull();
  });

  it('acusar recibo detiene la cadena', async () => {
    await h.service.openForIncident(h.incident as never, T0);
    await h.service.acknowledge('inc-1', 'r-checkout', minutes(2));
    await h.service.tick(minutes(30));
    expect(h.rolesNotifiedAt(2)).toEqual([]);
    const escalation = [...h.escalations.values()][0]!;
    expect(escalation.status).toBe('ACKNOWLEDGED');
    expect(escalation.acknowledgedById).toBe('r-checkout');
  });

  it('no abre dos cadenas para el mismo incidente', async () => {
    await h.service.openForIncident(h.incident as never, T0);
    await h.service.openForIncident(h.incident as never, T0);
    expect(h.escalations.size).toBe(1);
  });

  it('respeta el alcance geografico de cada persona', async () => {
    await h.service.openForIncident(h.incident as never, T0);
    // El incidente es de MX; la guardia de Brasil no debe recibirlo.
    expect(h.notifications.some((n) => n.recipientId === 'r-ops-br')).toBe(false);
    expect(h.notifications.some((n) => n.recipientId === 'r-ops')).toBe(true);
  });

  it('un fraude va a riesgo, no a checkout', async () => {
    const fraude = harness({
      fingerprint: 'country=BR|failureReason=FRAUD_VALIDATION',
      severity: 3,
    });
    await fraude.service.openForIncident(fraude.incident as never, T0);
    expect(fraude.rolesNotifiedAt(1)).toContain('RISK_ANALYST');
    expect(fraude.rolesNotifiedAt(1)).not.toContain('CHECKOUT_ENGINEER');
  });

  it('severidad baja usa ventanas largas', async () => {
    const leve = harness({ severity: 1 });
    await leve.service.openForIncident(leve.incident as never, T0);
    await leve.service.tick(minutes(20));
    expect(leve.rolesNotifiedAt(2)).toEqual([]);
    await leve.service.tick(minutes(50));
    expect(leve.rolesNotifiedAt(2)).toContain('PAYMENTS_OPS');
  });

  it('preview no dispara notificaciones', async () => {
    const result = await h.service.preview('country=MX|failureReason=INVALID_CREDENTIALS', 4);
    expect(h.notifications).toHaveLength(0);
    expect(result.routing.category).toBe('PROVIDER_CONFIGURATION');
    expect(result.levels[0]?.recipients.map((r) => r.role)).toContain('INTEGRATIONS_ENGINEER');
  });
});
