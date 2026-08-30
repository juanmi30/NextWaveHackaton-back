import type { RecipientRole } from './routing.js';

export const NOTIFICATION_CHANNELS = ['EMAIL', 'WHATSAPP', 'CONSOLE'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type EscalationStepDefinition = {
  level: number;
  /** Minutos desde la apertura del escalamiento hasta que se dispara este nivel. */
  waitMinutes: number;
  /** Roles fijos de este nivel. */
  roles: RecipientRole[];
  /** Si es true, añade los roles derivados del diagnostico. */
  includeSpecialists: boolean;
  channels: NotificationChannel[];
  label: string;
};

export type EscalationPolicyDefinition = {
  name: string;
  minSeverity: number;
  maxSeverity: number;
  description: string;
  steps: EscalationStepDefinition[];
};

/**
 * Politicas por defecto.
 *
 * El escalamiento va de menor a mayor: primero quien puede arreglarlo, luego
 * quien puede conseguir que alguien lo arregle, y por ultimo quien responde por
 * el impacto. Los tiempos se acortan con la severidad, no los niveles.
 */
export const DEFAULT_POLICIES: EscalationPolicyDefinition[] = [
  {
    name: 'critical',
    minSeverity: 4,
    maxSeverity: 5,
    description: 'Critical severity: short response windows and rapid escalation to leadership.',
    steps: [
      {
        level: 1,
        waitMinutes: 0,
        roles: ['PAYMENTS_OPS'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'Responsible specialist and Payments Operations',
      },
      {
        level: 2,
        waitMinutes: 5,
        roles: ['ADMIN'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'No acknowledgement in 5 minutes: notify administration',
      },
      {
        level: 3,
        waitMinutes: 15,
        roles: ['ADMIN', 'PAYMENTS_OPS', 'INTEGRATIONS_ENGINEER', 'PROVIDER_MANAGER', 'RISK_ANALYST', 'CHECKOUT_ENGINEER', 'MERCHANT_SUCCESS'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'No acknowledgement in 15 minutes: notify the full team',
      },
    ],
  },
  {
    name: 'high',
    minSeverity: 3,
    maxSeverity: 3,
    description: 'High severity: the specialist has a short response window before escalation.',
    steps: [
      {
        level: 1,
        waitMinutes: 0,
        roles: [],
        includeSpecialists: true,
        channels: ['EMAIL'],
        label: 'Responsible specialist',
      },
      {
        level: 2,
        waitMinutes: 10,
        roles: ['PAYMENTS_OPS'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'No acknowledgement in 10 minutes: notify Payments Operations',
      },
      {
        level: 3,
        waitMinutes: 25,
        roles: ['ADMIN'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'No acknowledgement in 25 minutes: notify administration',
      },
    ],
  },
  {
    name: 'standard',
    minSeverity: 0,
    maxSeverity: 2,
    description: 'Low or medium severity: full escalation with wider response windows.',
    steps: [
      {
        level: 1,
        waitMinutes: 0,
        roles: [],
        includeSpecialists: true,
        channels: ['EMAIL'],
        label: 'Responsible specialist',
      },
      {
        level: 2,
        waitMinutes: 45,
        roles: ['PAYMENTS_OPS'],
        includeSpecialists: true,
        channels: ['EMAIL'],
        label: 'No acknowledgement in 45 minutes: notify Payments Operations',
      },
      {
        level: 3,
        waitMinutes: 120,
        roles: ['ADMIN'],
        includeSpecialists: true,
        channels: ['EMAIL'],
        label: 'No acknowledgement in 120 minutes: notify administration',
      },
    ],
  },
];

export function selectPolicy(
  severity: number,
  policies: EscalationPolicyDefinition[] = DEFAULT_POLICIES,
): EscalationPolicyDefinition {
  const match = policies.find(
    (policy) => severity >= policy.minSeverity && severity <= policy.maxSeverity,
  );
  if (match) return match;

  // Nunca dejar un incidente sin politica: mejor avisar de mas.
  return (
    policies.find((policy) => policy.name === 'standard') ??
    policies[policies.length - 1] ??
    DEFAULT_POLICIES[DEFAULT_POLICIES.length - 1]!
  );
}

export function stepAt(
  policy: EscalationPolicyDefinition,
  level: number,
): EscalationStepDefinition | null {
  return policy.steps.find((step) => step.level === level) ?? null;
}

/**
 * Cuando toca el siguiente nivel. `null` significa que la politica se agoto:
 * no hay a quien mas escalar.
 */
export function nextEscalationAt(
  policy: EscalationPolicyDefinition,
  currentLevel: number,
  openedAt: Date,
): Date | null {
  const next = stepAt(policy, currentLevel + 1);
  if (!next) return null;
  return new Date(openedAt.getTime() + next.waitMinutes * 60_000);
}

/** Roles a notificar en un nivel, combinando los fijos con los del diagnostico. */
export function rolesForStep(
  step: EscalationStepDefinition,
  specialistRoles: RecipientRole[],
): RecipientRole[] {
  const roles = new Set<RecipientRole>(step.roles);
  if (step.includeSpecialists) {
    for (const role of specialistRoles) roles.add(role);
  }
  return [...roles];
}
