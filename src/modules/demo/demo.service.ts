import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

type Status = 'APPROVED' | 'DECLINED' | 'ERROR' | 'TIMEOUT';

@Injectable()
export class DemoService {
  constructor(private readonly prisma: PrismaService) {}

  async seed(reset = false) {
    if (reset) {
      await this.prisma.incident.deleteMany();
      await this.prisma.transaction.deleteMany();
    } else {
      const existing = await this.prisma.transaction.count();
      if (existing > 0) {
        return { seeded: false, reason: 'Transactions already exist. Use ?reset=true to reseed.' };
      }
    }

    const now = new Date();
    const rows = [];
    let state = 42;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };

    const routes = [
      { merchant: 'Acme Store', provider: 'Stripe', method: 'CARD', country: 'CO', issuingBank: 'Bancolombia', approval: 0.92 },
      { merchant: 'Acme Store', provider: 'Adyen', method: 'CARD', country: 'CO', issuingBank: 'Davivienda', approval: 0.9 },
      { merchant: 'Nova Travel', provider: 'dLocal', method: 'CARD', country: 'CO', issuingBank: 'Bancolombia', approval: 0.91 },
      { merchant: 'Nova Travel', provider: 'dLocal', method: 'PSE', country: 'CO', issuingBank: 'Bancolombia', approval: 0.89 },
      { merchant: 'Mercado Uno', provider: 'dLocal', method: 'PIX', country: 'BR', issuingBank: 'Itau', approval: 0.93 },
      { merchant: 'Mercado Uno', provider: 'Stripe', method: 'CARD', country: 'MX', issuingBank: 'BBVA', approval: 0.9 },
    ];

    for (let minutesAgo = 48 * 60; minutesAgo > 60; minutesAgo -= 10) {
      for (const route of routes) {
        rows.push(this.makeTx(route, new Date(now.getTime() - minutesAgo * 60_000), route.approval, random));
      }
    }

    for (let minutesAgo = 60; minutesAgo >= 1; minutesAgo -= 3) {
      for (const route of routes) {
        const degraded =
          route.provider === 'dLocal' &&
          route.method === 'CARD' &&
          route.country === 'CO' &&
          route.issuingBank === 'Bancolombia';
        rows.push(this.makeTx(route, new Date(now.getTime() - minutesAgo * 60_000), degraded ? 0.42 : route.approval, random));
        rows.push(this.makeTx(route, new Date(now.getTime() - minutesAgo * 60_000 + 25_000), degraded ? 0.42 : route.approval, random));
      }
    }

    const result = await this.prisma.transaction.createMany({ data: rows });
    return {
      seeded: true,
      transactions: result.count,
      scenario: {
        degradedRoute: 'Nova Travel / dLocal / CARD / CO / Bancolombia',
        baselineApproval: '~91%',
        currentApproval: '~42%',
        suggestedDemo: 'GET /api/analytics/risk?groupBy=route&timeWindowMinutes=60&baselineHours=24&minSampleSize=10',
      },
    };
  }

  private makeTx(
    route: { merchant: string; provider: string; method: string; country: string; issuingBank: string },
    occurredAt: Date,
    approvalRate: number,
    random: () => number,
  ) {
    const roll = random();
    let status: Status;
    if (roll < approvalRate) status = 'APPROVED';
    else if (roll < approvalRate + 0.06) status = 'DECLINED';
    else if (roll < approvalRate + 0.085) status = 'ERROR';
    else status = 'TIMEOUT';

    return {
      ...route,
      status,
      declineCode: status === 'DECLINED' ? (random() > 0.5 ? 'DO_NOT_HONOR' : 'INSUFFICIENT_FUNDS') : null,
      errorType: status === 'ERROR' ? 'PROVIDER_ERROR' : status === 'TIMEOUT' ? 'TIMEOUT' : null,
      latencyMs: status === 'TIMEOUT' ? 5_000 + Math.floor(random() * 3_000) : 250 + Math.floor(random() * 900),
      amountCents: 2_000 + Math.floor(random() * 48_000),
      currency: 'USD',
      occurredAt,
    };
  }
}
