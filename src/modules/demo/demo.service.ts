import { Injectable, Logger } from '@nestjs/common';
import { FxService } from '../fx/fx.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { TransactionsRepository } from '../transactions/transactions.repository.js';
import { BaselinesService } from '../baselines/baselines.service.js';
import type { CreateTransactionDto, PaymentStatusValue } from '../transactions/dto/create-transaction.dto.js';
import type { InjectIncidentDto } from './dto/inject-incident.dto.js';
import type { InjectPredictiveRiskDto } from './dto/inject-predictive-risk.dto.js';
import { DetectionService } from '../detection/detection.service.js';
import { localHourMinute } from '../../common/local-time.js';
import { resolveRouteTimeZone } from '../../common/route-timezone.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type Route = {
  merchant: string;
  provider: string;
  method: string;
  country: string;
  issuingBank: string;
  currency: string;
  approval: number;
  weight: number;
  minAmountCents: number;
  maxAmountCents: number;
  baseLatencyMs: number;
  latencyJitterMs: number;
  declineCodes: string[];
  errorCodes?: string[];
  timeoutShare?: number;
  errorShare?: number;
};

type PredictiveProfile = {
  approvalRate: number;
  timeoutRate: number;
  errorRate: number;
  baseLatencyMs: number;
};

/**
 * Portafolio sintetico de comercios LATAM. Los nombres son ficticios, pero las
 * combinaciones de metodos, monedas, bancos, tickets y proveedores representan
 * patrones habituales de e-commerce, travel, delivery y suscripciones.
 */
