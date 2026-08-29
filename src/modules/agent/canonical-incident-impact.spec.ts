import { describe, expect, it } from 'vitest';
import type { AgentDiagnosis } from './schemas/agent-diagnosis.schema.js';
import {
  enforceCanonicalIncidentImpact,
  getCanonicalIncidentImpact,
} from './canonical-incident-impact.js';

const modelDiagnosis = {
  incidentId: 'incident-1',
  evidenceStatus: 'INSUFFICIENT',
  affectedScope: {
    merchant: null,
    provider: null,
    method: null,
    country: null,
    issuingBank: null,
    failureReason: null,
  },
  rootCause: null,
  impact: {
    expectedApprovalRate: 0.5,
    observedApprovalRate: 0.2,
    lossPerMinuteCents: 999,
    startedAt: '2020-01-01T00:00:00.000Z',
  },
  evidence: [],
  recurrence: { isRecurrence: false, previousOccurrenceCount: 0 },
  recommendation: { action: 'Review manually', requiresHumanApproval: true },
  summaries: { operations: 'Operations summary', executive: 'Executive summary' },
} satisfies AgentDiagnosis;

describe('canonical incident impact', () => {
  it('overrides every model-generated impact value with stored incident values', () => {
    const incident = {
      lossPerMinuteCents: 346_210,
      startedAt: new Date('2026-08-29T12:00:00.000Z'),
      diagnoses: [
        { baselineRate: 0.8, observedRate: 0.6 },
        { baselineRate: 0.909, observedRate: 0.4149 },
      ],
    };

    const result = enforceCanonicalIncidentImpact(modelDiagnosis, incident);

    expect(result.impact).toEqual({
      expectedApprovalRate: 0.909,
      observedApprovalRate: 0.4149,
      lossPerMinuteCents: 346_210,
      startedAt: '2026-08-29T12:00:00.000Z',
    });
    expect(result).not.toBe(modelDiagnosis);
    expect(modelDiagnosis.impact.lossPerMinuteCents).toBe(999);
  });

  it('returns null rates safely when no stored diagnosis exists', () => {
    const impact = getCanonicalIncidentImpact({
      lossPerMinuteCents: 0,
      startedAt: null,
      diagnoses: [],
    });

    expect(impact).toEqual({
      expectedApprovalRate: null,
      observedApprovalRate: null,
      lossPerMinuteCents: 0,
      startedAt: null,
    });
  });
});
