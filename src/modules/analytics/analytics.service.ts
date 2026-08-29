import { Injectable } from '@nestjs/common';
import { DIMENSIONS, type Dimension } from '../../common/dimensions.js';
import { approvalRate, percentile, round } from '../../common/stats.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { TransactionsRepository, toWhere } from '../transactions/transactions.repository.js';
import { DetectionRepository } from '../detection/detection.repository.js';
import type { AnalyzeRiskDto } from './dto/analyze-risk.dto.js';
import type { DeclineReasonBreakdownDto } from './dto/decline-reason-breakdown.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Modulo de solo lectura. La deteccion y la creacion de incidentes viven
 * en DetectionModule; aqui solo se exponen metricas para la UI.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly incidents: IncidentsService,
    private readonly runs: DetectionRepository,
  ) {}

  /** Cabecera del dashboard: estado global en un vistazo. */
  async summary(windowMinutes = 60) {
    const now = new Date();
    const from = new Date(now.getTime() - windowMinutes * 60_000);

    const [totals, incidents, quiet] = await Promise.all([
      this.transactions.totals(from, now),
      this.incidents.countOpen(),
      this.runs.quietStats(new Date(now.getTime() - 24 * 3_600_000)),
    ]);

    const rate = approvalRate(totals.approved, totals.attempts);

    return {
      window: { from, to: now, minutes: windowMinutes },
      transactions: totals.attempts,
      approved: totals.approved,
      approvalRate: round(rate),
      failureRate: round(1 - rate),
      volumeUsdCents: totals.amountUsdCents,
      incidents,
      detection: quiet,
      state: incidents.open === 0 ? 'NORMAL' : incidents.highCritical > 0 ? 'INCIDENT' : 'DEGRADED',
    };
  }

  /** Desglose por dimension, para las tablas de exploracion de la UI. */
  async breakdown(dto: AnalyzeRiskDto) {
    const groupBy = dto.groupBy ?? 'route';
    const windowMinutes = dto.timeWindowMinutes ?? 60;
    const baselineHours = dto.baselineHours ?? 24;
    const minSampleSize = dto.minSampleSize ?? 10;

    const now = new Date();
    const currentStart = new Date(now.getTime() - windowMinutes * 60_000);
    const baselineStart = new Date(currentStart.getTime() - baselineHours * 3_600_000);

    const by: Dimension[] = groupBy === 'route' ? [...DIMENSIONS] : [groupBy as Dimension];
    const filters = toWhere({
      merchant: dto.merchant,
      provider: dto.provider,
      method: dto.method,
      country: dto.country,
      issuingBank: dto.issuingBank,
      failureReason: dto.failureReason,
    }) as Prisma.TransactionWhereInput;

    const [current, baseline] = await Promise.all([
      this.transactions.aggregateBy(by, currentStart, now, filters),
      this.transactions.aggregateBy(by, baselineStart, currentStart, filters),
    ]);

    const baselineIndex = new Map(baseline.map((slice) => [JSON.stringify(slice.dimensions), slice]));

    const rows = current
      .filter((slice) => slice.attempts >= minSampleSize)
      .map((slice) => {
        const previous = baselineIndex.get(JSON.stringify(slice.dimensions));
        const currentRate = approvalRate(slice.approved, slice.attempts);
        const baselineRate = previous ? approvalRate(previous.approved, previous.attempts) : 0;
        const baselineAttempts = previous?.attempts ?? 0;
        return {
          dimensions: slice.dimensions,
          attempts: slice.attempts,
          approved: slice.approved,
          approvalRate: round(currentRate),
          baselineRate: round(baselineRate),
          baselineAttempts,
          hasBaseline: baselineAttempts > 0,
          drop: round(Math.max(0, baselineRate - currentRate)),
          volumeUsdCents: slice.amountUsdCents,
        };
      })
      .sort((a, b) => b.drop - a.drop);

    return {
      config: { groupBy, windowMinutes, baselineHours, minSampleSize },
      windows: {
        baseline: { from: baselineStart, to: currentStart },
        current: { from: currentStart, to: now },
      },
      rows,
    };
  }

  /** Distribucion de motivos solamente entre transacciones DECLINED. */
  async declineReasonBreakdown(dto: DeclineReasonBreakdownDto) {
    const windowMinutes = dto.timeWindowMinutes ?? 60;
    const baselineHours = dto.baselineHours ?? 24;
    const minSampleSize = dto.minSampleSize ?? 1;
    const now = new Date();
    const currentStart = new Date(now.getTime() - windowMinutes * 60_000);
    const baselineStart = new Date(currentStart.getTime() - baselineHours * 3_600_000);
    const filters = toWhere({
      merchant: dto.merchant,
      provider: dto.provider,
      method: dto.method,
      country: dto.country,
      issuingBank: dto.issuingBank,
    }) as Prisma.TransactionWhereInput;

    const [currentTransactions, baselineTransactions] = await Promise.all([
      this.transactions.findWindow(currentStart, now, filters),
      this.transactions.findWindow(baselineStart, currentStart, filters),
    ]);
    const current = declineReasonCounts(currentTransactions);
    const baseline = declineReasonCounts(baselineTransactions);
    const failureReasons = new Set([...current.counts.keys(), ...baseline.counts.keys()]);

    const rows = [...failureReasons]
      .map((failureReason) => {
        const currentDeclines = current.counts.get(failureReason) ?? 0;
        const baselineDeclines = baseline.counts.get(failureReason) ?? 0;
        const currentShare = current.total > 0 ? currentDeclines / current.total : 0;
        const baselineShare = baseline.total > 0 ? baselineDeclines / baseline.total : 0;
        return {
          failureReason,
          currentDeclines,
          currentShare: round(currentShare),
          baselineDeclines,
          baselineShare: round(baselineShare),
          shareDelta: round(currentShare - baselineShare),
          hasBaseline: baselineDeclines > 0,
        };
      })
      .filter((row) => row.currentDeclines >= minSampleSize)
      .sort((a, b) => b.shareDelta - a.shareDelta);

    return {
      config: { windowMinutes, baselineHours, minSampleSize },
      windows: {
        baseline: { from: baselineStart, to: currentStart },
        current: { from: currentStart, to: now },
      },
      totals: {
        currentDeclines: current.total,
        baselineDeclines: baseline.total,
      },
      rows,
    };
  }

  /** Serie temporal para las graficas. */
  async timeseries(minutes = 120, bucketMinutes = 5, dimensions: Record<string, string | undefined> = {}) {
    const now = new Date();
    const from = new Date(now.getTime() - minutes * 60_000);
    const rows = await this.transactions.findWindow(from, now, toWhere(dimensions) as Prisma.TransactionWhereInput);

    const buckets = new Map<number, { attempts: number; approved: number; latencies: number[] }>();
    const size = bucketMinutes * 60_000;

    for (const row of rows) {
      const slot = Math.floor(row.occurredAt.getTime() / size) * size;
      const bucket = buckets.get(slot) ?? { attempts: 0, approved: 0, latencies: [] };
      bucket.attempts += 1;
      if (row.status === 'APPROVED') bucket.approved += 1;
      if (row.latencyMs !== null) bucket.latencies.push(row.latencyMs);
      buckets.set(slot, bucket);
    }

    return {
      window: { from, to: now, bucketMinutes },
      points: [...buckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([slot, bucket]) => ({
          bucketStart: new Date(slot),
          attempts: bucket.attempts,
          approved: bucket.approved,
          approvalRate: round(approvalRate(bucket.approved, bucket.attempts)),
          p95LatencyMs: percentile(bucket.latencies.sort((a, b) => a - b), 0.95),
        })),
    };
  }
}

function declineReasonCounts(
  transactions: Array<{ status: string; failureReason: string | null }>,
) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const transaction of transactions) {
    if (transaction.status !== 'DECLINED' || transaction.failureReason === null) continue;
    total += 1;
    counts.set(transaction.failureReason, (counts.get(transaction.failureReason) ?? 0) + 1);
  }
  return { counts, total };
}
