import { Injectable, Logger } from '@nestjs/common';
import { FxService } from '../fx/fx.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { TransactionsRepository } from '../transactions/transactions.repository.js';
import { IncidentsRepository } from '../incidents/incidents.repository.js';
import { BaselinesService } from '../baselines/baselines.service.js';
import type { CreateTransactionDto, PaymentStatusValue } from '../transactions/dto/create-transaction.dto.js';
import type { InjectIncidentDto } from './dto/inject-incident.dto.js';
import type { InjectPredictiveRiskDto } from './dto/inject-predictive-risk.dto.js';

type Route = {
  merchant: string;
  provider: string;
  method: string;
  country: string;
  issuingBank: string;
  currency: string;
  approval: number;
  weight: number;
};

type PredictiveProfile = {
  approvalRate: number;
  timeoutRate: number;
  errorRate: number;
  baseLatencyMs: number;
};

/** PagoTotal: 3 comercios, 3 proveedores, 3 paises. Datos inventados. */
const ROUTES: Route[] = [
  { merchant: 'PagoTotal Retail', provider: 'Stripe',       method: 'CARD', country: 'MX', issuingBank: 'BBVA',        currency: 'MXN', approval: 0.93, weight: 3 },
  { merchant: 'PagoTotal Retail', provider: 'dLocal',       method: 'CARD', country: 'MX', issuingBank: 'Banorte',     currency: 'MXN', approval: 0.91, weight: 2 },
  { merchant: 'PagoTotal Retail', provider: 'MercadoPago',  method: 'CASH', country: 'MX', issuingBank: 'OXXO',        currency: 'MXN', approval: 0.88, weight: 1 },
  { merchant: 'Nova Travel',      provider: 'dLocal',       method: 'CARD', country: 'CO', issuingBank: 'Bancolombia', currency: 'COP', approval: 0.90, weight: 3 },
  { merchant: 'Nova Travel',      provider: 'Stripe',       method: 'PSE',  country: 'CO', issuingBank: 'Davivienda',  currency: 'COP', approval: 0.92, weight: 2 },
  { merchant: 'Mercado Uno',      provider: 'dLocal',       method: 'PIX',  country: 'BR', issuingBank: 'Itau',        currency: 'BRL', approval: 0.94, weight: 3 },
  { merchant: 'Mercado Uno',      provider: 'Adyen',        method: 'CARD', country: 'BR', issuingBank: 'Bradesco',    currency: 'BRL', approval: 0.91, weight: 2 },
  { merchant: 'Mercado Uno',      provider: 'Adyen',        method: 'CARD', country: 'BR', issuingBank: 'Itau',        currency: 'BRL', approval: 0.90, weight: 2 },
  { merchant: 'Mercado Uno',      provider: 'Adyen',        method: 'CARD', country: 'BR', issuingBank: 'Nubank',      currency: 'BRL', approval: 0.89, weight: 2 },
  { merchant: 'Mercado Uno',      provider: 'Adyen',        method: 'PIX',  country: 'BR', issuingBank: 'Itau',        currency: 'BRL', approval: 0.92, weight: 2 },
  { merchant: 'Mercado Uno',      provider: 'Adyen',        method: 'WALLET', country: 'BR', issuingBank: 'Nubank',    currency: 'BRL', approval: 0.89, weight: 1 },
];

