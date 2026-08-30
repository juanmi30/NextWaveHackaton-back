import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { AnalyticsService } from '../analytics/analytics.service.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { EnrichedAgentDiagnosis } from './schemas/agent-diagnosis.schema.js';
import { AgentService } from './agent.service.js';

function activeIncident(
  id: string,
  lossPerMinuteCents: number,
  country: string,
  severity = 4,
) {
  return {
    id,
    lossPerMinuteCents,
    severity,
    lostApprovals: Math.round(lossPerMinuteCents / 1_000),
    detectedAt: new Date('2026-08-29T12:00:00.000Z'),
    diagnoses: [{ confidence: 0.9 }],
    fingerprint: `provider=Adyen|country=${country}`,
    status: 'OPEN',
  };
}

function diagnosis(id: string, country: string): EnrichedAgentDiagnosis {
  const dimensions = {
    merchant: null,
    provider: 'Adyen',
    method: null,
    country,
    issuingBank: null,
    failureReason: null,
  };
  return {
    incidentId: id,
    evidenceStatus: 'SUFFICIENT',
    affectedScope: dimensions,
    rootCause: { statement: `Adyen ${country}`, dimensions, confidence: 0.9 },
    impact: {
      expectedApprovalRate: 0.9,
      observedApprovalRate: 0.4,
      lossPerMinuteCents: 1,
      startedAt: '2026-08-29T12:00:00.000Z',
    },
    evidence: [],
    recurrence: { isRecurrence: false, previousOccurrenceCount: 0 },
    recommendation: { action: 'Investigate manually', requiresHumanApproval: true },
    summaries: { operations: `${id} operations`, executive: `${id} executive` },
    confidenceAnalysis: { score: 0.9, level: 'HIGH', factors: [], limitations: [] },
    ruledOutHypotheses: [],
    counterfactualImpact: {
      estimatedRecoverableApprovalsPerMinute: 1,
      estimatedRecoverableApprovalsPerHour: 60,
      estimatedRecoverableRevenuePerHourCents: 60,
    },
    diagnosisTrace: [{
      order: 1,
      type: 'ROOT_CAUSE',
      scope: dimensions,
      statement: `Stored evidence isolates Adyen ${country}.`,
      baselineValue: null,
      observedValue: null,
      attempts: null,
    }],
    declineIntelligence: null,
    operationalOwnership: {
      suspectedDomain: 'UNKNOWN',
      primaryTeam: 'PAYMENTS_OPS',
      supportingTeams: [],
      statement: 'Payments Operations should review the evidence.',
      basis: ['No failureReason is present.'],
      requiresHumanApproval: true,
    },
  };
}

function setup(active: ReturnType<typeof activeIncident>[]) {
  const incidents = {
    findAll: vi.fn().mockResolvedValue(active),
    findOne: vi.fn(),
    history: vi.fn().mockResolvedValue({ isRecurrence: false, previousOccurrences: [] }),
    acknowledge: vi.fn(),
    resolve: vi.fn(),
  };
  const config = { get: vi.fn(() => undefined) };
  const service = new AgentService(
    config as unknown as ConfigService,
    incidents as unknown as IncidentsService,
    {} as AnalyticsService,
  );
  return { service, incidents };
}

