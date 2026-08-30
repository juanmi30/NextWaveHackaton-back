import { describe, expect, it, vi } from 'vitest';
import type { DimensionMap } from '../../common/dimensions.js';
import type { TransactionsRepository } from '../transactions/transactions.repository.js';
import type { BaselinesRepository } from './baselines.repository.js';
import { BaselinesService, GLOBAL_BASELINE_KEY } from './baselines.service.js';

type TestRow = {
  segmentKey: string;
  hourOfDay: number;
  dayOfWeek: number;
  expectedRate: number;
  variance: number;
  sampleSize: number;
};

function serviceWithRows(rows: TestRow[]) {
  const repository = {
    findForSegments: vi.fn(async (keys: string[]) => rows.filter((row) => keys.includes(row.segmentKey))),
  };
  return new BaselinesService(
    repository as unknown as BaselinesRepository,
    {} as TransactionsRepository,
  );
}

describe('BaselinesService hierarchical lookup', () => {
  const at = new Date('2026-08-29T15:00:00.000Z');

  it('falls back to the most specific ancestor with sufficient samples', async () => {
    const service = serviceWithRows([
      {
        segmentKey: 'country=BR|provider=Adyen',
        hourOfDay: 15,
        dayOfWeek: 6,
        expectedRate: 0.91,
        variance: 0.02,
        sampleSize: 80,
      },
      {
        segmentKey: GLOBAL_BASELINE_KEY,
        hourOfDay: 15,
        dayOfWeek: 6,
        expectedRate: 0.9,
        variance: 0.03,
        sampleSize: 500,
      },
    ]);
    const dimensions: DimensionMap = {
      provider: 'Adyen',
      country: 'BR',
      issuingBank: 'BancoJudgeUnseen',
    };

    const result = await service.lookupMany([dimensions], at, 20);

    expect(result.get('country=BR|issuingBank=BancoJudgeUnseen|provider=Adyen')).toMatchObject({
      source: 'ancestor_hour',
      matchedSegmentKey: 'country=BR|provider=Adyen',
      matchedDimensions: { country: 'BR', provider: 'Adyen' },
      fallbackDepth: 1,
    });
  });

  it('uses the same hour across historical days before the segment global average', async () => {
    const service = serviceWithRows([
      { segmentKey: 'provider=Adyen', hourOfDay: 15, dayOfWeek: 4, expectedRate: 0.9, variance: 0.02, sampleSize: 15 },
      { segmentKey: 'provider=Adyen', hourOfDay: 15, dayOfWeek: 5, expectedRate: 0.92, variance: 0.02, sampleSize: 15 },
      { segmentKey: 'provider=Adyen', hourOfDay: 14, dayOfWeek: 6, expectedRate: 0.8, variance: 0.02, sampleSize: 100 },
    ]);

    const result = await service.lookupMany([{ provider: 'Adyen' }], at, 20);

    expect(result.get('provider=Adyen')).toMatchObject({
      source: 'segment_hour_of_day',
      expectedRate: 0.91,
      sampleSize: 30,
    });
  });

  it('uses the platform baseline only as the last fallback', async () => {
    const service = serviceWithRows([
      { segmentKey: GLOBAL_BASELINE_KEY, hourOfDay: 15, dayOfWeek: 6, expectedRate: 0.9, variance: 0.03, sampleSize: 500 },
    ]);

    const result = await service.lookupMany([{ issuingBank: 'EntirelyNewBank' }], at, 20);

    expect(result.get('issuingBank=EntirelyNewBank')).toMatchObject({
      source: 'platform_hour',
      matchedSegmentKey: GLOBAL_BASELINE_KEY,
      matchedDimensions: {},
    });
  });

  it('writes platform baseline rows during rebuild', async () => {
    const replaceAll = vi.fn(async (rows: unknown[]) => rows.length);
    const repository = { replaceAll };
    const transactions = {
      findWindow: vi.fn().mockResolvedValue([
        { provider: 'Adyen', occurredAt: at, status: 'APPROVED' },
        { provider: 'Stripe', occurredAt: at, status: 'DECLINED' },
      ]),
    };
    const service = new BaselinesService(
      repository as unknown as BaselinesRepository,
      transactions as unknown as TransactionsRepository,
    );

    await service.rebuild({ lookbackHours: 1, maxDepth: 1, excludeLastMinutes: 0 });

    expect(replaceAll.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ segmentKey: GLOBAL_BASELINE_KEY, sampleSize: 2 })]),
    );
  });
});
