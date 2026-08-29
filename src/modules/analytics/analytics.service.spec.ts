import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from './analytics.service.js';
import type { TransactionsRepository } from '../transactions/transactions.repository.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { DetectionRepository } from '../detection/detection.repository.js';

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
