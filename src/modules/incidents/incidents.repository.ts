import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

const WITH_LATEST_DIAGNOSIS = {
  diagnoses: {
    orderBy: { version: 'desc' },
    take: 1,
    include: { evidence: { orderBy: { difference: 'desc' } } },
  },
} satisfies Prisma.IncidentInclude;

@Injectable()
export class IncidentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany(where: Prisma.IncidentWhereInput, take: number) {
    return this.prisma.incident.findMany({
      where,
      include: WITH_LATEST_DIAGNOSIS,
      orderBy: [{ lossPerMinuteCents: 'desc' }, { severity: 'desc' }, { detectedAt: 'desc' }],
      take,
    });
  }

  findOne(id: string) {
    return this.prisma.incident.findUnique({
      where: { id },
      include: {
        detectionRun: true,
        diagnoses: {
          orderBy: { version: 'asc' },
          include: { evidence: { orderBy: { difference: 'desc' } } },
        },
      },
    });
  }

  findOpenByAnchor(anchorFingerprint: string) {
    return this.prisma.incident.findFirst({
      where: { anchorFingerprint, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      include: { diagnoses: { orderBy: { version: 'desc' }, take: 1 } },
    });
  }

  /** Incidentes ya cerrados con exactamente la misma ruta normalizada. */
  findResolvedByFingerprint(fingerprint: string, take = 5) {
    return this.prisma.incident.findMany({
      where: { fingerprint, status: 'RESOLVED' },
      orderBy: { detectedAt: 'desc' },
      take,
    });
  }

  create(data: Prisma.IncidentCreateInput) {
    return this.prisma.incident.create({ data, include: WITH_LATEST_DIAGNOSIS });
  }

  update(id: string, data: Prisma.IncidentUpdateInput) {
    return this.prisma.incident.update({ where: { id }, data, include: WITH_LATEST_DIAGNOSIS });
  }

  addDiagnosis(data: Prisma.IncidentDiagnosisCreateInput) {
    return this.prisma.incidentDiagnosis.create({ data, include: { evidence: true } });
  }

  nextVersion(incidentId: string) {
    return this.prisma.incidentDiagnosis.count({ where: { incidentId } });
  }

  /** Cierra los incidentes cuya señal ya no aparece. */
  autoResolveStale(before: Date) {
    return this.prisma.incident.updateMany({
      where: { status: 'OPEN', lastSeenAt: { lt: before } },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
  }

  findActive() {
    return this.prisma.incident.findMany({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      select: { id: true, anchorFingerprint: true, lastSeenAt: true },
    });
  }

  resolveMany(ids: string[], resolvedAt: Date) {
    if (ids.length === 0) return Promise.resolve({ count: 0 });
    return this.prisma.incident.updateMany({
      where: { id: { in: ids }, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      data: { status: 'RESOLVED', resolvedAt },
    });
  }

  countByStatus() {
    return this.prisma.incident.groupBy({ by: ['status'], _count: { _all: true } });
  }

  countOpenSevere(minSeverity: number) {
    return this.prisma.incident.count({
      where: { status: 'OPEN', severity: { gte: minSeverity } },
    });
  }

  deleteAll() {
    return this.prisma.incident.deleteMany();
  }
}
