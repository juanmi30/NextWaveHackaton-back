import { describe, expect, it } from 'vitest';
import { buildExplanation, type ExplanationInput } from './explanation.js';

const SPANISH_COPY = /Confianza|caída|intentos|evidencia insuficiente/i;

function input(overrides: Partial<ExplanationInput> = {}): ExplanationInput {
  return {
    dimensions: { merchant: 'Mercado Uno', country: 'BR', issuingBank: 'Nubank' },
    expectedRate: 0.91,
    observedRate: 0.41,
    observedAttempts: 485,
    baselineAttempts: 1_000,
    confidence: 0.99,
    lossPerMinuteCents: 346_210,
    lostApprovals: 200,
    startedAt: new Date('2026-08-29T12:00:00.000Z'),
    baselineSource: 'exact',
    ...overrides,
  };
}

describe('buildExplanation English copy', () => {
  it('generates English incident descriptions, recommendation, and confidence copy', () => {
    const result = buildExplanation(input());

    expect(result.summaryOps).toContain('Approval-rate drop');
    expect(result.summaryOps).toContain('merchant Mercado Uno');
    expect(result.summaryExec).toContain('is costing approximately');
    expect(result.recommendation).toContain('Suggested operator action');
    expect(result.confidenceStatement).toContain('High confidence (99.0%)');
    expect(JSON.stringify(result)).not.toMatch(SPANISH_COPY);
  });

  it('generates English insufficient-evidence copy', () => {
    const result = buildExplanation(input({ baselineSource: 'none' }));
    expect(result.confidenceStatement).toContain('Insufficient evidence');
    expect(JSON.stringify(result)).not.toMatch(SPANISH_COPY);
  });
});
