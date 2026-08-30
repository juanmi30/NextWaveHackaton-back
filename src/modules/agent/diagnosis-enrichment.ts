import {
  DiagnosticDimensionsSchema,
  EnrichedAgentDiagnosisSchema,
  type AgentDiagnosis,
  type DiagnosticDimensions,
  type EnrichedAgentDiagnosis,
} from './schemas/agent-diagnosis.schema.js';

type StoredEvidence = {
  dimension: string;
  dimensionValue: string;
  baselineRate: number;
  observedRate: number;
  attempts: number;
  isRootCause: boolean;
};

type StoredDiagnosis = {
  dimensions: unknown;
  baselineRate: number;
  observedRate: number;
  baselineAttempts: number;
  observedAttempts: number;
  confidence: number;
  evidence: StoredEvidence[];
};

type EnrichmentIncident = {
  lossPerMinuteCents: number;
  averageTicketCents: number;
  detectionRun?: { params: unknown } | null;
  diagnoses: StoredDiagnosis[];
};

const DIMENSION_NAMES = [
  'merchant', 'provider', 'method', 'country', 'issuingBank', 'failureReason',
] as const;

export function enrichDiagnosis(
  baseDiagnosis: AgentDiagnosis,
  incident: EnrichmentIncident,
): EnrichedAgentDiagnosis {
  const latest = incident.diagnoses.at(-1);
  const controls = (latest?.evidence ?? [])
    .filter((row) => row.dimension === 'controlSibling')
    .map((row) => ({ row, scope: parseDiagnosticDimensions(row.dimensionValue) }));
  const validControls = controls.filter(({ scope }) => hasDimensions(scope));
  const score = clamp(baseDiagnosis.rootCause?.confidence ?? latest?.confidence ?? 0);
  const minSampleSize = readMinSampleSize(incident.detectionRun?.params);
  const limitations = buildLimitations(baseDiagnosis, latest, validControls.length, minSampleSize);
  const factors = buildFactors(baseDiagnosis, latest, validControls.length, minSampleSize);
  const trace = buildTrace(baseDiagnosis, latest, validControls);
  const approvalsPerMinute = incident.averageTicketCents > 0
    ? round2(incident.lossPerMinuteCents / incident.averageTicketCents)
    : null;

  return EnrichedAgentDiagnosisSchema.parse({
    ...baseDiagnosis,
    confidenceAnalysis: {
      score,
      level: score >= 0.7 ? 'HIGH' : score >= 0.4 ? 'MEDIUM' : 'LOW',
      factors,
      limitations,
    },
    ruledOutHypotheses: validControls.map(({ scope }) => ({
      hypothesis: ruledOutStatement(baseDiagnosis.affectedScope, scope),
      reason: `${formatScope(scope)} remains within its expected approval range and acts as a healthy control.`,
      controlScope: scope,
    })),
    counterfactualImpact: {
      estimatedRecoverableApprovalsPerMinute: approvalsPerMinute,
      estimatedRecoverableApprovalsPerHour:
        approvalsPerMinute === null ? null : round2(approvalsPerMinute * 60),
      estimatedRecoverableRevenuePerHourCents: incident.lossPerMinuteCents * 60,
    },
    diagnosisTrace: trace,
  });
}

export function parseDiagnosticDimensions(segmentKey: string): DiagnosticDimensions {
  const parsed: Record<string, string> = {};
  for (const part of segmentKey.split('|')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (DIMENSION_NAMES.includes(name as (typeof DIMENSION_NAMES)[number]) && value) {
      parsed[name] = value;
    }
  }
  return DiagnosticDimensionsSchema.parse(
    Object.fromEntries(DIMENSION_NAMES.map((name) => [name, parsed[name] ?? null])),
  );
}

function buildFactors(
  diagnosis: AgentDiagnosis,
  latest: StoredDiagnosis | undefined,
  controlCount: number,
  minSampleSize: number | null,
): EnrichedAgentDiagnosis['confidenceAnalysis']['factors'] {
  const observedAttempts = latest?.observedAttempts ?? 0;
  const baselineAttempts = latest?.baselineAttempts ?? 0;
  const drop = latest ? Math.max(0, latest.baselineRate - latest.observedRate) : 0;
  return [
    {
      code: 'OBSERVED_SAMPLE',
      effect: observedAttempts > 0 && (minSampleSize === null || observedAttempts >= minSampleSize)
        ? 'SUPPORTS' : 'LIMITS',
      statement: `${observedAttempts} observed attempts are stored for the latest diagnosis.`,
    },
    {
      code: 'BASELINE_SAMPLE',
      effect: baselineAttempts > 0 ? 'SUPPORTS' : 'LIMITS',
      statement: `${baselineAttempts} baseline attempts are stored for comparison.`,
    },
    {
      code: 'DROP_MAGNITUDE',
      effect: drop > 0 ? 'SUPPORTS' : 'NEUTRAL',
      statement: `Stored approval-rate difference is ${round4(drop)}.`,
    },
    {
      code: 'HEALTHY_SIBLINGS',
      effect: controlCount > 0 ? 'SUPPORTS' : 'LIMITS',
      statement: `${controlCount} healthy sibling control${controlCount === 1 ? '' : 's'} ${controlCount === 1 ? 'is' : 'are'} stored.`,
    },
    {
      code: 'ROOT_CAUSE_ISOLATION',
      effect: diagnosis.rootCause ? 'SUPPORTS' : 'LIMITS',
      statement: diagnosis.rootCause
        ? 'Stored evidence supports an isolated root cause.'
        : 'Stored evidence does not isolate a root cause.',
    },
  ];
}

