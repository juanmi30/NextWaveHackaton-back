import { humanizeDimensions, type DimensionMap } from '../../common/dimensions.js';

export type ExplanationInput = {
  dimensions: DimensionMap;
  expectedRate: number;
  observedRate: number;
  observedAttempts: number;
  baselineAttempts: number;
  confidence: number;
  lossPerMinuteCents: number;
  lostApprovals: number;
  startedAt: Date;
  baselineSource: string;
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const hhmm = (date: Date) =>
  `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;

/**
 * Los textos se generan desde los datos, nunca desde plantillas por caso.
 * Una combinacion de dimensiones nunca vista produce una explicacion
 * igual de legible que una ensayada.
 */
export function buildExplanation(input: ExplanationInput) {
  const where = humanizeDimensions(input.dimensions);
  const drop = input.expectedRate - input.observedRate;

  const summaryOps =
    `Approval-rate drop in ${where}. ` +
    `Expected ${pct(input.expectedRate)}, observed ${pct(input.observedRate)} ` +
    `(-${pct(drop)}) across ${input.observedAttempts} attempts since ${hhmm(input.startedAt)}. ` +
    `Baseline built from ${input.baselineAttempts} transactions (${input.baselineSource}).`;

  const summaryExec =
    `Estimated payment volume at risk is approximately ${usd(input.lossPerMinuteCents)} per minute ` +
    `for ${where} since ${hhmm(input.startedAt)}.`;

  return {
    summaryOps,
    summaryExec,
    recommendation: buildRecommendation(input.dimensions),
    confidenceStatement: buildConfidenceStatement(input),
  };
}

/**
 * La recomendacion se deriva de QUE dimensiones componen el diagnostico,
 * no de sus valores. Un proveedor desconocido produce la misma
 * recomendacion util que uno conocido.
 */
function buildRecommendation(dimensions: DimensionMap): string {
  const keys = Object.keys(dimensions);
  const parts: string[] = [];

  if (keys.includes('provider')) {
    parts.push(`contact ${dimensions.provider} and evaluate routing traffic to an alternate provider`);
  }
  if (keys.includes('issuingBank')) {
    parts.push(`verify whether ${dimensions.issuingBank} is declining abnormally and evaluate an alternate route`);
  }
  if (keys.includes('method')) {
    parts.push(`review ${dimensions.method} availability and prioritize alternate payment methods`);
  }
  if (keys.includes('country')) {
    parts.push(`confirm whether the degradation is regional within ${dimensions.country}`);
  }
  if (keys.includes('merchant')) {
    parts.push(`review recent configuration changes for ${dimensions.merchant}`);
  }
  if (keys.includes('failureReason')) {
    parts.push(`analyze the concentration of response code ${dimensions.failureReason}`);
  }

  if (parts.length === 0) return 'Investigate the degradation with the operations team.';
  return `Suggested operator action: ${parts.join('; ')}. The system does not execute any action automatically.`;
}

function buildConfidenceStatement(input: ExplanationInput): string {
  if (input.baselineSource === 'none') {
    return 'Insufficient evidence: no historical baseline exists for this segment. The anomaly is reported without a confirmed diagnosis.';
  }
  if (input.confidence < 0.4) {
    return `Low confidence (${pct(input.confidence)}): the sample of ${input.observedAttempts} attempts is limited. Wait for more data before acting.`;
  }
  if (input.confidence < 0.7) {
    return `Medium confidence (${pct(input.confidence)}) with ${input.observedAttempts} observed attempts compared with ${input.baselineAttempts} baseline attempts.`;
  }
  return `High confidence (${pct(input.confidence)}): the degradation is consistent across ${input.observedAttempts} attempts and exceeds the segment's historical variance.`;
}
