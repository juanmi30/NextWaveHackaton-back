import { describe, expect, it, vi } from 'vitest';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { AgentService } from './agent.service.js';
import { IncidentAutoAnalysisService } from './incident-auto-analysis.service.js';
import type { EnrichedAgentDiagnosis } from './schemas/agent-diagnosis.schema.js';

const diagnosis = { incidentId: 'incident-a' } as EnrichedAgentDiagnosis;

function setup(analyzeIncident = vi.fn().mockResolvedValue(diagnosis)) {
  const incidents = { findOne: vi.fn().mockResolvedValue({ id: 'incident-a' }) };
  const service = new IncidentAutoAnalysisService(
    { analyzeIncident } as unknown as AgentService,
    incidents as unknown as IncidentsService,
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
