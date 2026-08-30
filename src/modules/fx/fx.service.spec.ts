import { describe, expect, it, vi } from 'vitest';
import type { FxRepository } from './fx.repository.js';
import { FxService } from './fx.service.js';

describe('FxService bulk lookup cache', () => {
  it('shares one database lookup for concurrent rows in the same currency and day', async () => {
    const repository = {
      findEffective: vi.fn().mockResolvedValue({ id: 'fx-cop', usdPerUnit: 0.00025 }),
    };
    const service = new FxService(repository as unknown as FxRepository);
    const occurredAt = new Date('2026-08-30T15:00:00.000Z');

    const converted = await Promise.all(
      Array.from({ length: 100 }, () => service.convert(4_000_000, 'COP', occurredAt)),
    );

    expect(repository.findEffective).toHaveBeenCalledOnce();
    expect(converted).toHaveLength(100);
    expect(converted[0]).toEqual({ amountUsdCents: 1_000, fxRateId: 'fx-cop' });
  });
});