describe('AgentService multi-incident analysis', () => {
  it('returns an empty portfolio without starting any incident analysis', async () => {
    const { service } = setup([]);
    const analyze = vi.spyOn(service, 'analyzeIncident');

    const result = await service.analyzeActiveIncidents();

    expect(analyze).not.toHaveBeenCalled();
    expect(result.portfolio).toMatchObject({
      activeIncidentCount: 0,
      successfullyAnalyzed: 0,
      failedAnalyses: 0,
      totalLossPerMinuteCents: 0,
      highestPriorityIncidentId: null,
    });
    expect(result.incidents).toEqual([]);
  });

  it('analyzes one incident independently and assigns rank 1', async () => {
    const { service } = setup([activeIncident('A', 100_000, 'BR')]);
    vi.spyOn(service, 'analyzeIncident').mockResolvedValue(diagnosis('A', 'BR'));

    const result = await service.analyzeActiveIncidents();

    expect(result.incidents[0]).toMatchObject({
      incidentId: 'A',
      priorityRank: 1,
      analysisStatus: 'ANALYZED',
    });
  });

  it('analyzes two same-provider incidents separately and ranks money first', async () => {
    const active = [
      activeIncident('B', 100_000, 'MX', 5),
      activeIncident('A', 400_000, 'BR', 2),
    ];
    const { service } = setup(active);
    const analyze = vi
      .spyOn(service, 'analyzeIncident')
      .mockImplementation(async (id) => diagnosis(id, id === 'A' ? 'BR' : 'MX'));

    const result = await service.analyzeActiveIncidents();

    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze).toHaveBeenCalledWith('A');
    expect(analyze).toHaveBeenCalledWith('B');
    expect(result.incidents.map(({ incidentId, priorityRank }) => ({ incidentId, priorityRank }))).toEqual([
      { incidentId: 'A', priorityRank: 1 },
      { incidentId: 'B', priorityRank: 2 },
    ]);
    expect(result.incidents[0].diagnosis?.incidentId).toBe('A');
    expect(result.incidents[1].diagnosis?.incidentId).toBe('B');
    expect(result.incidents.every((row) => row.diagnosis?.operationalOwnership)).toBe(true);
    expect(result.correlation.status).toBe('INDEPENDENT');
    expect(result.portfolio.totalLossPerMinuteCents).toBe(500_000);
  });

  it('isolates a failed analysis while preserving canonical portfolio impact', async () => {
    const { service } = setup([
      activeIncident('A', 400_000, 'BR'),
      activeIncident('B', 100_000, 'MX'),
    ]);
    vi.spyOn(service, 'analyzeIncident').mockImplementation(async (id) => {
      if (id === 'B') throw new Error('OpenAI unavailable');
      return diagnosis(id, 'BR');
    });

    const result = await service.analyzeActiveIncidents();

    expect(result.portfolio).toMatchObject({
      successfullyAnalyzed: 1,
      failedAnalyses: 1,
      totalLossPerMinuteCents: 500_000,
    });
    expect(result.incidents.find((incident) => incident.incidentId === 'A')?.analysisStatus).toBe(
      'ANALYZED',
    );
    expect(result.incidents.find((incident) => incident.incidentId === 'B')).toMatchObject({
      analysisStatus: 'FAILED',
      diagnosis: null,
      error: 'Incident analysis failed',
    });
  });

  it('never acknowledges or resolves incidents during portfolio analysis', async () => {
    const { service, incidents } = setup([activeIncident('A', 100_000, 'BR')]);
    vi.spyOn(service, 'analyzeIncident').mockResolvedValue(diagnosis('A', 'BR'));

    await service.analyzeActiveIncidents();

    expect(incidents.acknowledge).not.toHaveBeenCalled();
    expect(incidents.resolve).not.toHaveBeenCalled();
  });

  it('analyzes every active incident with deterministic fallback when the key is absent', async () => {
    const active = [activeIncident('A', 400_000, 'BR'), activeIncident('B', 100_000, 'MX')];
    const { service, incidents } = setup(active);
    incidents.findOne.mockImplementation(async (id: string) => ({
      ...active.find((row) => row.id === id),
      expectedApprovals: 90,
      actualApprovals: 40,
      averageTicketCents: 10_000,
      startedAt: new Date('2026-08-29T11:55:00.000Z'),
      lastSeenAt: new Date('2026-08-29T12:05:00.000Z'),
      summaryOps: `${id} stored operations`,
      summaryExec: `${id} stored executive`,
      recommendation: 'Review manually',
      confidenceStatement: null,
      diagnoses: [{
        dimensions: { provider: 'Adyen', country: id === 'A' ? 'BR' : 'MX' },
        baselineRate: 0.9, observedRate: 0.4, baselineAttempts: 500,
        observedAttempts: 100, confidence: 0.7,
        evidence: [{ dimension: 'provider', dimensionValue: 'Adyen', baselineRate: 0.9,
          observedRate: 0.4, attempts: 100, confidence: 0.7, isRootCause: true }],
      }],
    }));

    const result = await service.analyzeActiveIncidents();

    expect(result.portfolio).toMatchObject({ successfullyAnalyzed: 2, failedAnalyses: 0,
      totalLossPerMinuteCents: 500_000 });
    expect(result.incidents.every((row) => row.analysisStatus === 'ANALYZED')).toBe(true);
    expect(incidents.acknowledge).not.toHaveBeenCalled();
    expect(incidents.resolve).not.toHaveBeenCalled();
  });

  it('counts a refined anomaly once using its single stable Incident identity', async () => {
    const refined = activeIncident('X', 250_000, 'BR');
    refined.diagnoses = [{ confidence: 0.9 }, { confidence: 0.95 }];
    const { service } = setup([refined]);
    vi.spyOn(service, 'analyzeIncident').mockResolvedValue(diagnosis('X', 'BR'));

    const result = await service.analyzeActiveIncidents();

    expect(result.portfolio).toMatchObject({
      activeIncidentCount: 1,
      totalLossPerMinuteCents: 250_000,
    });
    expect(result.incidents).toHaveLength(1);
  });
});
