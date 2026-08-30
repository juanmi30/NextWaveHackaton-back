import { describe, expect, it, vi } from 'vitest';
import type { TransactionsRepository } from '../transactions/transactions.repository.js';
import type { LiveDegradation } from './live-monitoring.types.js';
import {
  LiveTransactionGeneratorService,
  matchesDimensions,
  selectDegradation,
} from './live-transaction-generator.service.js';

function degradation(
  id: string,
  dimensions: LiveDegradation['dimensions'],
  approvalRate: number,
): LiveDegradation {
  return {
    id,
    dimensions,
    approvalRate,
    failureReason: 'DO_NOT_HONOR',
    targetTransactionsPerTick: 2,
    startedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-30T00:00:00.000Z',
    status: 'ACTIVE',
  };
}

function setup() {
  const createMany = vi.fn(async (rows: unknown[]) => ({ count: rows.length }));
  const generator = new LiveTransactionGeneratorService({ createMany } as unknown as TransactionsRepository);
  generator.reset(42);
  return { generator, createMany };
}

describe('LiveTransactionGeneratorService', () => {
  it('generates one batch using createMany and stable-but-variable normal traffic', async () => {
    const { generator, createMany } = setup();
    const first = await generator.generate(100, []);
    const second = await generator.generate(100, []);

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(first.generated).toBe(100);
    expect(first.approved).toBeGreaterThan(80);
    expect(first.approved).toBeLessThan(100);
    expect(second.approved).not.toBe(first.approved);
  });

  it('matches complete and partial dimensions as wildcards', () => {
    const transaction = { provider: 'Adyen', country: 'BR', method: 'CARD' };
    expect(matchesDimensions(transaction, { provider: 'Adyen' })).toBe(true);
    expect(matchesDimensions(transaction, { provider: 'Adyen', country: 'MX' })).toBe(false);
  });

  it('selects the most specific overlapping degradation', () => {
    const broad = degradation('broad', { provider: 'Adyen' }, 0.1);
    const specific = degradation('specific', { provider: 'Adyen', country: 'BR' }, 0.4);
    expect(selectDegradation({ provider: 'Adyen', country: 'BR' }, [broad, specific])?.id).toBe(
      'specific',
    );
  });

  it('selects the lowest approval rate at equal specificity', () => {
    const first = degradation('first', { provider: 'Adyen' }, 0.4);
    const lower = degradation('lower', { provider: 'Adyen' }, 0.2);
    expect(selectDegradation({ provider: 'Adyen' }, [first, lower])?.id).toBe('lower');
  });

  it('supports multiple simultaneous degradations without applying one transaction twice', () => {
    const br = degradation('br', { provider: 'Adyen', country: 'BR' }, 0.3);
    const mx = degradation('mx', { provider: 'Stripe', country: 'MX' }, 0.4);
    expect(selectDegradation({ provider: 'Adyen', country: 'BR' }, [br, mx])?.id).toBe('br');
    expect(selectDegradation({ provider: 'Stripe', country: 'MX' }, [br, mx])?.id).toBe('mx');
  });

  it('generates directed traffic for an unseen trial-by-fire target', async () => {
    const { generator, createMany } = setup();
    const unseen = degradation(
      'unseen',
      {
        merchant: 'PagoTotal Retail',
        provider: 'Adyen',
        method: 'CARD',
        country: 'BR',
        issuingBank: 'BancoJudgeUnseen',
      },
      0,
    );

    await generator.generate(1, [unseen]);

    const rows = createMany.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows.filter((row) => row.issuingBank === 'BancoJudgeUnseen')).toHaveLength(2);
    expect(rows.filter((row) => row.issuingBank === 'BancoJudgeUnseen')).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'DECLINED' })]),
    );
  });
});
