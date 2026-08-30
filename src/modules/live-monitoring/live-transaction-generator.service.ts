import { Injectable } from '@nestjs/common';
import { DIMENSIONS, type Dimension, type DimensionMap } from '../../common/dimensions.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { TransactionsRepository } from '../transactions/transactions.repository.js';
import type { LiveDegradation } from './live-monitoring.types.js';

type RouteProfile = Required<Omit<DimensionMap, 'failureReason'>> & {
  approvalRate: number;
  weight: number;
};

const NORMAL_ROUTES: RouteProfile[] = [
  { merchant: 'PagoTotal Retail', provider: 'Stripe', method: 'CARD', country: 'MX', issuingBank: 'BBVA', approvalRate: 0.93, weight: 3 },
  { merchant: 'PagoTotal Retail', provider: 'dLocal', method: 'CARD', country: 'MX', issuingBank: 'Banorte', approvalRate: 0.91, weight: 2 },
  { merchant: 'Nova Travel', provider: 'dLocal', method: 'CARD', country: 'CO', issuingBank: 'Bancolombia', approvalRate: 0.9, weight: 3 },
  { merchant: 'Nova Travel', provider: 'Stripe', method: 'PSE', country: 'CO', issuingBank: 'Davivienda', approvalRate: 0.92, weight: 2 },
  { merchant: 'Mercado Uno', provider: 'dLocal', method: 'PIX', country: 'BR', issuingBank: 'Itau', approvalRate: 0.94, weight: 3 },
  { merchant: 'Mercado Uno', provider: 'Adyen', method: 'CARD', country: 'BR', issuingBank: 'Bradesco', approvalRate: 0.91, weight: 2 },
  { merchant: 'Mercado Uno', provider: 'Adyen', method: 'CARD', country: 'BR', issuingBank: 'Nubank', approvalRate: 0.89, weight: 2 },
];

const DECLINE_CODES = ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS', 'EXPIRED_CARD'];

@Injectable()
export class LiveTransactionGeneratorService {
  private random = seededRandom(1_337);

  constructor(private readonly transactions: TransactionsRepository) {}

  reset(seed: number) {
    this.random = seededRandom(seed);
  }

  async generate(transactionsPerTick: number, degradations: LiveDegradation[], now = new Date()) {
    const rows: Prisma.TransactionCreateManyInput[] = [];
    for (let index = 0; index < transactionsPerTick; index++) {
      const route = weightedRoute(this.random);
      rows.push(this.makeTransaction(route, degradations, now));
    }
    for (const degradation of degradations) {
      const route = targetRoute(degradation.dimensions);
      for (let index = 0; index < degradation.targetTransactionsPerTick; index++) {
        rows.push(this.makeTransaction(route, degradations, now));
      }
    }

    const inserted = await this.transactions.createMany(rows);
    const approved = rows.filter((row) => row.status === 'APPROVED').length;
    return { generated: inserted.count, approved, declined: rows.length - approved, rows };
  }

  private makeTransaction(
    route: RouteProfile,
    degradations: LiveDegradation[],
    occurredAt: Date,
  ): Prisma.TransactionCreateManyInput {
    const degradation = selectDegradation(route, degradations);
    const fluctuatingNormalRate = clamp(route.approvalRate + (this.random() - 0.5) * 0.04, 0, 1);
    const approvalRate = degradation?.approvalRate ?? fluctuatingNormalRate;
    const approved = this.random() < approvalRate;
    const failureReason = approved
      ? null
      : degradation?.failureReason ?? DECLINE_CODES[Math.floor(this.random() * DECLINE_CODES.length)]!;
    const amountUsdCents = 2_000 + Math.floor(this.random() * 48_000);
    return {
      merchant: route.merchant,
      provider: route.provider,
      method: route.method,
      country: route.country,
      issuingBank: route.issuingBank,
      failureReason,
      status: approved ? 'APPROVED' : 'DECLINED',
      declineCode: failureReason,
      errorType: null,
      latencyMs: 200 + Math.floor(this.random() * 900),
      amountCents: amountUsdCents,
      amountUsdCents,
      currency: 'USD',
      occurredAt,
    };
  }
}

export function matchesDimensions(transaction: DimensionMap, dimensions: DimensionMap) {
  return DIMENSIONS.every((dimension) => {
    const expected = dimensions[dimension];
    return expected === undefined || transaction[dimension] === expected;
  });
}

export function selectDegradation(
  transaction: DimensionMap,
  degradations: LiveDegradation[],
) {
  return degradations
    .filter((degradation) => matchesDimensions(transaction, degradation.dimensions))
    .sort(
      (left, right) =>
        specificity(right.dimensions) - specificity(left.dimensions) ||
        left.approvalRate - right.approvalRate ||
        left.startedAt.localeCompare(right.startedAt),
    )[0];
}

function targetRoute(dimensions: DimensionMap): RouteProfile {
  const base = NORMAL_ROUTES.find((route) => matchesDimensions(route, dimensions)) ?? NORMAL_ROUTES[0]!;
  return {
    merchant: dimensions.merchant ?? base.merchant,
    provider: dimensions.provider ?? base.provider,
    method: dimensions.method ?? base.method,
    country: dimensions.country ?? base.country,
    issuingBank: dimensions.issuingBank ?? base.issuingBank,
    approvalRate: base.approvalRate,
    weight: 1,
  };
}

function weightedRoute(random: () => number) {
  const total = NORMAL_ROUTES.reduce((sum, route) => sum + route.weight, 0);
  let roll = random() * total;
  for (const route of NORMAL_ROUTES) {
    roll -= route.weight;
    if (roll <= 0) return route;
  }
  return NORMAL_ROUTES[0]!;
}

function specificity(dimensions: DimensionMap) {
  return (Object.keys(dimensions) as Dimension[]).filter(
    (dimension) => dimensions[dimension] !== undefined,
  ).length;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}