const DECLINE_CODES = ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS', 'EXPIRED_CARD', 'RESTRICTED_CARD'];

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private readonly fx: FxService,
    private readonly transactions: TransactionsService,
    private readonly transactionsRepo: TransactionsRepository,
    private readonly incidents: IncidentsRepository,
    private readonly baselines: BaselinesService,
  ) {}

  /**
   * Siembra operacion normal. Deliberadamente SIN incidente: la demo
   * empieza mostrando que el sistema vigila y no alerta.
   */
  async seed(options: { reset?: boolean; historyHours?: number; density?: number } = {}) {
    const historyHours = options.historyHours ?? 24 * 3;
    const density = options.density ?? 8;

    if (options.reset) {
      await this.incidents.deleteAll();
      await this.transactionsRepo.deleteAll();
    } else if ((await this.transactionsRepo.count()) > 0) {
      return { seeded: false, reason: 'Ya existen transacciones. Usa reset=true para regenerar.' };
    }

    await this.fx.ensureSeeded();

    const random = seededRandom(1337);
    const now = new Date();
    const rows: CreateTransactionDto[] = [];

    for (let minutesAgo = historyHours * 60; minutesAgo >= 0; minutesAgo -= 5) {
      const at = new Date(now.getTime() - minutesAgo * 60_000);
      const activity = dailyActivity(at);
      for (const route of ROUTES) {
          const count = Math.max(1, Math.round(route.weight * density * activity * (0.8 + random() * 0.4)));
        for (let i = 0; i < count; i++) {
          rows.push(makeTx(route, offset(at, random), route.approval, random));
        }
      }
    }

    const inserted = await this.insertInChunks(rows);
    // La profundidad de los baselines DEBE cubrir la del detector: un
    // segmento sin baseline se descarta en silencio, y con maxDepth 2 los
    // diagnosticos de tres dimensiones nunca llegarian a existir.
    const baselines = await this.baselines.rebuild({ lookbackHours: historyHours, maxDepth: 3 });

    return {
      seeded: true,
      transactions: inserted,
      baselines: baselines.rebuilt,
      routes: ROUTES.length,
      historyHours,
      next: [
        'POST /api/detection/run  -> deberia responder NO_ANOMALY',
        'POST /api/demo/inject-incident -> inyecta una degradacion',
        'POST /api/detection/run  -> deberia responder INCIDENTS_FOUND',
      ],
    };
  }

  /**
   * Genera trafico degradado para una combinacion arbitraria.
   * Este endpoint es la prueba de fuego: acepta dimensiones que no
   * existen en el seed y el pipeline las procesa igual.
   */
  async injectIncident(dto: InjectIncidentDto) {
    const random = seededRandom(Date.now() % 100_000);
    const now = new Date();
    const duration = dto.durationMinutes ?? 15;
    const perMinute = dto.transactionsPerMinute ?? 12;
    const approval = dto.approvalRate ?? 0.35;

    const base = ROUTES.find(
      (route) =>
        (!dto.provider || route.provider === dto.provider) &&
        (!dto.country || route.country === dto.country) &&
        (!dto.method || route.method === dto.method) &&
        (!dto.merchant || route.merchant === dto.merchant) &&
        (!dto.issuingBank || route.issuingBank === dto.issuingBank),
    );

    const route: Route = {
      merchant: dto.merchant ?? base?.merchant ?? 'PagoTotal Retail',
      provider: dto.provider ?? base?.provider ?? 'dLocal',
      method: dto.method ?? base?.method ?? 'CARD',
      country: dto.country ?? base?.country ?? 'BR',
      issuingBank: dto.issuingBank ?? base?.issuingBank ?? 'Itau',
      currency: base?.currency ?? 'USD',
      approval,
      weight: 1,
    };

    const rows: CreateTransactionDto[] = [];
    for (let minutesAgo = duration; minutesAgo >= 0; minutesAgo -= 1) {
      const at = new Date(now.getTime() - minutesAgo * 60_000);
      for (let i = 0; i < perMinute; i++) {
        const tx = makeTx(route, offset(at, random), approval, random);
        if (dto.declineCode && tx.status === 'DECLINED') tx.declineCode = dto.declineCode;
        if (dto.errorType && (tx.status === 'ERROR' || tx.status === 'TIMEOUT')) tx.errorType = dto.errorType;
        rows.push(tx);
      }
    }

    const inserted = await this.insertInChunks(rows);
    this.logger.log(`Incidente inyectado en ${JSON.stringify(route)}: ${inserted} transacciones`);

    return {
      injected: true,
      transactions: inserted,
      dimensions: {
        merchant: route.merchant,
        provider: route.provider,
        method: route.method,
        country: route.country,
        issuingBank: route.issuingBank,
      },
      approvalRate: approval,
      durationMinutes: duration,
      next: 'POST /api/detection/run',
    };
  }

  async injectPredictiveRisk(
    dto: InjectPredictiveRiskDto,
  ) {
    const random = seededRandom(
      Date.now() % 100_000,
    );

    const now = new Date();

    const base = ROUTES.find(
      (route) =>
        (!dto.provider ||
          route.provider === dto.provider) &&
        (!dto.country ||
          route.country === dto.country) &&
        (!dto.method ||
          route.method === dto.method) &&
        (!dto.merchant ||
          route.merchant === dto.merchant) &&
        (!dto.issuingBank ||
          route.issuingBank === dto.issuingBank),
    );

    const route: Route = {
      merchant:
        dto.merchant ??
        base?.merchant ??
        'PagoTotal Retail',

      provider:
        dto.provider ??
        base?.provider ??
        'dLocal',

      method:
        dto.method ??
        base?.method ??
        'CARD',

      country:
        dto.country ??
        base?.country ??
        'CO',

      issuingBank:
        dto.issuingBank ??
        base?.issuingBank ??
        'Bancolombia',

      currency:
        base?.currency ??
        'USD',

      approval:
        base?.approval ??
        0.90,

      weight: 1,
    };

    const perMinute =
      dto.transactionsPerMinute ?? 12;

    /*
    * Tres buckets de 5 minutos.
    *
    * IMPORTANTE:
    * No estamos creando una caída completa.
    *
    * Estamos creando señales precursoras:
    *
    * bucket 1:
    * casi normal
    *
    * bucket 2:
    * empieza deterioro
    *
    * bucket 3:
    * riesgo significativo
    *
    * Esto coincide con la estructura temporal
    * usada para entrenar el modelo.
    */
    const profiles: PredictiveProfile[] = [
      {
        approvalRate: 0.92,
        timeoutRate: 0.01,
        errorRate: 0.01,
        baseLatencyMs: 450,
      },

      {
        approvalRate: 0.88,
        timeoutRate: 0.03,
        errorRate: 0.03,
        baseLatencyMs: 800,
      },

      {
        approvalRate: 0.82,
        timeoutRate: 0.07,
        errorRate: 0.06,
        baseLatencyMs: 1400,
      },
    ];

    const rows: CreateTransactionDto[] = [];

    for (
      let bucketIndex = 0;
      bucketIndex < profiles.length;
      bucketIndex++
    ) {
      const profile =
        profiles[bucketIndex];

      /*
      * Bucket 0 = hace 15–10 min
      * Bucket 1 = hace 10–5 min
      * Bucket 2 = hace 5–0 min
      */
      const bucketStartMinutesAgo =
        15 - bucketIndex * 5;

      for (
        let minuteOffset = 0;
        minuteOffset < 5;
        minuteOffset++
      ) {
        const minutesAgo =
          bucketStartMinutesAgo -
          minuteOffset;

        /*
        * -30 segundos evita que una transacción
        * termine accidentalmente en el futuro.
        */
        const at = new Date(
          now.getTime() -
            minutesAgo * 60_000 -
            30_000,
        );

        for (
          let transactionIndex = 0;
          transactionIndex < perMinute;
          transactionIndex++
        ) {
          /*
          * Distribución dentro del minuto para no
          * generar todas con exactamente el mismo
          * timestamp.
          */
          const secondsOffset =
            Math.floor(random() * 25);

          const occurredAt = new Date(
            at.getTime() +
              secondsOffset * 1000,
          );

          rows.push(
            makePredictiveTx(
              route,
              occurredAt,
              profile,
              random,
            ),
          );
        }
      }
    }

    const inserted =
      await this.insertInChunks(rows);

    this.logger.log(
      `Riesgo predictivo inyectado en ${JSON.stringify(
        route,
      )}: ${inserted} transacciones`,
    );

    return {
      injected: true,

      type: 'PREDICTIVE_RISK',

      transactions: inserted,

      dimensions: {
        merchant: route.merchant,
        provider: route.provider,
        method: route.method,
        country: route.country,
        issuingBank: route.issuingBank,
      },

      buckets: profiles.map(
        (profile, index) => ({
          bucket: index + 1,
          minutes:
            index === 0
              ? '-15 to -10'
              : index === 1
                ? '-10 to -5'
                : '-5 to now',

          approvalRate:
            profile.approvalRate,

          timeoutRate:
            profile.timeoutRate,

          errorRate:
            profile.errorRate,

          baseLatencyMs:
            profile.baseLatencyMs,
        }),
      ),

      next:
        'POST /api/predictions/segment',
    };
  }

  async reset() {
    await this.incidents.deleteAll();
    await this.transactionsRepo.deleteAll();
    return { reset: true };
  }

  private async insertInChunks(rows: CreateTransactionDto[], chunkSize = 500) {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const result = await this.transactions.createBulk({ transactions: rows.slice(i, i + chunkSize) });
      inserted += result.inserted;
    }
    return inserted;
  }
}

