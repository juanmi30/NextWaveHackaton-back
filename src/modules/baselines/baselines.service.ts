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
  source:
    | 'segment_hour'
    | 'segment_hour_of_day'
    | 'segment_global'
    | 'ancestor_hour'
    | 'ancestor_hour_of_day'
    | 'ancestor_global'
    | 'platform_hour'
    | 'platform_hour_of_day'
    | 'platform_global'
    | 'none';
  matchedSegmentKey: string | null;
  matchedDimensions: DimensionMap;
  fallbackDepth: number;
};

type Bucket = { attempts: number; approved: number };
type BaselineRow = {
  segmentKey: string;
  hourOfDay: number;
  dayOfWeek: number;
  expectedRate: number;
  variance: number;
  sampleSize: number;
};

export const GLOBAL_BASELINE_KEY = '__GLOBAL__';

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

    index.set(GLOBAL_BASELINE_KEY, {
      dimensionKey: GLOBAL_BASELINE_KEY,
      segment: {},
      slots: new Map(),
    });
    for (const tx of transactions) addToBucket(index.get(GLOBAL_BASELINE_KEY)!, tx);

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

          addToBucket(entry, tx);
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
    return resolveTemporalBaseline(rows, at, 1, 'segment', segmentKey, {}, 0) ?? noneBaseline();
  }

  /** Precarga en memoria para no hacer N consultas dentro del detector. */
  async lookupMany(
    segments: DimensionMap[] | string[],
    at: Date,
    minSampleSize = 1,
  ): Promise<Map<string, BaselineLookup>> {
    const paths = new Map<string, ReturnType<typeof baselinePath>>();
    const keys = new Set<string>();
    for (const segment of segments) {
      const segmentKey = typeof segment === 'string' ? segment : buildSegmentKey(segment);
      const path =
        typeof segment === 'string'
          ? [
              {
                kind: 'segment' as const,
                segmentKey,
                dimensions: {},
                fallbackDepth: 0,
              },
            ]
          : baselinePath(segment);
      paths.set(segmentKey, path);
      for (const candidate of path) keys.add(candidate.segmentKey);
    }

    const rows = await this.repository.findForSegments([...keys]);
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = grouped.get(row.segmentKey) ?? [];
      bucket.push(row);
      grouped.set(row.segmentKey, bucket);
    }

    const out = new Map<string, BaselineLookup>();

    for (const [segmentKey, path] of paths) {
      let match: BaselineLookup | null = null;
      for (const candidate of path) {
        match = resolveTemporalBaseline(
          grouped.get(candidate.segmentKey) ?? [],
          at,
          minSampleSize,
          candidate.kind,
          candidate.segmentKey,
          candidate.dimensions,
          candidate.fallbackDepth,
        );
        if (match) break;
      }
      out.set(segmentKey, match ?? noneBaseline());
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

function addToBucket(
  entry: { slots: Map<string, Bucket> },
  tx: { occurredAt: Date; status: string },
) {
  const slotKey = `${tx.occurredAt.getUTCHours()}:${tx.occurredAt.getUTCDay()}`;
  const bucket = entry.slots.get(slotKey) ?? { attempts: 0, approved: 0 };
  bucket.attempts += 1;
  if (tx.status === 'APPROVED') bucket.approved += 1;
  entry.slots.set(slotKey, bucket);
}

function baselinePath(segment: DimensionMap) {
  const dimensions = Object.keys(segment) as Dimension[];
  const targetDepth = dimensions.length;
  const path: Array<{
    kind: 'segment' | 'ancestor' | 'platform';
    segmentKey: string;
    dimensions: DimensionMap;
    fallbackDepth: number;
  }> = [
    {
      kind: 'segment',
      segmentKey: buildSegmentKey(segment),
      dimensions: segment,
      fallbackDepth: 0,
    },
  ];

  for (let depth = targetDepth - 1; depth >= 1; depth--) {
    const ancestors = combinations(dimensions, depth)
      .map((combo) => {
        const dimensions = Object.fromEntries(combo.map((key) => [key, segment[key]])) as DimensionMap;
        return { dimensions, segmentKey: buildSegmentKey(dimensions) };
      })
      .sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));
    for (const ancestor of ancestors) {
      path.push({
        kind: 'ancestor',
        ...ancestor,
        fallbackDepth: targetDepth - depth,
      });
    }
  }

  path.push({
    kind: 'platform',
    segmentKey: GLOBAL_BASELINE_KEY,
    dimensions: {},
    fallbackDepth: targetDepth,
  });
  return path;
}

export function resolveTemporalBaseline(
  rows: BaselineRow[],
  at: Date,
  minSampleSize: number,
  kind: 'segment' | 'ancestor' | 'platform',
  matchedSegmentKey: string,
  matchedDimensions: DimensionMap,
  fallbackDepth: number,
): BaselineLookup | null {
  const hour = at.getUTCHours();
  const dow = at.getUTCDay();
  const exact = rows.find(
    (row) => row.hourOfDay === hour && row.dayOfWeek === dow && row.sampleSize >= minSampleSize,
  );
  if (exact) {
    return lookupFromRows(
      [exact],
      `${kind === 'segment' ? 'segment' : kind}_hour` as BaselineLookup['source'],
      matchedSegmentKey,
      matchedDimensions,
      fallbackDepth,
    );
  }

  const sameHour = rows.filter((row) => row.hourOfDay === hour);
  if (sameHour.reduce((sum, row) => sum + row.sampleSize, 0) >= minSampleSize) {
    return lookupFromRows(
      sameHour,
      `${kind === 'segment' ? 'segment' : kind}_hour_of_day` as BaselineLookup['source'],
      matchedSegmentKey,
      matchedDimensions,
      fallbackDepth,
    );
  }

  if (rows.reduce((sum, row) => sum + row.sampleSize, 0) >= minSampleSize) {
    return lookupFromRows(
      rows,
      `${kind === 'segment' ? 'segment' : kind}_global` as BaselineLookup['source'],
      matchedSegmentKey,
      matchedDimensions,
      fallbackDepth,
    );
  }
  return null;
}

function lookupFromRows(
  rows: BaselineRow[],
  source: BaselineLookup['source'],
  matchedSegmentKey: string,
  matchedDimensions: DimensionMap,
  fallbackDepth: number,
): BaselineLookup {
  const sampleSize = rows.reduce((sum, row) => sum + row.sampleSize, 0);
  const weighted = rows.reduce((sum, row) => sum + row.expectedRate * row.sampleSize, 0);
  return {
    expectedRate: sampleSize > 0 ? round(weighted / sampleSize) : 0,
    variance: rows.length === 1 ? rows[0]!.variance : round(stddev(rows.map((row) => row.expectedRate))),
    sampleSize,
    source,
    matchedSegmentKey,
    matchedDimensions,
    fallbackDepth,
  };
}

function noneBaseline(): BaselineLookup {
  return {
    expectedRate: 0,
    variance: 0,
    sampleSize: 0,
    source: 'none',
    matchedSegmentKey: null,
    matchedDimensions: {},
    fallbackDepth: 0,
  };
}
