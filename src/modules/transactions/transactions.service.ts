import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  BulkCreateTransactionsDto,
  CreateTransactionDto,
} from './dto/create-transaction.dto.js';
import type { QueryTransactionsDto } from './dto/query-transactions.dto.js';

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateTransactionDto) {
    return this.prisma.transaction.create({
      data: {
        merchant: dto.merchant,
        provider: dto.provider,
        method: dto.method,
        country: dto.country,
        issuingBank: dto.issuingBank,
        status: dto.status,
        declineCode: dto.declineCode,
        errorType: dto.errorType,
        latencyMs: dto.latencyMs,
        amountCents: dto.amountCents,
        currency: dto.currency ?? 'USD',
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      },
    });
  }

  async createBulk(dto: BulkCreateTransactionsDto) {
    const data = dto.transactions.map((tx) => ({
      merchant: tx.merchant,
      provider: tx.provider,
      method: tx.method,
      country: tx.country,
      issuingBank: tx.issuingBank,
      status: tx.status,
      declineCode: tx.declineCode,
      errorType: tx.errorType,
      latencyMs: tx.latencyMs,
      amountCents: tx.amountCents,
      currency: tx.currency ?? 'USD',
      occurredAt: tx.occurredAt ? new Date(tx.occurredAt) : new Date(),
    }));

    const result = await this.prisma.transaction.createMany({ data });
    return { inserted: result.count };
  }

  findAll(query: QueryTransactionsDto) {
    const occurredAt =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          }
        : undefined;

    return this.prisma.transaction.findMany({
      where: {
        ...(query.merchant ? { merchant: query.merchant } : {}),
        ...(query.provider ? { provider: query.provider } : {}),
        ...(query.method ? { method: query.method } : {}),
        ...(query.country ? { country: query.country } : {}),
        ...(query.issuingBank ? { issuingBank: query.issuingBank } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(occurredAt ? { occurredAt } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: query.limit ?? 100,
    });
  }
}
