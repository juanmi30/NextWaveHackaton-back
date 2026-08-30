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
    description: 'Severidad critica: ventanas cortas y llegada rapida a direccion.',
    steps: [
      {
        level: 1,
        waitMinutes: 0,
        roles: ['PAYMENTS_OPS'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'Especialista competente y guardia de operaciones',
      },
      {
        level: 2,
        waitMinutes: 5,
        roles: ['ADMIN'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'Sin acuse en 5 min: entra administracion',
      },
      {
        level: 3,
        waitMinutes: 15,
        roles: ['ADMIN', 'PAYMENTS_OPS', 'INTEGRATIONS_ENGINEER', 'PROVIDER_MANAGER', 'RISK_ANALYST', 'CHECKOUT_ENGINEER', 'MERCHANT_SUCCESS'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'Sin acuse en 15 min: aviso a todo el equipo',
      },
    ],
  },
  {
    name: 'high',
    minSeverity: 3,
    maxSeverity: 3,
    description: 'Severidad alta: el especialista tiene margen antes de escalar.',
    steps: [
      {
        level: 1,
        waitMinutes: 0,
        roles: [],
        includeSpecialists: true,
        channels: ['EMAIL'],
        label: 'Especialista competente',
      },
      {
        level: 2,
        waitMinutes: 10,
        roles: ['PAYMENTS_OPS'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'Sin acuse en 10 min: guardia de operaciones',
      },
      {
        level: 3,
        waitMinutes: 25,
        roles: ['ADMIN'],
        includeSpecialists: true,
        channels: ['EMAIL', 'WHATSAPP'],
        label: 'Sin acuse en 25 min: administracion',
      },
    ],
  },
  {
    name: 'standard',
    minSeverity: 0,
    maxSeverity: 2,
    description: 'Severidad baja o media: escalamiento completo con ventanas amplias.',
    steps: [
      {
        level: 1,
        waitMinutes: 0,
        roles: [],
        includeSpecialists: true,
        channels: ['EMAIL'],
        label: 'Especialista competente',
      },
      {
        level: 2,
        waitMinutes: 45,
        roles: ['PAYMENTS_OPS'],
        includeSpecialists: true,
        channels: ['EMAIL'],
        label: 'Sin acuse en 45 min: guardia de operaciones',
      },
      {
        level: 3,
        waitMinutes: 120,
        roles: ['ADMIN'],
        includeSpecialists: true,
        channels: ['EMAIL'],
        label: 'Sin acuse en 120 min: administracion',
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
