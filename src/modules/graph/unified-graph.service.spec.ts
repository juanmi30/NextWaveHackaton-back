import { describe, expect, it, vi } from 'vitest';
import type { DimensionMap } from '../../common/dimensions.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { PredictionFeaturesService } from '../prediction/prediction-features.service.js';
import type {
  PredictionService,
  SegmentPredictionResult,
} from '../prediction/prediction.service.js';
import { UnifiedGraphService } from './unified-graph.service.js';

const PREDICTIVE_ROUTE: DimensionMap = {
  merchant: 'Predictive Merchant',
  provider: 'Stripe',
  method: 'CARD',
  country: 'MX',
  issuingBank: 'BBVA',
};

const INCIDENT_ROUTE: DimensionMap = {
  merchant: 'Incident Merchant',
  provider: 'dLocal',
  method: 'PSE',
  country: 'CO',
  issuingBank: 'Bancolombia',
};

describe('UnifiedGraphService focus selection', () => {
  it('keeps prediction focus when an active predictive segment exists', async () => {
    const harness = createHarness({
      activeSegments: [{ segment: PREDICTIVE_ROUTE, attempts: 40 }],
      openIncidents: [incident('incident-overlay', INCIDENT_ROUTE, 500)],
      predictionResult: prediction(PREDICTIVE_ROUTE),
    });

    const graph = await harness.service.build();

    expect(graph.focus).toMatchObject({
      source: 'PREDICTION',
      selectedFlow: PREDICTIVE_ROUTE,
      selectedFlowSource: 'HIGHEST_PREDICTED_RISK',
    });
    expect(graph.summary.activeRoutes).toBe(1);
  });

  it('uses the highest-priority active incident when prediction discovers no routes', async () => {
    const lowerPriority = incident('incident-low', PREDICTIVE_ROUTE, 100);
    const highestPriority = incident('incident-high', INCIDENT_ROUTE, 900);
    const harness = createHarness({
      openIncidents: [lowerPriority, highestPriority],
      predictionResult: insufficientEvidence(INCIDENT_ROUTE),
    });

    const graph = await harness.service.build();
    const routeStatus = graph.nodes.find((node) => node.id === 'route-status');

    expect(graph.focus).toMatchObject({
      source: 'INCIDENT',
      requestedIncidentId: null,
      incidentScope: INCIDENT_ROUTE,
      selectedFlow: INCIDENT_ROUTE,
      selectedFlowSource: 'ACTIVE_INCIDENT_FALLBACK',
      selectedFlowAttempts: 0,
    });
    expect(graph.summary).toMatchObject({
      activeRoutes: 0,
      activeIncidents: 2,
      predictions: 0,
    });
    expect(graph.explorationOrder).toEqual([
      'merchant',
      'provider',
      'method',
      'country',
      'issuingBank',
    ]);
    expect(graph.nodes).toHaveLength(7);
    expect(graph.edges).toHaveLength(6);
    expect(routeStatus?.data).toMatchObject({
      operationalState: 'INCIDENT',
      predictionStatus: 'INSUFFICIENT_EVIDENCE',
      failureProbability: null,
      temporal: { timeZone: 'America/Bogota' },
      featureVectorV2: null,
      baselineMode: 'LOCAL_HOUR_COMPARABLE',
      focusIncident: { id: 'incident-high' },
    });
  });

  it('gives an explicit incidentId priority over prediction and incident fallback', async () => {
    const explicit = incident('incident-explicit', INCIDENT_ROUTE, 10);
    const harness = createHarness({
      activeSegments: [{ segment: PREDICTIVE_ROUTE, attempts: 80 }],
      openIncidents: [incident('incident-high', PREDICTIVE_ROUTE, 999)],
      focusIncident: explicit,
      predictionResult: prediction(PREDICTIVE_ROUTE),
    });

    const graph = await harness.service.build({ incidentId: explicit.id });

    expect(graph.focus).toMatchObject({
      source: 'INCIDENT',
      requestedIncidentId: 'incident-explicit',
      incidentScope: INCIDENT_ROUTE,
      selectedFlow: INCIDENT_ROUTE,
      selectedFlowSource: 'INCIDENT_SCOPE',
    });
    expect(harness.incidents.findOne).toHaveBeenCalledWith('incident-explicit');
  });

  it('returns the legitimate empty graph when there are no routes or incidents', async () => {
    const harness = createHarness({
      predictionResult: insufficientEvidence({}),
    });

    const graph = await harness.service.build();

    expect(graph.focus).toBeNull();
    expect(graph.summary).toMatchObject({ activeRoutes: 0, activeIncidents: 0 });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });
});