function makeTx(route: Route, occurredAt: Date, approval: number, random: () => number): CreateTransactionDto {
  const roll = random();
  let status: PaymentStatusValue;
  if (roll < approval) status = 'APPROVED';
  else if (roll < approval + (1 - approval) * 0.7) status = 'DECLINED';
  else if (roll < approval + (1 - approval) * 0.88) status = 'ERROR';
  else status = 'TIMEOUT';

  const scale = route.currency === 'COP' ? 400 : route.currency === 'MXN' ? 20 : route.currency === 'BRL' ? 5 : 1;

  return {
    merchant: route.merchant,
    provider: route.provider,
    method: route.method,
    country: route.country,
    issuingBank: route.issuingBank,
    status,
    declineCode: status === 'DECLINED' ? DECLINE_CODES[Math.floor(random() * DECLINE_CODES.length)] : undefined,
    errorType: status === 'ERROR' ? 'PROVIDER_ERROR' : status === 'TIMEOUT' ? 'GATEWAY_TIMEOUT' : undefined,
    latencyMs: status === 'TIMEOUT' ? 5_000 + Math.floor(random() * 3_000) : 200 + Math.floor(random() * 900),
    amountCents: Math.round((2_000 + Math.floor(random() * 48_000)) * scale),
    currency: route.currency,
    occurredAt: occurredAt.toISOString(),
  };
}

