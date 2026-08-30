import { describe, expect, it } from 'vitest';
import { buildDeterministicDiagnosis } from './deterministic-diagnosis.js';

function incident(root = true) {
  return {
    id: 'incident-1', lossPerMinuteCents: 12345, startedAt: new Date('2026-01-01T00:00:00Z'),
    summaryOps: null, summaryExec: null, recommendation: null, confidenceStatement: null,
    diagnoses: [{ dimensions: { provider: 'Adyen' }, baselineRate: 0.9, observedRate: 0.4,
      confidence: 0.7, evidence: root ? [{ dimension: 'provider', dimensionValue: 'Adyen',
        baselineRate: 0.9, observedRate: 0.4, attempts: 100, confidence: 0.6, isRootCause: true }] : [] }],
  };
}

const SPANISH_COPY = /Confianza|caída|intentos|evidencia insuficiente/i;

describe('buildDeterministicDiagnosis', () => {
  it('uses exact canonical stored impact', () => {
    expect(buildDeterministicDiagnosis(incident(), { isRecurrence: false, previousOccurrences: [] }).impact)
      .toEqual({ expectedApprovalRate: 0.9, observedApprovalRate: 0.4,
        lossPerMinuteCents: 12345, startedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('fills every affected-scope dimension with null when unknown', () => {
    expect(buildDeterministicDiagnosis(incident(), { isRecurrence: false, previousOccurrences: [] }).affectedScope)
      .toEqual({ merchant: null, provider: 'Adyen', method: null, country: null,
        issuingBank: null, failureReason: null });
  });

  it('uses only stored root-cause evidence as discriminating dimensions', () => {
    const diagnosis = buildDeterministicDiagnosis(incident(), { isRecurrence: false, previousOccurrences: [] });
    expect(diagnosis.rootCause?.dimensions.provider).toBe('Adyen');
    expect(diagnosis.rootCause?.dimensions.method).toBeNull();
    expect(diagnosis.rootCause?.confidence).toBe(0.6);
  });

  it('returns insufficient evidence with null root cause when root evidence is absent', () => {
    const diagnosis = buildDeterministicDiagnosis(
      incident(false),
      { isRecurrence: false, previousOccurrences: [] },
    );
    expect(diagnosis).toMatchObject({ evidenceStatus: 'INSUFFICIENT', rootCause: null });
    expect(JSON.stringify(diagnosis)).not.toMatch(SPANISH_COPY);
  });

  it('returns English copy even when legacy stored incident prose is Spanish', () => {
    const stored = {
      ...incident(),
      summaryOps: 'Caída de aprobación sobre 100 intentos.',
      summaryExec: 'Incidente activo.',
      recommendation: 'Recomendación manual.',
      confidenceStatement: 'Confianza alta sobre el segmento.',
    };
    const diagnosis = buildDeterministicDiagnosis(stored, {
      isRecurrence: false,
      previousOccurrences: [],
    });

    expect(diagnosis.rootCause?.statement).toContain('Stored evidence isolates');
    expect(diagnosis.recommendation.action).toContain('Review');
    expect(diagnosis.summaries.operations).toContain('Expected approval rate');
    expect(diagnosis.summaries.executive).toContain('Payment incident');
    expect(JSON.stringify(diagnosis)).not.toMatch(SPANISH_COPY);
  });

  it('always requires human approval and uses conservative fallback text', () => {
    const diagnosis = buildDeterministicDiagnosis(incident(), { isRecurrence: false, previousOccurrences: [] });
    expect(diagnosis.recommendation.requiresHumanApproval).toBe(true);
    expect(diagnosis.recommendation.action).toContain('Review');
  });

  it('maps recurrence from backend history', () => {
    expect(buildDeterministicDiagnosis(incident(), { isRecurrence: true, previousOccurrences: [{}, {}] }).recurrence)
      .toEqual({ isRecurrence: true, previousOccurrenceCount: 2 });
  });
});
