import { describe, expect, it, vi } from 'vitest';
import type { FxService } from '../fx/fx.service.js';
import type { TransactionsService } from '../transactions/transactions.service.js';
import type { TransactionsRepository } from '../transactions/transactions.repository.js';
import type { BaselinesService } from '../baselines/baselines.service.js';
import type { DetectionService } from '../detection/detection.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DemoService } from './demo.service.js';

describe('DemoService reset consistency', () => {
  it('clears incidents, detection history, transactions and baselines in FK-safe order', async () => {
    const transactions = {};
    const baselines = {};
    const prisma = { $executeRawUnsafe: vi.fn().mockResolvedValue(0) };
    const service = new DemoService(
      {} as FxService,
      {} as TransactionsService,
      transactions as unknown as TransactionsRepository,
      baselines as unknown as BaselinesService,
      {} as DetectionService,
      prisma as unknown as PrismaService,
    );

    await expect(service.reset()).resolves.toEqual({ reset: true });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledOnce();
    expect(prisma.$executeRawUnsafe.mock.calls[0]?.[0]).toContain('TRUNCATE TABLE');
    expect(prisma.$executeRawUnsafe.mock.calls[0]?.[0]).toContain('"Transaction"');
    expect(prisma.$executeRawUnsafe.mock.calls[0]?.[0]).not.toContain('"FxRate"');
  });
});
