import { describe, expect, it } from 'vitest';
import type { AgentDiagnosis } from './schemas/agent-diagnosis.schema.js';
import { enrichDiagnosis, parseDiagnosticDimensions } from './diagnosis-enrichment.js';

const dimensions = {
  merchant: null,
  provider: 'Adyen',
  method: null,
  country: 'BR',
  issuingBank: null,
  failureReason: null,
};

function diagnosis(sufficient = true): AgentDiagnosis {
  return {
    incidentId: 'incident-1',
    evidenceStatus: sufficient ? 'SUFFICIENT' : 'INSUFFICIENT',
    affectedScope: dimensions,
    rootCause: sufficient
      ? { statement: 'Adyen is isolated in BR.', dimensions, confidence: 0.82 }
      : null,
    impact: {
      expectedApprovalRate: 0.91,
      observedApprovalRate: 0.41,
      lossPerMinuteCents: 20_000,
      startedAt: '2026-08-29T12:00:00.000Z',
    },
    evidence: [],
    recurrence: { isRecurrence: false, previousOccurrenceCount: 0 },
    recommendation: { action: 'Review routing.', requiresHumanApproval: true },
    summaries: { operations: 'Stored operations.', executive: 'Stored executive.' },
  };
}

function incident(options: {
  control?: string;
  averageTicketCents?: number;
  root?: boolean;
  detectorConfidence?: number;
} = {}) {
  const evidence = options.control === undefined ? [] : [{
    dimension: 'controlSibling',
    dimensionValue: options.control,
    baselineRate: 0.9,
    observedRate: 0.89,
    attempts: 160,
    confidence: 0.8,
    isRootCause: false,
  }];
  if (options.root !== false) evidence.push({
    dimension: 'provider',
    dimensionValue: 'Adyen',
    baselineRate: 0.91,
    observedRate: 0.41,
    attempts: 180,
    confidence: 0.82,
    isRootCause: true,
  });
  return {
    lossPerMinuteCents: 20_000,
    averageTicketCents: options.averageTicketCents ?? 10_000,
    detectionRun: { params: { minSampleSize: 100 } },
    diagnoses: [{
      dimensions: { provider: 'Adyen', country: 'BR' },
      baselineRate: 0.91,
      observedRate: 0.41,
      baselineAttempts: 500,
      observedAttempts: 180,
      confidence: options.detectorConfidence ?? 0.77,
      evidence,
    }],
  };
}

describe('enrichDiagnosis', () => {
  it('explains sufficient evidence, healthy controls and canonical counterfactual impact', () => {
    const result = enrichDiagnosis(
      diagnosis(),
      incident({ control: 'country=BR|provider=Stripe' }),
    );

    expect(result.confidenceAnalysis).toMatchObject({
      detectorConfidence: 0.77,
      rootCauseConfidence: 0.82,
      score: 0.77,
      level: 'HIGH',
    });
    expect(result.ruledOutHypotheses).toHaveLength(1);
    expect(result.ruledOutHypotheses[0].controlScope).toEqual({
      merchant: null, provider: 'Stripe', method: null, country: 'BR',
      issuingBank: null, failureReason: null,
    });
    expect(result.counterfactualImpact).toEqual({
      estimatedRecoverableApprovalsPerMinute: 2,
      estimatedRecoverableApprovalsPerHour: 120,
      estimatedRecoverableRevenuePerHourCents: 1_200_000,
    });
    expect(result.diagnosisTrace.map((step) => step.type)).toEqual([
      'AFFECTED_SCOPE', 'HEALTHY_CONTROL', 'ROOT_CAUSE',
    ]);
  });

  it('ends an insufficient diagnosis with a factual limitation and no invented controls', () => {
    const result = enrichDiagnosis(diagnosis(false), incident({ root: false }));

    expect(result.rootCause).toBeNull();
    expect(result.confidenceAnalysis.limitations.length).toBeGreaterThan(0);
    expect(result.ruledOutHypotheses).toEqual([]);
    expect(result.diagnosisTrace.some((step) => step.type === 'ROOT_CAUSE')).toBe(false);
    expect(result.diagnosisTrace.at(-1)?.type).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('preserves positive detector confidence when Agent root-cause confidence is zero', () => {
    const baseDiagnosis = diagnosis();
    baseDiagnosis.rootCause!.confidence = 0;

    const result = enrichDiagnosis(baseDiagnosis, incident({ detectorConfidence: 0.8415 }));

    expect(result.confidenceAnalysis).toMatchObject({
      detectorConfidence: 0.8415,
      rootCauseConfidence: 0,
      score: 0.8415,
      level: 'HIGH',
    });
    expect(result.rootCause?.confidence).toBe(0);
  });

  it('keeps valid Agent root-cause confidence separate from detector confidence', () => {
    const result = enrichDiagnosis(diagnosis(), incident({ detectorConfidence: 0.64 }));

    expect(result.confidenceAnalysis).toMatchObject({
      detectorConfidence: 0.64,
      rootCauseConfidence: 0.82,
      score: 0.64,
      level: 'MEDIUM',
    });
    expect(result.rootCause?.confidence).toBe(0.82);
  });

  it('does not derive display confidence from sufficient evidence when detector confidence is absent', () => {
    const result = enrichDiagnosis(diagnosis(), {
      ...incident(),
      diagnoses: [],
    });

    expect(result.evidenceStatus).toBe('SUFFICIENT');
    expect(result.confidenceAnalysis).toMatchObject({
      detectorConfidence: null,
      rootCauseConfidence: 0.82,
      score: 0,
      level: 'LOW',
    });
  });

  it('returns nullable approval estimates when average ticket is zero', () => {
    const result = enrichDiagnosis(diagnosis(), incident({ averageTicketCents: 0 }));

    expect(result.counterfactualImpact.estimatedRecoverableApprovalsPerMinute).toBeNull();
    expect(result.counterfactualImpact.estimatedRecoverableApprovalsPerHour).toBeNull();
    expect(result.counterfactualImpact.estimatedRecoverableRevenuePerHourCents).toBe(1_200_000);
  });

  it('parses malformed control segment keys defensively and ignores unknown dimensions', () => {
    expect(() => parseDiagnosticDimensions('bad|unknown=value|provider=Stripe|country=')).not.toThrow();
    expect(parseDiagnosticDimensions('bad|unknown=value|provider=Stripe|country=')).toEqual({
      merchant: null, provider: 'Stripe', method: null, country: null,
      issuingBank: null, failureReason: null,
    });
  });
});
