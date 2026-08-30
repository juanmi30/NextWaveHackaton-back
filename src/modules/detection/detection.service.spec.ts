import { describe, expect, it } from 'vitest';
import type { DimensionMap } from '../../common/dimensions.js';
import type { BaselineLookup } from '../baselines/baselines.service.js';
import {
  anchorFor,
  baselineConfidenceFactor,
  buildEvidenceRows,
  conflicts,
  detectionOutcome,
  incidentPersistenceDecision,
  nextDiagnosisVersion,
  prune,
  type Candidate,
} from './detection.service.js';

const baseline: BaselineLookup = {
  expectedRate: 0.9,
  variance: 0.02,
  sampleSize: 100,
  source: 'segment_hour',
  matchedSegmentKey: 'provider=Adyen',
  matchedDimensions: { provider: 'Adyen' },
  fallbackDepth: 0,
};

function candidate(dimensions: DimensionMap, confidence = 0.9): Candidate {
  const segmentKey = Object.entries(dimensions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
  return {
    dimensions,
    segmentKey,
    depth: Object.keys(dimensions).length,
    attempts: 100,
    approved: 30,
    observedRate: 0.3,
    amountUsdCents: 100_000,
    baseline,
    drop: 0.6,
    z: 5,
    confidence,
    lostApprovals: 60,
    averageTicketCents: 1_000,
    lossPerMinuteCents: 4_000,
    severity: 4,
    anomalyConfidence: confidence,
    rootCauseConfidence: confidence,
    priorityScore: 4_000_040,
  };
}

describe('detection candidate families', () => {
  it.each([
    [{ provider: 'Adyen', country: 'BR' }, { provider: 'Adyen', country: 'MX' }],
    [{ country: 'BR', provider: 'Adyen' }, { country: 'BR', provider: 'Stripe' }],
    [{ merchant: 'M1', issuingBank: 'BankA' }, { merchant: 'M1', issuingBank: 'BankB' }],
  ])('keeps conflicting degradations as separate incidents', (left, right) => {
    const candidates = [candidate(left), candidate(right)];
    expect(conflicts(left, right)).toBe(true);
    expect(prune(candidates)).toHaveLength(2);
  });

  it('keeps one refinement story and prefers the most specific candidate', () => {
    const candidates = [
      candidate({ provider: 'Adyen' }),
      candidate({ provider: 'Adyen', country: 'BR' }),
      candidate({ provider: 'Adyen', country: 'BR', method: 'CARD' }),
    ];

    expect(prune(candidates)).toEqual([candidates[2]]);
  });

  it('does not merge compatible candidates without parent-child or bridge evidence', () => {
    const candidates = [
      candidate({ provider: 'Adyen', country: 'BR' }),
      candidate({ merchant: 'M1', issuingBank: 'BankA' }),
    ];

    expect(conflicts(candidates[0]!.dimensions, candidates[1]!.dimensions)).toBe(false);
    expect(prune(candidates)).toHaveLength(2);
  });
});

describe('detection anchors and outcomes', () => {
  it.each([
    [
      { provider: 'Adyen', country: 'BR' },
      { provider: 'Adyen', country: 'MX' },
    ],
    [
      { country: 'BR', provider: 'Adyen' },
      { country: 'BR', provider: 'Stripe' },
    ],
  ])('creates distinct minimal anchors for simultaneous winners', (left, right) => {
    const winners = [candidate(left), candidate(right)];
    expect(anchorFor(winners[0]!, winners, winners)).not.toBe(anchorFor(winners[1]!, winners, winners));
  });

  it('penalizes weaker baselines without increasing confidence', () => {
    expect(baselineConfidenceFactor('segment_hour')).toBe(1);
    expect(baselineConfidenceFactor('ancestor_global')).toBe(0.85);
    expect(baselineConfidenceFactor('platform_global')).toBe(0.65);
  });

  it('distinguishes outcome semantics by evaluated evidence', () => {
    expect(detectionOutcome(1, 10, 10)).toBe('INCIDENTS_FOUND');
    expect(detectionOutcome(0, 10, 0)).toBe('INSUFFICIENT_EVIDENCE');
    expect(detectionOutcome(0, 10, 10)).toBe('NO_ANOMALY');
  });
});

describe('incident persistence and evidence', () => {
  it('reuses the same incident and increments diagnosis versions', () => {
    expect(incidentPersistenceDecision({ id: 'X', fingerprint: 'provider=Adyen' }, 'provider=Adyen')).toEqual({
      incidentId: 'X',
      isNew: false,
      refined: false,
    });
    expect(nextDiagnosisVersion(1)).toBe(2);
  });

  it('keeps the incident id when diagnosis becomes more specific', () => {
    expect(
      incidentPersistenceDecision(
        { id: 'X', fingerprint: 'country=BR|provider=Adyen' },
        'country=BR|issuingBank=Bradesco|provider=Adyen',
      ),
    ).toMatchObject({ incidentId: 'X', isNew: false, refined: true });
    expect(nextDiagnosisVersion(2)).toBe(3);
  });

  it('includes a healthy sibling control when one exists', () => {
    const affected = candidate({ provider: 'Adyen', country: 'BR' });
    const control = candidate({ provider: 'Adyen', country: 'MX' });
    control.observedRate = 0.89;
    control.drop = 0.01;

    expect(buildEvidenceRows(affected, [affected, control])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: 'controlSibling', dimensionValue: control.segmentKey }),
      ]),
    );
  });
});
