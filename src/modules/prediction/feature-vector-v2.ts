import { encodeLocalTime } from '../../common/local-time.js';
import { classifyTransaction, type FailureDomain } from '../../common/yuno-taxonomy.js';

/**
 * Orden CONGELADO de las features V2.
 *
 * Tiene que coincidir exactamente con `FEATURES` en ml/train_model_v2.py.
 * Si divergen, la inferencia sigue "funcionando" pero da numeros sin sentido:
 * por eso hay un test de paridad que compara este array contra el artefacto.
 */
export const V2_FEATURES = [
  // Contexto temporal ciclico: dos columnas, UN concepto logico.
  // La hora cruda no sirve en un modelo lineal (23h y 0h quedarian a 23
  // unidades de distancia) y el seno solo no identifica la fase.
  'local_time_sin',
  'local_time_cos',
  'baseline_approval_rate',
  'approval_drop',
  'approval_slope',
  'p95_latency_ms',
  'latency_slope',
  'provider_error_rate',
  'provider_timeout_rate',
  'provider_failure_slope',
  'rejected_rate',
  'issuer_decline_rate',
  'auth_3ds_failure_rate',
  'fraud_screening_failure_rate',
  'data_quality_failure_rate',
  'provider_config_failure_rate',
  'hard_decline_share',
  'retry_attempt_rate',
] as const;

export type V2Feature = (typeof V2_FEATURES)[number];

/** Fila minima que el extractor necesita de una transaccion. */
export type YunoTransactionRow = {
  status: string;
  latencyMs?: number | null;
  occurredAt: Date;
  responseCode?: string | null;
  yunoStatus?: string | null;
  merchantAdviceCode?: string | null;
  failureReason?: string | null;
  declineCode?: string | null;
  errorType?: string | null;
  attemptNumber?: number | null;
};

export type YunoBucket = {
  attempts: number;
  approved: number;
  approvalRate: number;
  p95LatencyMs: number;
  providerErrorRate: number;
  providerTimeoutRate: number;
  rejectedRate: number;
  issuerDeclineRate: number;
  auth3dsFailureRate: number;
  fraudScreeningFailureRate: number;
  dataQualityFailureRate: number;
  providerConfigFailureRate: number;
  hardDeclineShare: number;
  retryAttemptRate: number;
};

/**
 * Resuelve el response_code de una transaccion.
 *
 * Las transacciones antiguas no traen `responseCode` (la columna es nueva).
 * Para no perderlas se cae a los campos que ya existian, en el mismo orden en
 * que el resto del proyecto los ha venido usando.
 */
export function resolveResponseCode(row: YunoTransactionRow): string | null {
  return (
    row.responseCode ??
    row.declineCode ??
    row.errorType ??
    row.failureReason ??
    (row.status === 'TIMEOUT' ? 'PROVIDER_TIMEOUT' : null)
  );
}

