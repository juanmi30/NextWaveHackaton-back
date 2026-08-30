import { DIMENSIONS, type DimensionMap } from '../../common/dimensions.js';
import { buildExplanation } from '../detection/explanation.js';

type PresentationDiagnosis = {
  version?: number;
  dimensions: unknown;
  baselineRate: number;
  observedRate: number;
  baselineAttempts: number;
  observedAttempts: number;
  confidence: number;
};

type PresentableIncident = {
  id: string;
  lossPerMinuteCents: number;
  lostApprovals: number;
  startedAt: Date;
  diagnoses?: PresentationDiagnosis[];
  summaryOps?: string | null;
  summaryExec?: string | null;
  recommendation?: string | null;
  confidenceStatement?: string | null;
};

/**
 * Rebuilds API-facing incident copy from canonical structured data. Persisted
 * text is intentionally ignored so legacy and new incidents render uniformly.
 */
export function presentIncident<T extends PresentableIncident>(incident: T): T {
  if (
    typeof incident.lossPerMinuteCents !== 'number' ||
    typeof incident.lostApprovals !== 'number' ||
    !(incident.startedAt instanceof Date)
  ) {
    return incident;
  }

  const latest = latestDiagnosis(incident.diagnoses ?? []);
  if (!latest) {
    return {
      ...incident,
      summaryOps:
        `Payment degradation detected for incident ${incident.id}. ` +
        'Structured diagnosis metrics are unavailable.',
      summaryExec:
        `Estimated payment volume at risk is approximately ${formatUsd(incident.lossPerMinuteCents)} ` +
        `per minute since ${formatTime(incident.startedAt)}.`,
      recommendation:
        'Review the incident with Payments Operations before taking any remediation action.',
      confidenceStatement:
        'Insufficient evidence: no structured diagnosis is available for this incident.',
    };
  }

  const explanation = buildExplanation({
    dimensions: dimensionsFromUnknown(latest.dimensions),
    expectedRate: latest.baselineRate,
    observedRate: latest.observedRate,
    observedAttempts: latest.observedAttempts,
    baselineAttempts: latest.baselineAttempts,
    confidence: latest.confidence,
    lossPerMinuteCents: incident.lossPerMinuteCents,
    lostApprovals: incident.lostApprovals,
    startedAt: incident.startedAt,
    baselineSource: 'stored diagnosis',
  });

  return { ...incident, ...explanation };
}

function latestDiagnosis(diagnoses: PresentationDiagnosis[]) {
  if (diagnoses.length === 0) return undefined;
  if (diagnoses.every((diagnosis) => typeof diagnosis.version === 'number')) {
    return diagnoses.reduce((latest, diagnosis) =>
      diagnosis.version! > latest.version! ? diagnosis : latest,
    );
  }
  return diagnoses.at(-1);
}

function dimensionsFromUnknown(value: unknown): DimensionMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    DIMENSIONS.flatMap((dimension) =>
      typeof source[dimension] === 'string' ? [[dimension, source[dimension]]] : [],
    ),
  );
}

function formatUsd(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function formatTime(date: Date) {
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}
