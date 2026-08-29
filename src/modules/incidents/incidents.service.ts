import { Injectable, NotFoundException } from '@nestjs/common';
import { IncidentsRepository } from './incidents.repository.js';
import type { QueryIncidentsDto } from './dto/query-incidents.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';

@Injectable()
export class IncidentsService {
  constructor(private readonly repository: IncidentsRepository) {}

  findAll(query: QueryIncidentsDto) {
    const where: Prisma.IncidentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.minSeverity !== undefined ? { severity: { gte: query.minSeverity } } : {}),
    };
    return this.repository.findMany(where, query.limit ?? 50);
  }

  async findOne(id: string) {
    const incident = await this.repository.findOne(id);
    if (!incident) throw new NotFoundException(`Incident ${id} not found`);
    return incident;
  }

  /** Incidentes resueltos con exactamente el mismo fingerprint normalizado. */
  async history(id: string) {
    const incident = await this.findOne(id);
    const candidates = await this.repository.findResolvedByFingerprint(incident.fingerprint);
    const previousOccurrences = candidates.filter(
      (row) =>
        row.id !== incident.id &&
        row.status === 'RESOLVED' &&
        row.fingerprint === incident.fingerprint,
    );
    return {
      anchorFingerprint: incident.anchorFingerprint,
      isRecurrence: previousOccurrences.length > 0,
      previousOccurrences,
    };
  }

  async countOpen() {
    const [byStatus, highCritical] = await Promise.all([
      this.repository.countByStatus(),
      this.repository.countOpenSevere(3),
    ]);
    const open = byStatus.find((row) => row.status === 'OPEN')?._count._all ?? 0;
    const acknowledged = byStatus.find((row) => row.status === 'ACKNOWLEDGED')?._count._all ?? 0;
    const resolved = byStatus.find((row) => row.status === 'RESOLVED')?._count._all ?? 0;
    return { open, acknowledged, resolved, highCritical };
  }

  async acknowledge(id: string) {
    await this.findOne(id);
    return this.repository.update(id, { status: 'ACKNOWLEDGED' });
  }

  async resolve(id: string) {
    await this.findOne(id);
    return this.repository.update(id, { status: 'RESOLVED', resolvedAt: new Date() });
  }
}