const ROUTES: Route[] = [
  route('PagoTotal Retail', 'Stripe', 'CARD', 'MX', 'BBVA', 'MXN', 0.93, 3, 25_000, 450_000, 320, 650,
    ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS', 'EXPIRED_CARD', 'INVALID_SECURITY_CODE']),
  route('PagoTotal Retail', 'dLocal', 'CARD', 'MX', 'Banorte', 'MXN', 0.91, 2, 18_000, 380_000, 480, 800,
    ['DECLINED_BY_BANK', 'INSUFFICIENT_FUNDS', 'RESTRICTED_BY_BANK', 'INVALID_CARD_DATA']),
  route('PagoTotal Retail', 'MercadoPago', 'CASH', 'MX', 'OXXO', 'MXN', 0.88, 1, 12_000, 220_000, 700, 1_100,
    ['EXPIRED', 'CANCELLED_BY_USER', 'INVALID_AMOUNT'], ['PROVIDER_ERROR'], 0.04, 0.04),
  route('Nova Travel', 'dLocal', 'CARD', 'CO', 'Bancolombia', 'COP', 0.90, 3, 6_000_000, 180_000_000, 520, 1_000,
    ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS', 'DECLINED_BY_BANK', 'THREE_D_SECURE_REQUIRED']),
  route('Nova Travel', 'Stripe', 'PSE', 'CO', 'Davivienda', 'COP', 0.92, 2, 5_000_000, 120_000_000, 650, 1_250,
    ['DECLINED_BY_BANK', 'CANCELLED_BY_USER', 'BANK_NOT_SUPPORTED']),
  route('Nova Travel', 'Adyen', 'CARD', 'MX', 'Santander', 'MXN', 0.89, 1, 90_000, 1_200_000, 610, 1_050,
    ['DO_NOT_HONOR', 'CALL_FOR_AUTHORIZE', 'THREE_D_SECURE_REQUIRED', 'RESTRICTED_BY_BANK']),
  route('Mercado Uno', 'dLocal', 'PIX', 'BR', 'Itau', 'BRL', 0.95, 3, 2_500, 90_000, 260, 500,
    ['DECLINED_BY_BANK', 'INVALID_AMOUNT', 'CANCELLED_BY_USER']),
  route('Mercado Uno', 'Adyen', 'CARD', 'BR', 'Bradesco', 'BRL', 0.91, 2, 4_000, 180_000, 390, 700,
    ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS', 'EXPIRED_CARD', 'FRAUD_VALIDATION']),
  route('Mercado Uno', 'Adyen', 'CARD', 'BR', 'Itau', 'BRL', 0.90, 2, 4_000, 180_000, 370, 720,
    ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS', 'RESTRICTED_BY_BANK', 'INVALID_SECURITY_CODE']),
  route('Mercado Uno', 'Adyen', 'CARD', 'BR', 'Nubank', 'BRL', 0.89, 2, 3_500, 160_000, 350, 680,
    ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS', 'FRAUD_VALIDATION', 'THREE_D_SECURE_REQUIRED']),
  route('Mercado Uno', 'Adyen', 'PIX', 'BR', 'Itau', 'BRL', 0.93, 2, 2_000, 85_000, 240, 480,
    ['DECLINED_BY_BANK', 'INVALID_AMOUNT', 'DUPLICATED_TRANSACTION']),
  route('Mercado Uno', 'MercadoPago', 'WALLET', 'BR', 'Nubank', 'BRL', 0.90, 1, 1_500, 65_000, 300, 600,
    ['USER_RESTRICTION', 'INSUFFICIENT_FUNDS', 'CANCELLED_BY_USER']),
  route('Flash Delivery', 'PayU', 'CARD', 'CO', 'Banco de Bogota', 'COP', 0.87, 2, 1_800_000, 15_000_000, 430, 750,
    ['INSUFFICIENT_FUNDS', 'DO_NOT_HONOR', 'INVALID_CARD_DATA', 'FRAUD_VALIDATION']),
  route('Flash Delivery', 'dLocal', 'PSE', 'CO', 'Nequi', 'COP', 0.94, 2, 1_200_000, 12_000_000, 580, 900,
    ['DECLINED_BY_BANK', 'CANCELLED_BY_USER', 'INVALID_AMOUNT']),
  route('StreamPlus', 'Stripe', 'CARD', 'MX', 'Citibanamex', 'MXN', 0.86, 2, 9_900, 29_900, 280, 520,
    ['INSUFFICIENT_FUNDS', 'EXPIRED_CARD', 'DO_NOT_HONOR', 'NO_RETRY_LIFE_CYCLE']),
  route('StreamPlus', 'Adyen', 'CARD', 'BR', 'Nubank', 'BRL', 0.88, 2, 1_990, 7_990, 300, 540,
    ['INSUFFICIENT_FUNDS', 'EXPIRED_CARD', 'DO_NOT_HONOR', 'NO_RETRY_POLICY']),
  route('Arena Gaming', 'EBANX', 'PIX', 'BR', 'Banco do Brasil', 'BRL', 0.92, 1, 1_000, 35_000, 460, 850,
    ['DECLINED_BY_BANK', 'USER_RESTRICTION', 'DUPLICATED_TRANSACTION']),
  route('Arena Gaming', 'PayU', 'CARD', 'CO', 'Daviplata', 'COP', 0.84, 1, 900_000, 25_000_000, 510, 900,
    ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS', 'FRAUD_VALIDATION', 'INVALID_SECURITY_CODE']),
];

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private readonly fx: FxService,
    private readonly transactions: TransactionsService,
    private readonly transactionsRepo: TransactionsRepository,
    private readonly baselines: BaselinesService,
    private readonly detection: DetectionService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Siembra operacion normal. Deliberadamente SIN incidente: la demo
   * empieza mostrando que el sistema vigila y no alerta.
   */
  async seed(options: { reset?: boolean; historyHours?: number; density?: number } = {}) {
    const historyHours = options.historyHours ?? 24 * 3;
    const density = options.density ?? 8;

    if (options.reset) {
      await this.resetDemoData();
    } else if ((await this.transactionsRepo.count()) > 0) {
      return { seeded: false, reason: 'Transactions already exist. Use reset=true to regenerate them.' };
    }

    await this.fx.ensureSeeded();

    const random = seededRandom(1337);
    const now = new Date();
    const rows: CreateTransactionDto[] = [];

    for (let minutesAgo = historyHours * 60; minutesAgo >= 0; minutesAgo -= 5) {
      const at = new Date(now.getTime() - minutesAgo * 60_000);
      for (const route of ROUTES) {
        const activity = dailyActivity(at, route.country);
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
      merchants: new Set(ROUTES.map((route) => route.merchant)).size,
      providers: new Set(ROUTES.map((route) => route.provider)).size,
      countries: new Set(ROUTES.map((route) => route.country)).size,
      methods: new Set(ROUTES.map((route) => route.method)).size,
      currencies: [...new Set(ROUTES.map((route) => route.currency))].sort(),
      historyHours,
      next: [
        'POST /api/detection/run -> should return NO_ANOMALY',
        'POST /api/demo/inject-incident -> injects a degradation',
        'POST /api/detection/run -> should return INCIDENTS_FOUND',
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
      minAmountCents: base?.minAmountCents ?? 2_000,
      maxAmountCents: base?.maxAmountCents ?? 50_000,
      baseLatencyMs: base?.baseLatencyMs ?? 450,
      latencyJitterMs: base?.latencyJitterMs ?? 850,
      declineCodes: base?.declineCodes ?? ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS'],
      errorCodes: base?.errorCodes,
      timeoutShare: base?.timeoutShare,
      errorShare: base?.errorShare,
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

      minAmountCents:
        base?.minAmountCents ??
        2_000,

      maxAmountCents:
        base?.maxAmountCents ??
        50_000,

      baseLatencyMs:
        base?.baseLatencyMs ??
        450,

      latencyJitterMs:
        base?.latencyJitterMs ??
        850,

      declineCodes:
        base?.declineCodes ??
        ['DO_NOT_HONOR', 'INSUFFICIENT_FUNDS'],

      errorCodes:
        base?.errorCodes,

      timeoutShare:
        base?.timeoutShare,

      errorShare:
        base?.errorShare,
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
        approvalRate: 0.89,
        timeoutRate: 0.06,
        errorRate: 0.04,
        baseLatencyMs: 1200,
      },

      {
        approvalRate: 0.84,
        timeoutRate: 0.12,
        errorRate: 0.04,
        baseLatencyMs: 3000,
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
        14 - bucketIndex * 5;

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
    await this.resetDemoData();
    return { reset: true };
  }

  private async resetDemoData() {
    /*
     * Destructivo y exclusivo del entorno demo. TRUNCATE es intencional:
     * Railway puede tener un disco pequeno y DELETE de decenas de miles de
     * filas genera suficiente WAL para agotarlo antes de volver a sembrar.
     * La lista es fija (sin input del usuario) y conserva FX, destinatarios y
     * politicas de escalamiento.
     */
    await this.prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AlertNotification",
        "IncidentEscalation",
        "DiagnosisEvidence",
        "IncidentDiagnosis",
        "Incident",
        "DetectionRun",
        "Transaction",
        "Baseline"
      RESTART IDENTITY CASCADE
    `);
  }

  private async insertInChunks(rows: CreateTransactionDto[], chunkSize = 2_000) {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const result = await this.transactions.createBulk({ transactions: rows.slice(i, i + chunkSize) });
      inserted += result.inserted;
    }
    return inserted;
  }

  async runIncidentScenario(
    dto: InjectIncidentDto,
  ) {
    /*
    * 1. Únicamente inyectamos telemetría degradada.
    *    Todavía NO existe un Incident.
    */
    const injection =
      await this.injectIncident(dto);

    /*
    * 2. Ejecutamos exactamente el mismo detector
    *    que usaría el sistema real.
    *
    * Sus valores por defecto actualmente son:
    * - windowMinutes: 15
    * - maxDepth: 3
    * - minSampleSize: 20
    * - minZScore: 2.5
    * - minConfidence: 0.35
    * - minDrop: 0.10
    */
    const detection =
      await this.detection.run({});

    const incidentIds =
      detection.incidents.map(
        (incident) =>
          incident.incidentId,
      );

    return {
      scenario: 'CONFIRMED_INCIDENT',

      injection,

      detection: {
        runId:
          detection.runId,

        outcome:
          detection.outcome,

        combosEvaluated:
          detection.combosEvaluated,

        incidents:
          detection.incidents,

        incidentIds,
      },

      readyFor: {
        incidents:
          incidentIds.map(
            (id) =>
              `/api/incidents/${id}`,
          ),

        agent:
          incidentIds.map(
            (id) =>
              `/api/agent/incidents/${id}/analyze`,
          ),
      },
    };
  }
}

function makeTx(route: Route, occurredAt: Date, approval: number, random: () => number): CreateTransactionDto {
  const roll = random();
  let status: PaymentStatusValue;
  if (roll < approval) status = 'APPROVED';
  else if (roll < approval + (1 - approval) * (1 - (route.errorShare ?? 0.12) - (route.timeoutShare ?? 0.08))) status = 'DECLINED';
  else if (roll < approval + (1 - approval) * (1 - (route.timeoutShare ?? 0.08))) status = 'ERROR';
  else status = 'TIMEOUT';

  const declineCode = status === 'DECLINED' ? pick(route.declineCodes, random) : undefined;
  const errorType = status === 'ERROR'
    ? pick(route.errorCodes ?? ['PROVIDER_ERROR', 'PROVIDER_INTERNAL_ERROR', 'PROVIDER_INVALID_RESPONSE'], random)
    : status === 'TIMEOUT'
      ? 'PROVIDER_TIMEOUT'
      : undefined;
  const responseCode = declineCode ?? errorType ?? (status === 'APPROVED' ? 'SUCCEEDED' : undefined);
  const attemptNumber = random() < 0.08 ? 2 : 1;
  const paymentId = demoId('pay', route, occurredAt, random);
  const latencyMs = status === 'TIMEOUT'
    ? 5_000 + Math.floor(random() * 4_000)
    : route.baseLatencyMs + Math.floor(random() * route.latencyJitterMs) + (status === 'ERROR' ? 500 : 0);

  return {
    externalId: demoId('txn', route, occurredAt, random),
    paymentId,
    attemptNumber,
    transactionType: random() < 0.03 ? 'AUTHORIZE' : 'PURCHASE',
    merchant: route.merchant,
    provider: route.provider,
    method: route.method,
    country: route.country,
    issuingBank: route.issuingBank,
    status,
    declineCode,
    errorType,
    responseCode,
    merchantAdviceCode: merchantAdviceFor(declineCode),
    providerResponseCode: providerCodeFor(responseCode),
    latencyMs,
    amountCents: route.minAmountCents + Math.floor(random() * (route.maxAmountCents - route.minAmountCents + 1)),
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
      Math.floor(
        random() * 1800,
      );
  }

  if (status === 'ERROR') {
    latencyMs +=
      500 +
      Math.floor(
        random() * 700,
      );
  }

  /*
   * Taxonomía entregada por el mentor de Yuno.
   *
   * En este escenario predictivo queremos simular
   * principalmente fallos accionables relacionados
   * con proveedor/integración.
   */
  let declineCode:
    string | undefined;

  let errorType:
    string | undefined;

  if (status === 'DECLINED') {
    const declineCodes = [
      'DECLINED_BY_PROVIDER',
      'INVALID_ISSUER',
      'REQUESTS_EXCEEDED',
    ];

    declineCode =
      declineCodes[
        Math.floor(
          random() *
            declineCodes.length,
        )
      ];
  }

  if (status === 'ERROR') {
    const integrationErrors = [
      'TERMINAL_ERROR',
      'INVALID_RESPONSE_FORMAT',
      'UNKNOWN_ERROR',
    ];

    errorType =
      integrationErrors[
        Math.floor(
          random() *
            integrationErrors.length,
        )
      ];
  }

  if (status === 'TIMEOUT') {
    /*
     * La transacción sigue siendo TIMEOUT,
     * pero usamos un failureReason del
     * vocabulario real para representar
     * degradación del proveedor.
     */
    const timeoutReasons = [
      'ACQUIRE_CONTINGENCY',
      'REQUESTS_EXCEEDED',
    ];

    errorType =
      timeoutReasons[
        Math.floor(
          random() *
            timeoutReasons.length,
        )
      ];
  }

  return {
    externalId: demoId('txn', route, occurredAt, random),
    paymentId: demoId('pay', route, occurredAt, random),
    attemptNumber: random() < 0.12 ? 2 : 1,
    transactionType: 'PURCHASE',
    merchant:
      route.merchant,

    provider:
      route.provider,

    method:
      route.method,

    country:
      route.country,

    issuingBank:
      route.issuingBank,

    status,

    declineCode,

    errorType,

    responseCode:
      declineCode ??
      errorType ??
      (status === 'APPROVED' ? 'SUCCEEDED' : undefined),

    merchantAdviceCode:
      merchantAdviceFor(declineCode),

    providerResponseCode:
      providerCodeFor(declineCode ?? errorType),

    latencyMs,

    amountCents:
      route.minAmountCents +
      Math.floor(
        random() *
          (route.maxAmountCents -
            route.minAmountCents +
            1),
      ),

    currency:
      route.currency,

    occurredAt:
      occurredAt.toISOString(),
  };
}

function route(
  merchant: string,
  provider: string,
  method: string,
  country: string,
  issuingBank: string,
  currency: string,
  approval: number,
  weight: number,
  minAmountCents: number,
  maxAmountCents: number,
  baseLatencyMs: number,
  latencyJitterMs: number,
  declineCodes: string[],
  errorCodes?: string[],
  timeoutShare?: number,
  errorShare?: number,
): Route {
  return {
    merchant,
    provider,
    method,
    country,
    issuingBank,
    currency,
    approval,
    weight,
    minAmountCents,
    maxAmountCents,
    baseLatencyMs,
    latencyJitterMs,
    declineCodes,
    errorCodes,
    timeoutShare,
    errorShare,
  };
}

function pick(values: string[], random: () => number): string {
  return values[Math.floor(random() * values.length)]!;
}

function merchantAdviceFor(code?: string): string | undefined {
  if (!code) return undefined;
  if (['EXPIRED_CARD', 'INVALID_CARD_DATA', 'INVALID_SECURITY_CODE'].includes(code)) {
    return 'UPDATE_INFORMATION';
  }
  if (['FRAUD_VALIDATION', 'NO_RETRY_LIFE_CYCLE', 'NO_RETRY_POLICY'].includes(code)) {
    return 'DO_NOT_TRY_AGAIN';
  }
  if (['INSUFFICIENT_FUNDS', 'DO_NOT_HONOR', 'DECLINED_BY_BANK'].includes(code)) {
    return 'TRY_AGAIN_LATER';
  }
  return undefined;
}

function providerCodeFor(code?: string): string | undefined {
  const codes: Record<string, string> = {
    SUCCEEDED: '00',
    DO_NOT_HONOR: '05',
    INSUFFICIENT_FUNDS: '51',
    EXPIRED_CARD: '54',
    INVALID_SECURITY_CODE: 'N7',
    RESTRICTED_BY_BANK: '62',
    DECLINED_BY_BANK: '57',
    PROVIDER_TIMEOUT: '91',
    PROVIDER_ERROR: '96',
    PROVIDER_INTERNAL_ERROR: '96',
  };
  return code ? codes[code] ?? code : undefined;
}

function demoId(prefix: string, route: Route, occurredAt: Date, random: () => number): string {
  const routeKey = `${route.country}-${route.provider}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const entropy = Math.floor(random() * 2_176_782_336).toString(36).padStart(6, '0');
  return `${prefix}_demo_${routeKey}_${occurredAt.getTime().toString(36)}_${entropy}`;
}

/** Curva por hora local: valle nocturno, picos de almuerzo y tarde. */
function dailyActivity(at: Date, country: string): number {
  const timeZone = resolveRouteTimeZone({ country }).timeZone;
  const { hour } = localHourMinute(at, timeZone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  const weekend = weekday === 'Sun' || weekday === 'Sat';
  const shape = 0.35 + 0.65 * Math.sin(((hour - 4 + 24) % 24) * (Math.PI / 24)) ** 2;
  const lunchPeak = hour >= 11 && hour <= 14 ? 1.15 : 1;
  return shape * lunchPeak * (weekend ? 0.72 : 1);
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
