import { describe, expect, it } from 'vitest';
import {
  calculateEconomicImpact,
  calculateIncidentPriority,
  evaluateAnomaly,
  hasSustainedRecovery,
  isAnomalyConfirmed,
  rootCauseConfidence,
  topDeclineReasons,
} from './detection-metrics.js';

const thresholds = {
  minSampleSize: 20,
  minDrop: 0.1,
  minZScore: 2.5,
  minConfidence: 0.35,
};

describe('false-positive suppression', () => {
  it('suppresses a large drop with only four transactions', () => {
    expect(
      evaluateAnomaly({ attempts: 4, drop: 0.2, zScore: 4, confidence: 0.9, ...thresholds }),
    ).toMatchObject({ enoughSample: false, finalCandidate: false });
  });

  it('suppresses a 0.5pp drop even with a large sample', () => {
    expect(
      evaluateAnomaly({ attempts: 10_000, drop: 0.005, zScore: 1, confidence: 0.9, ...thresholds }),
    ).toMatchObject({ absoluteDropSignificant: false, finalCandidate: false });
  });

  it('accepts a significant degradation', () => {
    expect(
      evaluateAnomaly({ attempts: 200, drop: 0.4, zScore: 6, confidence: 0.95, ...thresholds }),
    ).toMatchObject({ finalCandidate: true });
  });
});

describe('temporal confirmation and recovery', () => {
  it('waits on the first moderate run and confirms the second', () => {
    expect(
      isAnomalyConfirmed({
        anchor: 'provider=Adyen',
        confirmationRuns: 2,
        previousCandidateAnchors: [],
        severe: false,
      }),
    ).toBe(false);
    expect(
      isAnomalyConfirmed({
        anchor: 'provider=Adyen',
        confirmationRuns: 2,
        previousCandidateAnchors: [['provider=Adyen']],
        severe: false,
      }),
    ).toBe(true);
  });

  it('confirms a severe anomaly on its first run', () => {
    expect(
      isAnomalyConfirmed({
        anchor: 'provider=Adyen',
        confirmationRuns: 2,
        previousCandidateAnchors: [],
        severe: true,
      }),
    ).toBe(true);
  });

  it('keeps an incident after one healthy run and resolves after two', () => {
    expect(
      hasSustainedRecovery({
        anchor: 'provider=Adyen',
        recoveryRuns: 2,
        recentCandidateAnchors: [[]],
      }),
    ).toBe(false);
    expect(
      hasSustainedRecovery({
        anchor: 'provider=Adyen',
        recoveryRuns: 2,
        recentCandidateAnchors: [[], []],
      }),
    ).toBe(true);
  });
});

describe('economic impact and deterministic priority', () => {
  it('calculates a known impact exactly from stored USD cents', () => {
    expect(
      calculateEconomicImpact({
        attempts: 100,
        approved: 50,
        baselineRate: 0.9,
        amountUsdCents: 1_000_000,
        windowMinutes: 10,
      }),
    ).toEqual({
      expectedApprovals: 90,
      actualApprovals: 50,
      lostApprovals: 40,
      averageTicketCents: 10_000,
      lossPerMinuteCents: 40_000,
    });
  });

  it('ranks the higher canonical loss first', () => {
    const low = calculateIncidentPriority({
      lossPerMinuteCents: 100_000,
      severity: 4,
      confidence: 0.99,
      lostApprovals: 100,
    });
    const high = calculateIncidentPriority({
      lossPerMinuteCents: 400_000,
      severity: 2,
      confidence: 0.6,
      lostApprovals: 20,
    });
    expect(high).toBeGreaterThan(low);
  });
});

describe('diagnostic confidence and decline codes', () => {
  it('gives exact segment evidence more root-cause confidence than platform fallback', () => {
    expect(rootCauseConfidence(0.9, 'segment_hour', false)).toBeGreaterThan(
      rootCauseConfidence(0.9, 'platform_global', false),
    );
  });

  it('orders decline codes by observed count and calculates baseline deltas', () => {
    expect(topDeclineReasons({ DO_NOT_HONOR: 62, TIMEOUT: 20 }, { DO_NOT_HONOR: 20, TIMEOUT: 20 })).toEqual([
      {
        code: 'DO_NOT_HONOR',
        count: 62,
        shareOfDeclines: 0.7561,
        baselineShare: 0.5,
        shareDelta: 0.2561,
      },
      {
        code: 'TIMEOUT',
        count: 20,
        shareOfDeclines: 0.2439,
        baselineShare: 0.5,
        shareDelta: -0.2561,
      },
    ]);
  });
});