function buildLimitations(
  diagnosis: AgentDiagnosis,
  latest: StoredDiagnosis | undefined,
  controlCount: number,
  minSampleSize: number | null,
) {
  const limitations: string[] = [];
  if (controlCount === 0) limitations.push('No healthy sibling controls were stored for this diagnosis.');
  if (!diagnosis.rootCause) limitations.push('Root cause could not be isolated from the available evidence.');
  if (
    minSampleSize !== null && latest &&
    latest.observedAttempts >= minSampleSize && latest.observedAttempts <= minSampleSize * 1.25
  ) {
    limitations.push('Observed sample is close to the detector minimum sample threshold.');
  }
  return limitations;
}

function buildTrace(
  diagnosis: AgentDiagnosis,
  latest: StoredDiagnosis | undefined,
  controls: Array<{ row: StoredEvidence; scope: DiagnosticDimensions }>,
): EnrichedAgentDiagnosis['diagnosisTrace'] {
  const trace: EnrichedAgentDiagnosis['diagnosisTrace'] = [{
    order: 1,
    type: 'AFFECTED_SCOPE',
    scope: dimensionsFromUnknown(latest?.dimensions),
    statement: `Approval degradation detected for ${formatScope(dimensionsFromUnknown(latest?.dimensions))}.`,
    baselineValue: latest?.baselineRate ?? null,
    observedValue: latest?.observedRate ?? null,
    attempts: latest?.observedAttempts ?? null,
  }];
  for (const { row, scope } of controls) {
    trace.push({
      order: trace.length + 1,
      type: 'HEALTHY_CONTROL',
      scope,
      statement: `${formatScope(scope)} remains within its expected range and acts as a healthy control.`,
      baselineValue: row.baselineRate,
      observedValue: row.observedRate,
      attempts: row.attempts,
    });
  }
  if (diagnosis.evidenceStatus === 'SUFFICIENT' && diagnosis.rootCause) {
    const rootEvidence = latest?.evidence.find((row) =>
      row.isRootCause &&
      row.dimension in diagnosis.rootCause!.dimensions &&
      diagnosis.rootCause!.dimensions[row.dimension as keyof DiagnosticDimensions] === row.dimensionValue,
    );
    trace.push({
      order: trace.length + 1,
      type: 'ROOT_CAUSE',
      scope: diagnosis.rootCause.dimensions,
      statement: `Stored evidence isolates ${formatScope(diagnosis.rootCause.dimensions)} as the supported root cause.`,
      baselineValue: rootEvidence?.baselineRate ?? null,
      observedValue: rootEvidence?.observedRate ?? null,
      attempts: rootEvidence?.attempts ?? null,
    });
  } else {
    trace.push({
      order: trace.length + 1,
      type: 'INSUFFICIENT_EVIDENCE',
      scope: diagnosis.affectedScope,
      statement: 'Stored evidence confirms the affected scope but does not isolate a supported root cause.',
      baselineValue: latest?.baselineRate ?? null,
      observedValue: latest?.observedRate ?? null,
      attempts: latest?.observedAttempts ?? null,
    });
  }
  return trace;
}

function ruledOutStatement(affected: DiagnosticDimensions, control: DiagnosticDimensions) {
  const differences = DIMENSION_NAMES.filter(
    (name) => affected[name] !== null && control[name] !== null && affected[name] !== control[name],
  );
  const shared = Object.fromEntries(DIMENSION_NAMES.map((name) => [
    name, affected[name] !== null && affected[name] === control[name] ? affected[name] : null,
  ])) as DiagnosticDimensions;
  const subject = differences.length > 0 ? differences.join(' and ') : 'the broader payment scope';
  return `The degradation affects all ${subject}${hasDimensions(shared) ? ` in ${formatScope(shared)}` : ''}.`;
}

function dimensionsFromUnknown(value: unknown): DiagnosticDimensions {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return DiagnosticDimensionsSchema.parse(Object.fromEntries(
    DIMENSION_NAMES.map((name) => [name, typeof source[name] === 'string' ? source[name] : null]),
  ));
}

function formatScope(scope: DiagnosticDimensions) {
  const values = DIMENSION_NAMES.flatMap((name) => scope[name] === null ? [] : [`${name}=${scope[name]}`]);
  return values.length > 0 ? values.join(', ') : 'the stored incident scope';
}

function hasDimensions(scope: DiagnosticDimensions) {
  return DIMENSION_NAMES.some((name) => scope[name] !== null);
}

function readMinSampleSize(params: unknown) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>).minSampleSize;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

function round4(value: number) {
  return Number(value.toFixed(4));
}
