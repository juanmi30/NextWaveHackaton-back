import { describe, expect, it, vi } from 'vitest';
import type { DimensionMap } from '../../common/dimensions.js';
import type { BaselineLookup } from '../baselines/baselines.service.js';
import {
  anchorFor,
  alertRoutingFingerprint,
  baselineConfidenceFactor,
  bestEffort,
  buildEvidenceRows,
  conflicts,
  detectionOutcome,
  evaluateUnseenChildIsolation,
  groupAnomalyFamilies,
  incidentPersistenceDecision,
  nextDiagnosisVersion,
  prune,
  resolveExistingIncident,
  stableFamilyAnchor,
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
    isolatedUnseenDimension: null,
    healthySiblingValues: [],
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

  it('keeps one refinement story and prefers its isolating child', () => {
    const candidates = [
      candidate({ provider: 'Adyen' }),
      candidate({ provider: 'Adyen', country: 'BR' }),
      candidate({ provider: 'Adyen', country: 'BR', method: 'CARD' }),
    ];

    expect(prune(candidates)).toEqual([candidates[2]]);
  });

  it('groups broad Adyen/BR projections into one canonical anomaly family', () => {
    const broad = candidate({ provider: 'Adyen', country: 'BR' });
    broad.attempts = 400;
    const candidates = [
      broad,
      candidate({ provider: 'Adyen', country: 'BR', method: 'CARD' }),
      candidate({ provider: 'Adyen', country: 'BR', issuingBank: 'Bradesco' }),
      candidate({ provider: 'Adyen', country: 'BR', issuingBank: 'Itau' }),
    ];

    expect(groupAnomalyFamilies(candidates)).toHaveLength(1);
    expect(prune(candidates)).toEqual([broad]);
  });

  it('keeps a narrow Bradesco root when other banks are healthy and not candidates', () => {
    const broad = candidate({ provider: 'Adyen', country: 'BR' });
    const bradesco = candidate({ provider: 'Adyen', country: 'BR', issuingBank: 'Bradesco' });
    bradesco.attempts = 200;
    expect(prune([broad, bradesco])).toEqual([bradesco]);
  });

  it('keeps different countries and different providers in separate families', () => {
    const candidates = [
      candidate({ provider: 'Adyen', country: 'BR' }),
      candidate({ provider: 'Adyen', country: 'MX' }),
      candidate({ provider: 'Stripe', country: 'BR' }),
    ];
    expect(groupAnomalyFamilies(candidates)).toHaveLength(3);
    expect(prune(candidates)).toHaveLength(3);
  });

  it('keeps the broad anchor stable when later runs add child projections', () => {
    const broad = candidate({ provider: 'Adyen', country: 'BR' });
    broad.attempts = 400;
    const firstWinner = prune([broad])[0]!;
    const refinedWinner = prune([
      broad,
      candidate({ provider: 'Adyen', country: 'BR', issuingBank: 'Bradesco' }),
      candidate({ provider: 'Adyen', country: 'BR', issuingBank: 'Itau' }),
    ])[0]!;
    expect(anchorFor(firstWinner, [broad])).toBe(anchorFor(refinedWinner, [broad]));
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

  it('enriches alert routing with a dominant failure reason when the fingerprint is broad', () => {
    expect(
      alertRoutingFingerprint('country=MX|provider=Stripe', [
        {
          code: 'INVALID_CVV',
          count: 80,
          shareOfDeclines: 0.8,
          baselineShare: 0.02,
          shareDelta: 0.78,
        },
      ]),
    ).toBe('country=MX|failureReason=INVALID_CVV|provider=Stripe');
  });

  it('keeps broad alert routing when no failure reason dominates', () => {
    expect(
      alertRoutingFingerprint('country=MX|provider=Stripe', [
        {
          code: 'INVALID_CVV',
          count: 40,
          shareOfDeclines: 0.4,
          baselineShare: 0.02,
          shareDelta: 0.38,
        },
      ]),
    ).toBe('country=MX|provider=Stripe');
  });
});

describe('stable incident identity across refinement', () => {
  function lineage(
    id: string,
    dimensions: DimensionMap,
    anchor = candidate(dimensions).segmentKey,
  ) {
    return {
      id,
      anchorFingerprint: anchor,
      fingerprint: candidate(dimensions).segmentKey,
      startedAt: new Date('2026-08-29T12:00:00Z'),
      diagnoses: [{ dimensions }],
    };
  }

  function resolve(current: DimensionMap, active: ReturnType<typeof lineage>[]) {
    const winner = candidate(current);
    return resolveExistingIncident({
      proposedAnchor: winner.segmentKey,
      winner,
      family: [winner],
      activeIncidents: active,
    });
  }

  it('reuses broad identity for a normal narrow refinement and preserves its anchor', () => {
    const broad = lineage('X', { provider: 'Adyen', country: 'BR' });
    const existing = resolve(
      { provider: 'Adyen', country: 'BR', issuingBank: 'Bradesco' },
      [broad],
    );
    expect(existing).toMatchObject({ id: 'X', anchorFingerprint: broad.anchorFingerprint });
    expect(
      incidentPersistenceDecision(existing, 'country=BR|issuingBank=Bradesco|provider=Adyen'),
    ).toMatchObject({ incidentId: 'X', isNew: false, refined: true });
  });

  it('keeps alert escalation best-effort when the provider throws', async () => {
    const warn = vi.fn();
    await expect(bestEffort(
      () => Promise.reject(new Error('SMTP unavailable')),
      warn,
    )).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'SMTP unavailable' }));
  });

  it('deduplicates redundant evidence by dimension, value and root-cause role', () => {
    const winner = candidate({ provider: 'Adyen', country: 'BR' });
    const duplicateA = candidate({ provider: 'Adyen' }, 0.5);
    const duplicateB = candidate({ provider: 'Adyen' }, 0.9);
    duplicateB.attempts = 200;
    const rows = buildEvidenceRows(winner, [winner, duplicateA, duplicateB]);
    const providerRows = rows.filter(
      (row) => row.dimension === 'provider' && row.dimensionValue === 'Adyen' && row.isRootCause,
    );
    expect(providerRows).toHaveLength(1);
    expect(providerRows[0]).toMatchObject({ confidence: 0.9, attempts: 200 });
  });

  it('marks only the broad creation as new so refinement cannot open another escalation', () => {
    const created = incidentPersistenceDecision(null, 'country=BR|provider=Adyen');
    const refined = incidentPersistenceDecision(
      { id: 'X', fingerprint: 'country=BR|provider=Adyen' },
      'country=BR|issuingBank=Bradesco|provider=Adyen',
    );
    expect(created.isNew).toBe(true);
    expect(refined).toMatchObject({ incidentId: 'X', isNew: false, refined: true });
  });

  it('reuses a narrow incident when diagnosis temporarily becomes broader', () => {
    expect(resolve(
      { provider: 'Adyen', country: 'BR' },
      [lineage('X', { provider: 'Adyen', country: 'BR', issuingBank: 'Bradesco' },
        'country=BR|provider=Adyen')],
    )?.id).toBe('X');
  });

  it('keeps one identity through successive CARD and bank refinements', () => {
    const active = [lineage('X', { provider: 'Adyen', country: 'BR' })];
    expect(resolve({ provider: 'Adyen', country: 'BR', method: 'CARD' }, active)?.id).toBe('X');
    active[0]!.fingerprint = 'country=BR|method=CARD|provider=Adyen';
    active[0]!.diagnoses = [{ dimensions: { provider: 'Adyen', country: 'BR', method: 'CARD' } }];
    expect(resolve({ provider: 'Adyen', country: 'BR', method: 'CARD', issuingBank: 'Bradesco' }, active)?.id)
      .toBe('X');
  });

  it.each([
    [
      { provider: 'Stripe', country: 'BR' },
      [lineage('A', { provider: 'Adyen', country: 'BR' })],
    ],
    [
      { provider: 'Adyen', country: 'MX' },
      [lineage('A', { provider: 'Adyen', country: 'BR' })],
    ],
    [
      { merchant: 'Merchant1', issuingBank: 'BankB' },
      [lineage('A', { merchant: 'Merchant1', issuingBank: 'BankA' })],
    ],
  ])('does not merge independent anomaly families', (current, active) => {
    expect(resolve(current, active)).toBeNull();
  });

  it('does not choose arbitrarily when lineage matching is ambiguous', () => {
    const active = [
      lineage('A', { provider: 'Adyen', country: 'BR' }),
      lineage('B', { provider: 'Adyen', country: 'BR', method: 'CARD' }, 'method=CARD|provider=Adyen'),
    ];
    expect(resolve(
      { provider: 'Adyen', country: 'BR', method: 'CARD', issuingBank: 'Bradesco' },
      active,
    )).toBeNull();
  });

  it('does not use a single broad dimension as cross-run lineage evidence', () => {
    expect(resolve(
      { provider: 'Adyen', country: 'BR' },
      [lineage('country-wide', { country: 'BR' })],
    )).toBeNull();
  });

  it('uses the original parent identity for an unseen child', () => {
    const active = [lineage('X', { merchant: 'Mercado Uno', provider: 'Adyen' })];
    expect(resolve(
      { merchant: 'Mercado Uno', provider: 'Adyen', issuingBank: 'BancoJudgeUnseen' },
      active,
    )?.id).toBe('X');
  });

  it('selects a stable normal ancestor inside the current family', () => {
    const broad = candidate({ provider: 'Adyen', country: 'BR' });
    const card = candidate({ provider: 'Adyen', country: 'BR', method: 'CARD' });
    const bank = candidate({
      provider: 'Adyen', country: 'BR', method: 'CARD', issuingBank: 'Bradesco',
    });
    expect(stableFamilyAnchor([broad, card, bank], bank)).toBe(card.segmentKey);
  });
});

