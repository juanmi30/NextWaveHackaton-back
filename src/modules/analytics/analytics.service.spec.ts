import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from './analytics.service.js';
import type { TransactionsRepository } from '../transactions/transactions.repository.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { DetectionRepository } from '../detection/detection.repository.js';
import type { Dimension } from '../../common/dimensions.js';

type TestTransaction = { status: string; failureReason: string | null };

function createService(current: TestTransaction[], baseline: TestTransaction[]) {
  const findWindow = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(baseline);
  const service = new AnalyticsService(
    { findWindow } as unknown as TransactionsRepository,
    {} as IncidentsService,
    {} as DetectionRepository,
  );
  return service;
}

describe('AnalyticsService.declineReasonBreakdown', () => {
  it('calculates current and baseline decline shares and their delta', async () => {
    const service = createService(
      [
        { status: 'DECLINED', failureReason: 'DO_NOT_HONOR' },
        { status: 'DECLINED', failureReason: 'DO_NOT_HONOR' },
        { status: 'DECLINED', failureReason: 'EXPIRED_CARD' },
      ],
      [
        { status: 'DECLINED', failureReason: 'DO_NOT_HONOR' },
        { status: 'DECLINED', failureReason: 'EXPIRED_CARD' },
        { status: 'DECLINED', failureReason: 'EXPIRED_CARD' },
        { status: 'DECLINED', failureReason: 'EXPIRED_CARD' },
      ],
    );

    const result = await service.declineReasonBreakdown({ minSampleSize: 1 });
    const row = result.rows.find((item) => item.failureReason === 'DO_NOT_HONOR');

    expect(row).toMatchObject({
      currentDeclines: 2,
      currentShare: 0.6667,
      baselineDeclines: 1,
      baselineShare: 0.25,
      shareDelta: 0.4167,
      hasBaseline: true,
    });
  });

  it('excludes approved transactions and null reasons from the denominator', async () => {
    const service = createService(
      [
        { status: 'DECLINED', failureReason: 'DO_NOT_HONOR' },
        { status: 'APPROVED', failureReason: 'DO_NOT_HONOR' },
        { status: 'DECLINED', failureReason: null },
      ],
      [],
    );

    const result = await service.declineReasonBreakdown({ minSampleSize: 1 });

    expect(result.totals.currentDeclines).toBe(1);
    expect(result.rows[0]?.currentShare).toBe(1);
  });

  it('marks a reason without historical declines as having no baseline', async () => {
    const service = createService(
      [{ status: 'DECLINED', failureReason: 'NEW_REASON' }],
      [{ status: 'DECLINED', failureReason: 'DO_NOT_HONOR' }],
    );

    const result = await service.declineReasonBreakdown({ minSampleSize: 1 });
    const row = result.rows.find((item) => item.failureReason === 'NEW_REASON');

    expect(row).toMatchObject({
      baselineDeclines: 0,
      baselineShare: 0,
      hasBaseline: false,
    });
  });
});

describe('AnalyticsService analysis windows', () => {
  function createBreakdownService(aggregateBy = vi.fn().mockResolvedValue([])) {
    return {
      aggregateBy,
      service: new AnalyticsService(
        { aggregateBy } as unknown as TransactionsRepository,
        {} as IncidentsService,
        {} as DetectionRepository,
      ),
    };
  }

  it('returns identical windows for a fixed asOf regardless of the current clock', async () => {
    vi.useFakeTimers();
    try {
      const { service } = createBreakdownService();
      const asOf = '2026-08-01T12:00:00.000Z';

      vi.setSystemTime(new Date('2026-08-10T00:00:00.000Z'));
      const first = await service.breakdown({ asOf, minSampleSize: 1 });
      vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
      const second = await service.breakdown({ asOf, minSampleSize: 1 });

      expect(first).toEqual(second);
      expect(first.windows.current).toEqual({
        from: new Date('2026-08-01T11:00:00.000Z'),
        to: new Date(asOf),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('groups a route independently of failureReason', async () => {
    const transactions = [
      {
        merchant: 'Mercado Uno',
        provider: 'Adyen',
        method: 'CARD',
        country: 'BR',
        issuingBank: 'Bradesco',
        failureReason: 'DO_NOT_HONOR',
        status: 'DECLINED',
      },
      {
        merchant: 'Mercado Uno',
        provider: 'Adyen',
        method: 'CARD',
        country: 'BR',
        issuingBank: 'Bradesco',
        failureReason: 'INSUFFICIENT_FUNDS',
        status: 'DECLINED',
      },
    ];
    const aggregateBy = vi.fn(async (by: Dimension[]) => {
      const groups = new Map<string, Record<string, string>>();
      for (const transaction of transactions) {
        const dimensions = Object.fromEntries(by.map((key) => [key, transaction[key]]));
        groups.set(JSON.stringify(dimensions), dimensions);
      }
      return [...groups.values()].map((dimensions) => ({
        dimensions,
        attempts: transactions.length,
        approved: 0,
        amountUsdCents: 2_000,
      }));
    });
    const { service } = createBreakdownService(aggregateBy);

    const result = await service.breakdown({ groupBy: 'route', minSampleSize: 1 });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.dimensions).not.toHaveProperty('failureReason');
    expect(aggregateBy.mock.calls[0]?.[0]).toEqual([
      'merchant',
      'provider',
      'method',
      'country',
      'issuingBank',
    ]);
  });

  it('uses the current time when asOf is omitted', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-08-29T15:30:00.000Z');
      vi.setSystemTime(now);
      const { service } = createBreakdownService();

      const result = await service.breakdown({ minSampleSize: 1 });

      expect(result.windows.current.to).toEqual(now);
    } finally {
      vi.useRealTimers();
    }
  });
});
