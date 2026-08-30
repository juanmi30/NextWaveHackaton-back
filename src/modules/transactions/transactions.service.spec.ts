import { describe, expect, it, vi } from 'vitest';
import type { FxService } from '../fx/fx.service.js';
import type { TransactionsRepository } from './transactions.repository.js';
import { TransactionsService } from './transactions.service.js';

describe('TransactionsService Yuno normalization', () => {
  it('never persists SUCCEEDED as failureReason for an approved transaction', async () => {
    const create = vi.fn(async (row) => row);
    const service = new TransactionsService(
      { create } as unknown as TransactionsRepository,
      { convert: vi.fn().mockResolvedValue({ amountUsdCents: 1000, fxRateId: null }) } as unknown as FxService,
    );

    const result = await service.create({
      merchant: 'Merchant', provider: 'Adyen', method: 'CARD', country: 'BR',
      issuingBank: 'Bank', status: 'APPROVED', amountCents: 1000,
      responseCode: 'SUCCEEDED', yunoStatus: 'SUCCEEDED',
    });

    expect(result).toMatchObject({
      status: 'APPROVED', responseCode: 'SUCCEEDED', yunoStatus: 'SUCCEEDED', failureReason: null,
    });
  });
});
