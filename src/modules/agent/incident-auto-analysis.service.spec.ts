import { describe, expect, it, vi } from 'vitest';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { AgentService } from './agent.service.js';
import type { ConfigService } from '@nestjs/config';
import { IncidentAutoAnalysisService } from './incident-auto-analysis.service.js';
import type { EnrichedAgentDiagnosis } from './schemas/agent-diagnosis.schema.js';

const diagnosis = { incidentId: 'incident-a' } as EnrichedAgentDiagnosis;

function setup(analyzeIncident = vi.fn().mockResolvedValue(diagnosis), open: Array<{ id: string; lossPerMinuteCents: number }> = [], concurrency = 3) {
  const incidents = { findOne: vi.fn().mockResolvedValue({ id: 'incident-a', lossPerMinuteCents: 100 }), findAll: vi.fn().mockResolvedValue(open) };
  const service = new IncidentAutoAnalysisService(
    { analyzeIncident } as unknown as AgentService,
    incidents as unknown as IncidentsService,
    { get: vi.fn().mockReturnValue(String(concurrency)) } as unknown as ConfigService,
  );
  return { service, analyzeIncident, incidents };
}

describe('IncidentAutoAnalysisService', () => {
  it('schedules a new incident once and exposes the completed diagnosis', async () => {
    const { service, analyzeIncident } = setup();

    expect(service.analyzeIfNeeded('incident-a')).toMatchObject({ scheduled: true });
    expect(service.analyzeIfNeeded('incident-a')).toMatchObject({
      scheduled: false,
      reason: 'already_running',
    });
    await vi.waitFor(() => expect(analyzeIncident).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () =>
      expect(await service.getDiagnosis('incident-a')).toMatchObject({
        status: 'COMPLETED',
        diagnosis,
      }),
    );

    expect(service.analyzeIfNeeded('incident-a')).toMatchObject({
      scheduled: false,
      reason: 'already_completed',
    });
    expect(analyzeIncident).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct incidents independent', async () => {
    const resolvers = new Map<string, (value: EnrichedAgentDiagnosis) => void>();
    const analyzeIncident = vi.fn(
      (incidentId: string) =>
        new Promise<EnrichedAgentDiagnosis>((resolve) => resolvers.set(incidentId, resolve)),
    );
    const { service } = setup(analyzeIncident);

    service.analyzeIfNeeded('incident-a');
    service.analyzeIfNeeded('incident-b');
    await vi.waitFor(() => expect(analyzeIncident).toHaveBeenCalledTimes(2));

    resolvers.get('incident-a')?.({ ...diagnosis, incidentId: 'incident-a' });
    resolvers.get('incident-b')?.({ ...diagnosis, incidentId: 'incident-b' });
    await vi.waitFor(async () =>
      expect(await service.getDiagnosis('incident-b')).toMatchObject({ status: 'COMPLETED' }),
    );
  });

  it('marks unexpected pipeline failures without retrying automatically', async () => {
    const { service, analyzeIncident } = setup(
      vi.fn().mockRejectedValue(new Error('unexpected failure')),
    );

    service.analyzeIfNeeded('incident-a');
    await vi.waitFor(async () =>
      expect(await service.getDiagnosis('incident-a')).toMatchObject({
        status: 'FAILED',
        diagnosis: null,
        error: 'Incident analysis failed',
      }),
    );
    expect(service.analyzeIfNeeded('incident-a')).toMatchObject({
      scheduled: false,
      reason: 'already_failed',
    });
    expect(analyzeIncident).toHaveBeenCalledTimes(1);
  });

  it('allows the existing manual path to retry a failed analysis', async () => {
    const analyzeIncident = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce(diagnosis);
    const { service } = setup(analyzeIncident);

    await expect(service.analyzeManually('incident-a')).rejects.toThrow('first failure');
    await expect(service.analyzeManually('incident-a')).resolves.toBe(diagnosis);
    await expect(service.getDiagnosis('incident-a')).resolves.toMatchObject({
      status: 'COMPLETED',
    });
  });

  it('returns NOT_STARTED for a valid incident without an analysis', async () => {
    const { service } = setup();
    await expect(service.getDiagnosis('incident-a')).resolves.toMatchObject({
      incidentId: 'incident-a',
      status: 'NOT_STARTED',
      diagnosis: null,
    });
  });
});

describe('IncidentAutoAnalysisService reconciliation', () => {
  it('starts existing incidents on startup up to available capacity', async () => {
    const analyze = vi.fn(() => new Promise<EnrichedAgentDiagnosis>(() => undefined));
    const open = [{ id: 'A', lossPerMinuteCents: 3800 }, { id: 'B', lossPerMinuteCents: 107 }];
    const { service } = setup(analyze, open, 3);
    await service.onModuleInit();
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    await expect(service.getDiagnosis('A')).resolves.toMatchObject({ status: 'RUNNING' });
    await expect(service.getDiagnosis('B')).resolves.toMatchObject({ status: 'RUNNING' });
  });

  it('prioritizes financial loss, queues excess work, and dispatches after completion', async () => {
    const resolvers = new Map<string, (value: EnrichedAgentDiagnosis) => void>();
    const analyze = vi.fn((id: string) => new Promise<EnrichedAgentDiagnosis>((resolve) => resolvers.set(id, resolve)));
    const open = [{ id: 'C', lossPerMinuteCents: 1000 }, { id: 'A', lossPerMinuteCents: 5000 }, { id: 'B', lossPerMinuteCents: 3000 }];
    const { service } = setup(analyze, open, 2);
    await service.reconcileOpenIncidents();
    expect(analyze.mock.calls.map(([id]) => id)).toEqual(['A', 'B']);
    await expect(service.getDiagnosis('C')).resolves.toMatchObject({ status: 'QUEUED' });
    resolvers.get('A')?.({ ...diagnosis, incidentId: 'A' });
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledWith('C'));
    await expect(service.getDiagnosis('C')).resolves.toMatchObject({ status: 'RUNNING' });
  });

  it('is idempotent and does not duplicate completed analyses', async () => {
    const analyze = vi.fn().mockResolvedValue(diagnosis);
    const { service } = setup(analyze, [{ id: 'incident-a', lossPerMinuteCents: 5000 }], 1);
    await service.reconcileOpenIncidents();
    await service.reconcileOpenIncidents();
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    await service.reconcileOpenIncidents();
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('frees failed capacity and starts the next queued incident', async () => {
    const analyze = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(diagnosis);
    const { service } = setup(analyze, [{ id: 'A', lossPerMinuteCents: 5000 }, { id: 'B', lossPerMinuteCents: 1000 }], 1);
    await service.reconcileOpenIncidents();
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    await expect(service.getDiagnosis('A')).resolves.toMatchObject({ status: 'FAILED' });
    await expect(service.getDiagnosis('B')).resolves.toMatchObject({ status: 'COMPLETED' });
  });
});
