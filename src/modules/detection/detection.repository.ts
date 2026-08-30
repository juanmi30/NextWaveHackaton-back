import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { DetectionOutcome, Prisma } from '../../generated/prisma/client.js';

@Injectable()
export class DetectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  createRun(data: Prisma.DetectionRunCreateInput) {
    return this.prisma.detectionRun.create({ data });
  }

  finishRun(
    id: string,
    outcome: DetectionOutcome,
    combosEvaluated: number,
    durationMs: number,
    params?: Prisma.InputJsonValue,
  ) {
    return this.prisma.detectionRun.update({
      where: { id },
      data: { outcome, combosEvaluated, durationMs, finishedAt: new Date(), ...(params ? { params } : {}) },
    });
  }

  findRecentRuns(excludeId: string, take: number, since?: Date) {
    return this.prisma.detectionRun.findMany({
      where: { id: { not: excludeId }, ...(since ? { finishedAt: { gte: since } } : {}) },
      select: { id: true, params: true, outcome: true, finishedAt: true },
      orderBy: { finishedAt: 'desc' },
      take,
    });
  }

  findRuns(take = 50) {
    return this.prisma.detectionRun.findMany({ orderBy: { finishedAt: 'desc' }, take });
  }

  /**
   * Cuantas corridas terminaron sin encontrar nada.
   *
   * Es la evidencia de que el sistema estuvo vigilando durante la operacion
   * normal sin alertar. Sin esto no hay forma de demostrar la ausencia de
   * falsos positivos: solo se veria que no paso nada.
   */
  async quietStats(since: Date) {
    const rows = await this.prisma.detectionRun.groupBy({
      by: ['outcome'],
      where: { finishedAt: { gte: since } },
      _count: { _all: true },
    });
    const get = (outcome: DetectionOutcome) =>
      rows.find((row) => row.outcome === outcome)?._count._all ?? 0;
    const noAnomaly = get('NO_ANOMALY');
    const insufficient = get('INSUFFICIENT_EVIDENCE');
    const found = get('INCIDENTS_FOUND');
    const total = noAnomaly + insufficient + found;
    return {
      total,
      noAnomaly,
      insufficientEvidence: insufficient,
      incidentsFound: found,
      quietRatio: total > 0 ? Number((noAnomaly / total).toFixed(4)) : 0,
      totalRuns: total,
      quietRuns: noAnomaly,
      incidentRuns: found,
      insufficientEvidenceRuns: insufficient,
    };
  }

  findRun(id: string) {
    return this.prisma.detectionRun.findUnique({
      where: { id },
    });
  }

  deleteAll() {
    return this.prisma.detectionRun.deleteMany();
  }
}