export function aggregateYunoBucket(rows: YunoTransactionRow[]): YunoBucket {
  const attempts = rows.length;
  const empty: YunoBucket = {
    attempts: 0,
    approved: 0,
    approvalRate: 0,
    p95LatencyMs: 0,
    providerErrorRate: 0,
    providerTimeoutRate: 0,
    rejectedRate: 0,
    issuerDeclineRate: 0,
    auth3dsFailureRate: 0,
    fraudScreeningFailureRate: 0,
    dataQualityFailureRate: 0,
    providerConfigFailureRate: 0,
    hardDeclineShare: 0,
    retryAttemptRate: 0,
  };
  if (attempts === 0) return empty;

  let approved = 0;
  let providerErrors = 0;
  let providerTimeouts = 0;
  let rejected = 0;
  let hard = 0;
  let failures = 0;
  let retries = 0;
  const domains: Partial<Record<FailureDomain, number>> = {};
  const latencies: number[] = [];

  for (const row of rows) {
    if (typeof row.latencyMs === 'number') latencies.push(row.latencyMs);
    if ((row.attemptNumber ?? 1) > 1) retries += 1;

    if (row.status === 'APPROVED') {
      approved += 1;
      continue;
    }

    failures += 1;
    const code = resolveResponseCode(row);
    const classification = classifyTransaction({
      responseCode: code,
      transactionStatus: row.yunoStatus,
      merchantAdviceCode: row.merchantAdviceCode,
    });

    if (!classification) continue;

    if (classification.declineType === 'HARD') hard += 1;
    if (classification.transactionStatus === 'REJECTED') rejected += 1;
    if (classification.transactionStatus === 'ERROR') {
      providerErrors += 1;
      if (classification.code === 'PROVIDER_TIMEOUT') providerTimeouts += 1;
    }

    const domain = classification.failureDomain;
    domains[domain] = (domains[domain] ?? 0) + 1;
  }

  const rate = (n: number) => n / attempts;
  const domainRate = (domain: FailureDomain) => rate(domains[domain] ?? 0);

  return {
    attempts,
    approved,
    approvalRate: rate(approved),
    p95LatencyMs: percentile(latencies, 0.95),
    providerErrorRate: rate(providerErrors),
    providerTimeoutRate: rate(providerTimeouts),
    rejectedRate: rate(rejected),
    issuerDeclineRate: domainRate('ISSUER'),
    auth3dsFailureRate: domainRate('AUTHENTICATION_3DS'),
    fraudScreeningFailureRate: domainRate('FRAUD_SCREENING'),
    dataQualityFailureRate: domainRate('MERCHANT_DATA'),
    providerConfigFailureRate: domainRate('PROVIDER_CONFIGURATION'),
    hardDeclineShare: failures > 0 ? hard / failures : 0,
    retryAttemptRate: rate(retries),
  };
}

/**
 * Construye el vector de features.
 *
 * La definicion de pendiente es (actual - mas_antiguo) / 2, identica a la del
 * generador en Python. Cualquier cambio aqui obliga a reentrenar.
 */
export function buildFeatureVectorV2(input: {
  buckets: YunoBucket[];
  baselineApprovalRate: number;
  /** Instante ancla: el FINAL de la ventana de observacion, no "ahora". */
  anchor: Date;
  /** Zona IANA de la ruta evaluada. */
  timeZone: string;
}): Record<V2Feature, number> {
  const { buckets, baselineApprovalRate } = input;
  const temporal = encodeLocalTime(input.anchor, input.timeZone);
  const oldest = buckets[0]!;
  const current = buckets[buckets.length - 1]!;

  const slope = (a: number, b: number) => (a - b) / 2;
  const providerFailure = (b: YunoBucket) => b.providerErrorRate + b.providerTimeoutRate;

  return {
    local_time_sin: temporal.localTimeSin,
    local_time_cos: temporal.localTimeCos,
    baseline_approval_rate: baselineApprovalRate,
    approval_drop: Math.max(0, baselineApprovalRate - current.approvalRate),
    approval_slope: slope(current.approvalRate, oldest.approvalRate),
    p95_latency_ms: current.p95LatencyMs,
    latency_slope: slope(current.p95LatencyMs, oldest.p95LatencyMs),
    provider_error_rate: current.providerErrorRate,
    provider_timeout_rate: current.providerTimeoutRate,
    provider_failure_slope: slope(providerFailure(current), providerFailure(oldest)),
    rejected_rate: current.rejectedRate,
    issuer_decline_rate: current.issuerDeclineRate,
    auth_3ds_failure_rate: current.auth3dsFailureRate,
    fraud_screening_failure_rate: current.fraudScreeningFailureRate,
    data_quality_failure_rate: current.dataQualityFailureRate,
    provider_config_failure_rate: current.providerConfigFailureRate,
    hard_decline_share: current.hardDeclineShare,
    retry_attempt_rate: current.retryAttemptRate,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}
