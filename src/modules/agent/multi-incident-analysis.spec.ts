import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { AnalyticsService } from '../analytics/analytics.service.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { AgentDiagnosis } from './schemas/agent-diagnosis.schema.js';
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

function diagnosis(id: string, country: string): AgentDiagnosis {
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
  };
}

function setup(active: ReturnType<typeof activeIncident>[]) {
  const incidents = {
    findAll: vi.fn().mockResolvedValue(active),
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
});