function createHarness(options: {
  activeSegments?: Array<{ segment: DimensionMap; attempts: number }>;
  openIncidents?: ReturnType<typeof incident>[];
  acknowledgedIncidents?: ReturnType<typeof incident>[];
  focusIncident?: ReturnType<typeof incident> | null;
  predictionResult: SegmentPredictionResult;
}) {
  const prediction = {
    evaluateSegment: vi.fn(async (segment: DimensionMap) => ({
      ...options.predictionResult,
      segment,
    })),
  };
  const predictionFeatures = {
    discoverActiveSegments: vi.fn().mockResolvedValue(options.activeSegments ?? []),
  };
  const incidents = {
    findAll: vi.fn(async (query: { status?: string }) =>
      query.status === 'ACKNOWLEDGED'
        ? (options.acknowledgedIncidents ?? [])
        : (options.openIncidents ?? []),
    ),
    findOne: vi.fn().mockResolvedValue(options.focusIncident ?? null),
  };

  return {
    incidents,
    service: new UnifiedGraphService(
      prediction as unknown as PredictionService,
      predictionFeatures as unknown as PredictionFeaturesService,
      incidents as unknown as IncidentsService,
    ),
  };
}

function incident(id: string, dimensions: DimensionMap, priorityScore: number) {
  return {
    id,
    detectionRunId: 'run-1',
    anchorFingerprint: id,
    fingerprint: id,
    status: 'OPEN' as const,
    severity: 4,
    expectedApprovals: 100,
    actualApprovals: 40,
    lostApprovals: 60,
    averageTicketCents: 10_000,
    lossPerMinuteCents: priorityScore,
    summaryOps: 'Confirmed degradation',
    summaryExec: 'Confirmed degradation',
    recommendation: 'Inspect the route',
    confidenceStatement: 'High confidence',
    startedAt: new Date('2026-08-30T06:00:00.000Z'),
    detectedAt: new Date('2026-08-30T06:15:00.000Z'),
    lastSeenAt: new Date('2026-08-30T06:15:00.000Z'),
    resolvedAt: null,
    diagnoses: [
      {
        dimensions,
        baselineRate: 0.9,
        observedRate: 0.4,
        confidence: 0.95,
      },
    ],
    priorityScore,
    priorityRank: 1,
  };
}

function insufficientEvidence(segment: DimensionMap): SegmentPredictionResult {
  return {
    status: 'INSUFFICIENT_EVIDENCE',
    segment,
    features: null,
    evidence: {
      currentAttempts: 0,
      baselineAttempts: 100,
      bucketAttempts: [0, 0, 0],
      sufficientEvidence: false,
      reason: 'INSUFFICIENT_CURRENT_SAMPLE',
    },
    failureContext: {
      totalAttempts: 0,
      totalFailures: 0,
      failureRate: 0,
      actionableFailures: 0,
      issuerSideFailures: 0,
      limitedFailures: 0,
      unknownFailures: 0,
      topReasons: [],
    },
    temporal: { timeZone: 'America/Bogota' },
    featureVectorV2: null,
    yunoFailureContext: { totalFailures: 0 },
    baselineMode: 'LOCAL_HOUR_COMPARABLE',
    prediction: null,
  };
}

function prediction(segment: DimensionMap): SegmentPredictionResult {
  return {
    ...insufficientEvidence(segment),
    status: 'PREDICTION',
    features: {
      baselineApprovalRate: 0.9,
      approvalDrop: 0.2,
      approvalSlope: -0.05,
      timeoutRate: 0.1,
      timeoutSlope: 0.02,
      errorRate: 0.05,
      p95LatencyMs: 2_000,
      latencySlope: 300,
    },
    featureVectorV2: { approval_drop: 0.2, local_time_sin: 0.5 },
    prediction: {
      model: { type: 'LogisticRegression', version: 'v2' },
      predictionHorizonMinutes: 15,
      failureProbability: 0.8,
      failureProbabilityPercent: 80,
      decisionThreshold: 0.5,
      elevatedRisk: true,
      riskLevel: 'HIGH',
      signals: [],
    },
  };
}
