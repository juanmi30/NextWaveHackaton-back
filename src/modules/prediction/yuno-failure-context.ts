import {
  classifyTransaction,
  type FailureDomain,
  type RetryAdvice,
} from '../../common/yuno-taxonomy.js';
import { resolveResponseCode, type YunoTransactionRow } from './feature-vector-v2.js';

/**
 * Contexto de fallo enriquecido.
 *
 * Es estadistica descriptiva de la ventana observada. NO es una explicacion
 * causal ni una entrada magica para el agente: son conteos que el front y el
 * agente pueden leer y contrastar.
 */
export type YunoFailureContext = {
  totalAttempts: number;
  totalFailures: number;
  failureRate: number;

  /** Distribucion por transaction status oficial de Yuno. */
  statusDistribution: Array<{ status: string; count: number; share: number }>;

  /** Distribucion por dominio logico (inferencia nuestra, no microservicios). */
  domainDistribution: Array<{ domain: FailureDomain; count: number; share: number }>;

  /** HARD/SOFT publicado por Yuno. */
  declineSemantics: { hard: number; soft: number; notApplicable: number; unknown: number };

  /** Agrupacion de Merchant Advice Codes. */
  retryContext: Record<RetryAdvice, number>;

  /** Cuantos fallos puede atacar el equipo y cuantos son del emisor. */
  actionability: { actionable: number; issuerSide: number; limited: number; unknown: number };

  /** Codigos mas frecuentes, con su semantica. */
  topResponseCodes: Array<{
    code: string;
    count: number;
    share: number;
    transactionStatus: string;
    failureDomain: FailureDomain;
    declineType: string;
    retryAdvice: RetryAdvice;
    unknownCode: boolean;
  }>;

  /** Codigos vistos que no estan en la taxonomia publicada. */
  unknownCodes: string[];
};

export function buildYunoFailureContext(rows: YunoTransactionRow[]): YunoFailureContext {
  const totalAttempts = rows.length;
  const failures = rows.filter((row) => row.status !== 'APPROVED');
  const totalFailures = failures.length;

  const statuses = new Map<string, number>();
  const domains = new Map<FailureDomain, number>();
  const codes = new Map<string, { count: number; classification: ReturnType<typeof classifyTransaction> }>();
  const declineSemantics = { hard: 0, soft: 0, notApplicable: 0, unknown: 0 };
  const retryContext: Record<RetryAdvice, number> = {
    DO_NOT_RETRY: 0,
    RETRY_LATER: 0,
    UPDATE_INFORMATION: 0,
    UNKNOWN: 0,
  };
  const actionability = { actionable: 0, issuerSide: 0, limited: 0, unknown: 0 };
  const unknownCodes = new Set<string>();

  for (const row of failures) {
    const code = resolveResponseCode(row);
    const classification = classifyTransaction({
      responseCode: code,
      transactionStatus: row.yunoStatus,
      merchantAdviceCode: row.merchantAdviceCode,
    });

    if (!classification) {
      statuses.set('UNKNOWN', (statuses.get('UNKNOWN') ?? 0) + 1);
      domains.set('UNKNOWN', (domains.get('UNKNOWN') ?? 0) + 1);
      declineSemantics.unknown += 1;
      retryContext.UNKNOWN += 1;
      actionability.unknown += 1;
      continue;
    }

    const status = String(classification.transactionStatus);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    domains.set(classification.failureDomain, (domains.get(classification.failureDomain) ?? 0) + 1);

    const entry = codes.get(classification.code) ?? { count: 0, classification };
    entry.count += 1;
    codes.set(classification.code, entry);

    if (classification.declineType === 'HARD') declineSemantics.hard += 1;
    else if (classification.declineType === 'SOFT') declineSemantics.soft += 1;
    else if (classification.declineType === 'N_A') declineSemantics.notApplicable += 1;
    else declineSemantics.unknown += 1;

    retryContext[classification.retryAdvice] += 1;

    if (classification.actionability === 'ACTIONABLE') actionability.actionable += 1;
    else if (classification.actionability === 'ISSUER_SIDE') actionability.issuerSide += 1;
    else if (classification.actionability === 'LIMITED') actionability.limited += 1;
    else actionability.unknown += 1;

    if (classification.unknownCode) unknownCodes.add(classification.code);
  }

  const share = (n: number) => (totalFailures > 0 ? Number((n / totalFailures).toFixed(4)) : 0);

  return {
    totalAttempts,
    totalFailures,
    failureRate: totalAttempts > 0 ? Number((totalFailures / totalAttempts).toFixed(4)) : 0,
    statusDistribution: [...statuses.entries()]
      .map(([status, count]) => ({ status, count, share: share(count) }))
      .sort((a, b) => b.count - a.count),
    domainDistribution: [...domains.entries()]
      .map(([domain, count]) => ({ domain, count, share: share(count) }))
      .sort((a, b) => b.count - a.count),
    declineSemantics,
    retryContext,
    actionability,
    topResponseCodes: [...codes.entries()]
      .map(([code, { count, classification }]) => ({
        code,
        count,
        share: share(count),
        transactionStatus: String(classification!.transactionStatus),
        failureDomain: classification!.failureDomain,
        declineType: classification!.declineType,
        retryAdvice: classification!.retryAdvice,
        unknownCode: classification!.unknownCode,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    unknownCodes: [...unknownCodes],
  };
}
