import { Injectable, Logger } from '@nestjs/common';
import {
  DIMENSIONS,
  buildDimensionKey,
  buildSegmentKey,
  combinations,
  type Dimension,
  type DimensionMap,
} from '../../common/dimensions.js';
import { approvalRate, round, stddev } from '../../common/stats.js';
import { TransactionsRepository } from '../transactions/transactions.repository.js';
import { BaselinesRepository, type BaselineUpsert } from './baselines.repository.js';

export type BaselineLookup = {
  expectedRate: number;
  variance: number;
  sampleSize: number;
  source: 'segment_hour' | 'segment_global' | 'none';
};

type Bucket = { attempts: number; approved: number };

@Injectable()
export class BaselinesService {
  private readonly logger = new Logger(BaselinesService.name);

  constructor(
    private readonly repository: BaselinesRepository,
    private readonly transactions: TransactionsRepository,
  ) {}

  /**
   * Recalcula los baselines desde el historico.
   *
   * Segmenta por hora del dia y dia de la semana porque la conversion
   * legitimamente cambia entre un martes a mediodia y un domingo a las 3am.
   * Sin esa segmentacion, cualquier incidente nocturno es una falsa alarma.
   */
  async rebuild(options: { lookbackHours?: number; maxDepth?: number; excludeLastMinutes?: number } = {}) {
    const lookbackHours = options.lookbackHours ?? 24 * 14;
    const maxDepth = Math.min(options.maxDepth ?? 2, DIMENSIONS.length);
    const excludeLastMinutes = options.excludeLastMinutes ?? 60;

    const to = new Date(Date.now() - excludeLastMinutes * 60_000);
    const from = new Date(to.getTime() - lookbackHours * 3_600_000);

    const transactions = await this.transactions.findWindow(from, to);
    if (transactions.length === 0) {
      await this.repository.replaceAll([]);
      return { rebuilt: 0, transactions: 0, from, to };
    }

    // segmentKey -> "hour:dow" -> conteos
    const index = new Map<string, { dimensionKey: string; segment: DimensionMap; slots: Map<string, Bucket> }>();

    for (let depth = 1; depth <= maxDepth; depth++) {
      for (const combo of combinations(DIMENSIONS, depth)) {
        for (const tx of transactions) {
          const segment = pick(tx, combo);
          if (segment === null) continue;

          const segmentKey = buildSegmentKey(segment);
          let entry = index.get(segmentKey);
          if (!entry) {
            entry = { dimensionKey: buildDimensionKey(segment), segment, slots: new Map() };
            index.set(segmentKey, entry);
          }

          const slotKey = `${tx.occurredAt.getUTCHours()}:${tx.occurredAt.getUTCDay()}`;
          const bucket = entry.slots.get(slotKey) ?? { attempts: 0, approved: 0 };
          bucket.attempts += 1;
          if (tx.status === 'APPROVED') bucket.approved += 1;
          entry.slots.set(slotKey, bucket);
        }
      }
    }

    const rows: BaselineUpsert[] = [];
    for (const [segmentKey, entry] of index) {
      const rates = [...entry.slots.values()]
        .filter((bucket) => bucket.attempts > 0)
        .map((bucket) => approvalRate(bucket.approved, bucket.attempts));
      const spread = stddev(rates);

      for (const [slotKey, bucket] of entry.slots) {
        const [hour, dow] = slotKey.split(':').map(Number);
        rows.push({
          dimensionKey: entry.dimensionKey,
          segmentKey,
          segment: entry.segment as never,
          hourOfDay: hour ?? 0,
          dayOfWeek: dow ?? 0,
          expectedRate: round(approvalRate(bucket.approved, bucket.attempts)),
          variance: round(spread),
          sampleSize: bucket.attempts,
        });
      }
    }

    const written = await this.repository.replaceAll(rows);
    this.logger.log(`Baselines reconstruidos: ${written} filas desde ${transactions.length} transacciones`);
    return { rebuilt: written, transactions: transactions.length, from, to };
  }

  /**
   * Baseline aplicable a un segmento en un instante dado, con degradacion:
   * franja exacta -> promedio del segmento -> nada.
   *
   * El fallback importa: los jueces pueden inyectar el incidente en una
   * franja horaria para la que no hay historico.
   */
  async lookup(segmentKey: string, at: Date): Promise<BaselineLookup> {
    const rows = await this.repository.findBySegment(segmentKey);
    if (rows.length === 0) {
      return { expectedRate: 0, variance: 0, sampleSize: 0, source: 'none' };
    }

    const hour = at.getUTCHours();
    const dow = at.getUTCDay();
    const exact = rows.find((row) => row.hourOfDay === hour && row.dayOfWeek === dow);
    if (exact && exact.sampleSize > 0) {
      return {
        expectedRate: exact.expectedRate,
        variance: exact.variance,
        sampleSize: exact.sampleSize,
        source: 'segment_hour',
      };
    }

    const attempts = rows.reduce((sum, row) => sum + row.sampleSize, 0);
    const weighted = rows.reduce((sum, row) => sum + row.expectedRate * row.sampleSize, 0);
    return {
      expectedRate: attempts > 0 ? round(weighted / attempts) : 0,
      variance: round(stddev(rows.map((row) => row.expectedRate))),
      sampleSize: attempts,
      source: 'segment_global',
    };
  }

  /** Precarga en memoria para no hacer N consultas dentro del detector. */
  async lookupMany(segmentKeys: string[], at: Date): Promise<Map<string, BaselineLookup>> {
    const rows = await this.repository.findForSegments(segmentKeys);
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = grouped.get(row.segmentKey) ?? [];
      bucket.push(row);
      grouped.set(row.segmentKey, bucket);
    }

    const hour = at.getUTCHours();
    const dow = at.getUTCDay();
    const out = new Map<string, BaselineLookup>();

    for (const segmentKey of segmentKeys) {
      const bucket = grouped.get(segmentKey);
      if (!bucket || bucket.length === 0) {
        out.set(segmentKey, { expectedRate: 0, variance: 0, sampleSize: 0, source: 'none' });
        continue;
      }
      const exact = bucket.find((row) => row.hourOfDay === hour && row.dayOfWeek === dow);
      if (exact && exact.sampleSize > 0) {
        out.set(segmentKey, {
          expectedRate: exact.expectedRate,
          variance: exact.variance,
          sampleSize: exact.sampleSize,
          source: 'segment_hour',
        });
        continue;
      }
      const attempts = bucket.reduce((sum, row) => sum + row.sampleSize, 0);
      const weighted = bucket.reduce((sum, row) => sum + row.expectedRate * row.sampleSize, 0);
      out.set(segmentKey, {
        expectedRate: attempts > 0 ? round(weighted / attempts) : 0,
        variance: round(stddev(bucket.map((row) => row.expectedRate))),
        sampleSize: attempts,
        source: 'segment_global',
      });
    }

    return out;
  }

  count() {
    return this.repository.count();
  }

  list(dimensionKey?: string) {
    return this.repository.findMany(dimensionKey);
  }
}

function pick(tx: Record<string, unknown>, combo: Dimension[]): DimensionMap | null {
  const segment: DimensionMap = {};
  for (const dimension of combo) {
    const value = tx[dimension];
    if (value === null || value === undefined || value === '') return null;
    segment[dimension] = String(value);
  }
  return segment;
}
