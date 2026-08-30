import { describe, expect, it, vi } from 'vitest';
import type { FxService } from '../fx/fx.service.js';
import type { TransactionsService } from '../transactions/transactions.service.js';
import type { TransactionsRepository } from '../transactions/transactions.repository.js';
import type { IncidentsRepository } from '../incidents/incidents.repository.js';
import type { BaselinesService } from '../baselines/baselines.service.js';
import type { DetectionRepository } from '../detection/detection.repository.js';
import { DemoService } from './demo.service.js';

describe('DemoService reset consistency', () => {
  it('clears incidents, detection history, transactions and baselines in FK-safe order', async () => {
    const incidents = { deleteAll: vi.fn().mockResolvedValue({ count: 1 }) };
    const runs = { deleteAll: vi.fn().mockResolvedValue({ count: 2 }) };
    const transactions = { deleteAll: vi.fn().mockResolvedValue({ count: 3 }) };
    const baselines = { clear: vi.fn().mockResolvedValue(4) };
    const service = new DemoService(
      {} as FxService,
      {} as TransactionsService,
      transactions as unknown as TransactionsRepository,
      incidents as unknown as IncidentsRepository,
      baselines as unknown as BaselinesService,
      runs as unknown as DetectionRepository,
    );

    await expect(service.reset()).resolves.toEqual({ reset: true });
    expect(incidents.deleteAll).toHaveBeenCalledOnce();
    expect(runs.deleteAll).toHaveBeenCalledOnce();
    expect(transactions.deleteAll).toHaveBeenCalledOnce();
    expect(baselines.clear).toHaveBeenCalledOnce();
    expect(incidents.deleteAll.mock.invocationCallOrder[0]).toBeLessThan(
      runs.deleteAll.mock.invocationCallOrder[0]!,
    );
  });
});
