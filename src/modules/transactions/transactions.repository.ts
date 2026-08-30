import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DIMENSIONS, type Dimension, type DimensionMap } from '../../common/dimensions.js';
import type { Prisma } from '../../generated/prisma/client.js';

export type SliceCount = {
  dimensions: DimensionMap;
  attempts: number;
  approved: number;
  amountUsdCents: number;
};

@Injectable()
export class TransactionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  createMany(data: Prisma.TransactionCreateManyInput[]) {
    return this.prisma.transaction.createMany({ data, skipDuplicates: true });
  }

  create(data: Prisma.TransactionCreateInput) {
    return this.prisma.transaction.create({ data });
  }

  findMany(where: Prisma.TransactionWhereInput, take: number) {
    return this.prisma.transaction.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take,
    });
  }

  count(where?: Prisma.TransactionWhereInput) {
    return this.prisma.transaction.count({ where });
  }

  findWindow(from: Date, to: Date, where: Prisma.TransactionWhereInput = {}) {
    return this.prisma.transaction.findMany({
      where: { ...where, occurredAt: { gte: from, lt: to } },
      orderBy: { occurredAt: 'asc' },
    });
  }

  sampleIds(dimensions: DimensionMap, from: Date, to: Date, take = 5) {
    return this.prisma.transaction.findMany({
      where: { ...toWhere(dimensions), occurredAt: { gte: from, lt: to }, status: { not: 'APPROVED' } },
      select: { id: true },
      orderBy: { occurredAt: 'desc' },
      take,
    });
  }

  async aggregateDeclineReasons(dimensions: DimensionMap, from: Date, to: Date) {
    const rows = await this.prisma.transaction.groupBy({
      by: ['failureReason'],
      where: {
        ...toWhere(dimensions),
        occurredAt: { gte: from, lt: to },
        status: 'DECLINED',
        failureReason: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { failureReason: 'desc' } },
    });
    return Object.fromEntries(
      rows
        .filter((row) => row.failureReason !== null)
        .map((row) => [row.failureReason!, row._count._all]),
    );
  }

  /**
   * Agregacion generica sobre CUALQUIER combinacion de dimensiones.
   *
   * Esta es la pieza que hace posible el trial by fire: `by` se construye
   * en tiempo de ejecucion desde el array DIMENSIONS, asi que una
   * combinacion nunca vista se agrega igual que cualquier otra.
   */
  async aggregateBy(
    by: Dimension[],
    from: Date,
    to: Date,
    where: Prisma.TransactionWhereInput = {},
  ): Promise<SliceCount[]> {
    if (by.length === 0) return [];

    // Prisma tipa `by` como tupla literal, asi que un array construido en
    // tiempo de ejecucion no encaja. Este es el unico punto del codigo donde
    // se rompe el tipado, y es a proposito: es lo que permite agrupar por
    // combinaciones que no se conocen al compilar.
    const groupBy = this.prisma.transaction.groupBy as unknown as (
      args: Record<string, unknown>,
    ) => Promise<GroupRow[]>;

    const rows = await groupBy({
      by,
      where: { ...where, occurredAt: { gte: from, lt: to } },
      _count: { _all: true },
      _sum: { amountUsdCents: true },
    });

    const approvedRows = await groupBy({
      by,
      where: { ...where, occurredAt: { gte: from, lt: to }, status: 'APPROVED' },
      _count: { _all: true },
    });

    const approvedIndex = new Map<string, number>();
    for (const row of approvedRows) {
      approvedIndex.set(indexKey(by, row), row._count?._all ?? 0);
    }

    return rows.map((row) => {
      const dimensions: DimensionMap = {};
      for (const dimension of by) {
        const value = row[dimension];
        dimensions[dimension] = value === null || value === undefined ? '(sin valor)' : String(value);
      }
      return {
        dimensions,
        attempts: row._count?._all ?? 0,
        approved: approvedIndex.get(indexKey(by, row)) ?? 0,
        amountUsdCents: Number(row._sum?.amountUsdCents ?? 0),
      };
    });
  }

  /** Totales globales de una ventana, sin agrupar. */
  async totals(from: Date, to: Date, where: Prisma.TransactionWhereInput = {}) {
    const [attempts, approved, sum] = await Promise.all([
      this.prisma.transaction.count({ where: { ...where, occurredAt: { gte: from, lt: to } } }),
      this.prisma.transaction.count({
        where: { ...where, occurredAt: { gte: from, lt: to }, status: 'APPROVED' },
      }),
      this.prisma.transaction.aggregate({
        where: { ...where, occurredAt: { gte: from, lt: to } },
        _sum: { amountUsdCents: true },
      }),
    ]);
    return { attempts, approved, amountUsdCents: Number(sum._sum.amountUsdCents ?? 0) };
  }

  deleteAll() {
    return this.prisma.transaction.deleteMany();
  }
}

export function toWhere(dimensions: DimensionMap): Prisma.TransactionWhereInput {
  const where: Record<string, string> = {};
  for (const dimension of DIMENSIONS) {
    const value = dimensions[dimension];
    if (value !== undefined && value !== '(sin valor)') where[dimension] = value;
  }
  return where as Prisma.TransactionWhereInput;
}

type GroupRow = Record<string, unknown> & {
  _count?: { _all: number };
  _sum?: { amountUsdCents: number | null };
};

function indexKey(by: Dimension[], row: Record<string, unknown>): string {
  return by.map((dimension) => String(row[dimension] ?? '')).join('\u0000');
}
