import { describe, expect, it } from 'vitest';
import { presentIncident } from './incident-presentation.js';

function incident(summaryOps: string) {
  return {
    id: 'incident-1',
    lossPerMinuteCents: 707_400,
    lostApprovals: 131,
    startedAt: new Date('2026-08-30T10:15:00.000Z'),
    summaryOps,
    summaryExec: 'El incidente está causando pérdidas.',
    recommendation: 'Revisar el incidente.',
    confidenceStatement: 'Confianza alta.',
    diagnoses: [{
      version: 1,
      dimensions: {
        merchant: 'Nova Travel',
        country: 'CO',
        failureReason: 'EXPIRED_CARD',
      },
      baselineRate: 0.943,
      observedRate: 0,
      baselineAttempts: 70,
      observedAttempts: 131,
      confidence: 0.84,
    }],
  };
}

describe('presentIncident', () => {
  it('reconstructs legacy Spanish incident text from structured data', () => {
    const result = presentIncident(incident('Caída de aprobación en país CO.'));

    expect(result.summaryOps).toContain('Approval-rate drop');
    expect(result.summaryOps).toContain('country CO');
    expect(result.summaryExec).toContain('Estimated payment volume at risk');
    expect(result.summaryExec).not.toContain('costing');
    expect(result.recommendation).toContain('Suggested operator action');
    expect(result.confidenceStatement).toContain('High confidence');
    expect(JSON.stringify(result)).not.toMatch(/caída|país|pérdidas|revisar|confianza/iu);
  });

  it('uses the same canonical English presentation for newly persisted English text', () => {
    const result = presentIncident(incident('Previously generated English summary.'));

    expect(result.summaryOps).toContain('merchant Nova Travel');
    expect(result.summaryOps).toContain('decline reason EXPIRED_CARD');
    expect(result.summaryOps).not.toContain('Previously generated English summary');
  });

  it('preserves domain and machine values exactly', () => {
    const result = presentIncident(incident('Legacy copy'));

    expect(result.summaryOps).toContain('Nova Travel');
    expect(result.summaryOps).toContain('CO');
    expect(result.summaryOps).toContain('EXPIRED_CARD');
  });
});
