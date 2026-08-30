import { Injectable } from '@nestjs/common';
import { FxService } from '../fx/fx.service.js';
import { TransactionsRepository } from './transactions.repository.js';
import type {
  BulkCreateTransactionsDto,
  CreateTransactionDto,
} from './dto/create-transaction.dto.js';
import type { QueryTransactionsDto } from './dto/query-transactions.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  canonicalToYunoStatus,
  classifyTransaction,
} from '../../common/yuno-taxonomy.js';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly repository: TransactionsRepository,
    private readonly fx: FxService,
  ) {}

  async create(dto: CreateTransactionDto) {
    const row = await this.toRow(dto);
    return this.repository.create(row as Prisma.TransactionCreateInput);
  }

  async createBulk(dto: BulkCreateTransactionsDto) {
    const rows = await Promise.all(dto.transactions.map((tx) => this.toRow(tx)));
    const result = await this.repository.createMany(rows as Prisma.TransactionCreateManyInput[]);
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

    const where: Prisma.TransactionWhereInput = {
      ...(query.merchant ? { merchant: query.merchant } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.country ? { country: query.country } : {}),
      ...(query.issuingBank ? { issuingBank: query.issuingBank } : {}),
      ...(query.failureReason ? { failureReason: query.failureReason } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(occurredAt ? { occurredAt } : {}),
    };

    return this.repository.findMany(where, query.limit ?? 100);
  }

  count() {
    return this.repository.count();
  }

  /**
   * Normaliza una transaccion entrante:
   *  - deriva failureReason para que TIMEOUT y ERROR puedan ser causa raiz
   *  - congela el monto en USD con la tasa vigente
   */
  private async toRow(dto: CreateTransactionDto) {
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    const currency = dto.currency ?? 'USD';
    const { amountUsdCents, fxRateId } = await this.fx.convert(dto.amountCents, currency, occurredAt);

    /*
     * Semantica Yuno derivada. Si el emisor no manda `responseCode` se deriva
     * de los campos antiguos, y si no manda `yunoStatus` se deriva del status
     * canonico. Asi las transacciones nuevas quedan completas aunque el
     * generador que las creo sea de la version anterior.
     */
    const responseCode =
      dto.responseCode ??
      dto.declineCode ??
      dto.errorType ??
      (dto.status === 'TIMEOUT' ? 'PROVIDER_TIMEOUT' : null);

    const yunoStatus =
      dto.yunoStatus ?? canonicalToYunoStatus(dto.status);

    const classification = classifyTransaction({
      responseCode,
      transactionStatus: yunoStatus,
      merchantAdviceCode: dto.merchantAdviceCode,
    });

    return {
      externalId: dto.externalId ?? null,
      paymentId: dto.paymentId ?? null,
      attemptNumber: dto.attemptNumber ?? 1,
      transactionType: dto.transactionType ?? 'PURCHASE',
      yunoStatus,
      responseCode,
      merchantAdviceCode: dto.merchantAdviceCode ?? null,
      providerResponseCode: dto.providerResponseCode ?? null,
      merchant: dto.merchant,
      provider: dto.provider,
      method: dto.method,
      country: dto.country,
      issuingBank: dto.issuingBank,
      failureReason:
        dto.status === 'APPROVED'
          ? null
          : classification?.code ?? deriveFailureReason(dto.status, dto.declineCode, dto.errorType),
      status: dto.status,
      declineCode: dto.declineCode ?? null,
      errorType: dto.errorType ?? null,
      latencyMs: dto.latencyMs ?? null,
      amountCents: dto.amountCents,
      currency,
      amountUsdCents,
      fxRateId,
      occurredAt,
    };
  }
}

/**
 * Un solo motivo de fallo, venga de un rechazo o de un error tecnico.
 * Sin esto, el detector nunca podria diagnosticar "dLocal da timeout en Brasil":
 * veria la caida pero no tendria la dimension que la explica.
 */
export function deriveFailureReason(
  status: string,
  declineCode?: string | null,
  errorType?: string | null,
): string | null {
  if (status === 'APPROVED') return null;
  if (status === 'DECLINED') return declineCode ?? 'DECLINED_UNKNOWN';
  return errorType ?? status;
}