describe('unseen child isolation', () => {
  function unseenScenario(targetAttempts = 100, siblingRate = 0.91) {
    const inheritedBaseline: BaselineLookup = {
      ...baseline,
      source: 'ancestor_hour',
      matchedSegmentKey: 'merchant=Mercado Uno|provider=Adyen',
      matchedDimensions: { merchant: 'Mercado Uno', provider: 'Adyen' },
      fallbackDepth: 1,
    };
    const ancestor = candidate({ merchant: 'Mercado Uno', provider: 'Adyen' });
    ancestor.attempts = 150;
    const target = candidate({
      merchant: 'Mercado Uno',
      provider: 'Adyen',
      issuingBank: 'BancoJudgeUnseen',
    });
    target.baseline = inheritedBaseline;
    target.attempts = targetAttempts;
    target.observedRate = 0.15;
    target.drop = 0.75;
    const siblings = ['Bradesco', 'Itau', 'Nubank'].map((issuingBank) => {
      const row = candidate({ merchant: 'Mercado Uno', provider: 'Adyen', issuingBank });
      row.observedRate = siblingRate;
      row.attempts = 80;
      return row;
    });
    return { target, ancestor, siblings };
  }

  it('isolates an unseen bank with inherited baseline, sufficient sample and healthy siblings', () => {
    const { target, ancestor, siblings } = unseenScenario();
    expect(evaluateUnseenChildIsolation(target, [target, ancestor, ...siblings], 20)).toEqual({
      isolated: true,
      dimension: 'issuingBank',
      healthySiblingValues: ['Bradesco', 'Itau', 'Nubank'],
    });
  });

  it('does not refine an unseen bank with a small sample', () => {
    const { target, ancestor, siblings } = unseenScenario(5);
    expect(evaluateUnseenChildIsolation(target, [target, ancestor, ...siblings], 20).isolated).toBe(
      false,
    );
  });

  it('does not isolate the unseen bank when sibling banks are also degraded', () => {
    const { target, ancestor, siblings } = unseenScenario(100, 0.3);
    expect(evaluateUnseenChildIsolation(target, [target, ancestor, ...siblings], 20).isolated).toBe(
      false,
    );
  });

  it('does not treat an exact historical baseline as unseen', () => {
    const { target, ancestor, siblings } = unseenScenario();
    target.baseline = baseline;
    expect(evaluateUnseenChildIsolation(target, [target, ancestor, ...siblings], 20).isolated).toBe(
      false,
    );
  });

  it('prefers the isolated unseen child as canonical without inventing direct baseline', () => {
    const { target, ancestor, siblings } = unseenScenario();
    const isolation = evaluateUnseenChildIsolation(target, [target, ancestor, ...siblings], 20);
    target.isolatedUnseenDimension = isolation.dimension;
    target.healthySiblingValues = isolation.healthySiblingValues;
    expect(prune([ancestor, target])).toEqual([target]);
    expect(target.baseline).toMatchObject({
      source: 'ancestor_hour',
      sampleSize: 100,
      matchedDimensions: { merchant: 'Mercado Uno', provider: 'Adyen' },
    });
  });

  it('keeps the parent anchor while refining the fingerprint to an unseen child', () => {
    const { target, ancestor, siblings } = unseenScenario();
    const parent = candidate({ merchant: 'Mercado Uno', provider: 'Adyen', country: 'BR' });
    const isolation = evaluateUnseenChildIsolation(target, [target, ancestor, ...siblings], 20);
    target.isolatedUnseenDimension = isolation.dimension;
    target.healthySiblingValues = isolation.healthySiblingValues;
    expect(stableFamilyAnchor([parent, target], target)).toBe(parent.segmentKey);
    expect(nextDiagnosisVersion(1)).toBe(2);
  });
});
