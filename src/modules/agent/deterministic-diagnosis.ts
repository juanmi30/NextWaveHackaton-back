import { getCanonicalIncidentImpact } from './canonical-incident-impact.js';
import { AgentDiagnosisSchema, type AgentDiagnosis } from './schemas/agent-diagnosis.schema.js';

type StoredEvidence = {
  dimension: string;
  dimensionValue: string;
  baselineRate: number;
  observedRate: number;
  attempts: number;
  confidence: number;
  isRootCause: boolean;
};

type StoredDiagnosis = {
  dimensions: unknown;
  baselineRate: number;
  observedRate: number;
  confidence: number;
  evidence: StoredEvidence[];
};

type StoredIncident = {
  id: string;
  lossPerMinuteCents: number;
  startedAt: Date | null;
  summaryOps: string | null;
  summaryExec: string | null;
  recommendation: string | null;
  confidenceStatement: string | null;
  diagnoses: StoredDiagnosis[];
};

type IncidentHistory = {
  isRecurrence: boolean;
  previousOccurrences: unknown[];
};

const DIMENSIONS = [
  'merchant',
  'provider',
  'method',
  'country',
  'issuingBank',
  'failureReason',
] as const;

export function buildDeterministicDiagnosis(
  incident: StoredIncident,
  history: IncidentHistory,
): AgentDiagnosis {
  const latest = incident.diagnoses.at(-1);
  const storedDimensions = asDimensions(latest?.dimensions);
  const affectedScope = Object.fromEntries(
    DIMENSIONS.map((name) => [name, storedDimensions[name] ?? null]),
  );
  const rootEvidence = (latest?.evidence ?? []).filter(
    (row) => row.isRootCause && DIMENSIONS.includes(row.dimension as (typeof DIMENSIONS)[number]),
  );
  const sufficient = Boolean(latest && rootEvidence.length > 0);
  const rootDimensions = Object.fromEntries(DIMENSIONS.map((name) => [name, null])) as Record<
    (typeof DIMENSIONS)[number],
    string | null
  >;
  for (const row of rootEvidence) {
    rootDimensions[row.dimension as (typeof DIMENSIONS)[number]] = row.dimensionValue;
  }

  return AgentDiagnosisSchema.parse({
    incidentId: incident.id,
    evidenceStatus: sufficient ? 'SUFFICIENT' : 'INSUFFICIENT',
    affectedScope,
    rootCause: sufficient
      ? {
          statement: `Stored evidence isolates ${rootEvidence
            .map((row) => `${row.dimension}=${row.dimensionValue}`)
            .join(', ')}.`,
          dimensions: rootDimensions,
          confidence: Math.min(latest?.confidence ?? 0, ...rootEvidence.map((row) => row.confidence)),
        }
      : null,
    impact: getCanonicalIncidentImpact(incident),
    evidence: (latest?.evidence ?? []).map((row) => ({
      statement:
        `${row.dimension}=${row.dimensionValue}: observed approval rate ${row.observedRate} ` +
        `versus stored comparison rate ${row.baselineRate} across ${row.attempts} attempts.`,
      metric: 'approvalRate',
      baselineValue: row.baselineRate,
      observedValue: row.observedRate,
      attempts: row.attempts,
    })),
    recurrence: {
      isRecurrence: history.isRecurrence,
      previousOccurrenceCount: history.previousOccurrences.length,
    },
    recommendation: {
      action: buildRecommendation(storedDimensions),
      requiresHumanApproval: true,
    },
    summaries: {
      operations: buildOperationsSummary(incident.id, storedDimensions, latest),
      executive: `Payment incident ${incident.id} is active, with estimated payment volume at risk of $${(
        incident.lossPerMinuteCents / 100
      ).toFixed(2)} per minute, and requires human review.`,
    },
  });
}

function buildRecommendation(dimensions: Record<string, string | null>) {
  return `Review the stored evidence for ${formatScope(dimensions)} and evaluate mitigation options. Human approval is required before any action.`;
}

function buildOperationsSummary(
  incidentId: string,
  dimensions: Record<string, string | null>,
  latest: StoredDiagnosis | undefined,
) {
  if (!latest) {
    return `Incident ${incidentId} affects ${formatScope(dimensions)}, but the stored evidence is insufficient to isolate a supported root cause.`;
  }
  return `Incident ${incidentId} affects ${formatScope(dimensions)}. Expected approval rate is ${(
    latest.baselineRate * 100
  ).toFixed(1)}%, observed approval rate is ${(latest.observedRate * 100).toFixed(1)}%.`;
}

function formatScope(dimensions: Record<string, string | null>) {
  const values = DIMENSIONS.flatMap((name) =>
    dimensions[name] ? [`${name}=${dimensions[name]}`] : [],
  );
  return values.length > 0 ? values.join(', ') : 'the stored payment scope';
}

function asDimensions(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | null] =>
        typeof entry[1] === 'string' || entry[1] === null,
    ),
  );
}
