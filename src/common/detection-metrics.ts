export type AnomalyEvaluationInput = {
  attempts: number;
  drop: number;
  zScore: number;
  confidence: number;
  minSampleSize: number;
  minDrop: number;
  minZScore: number;
  minConfidence: number;
};

export function evaluateAnomaly(input: AnomalyEvaluationInput) {
  const enoughSample = input.attempts >= input.minSampleSize;
  const absoluteDropSignificant = input.drop >= input.minDrop;
  const statisticallySignificant = input.zScore >= input.minZScore;
  const enoughConfidence = input.confidence >= input.minConfidence;
  return {
    enoughSample,
    absoluteDropSignificant,
    statisticallySignificant,
    enoughConfidence,
    finalCandidate:
      enoughSample && absoluteDropSignificant && statisticallySignificant && enoughConfidence,
  };
}

export function calculateEconomicImpact(input: {
  attempts: number;
  approved: number;
  baselineRate: number;
  amountUsdCents: number;
  windowMinutes: number;
}) {
  const expectedApprovals = Math.round(input.attempts * input.baselineRate);
  const actualApprovals = input.approved;
  const lostApprovals = Math.max(0, expectedApprovals - actualApprovals);
  const averageTicketCents =
    input.attempts > 0 ? Math.round(input.amountUsdCents / input.attempts) : 0;
  const lossPerMinuteCents =
    input.windowMinutes > 0
      ? Math.round((lostApprovals * averageTicketCents) / input.windowMinutes)
      : 0;
  return {
    expectedApprovals,
    actualApprovals,
    lostApprovals,
    averageTicketCents,
    lossPerMinuteCents,
  };
}

export function calculateIncidentPriority(input: {
  lossPerMinuteCents: number;
  severity: number;
  confidence: number;
  lostApprovals: number;
  evidenceSufficient?: boolean;
}) {
  const evidenceFactor = input.evidenceSufficient === false ? 0.5 : 1;
  const economic = input.lossPerMinuteCents * evidenceFactor;
  return Number(
    (
      economic * 1_000 +
      input.severity * 10 +
      input.confidence +
      Math.min(input.lostApprovals, 999) / 1_000
    ).toFixed(3),
  );
}

export function rootCauseConfidence(
  anomalyConfidence: number,
  baselineSource: string,
  hasHealthySibling: boolean,
) {
  const fallbackFactor = baselineSource.startsWith('platform_')
    ? 0.65
    : baselineSource.startsWith('ancestor_')
      ? 0.82
      : 1;
  const siblingFactor = hasHealthySibling ? 1 : 0.8;
  return Number(Math.min(1, anomalyConfidence * fallbackFactor * siblingFactor).toFixed(4));
}

export function isSevereAnomaly(input: {
  drop: number;
  zScore: number;
  confidence: number;
  lossPerMinuteCents: number;
}) {
  return (
    (input.drop >= 0.35 && input.zScore >= 4 && input.confidence >= 0.75) ||
    (input.drop >= 0.25 && input.confidence >= 0.85 && input.lossPerMinuteCents >= 100_000)
  );
}

export function isAnomalyConfirmed(input: {
  anchor: string;
  confirmationRuns: number;
  previousCandidateAnchors: string[][];
  severe: boolean;
}) {
  if (input.severe || input.confirmationRuns <= 1) return true;
  const requiredPrevious = input.confirmationRuns - 1;
  return (
    input.previousCandidateAnchors.length >= requiredPrevious &&
    input.previousCandidateAnchors
      .slice(0, requiredPrevious)
      .every((anchors) => anchors.includes(input.anchor))
  );
}

export function hasSustainedRecovery(input: {
  anchor: string;
  recoveryRuns: number;
  recentCandidateAnchors: string[][];
}) {
  return (
    input.recentCandidateAnchors.length >= input.recoveryRuns &&
    input.recentCandidateAnchors
      .slice(0, input.recoveryRuns)
      .every((anchors) => !anchors.includes(input.anchor))
  );
}

export type DeclineReasonRow = {
  code: string;
  count: number;
  shareOfDeclines: number;
  baselineShare: number | null;
  shareDelta: number | null;
};

export function topDeclineReasons(
  current: Record<string, number>,
  baseline: Record<string, number> = {},
  limit = 3,
): DeclineReasonRow[] {
  const total = Object.values(current).reduce((sum, count) => sum + count, 0);
  const baselineTotal = Object.values(baseline).reduce((sum, count) => sum + count, 0);
  return Object.entries(current)
    .map(([code, count]) => {
      const shareOfDeclines = total > 0 ? count / total : 0;
      const baselineShare = baselineTotal > 0 ? (baseline[code] ?? 0) / baselineTotal : null;
      return {
        code,
        count,
        shareOfDeclines: Number(shareOfDeclines.toFixed(4)),
        baselineShare: baselineShare === null ? null : Number(baselineShare.toFixed(4)),
        shareDelta:
          baselineShare === null ? null : Number((shareOfDeclines - baselineShare).toFixed(4)),
      };
    })
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
    .slice(0, limit);
}
