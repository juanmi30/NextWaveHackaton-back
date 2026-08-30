import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

export type BaselineUpsert = {
  dimensionKey: string;
  segmentKey: string;
  segment: Prisma.InputJsonValue;
  hourOfDay: number;
  dayOfWeek: number;
  expectedRate: number;
  variance: number;
  sampleSize: number;
};

@Injectable()
export class BaselinesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async replaceAll(rows: BaselineUpsert[]) {
    await this.prisma.baseline.deleteMany();
    if (rows.length === 0) return 0;

    let written = 0;
    // createMany soporta lotes mayores y reduce fuertemente los round-trips
    // contra PostgreSQL remoto durante el seed de demo.
    const chunkSize = 2_000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const result = await this.prisma.baseline.createMany({
        data: rows.slice(i, i + chunkSize).map((row) => ({ ...row, calculatedAt: new Date() })),
        skipDuplicates: true,
      });
      written += result.count;
    }
    return written;
  }

  findForSegments(segmentKeys: string[]) {
    return this.prisma.baseline.findMany({ where: { segmentKey: { in: segmentKeys } } });
  }

  findBySegment(segmentKey: string) {
    return this.prisma.baseline.findMany({ where: { segmentKey } });
  }

  count() {
    return this.prisma.baseline.count();
  }

  findMany(dimensionKey?: string, take = 200) {
    return this.prisma.baseline.findMany({
      where: dimensionKey ? { dimensionKey } : undefined,
      orderBy: [{ dimensionKey: 'asc' }, { segmentKey: 'asc' }, { dayOfWeek: 'asc' }, { hourOfDay: 'asc' }],
      take,
    });
  }
}