function makePredictiveTx(
  route: Route,
  occurredAt: Date,
  profile: PredictiveProfile,
  random: () => number,
): CreateTransactionDto {
  const roll = random();

  const approvalLimit =
    profile.approvalRate;

  const timeoutLimit =
    approvalLimit +
    profile.timeoutRate;

  const errorLimit =
    timeoutLimit +
    profile.errorRate;

  let status: PaymentStatusValue;

  if (roll < approvalLimit) {
    status = 'APPROVED';
  } else if (roll < timeoutLimit) {
    status = 'TIMEOUT';
  } else if (roll < errorLimit) {
    status = 'ERROR';
  } else {
    status = 'DECLINED';
  }

  let latencyMs =
    profile.baseLatencyMs +
    Math.floor(
      random() *
        profile.baseLatencyMs *
        0.35,
    );

  if (status === 'TIMEOUT') {
    latencyMs +=
      2500 +
      Math.floor(random() * 1800);
  }

  if (status === 'ERROR') {
    latencyMs +=
      500 +
      Math.floor(random() * 700);
  }

  const scale =
    route.currency === 'COP'
      ? 400
      : route.currency === 'MXN'
        ? 20
        : route.currency === 'BRL'
          ? 5
          : 1;

  return {
    merchant: route.merchant,
    provider: route.provider,
    method: route.method,
    country: route.country,
    issuingBank: route.issuingBank,

    status,

    declineCode:
      status === 'DECLINED'
        ? DECLINE_CODES[
            Math.floor(
              random() *
                DECLINE_CODES.length,
            )
          ]
        : undefined,

    errorType:
      status === 'ERROR'
        ? 'PROVIDER_DEGRADATION'
        : status === 'TIMEOUT'
          ? 'GATEWAY_SLOWDOWN'
          : undefined,

    latencyMs,

    amountCents:
      Math.round(
        (
          2_000 +
          Math.floor(
            random() * 48_000,
          )
        ) * scale,
      ),

    currency: route.currency,

    occurredAt:
      occurredAt.toISOString(),
  };
}

/** Curva de actividad diaria: valles de madrugada, picos de tarde. */
function dailyActivity(at: Date): number {
  const hour = at.getUTCHours();
  const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6;
  const shape = 0.35 + 0.65 * Math.sin(((hour - 4 + 24) % 24) * (Math.PI / 24)) ** 2;
  return shape * (weekend ? 0.6 : 1);
}

function offset(at: Date, random: () => number): Date {
  return new Date(at.getTime() + Math.floor(random() * 5 * 60_000));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
