import { describe, expect, it } from 'vitest';
import { AgentDiagnosisSchema } from './agent-diagnosis.schema.js';

const sufficientDiagnosis = {
  incidentId: 'incident-1',
  evidenceStatus: 'SUFFICIENT',
  rootCause: {
    statement: 'The degradation is isolated to one provider.',
    dimensions: {
      merchant: null,
      provider: 'Adyen',
      method: null,
      country: null,
      issuingBank: null,
      failureReason: null,
    },
    confidence: 0.91,
  },
  impact: {
    expectedApprovalRate: 0.9,
    observedApprovalRate: 0.42,
    lossPerMinuteCents: 12500,
    startedAt: '2026-08-29T12:00:00.000Z',
  },
  evidence: [
    {
      statement: 'Approval rate fell for Adyen.',
      metric: 'approvalRate',
      baselineValue: 0.9,
      observedValue: 0.42,
      attempts: 120,
    },
  ],
  recurrence: { isRecurrence: false, previousOccurrenceCount: 0 },
  recommendation: { action: 'Review the affected route.', requiresHumanApproval: true },
  summaries: {
    operations: 'Adyen approval performance is degraded.',
    executive: 'Adyen degradation is causing an estimated payment loss.',
  },
} as const;

describe('AgentDiagnosisSchema', () => {
  it('accepts a sufficient diagnosis', () => {
    expect(AgentDiagnosisSchema.safeParse(sufficientDiagnosis).success).toBe(true);
  });

  it('accepts an insufficient diagnosis with a null root cause', () => {
    const diagnosis = {
      ...sufficientDiagnosis,
      evidenceStatus: 'INSUFFICIENT',
      rootCause: null,
      impact: {
        expectedApprovalRate: null,
        observedApprovalRate: null,
        lossPerMinuteCents: null,
        startedAt: null,
      },
      evidence: [],
    };

    expect(AgentDiagnosisSchema.safeParse(diagnosis).success).toBe(true);
  });

  it('rejects confidence outside the 0..1 range', () => {
    const diagnosis = {
      ...sufficientDiagnosis,
      rootCause: { ...sufficientDiagnosis.rootCause, confidence: 1.1 },
    };

    expect(AgentDiagnosisSchema.safeParse(diagnosis).success).toBe(false);
  });

  it('rejects sufficient evidence with a null root cause', () => {
    const diagnosis = { ...sufficientDiagnosis, rootCause: null };

    expect(AgentDiagnosisSchema.safeParse(diagnosis).success).toBe(false);
  });

  it('rejects insufficient evidence with a non-null root cause', () => {
    const diagnosis = { ...sufficientDiagnosis, evidenceStatus: 'INSUFFICIENT' };

    expect(AgentDiagnosisSchema.safeParse(diagnosis).success).toBe(false);
  });

  it('rejects recommendations that do not require human approval', () => {
    const diagnosis = {
      ...sufficientDiagnosis,
      recommendation: { ...sufficientDiagnosis.recommendation, requiresHumanApproval: false },
    };

    expect(AgentDiagnosisSchema.safeParse(diagnosis).success).toBe(false);
  });
});
