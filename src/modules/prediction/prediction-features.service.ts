import {
  Injectable,
} from '@nestjs/common';

import type { DimensionMap } from '../../common/dimensions.js';
import {
  approvalRate,
  percentile,
} from '../../common/stats.js';

import {
  TransactionsRepository,
  toWhere,
} from '../transactions/transactions.repository.js';

import type { EvaluatePredictionDto } from './dto/evaluate-prediction.dto.js';
import type { EvaluateSegmentDto } from './dto/evaluate-segment.dto.js';

const BUCKET_MINUTES = 5;
const BUCKET_COUNT = 3;

const BASELINE_HOURS = 24;

const MIN_CURRENT_ATTEMPTS = 10;
const MIN_BASELINE_ATTEMPTS = 50;

export interface FeatureEvidence {
  currentAttempts: number;
  baselineAttempts: number;

  bucketAttempts: number[];

  sufficientEvidence: boolean;

  reason?: string;
}

export interface ExtractedFeatures {
  segment: DimensionMap;

  window: {
    from: Date;
    to: Date;
    bucketMinutes: number;
  };

  baselineWindow: {
    from: Date;
    to: Date;
    hours: number;
  };

  modelInput: EvaluatePredictionDto;

  evidence: FeatureEvidence;
}

interface BucketMetrics {
  attempts: number;

  approvalRate: number;
  timeoutRate: number;
  errorRate: number;

  p95LatencyMs: number;
}

@Injectable()
export class PredictionFeaturesService {
  constructor(
    private readonly transactions: TransactionsRepository,
  ) {}

  async extract(
    dto: EvaluateSegmentDto,
  ): Promise<ExtractedFeatures> {
    const now = new Date();

    const recentMinutes =
      BUCKET_MINUTES * BUCKET_COUNT;

    const recentStart = new Date(
      now.getTime() -
        recentMinutes * 60_000,
    );

    const baselineEnd = recentStart;

    const baselineStart = new Date(
      baselineEnd.getTime() -
        BASELINE_HOURS * 3_600_000,
    );

    const segment: DimensionMap = {
      merchant: dto.merchant,
      provider: dto.provider,
      method: dto.method,
      country: dto.country,
      issuingBank: dto.issuingBank,
    };

    const where = toWhere(segment);

    const [
      recentTransactions,
      baselineTotals,
    ] = await Promise.all([
      this.transactions.findWindow(
        recentStart,
        now,
        where,
      ),

      this.transactions.totals(
        baselineStart,
        baselineEnd,
        where,
      ),
    ]);

    const buckets: BucketMetrics[] = [];

    for (
      let index = 0;
      index < BUCKET_COUNT;
      index++
    ) {
      const from = new Date(
        recentStart.getTime() +
          index *
            BUCKET_MINUTES *
            60_000,
      );

      const to = new Date(
        from.getTime() +
          BUCKET_MINUTES *
            60_000,
      );

      const rows =
        recentTransactions.filter(
          (transaction) =>
            transaction.occurredAt >= from &&
            transaction.occurredAt < to,
        );

      buckets.push(
        this.aggregateBucket(rows),
      );
    }

    const oldest = buckets[0];
    const current =
      buckets[buckets.length - 1];

    const baselineApprovalRate =
      approvalRate(
        baselineTotals.approved,
        baselineTotals.attempts,
      );

    const approvalDrop = Math.max(
      0,
      baselineApprovalRate -
        current.approvalRate,
    );

    /*
     * El generador de entrenamiento calcula
     * la pendiente entre t y t-2 dividida
     * entre dos pasos.
     *
     * Como cada paso son 5 minutos,
     * aquí reproducimos exactamente
     * la misma definición.
     */
    const approvalSlope =
      (
        current.approvalRate -
        oldest.approvalRate
      ) / 2;

    const timeoutSlope =
      (
        current.timeoutRate -
        oldest.timeoutRate
      ) / 2;

    const latencySlope =
      (
        current.p95LatencyMs -
        oldest.p95LatencyMs
      ) / 2;

    const modelInput: EvaluatePredictionDto = {
      baselineApprovalRate,
      approvalDrop,
      approvalSlope,

      timeoutRate:
        current.timeoutRate,

      timeoutSlope,

      errorRate:
        current.errorRate,

      p95LatencyMs:
        current.p95LatencyMs,

      latencySlope,
    };

    const evidence =
      this.evaluateEvidence(
        buckets,
        baselineTotals.attempts,
      );

    return {
      segment,

      window: {
        from: recentStart,
        to: now,
        bucketMinutes: BUCKET_MINUTES,
      },

      baselineWindow: {
        from: baselineStart,
        to: baselineEnd,
        hours: BASELINE_HOURS,
      },

      modelInput,

      evidence,
    };
  }

  private aggregateBucket(
    transactions: Array<{
      status: string;
      latencyMs: number | null;
    }>,
  ): BucketMetrics {
    const attempts =
      transactions.length;

    if (attempts === 0) {
      return {
        attempts: 0,
        approvalRate: 0,
        timeoutRate: 0,
        errorRate: 0,
        p95LatencyMs: 0,
      };
    }

    let approved = 0;
    let timeouts = 0;
    let errors = 0;

    const latencies: number[] = [];

    for (const transaction of transactions) {
      if (
        transaction.status ===
        'APPROVED'
      ) {
        approved++;
      }

      if (
        transaction.status ===
        'TIMEOUT'
      ) {
        timeouts++;
      }

      if (
        transaction.status ===
        'ERROR'
      ) {
        errors++;
      }

      if (
        transaction.latencyMs !== null
      ) {
        latencies.push(
          transaction.latencyMs,
        );
      }
    }

    latencies.sort(
      (a, b) => a - b,
    );

    return {
      attempts,

      approvalRate:
        approved / attempts,

      timeoutRate:
        timeouts / attempts,

      errorRate:
        errors / attempts,

      p95LatencyMs:
        percentile(
          latencies,
          0.95,
        ) ?? 0,
    };
  }

  private evaluateEvidence(
    buckets: BucketMetrics[],
    baselineAttempts: number,
  ): FeatureEvidence {
    const current =
      buckets[buckets.length - 1];

    const bucketAttempts =
      buckets.map(
        (bucket) =>
          bucket.attempts,
      );

    if (
      baselineAttempts <
      MIN_BASELINE_ATTEMPTS
    ) {
      return {
        currentAttempts:
          current.attempts,

        baselineAttempts,

        bucketAttempts,

        sufficientEvidence: false,

        reason:
          'INSUFFICIENT_BASELINE',
      };
    }

    if (
      current.attempts <
      MIN_CURRENT_ATTEMPTS
    ) {
      return {
        currentAttempts:
          current.attempts,

        baselineAttempts,

        bucketAttempts,

        sufficientEvidence: false,

        reason:
          'INSUFFICIENT_CURRENT_SAMPLE',
      };
    }

    if (
      buckets.some(
        (bucket) =>
          bucket.attempts === 0,
      )
    ) {
      return {
        currentAttempts:
          current.attempts,

        baselineAttempts,

        bucketAttempts,

        sufficientEvidence: false,

        reason:
          'INSUFFICIENT_TIME_SERIES',
      };
    }

    return {
      currentAttempts:
        current.attempts,

      baselineAttempts,

      bucketAttempts,

      sufficientEvidence: true,
    };
  }
}