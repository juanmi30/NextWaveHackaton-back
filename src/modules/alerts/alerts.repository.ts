import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RecipientRole } from './routing.js';

/**
 * Delegados de las tablas de alertas.
 *
 * Se declaran a mano en vez de depender de los tipos generados porque estos
 * modelos son nuevos: asi el repositorio compila aunque alguien todavia no haya
 * corrido `prisma generate`. En tiempo de ejecucion son los delegados reales
 * del cliente de Prisma.
 */
type Delegate<T> = {
  findMany: (args?: Record<string, unknown>) => Promise<T[]>;
  findFirst: (args?: Record<string, unknown>) => Promise<T | null>;
  findUnique: (args: Record<string, unknown>) => Promise<T | null>;
  create: (args: Record<string, unknown>) => Promise<T>;
  createMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  update: (args: Record<string, unknown>) => Promise<T>;
  upsert: (args: Record<string, unknown>) => Promise<T>;
  deleteMany: (args?: Record<string, unknown>) => Promise<{ count: number }>;
  count: (args?: Record<string, unknown>) => Promise<number>;
};

export type RecipientRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: RecipientRole;
  merchants: string[];
  providers: string[];
  countries: string[];
  active: boolean;
};

export type EscalationStepRow = {
  id: string;
  level: number;
  waitMinutes: number;
  label: string;
  roles: string[];
  includeSpecialists: boolean;
  channels: string[];
};

export type EscalationPolicyRow = {
  id: string;
  name: string;
  description: string | null;
  minSeverity: number;
  maxSeverity: number;
  steps: EscalationStepRow[];
};

export type EscalationRow = {
  id: string;
  incidentId: string;
  policyId: string;
  status: string;
  currentLevel: number;
  category: string | null;
  actionability: string | null;
  routedRoles: string[];
  routingReason: string | null;
  nextEscalationAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedById: string | null;
  closedAt: Date | null;
  createdAt: Date;
  policy: EscalationPolicyRow;
};

export type IncidentRow = {
  id: string;
  fingerprint: string;
  anchorFingerprint: string;
  status: string;
  severity: number;
  expectedApprovals: number;
  actualApprovals: number;
  lostApprovals: number;
  averageTicketCents: number;
  lossPerMinuteCents: number;
  summaryOps: string | null;
  summaryExec: string | null;
  recommendation: string | null;
  startedAt: Date;
  detectedAt: Date;
};

export type AlertsPrisma = {
  recipient: Delegate<RecipientRow>;
  escalationPolicy: Delegate<EscalationPolicyRow>;
  escalationStep: Delegate<EscalationStepRow>;
  incidentEscalation: Delegate<EscalationRow>;
  alertNotification: Delegate<{ id: string }>;
  incident: Delegate<IncidentRow>;
};

@Injectable()
export class AlertsRepository {
  constructor(private readonly prismaService: PrismaService) {}

  private get prisma(): AlertsPrisma {
    return this.prismaService as unknown as AlertsPrisma;
  }

  // --- Destinatarios ---

  listRecipients(activeOnly = true) {
    return this.prisma.recipient.findMany({
      where: activeOnly ? { active: true } : undefined,
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
  }

  findRecipientsByRoles(roles: RecipientRole[]): Promise<RecipientRow[]> {
    if (roles.length === 0) return Promise.resolve([]);
    return this.prisma.recipient.findMany({
      where: { active: true, role: { in: roles as never } },
    });
  }

  findRecipient(id: string) {
    return this.prisma.recipient.findUnique({ where: { id } });
  }

  createRecipient(data: {
    name: string;
    email?: string | null;
    phone?: string | null;
    role: RecipientRole;
    merchants?: string[];
    providers?: string[];
    countries?: string[];
  }) {
    return this.prisma.recipient.create({ data: data as never });
  }

  deactivateRecipient(id: string) {
    return this.prisma.recipient.update({ where: { id }, data: { active: false } });
  }

  // --- Politicas ---

  listPolicies() {
    return this.prisma.escalationPolicy.findMany({
      include: { steps: { orderBy: { level: 'asc' } } },
      orderBy: { minSeverity: 'desc' },
    });
  }

  findPolicyForSeverity(severity: number) {
    return this.prisma.escalationPolicy.findFirst({
      where: { minSeverity: { lte: severity }, maxSeverity: { gte: severity } },
      include: { steps: { orderBy: { level: 'asc' } } },
    });
  }

  // --- Escalamientos ---

  findEscalationByIncident(incidentId: string) {
    return this.prisma.incidentEscalation.findUnique({
      where: { incidentId },
      include: {
        policy: { include: { steps: { orderBy: { level: 'asc' } } } },
        notifications: { orderBy: { sentAt: 'asc' }, include: { recipient: true } },
        acknowledgedBy: true,
      },
    });
  }

  listEscalations(status?: string, take = 50) {
    return this.prisma.incidentEscalation.findMany({
      where: status ? { status: status as never } : undefined,
      include: { policy: true, notifications: true, acknowledgedBy: true },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Escalamientos vencidos: nadie acuso recibo y ya toca subir de nivel. */
  findDue(now: Date) {
    return this.prisma.incidentEscalation.findMany({
      where: { status: 'PENDING', nextEscalationAt: { lte: now } },
      include: { policy: { include: { steps: { orderBy: { level: 'asc' } } } } },
      orderBy: { nextEscalationAt: 'asc' },
    });
  }

  createEscalation(data: Record<string, unknown>) {
    return this.prisma.incidentEscalation.create({ data: data as never });
  }

  updateEscalation(id: string, data: Record<string, unknown>) {
    return this.prisma.incidentEscalation.update({ where: { id }, data: data as never });
  }

  recordNotification(data: Record<string, unknown>) {
    return this.prisma.alertNotification.create({ data: data as never });
  }

  // --- Incidente asociado ---

  findIncidentForAlert(incidentId: string) {
    return this.prisma.incident.findUnique({
      where: { id: incidentId },
      include: { diagnoses: { orderBy: { version: 'desc' }, take: 1 } },
    });
  }
}
