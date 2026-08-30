import { describe, expect, it, vi } from 'vitest';
import type { MessageEvent } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AnalyticsService } from '../analytics/analytics.service.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { AgentDiagnosis } from './schemas/agent-diagnosis.schema.js';
import type { EnrichedAgentDiagnosis } from './schemas/agent-diagnosis.schema.js';

import { AgentService } from './agent.service.js';

const modelDiagnosis = {
  incidentId: 'incident-1',
  evidenceStatus: 'INSUFFICIENT',
  affectedScope: {
    merchant: 'Mercado Uno',
    provider: 'Adyen',
    method: 'CARD',
    country: 'BR',
    issuingBank: 'Bradesco',
    failureReason: null,
  },
  rootCause: null,
  impact: {
    expectedApprovalRate: 0.5,
    observedApprovalRate: 0.2,
    lossPerMinuteCents: 999,
    startedAt: '2020-01-01T00:00:00.000Z',
  },
  evidence: [],
  recurrence: { isRecurrence: false, previousOccurrenceCount: 0 },
  recommendation: { action: 'Review manually', requiresHumanApproval: true },
  summaries: { operations: 'Operations summary', executive: 'Executive summary' },
} satisfies AgentDiagnosis;

const storedIncident = {
  id: 'incident-1',
  expectedApprovals: 390,
  actualApprovals: 178,
  lostApprovals: 212,
  lossPerMinuteCents: 346_210,
  averageTicketCents: 10_000,
  startedAt: new Date('2026-08-29T12:00:00.000Z'),
  detectedAt: new Date('2026-08-29T12:05:00.000Z'),
  lastSeenAt: new Date('2026-08-29T12:20:00.000Z'),
  summaryOps: 'Stored operations summary',
  summaryExec: 'Stored executive summary',
  recommendation: 'Inspect Adyen routing',
  confidenceStatement: 'Stored evidence isolates provider=Adyen.',
  diagnoses: [
    {
      dimensions: { merchant: 'Mercado Uno', provider: 'Adyen', method: 'CARD', country: 'BR' },
      baselineRate: 0.909,
      observedRate: 0.4149,
      baselineAttempts: 1_000,
      observedAttempts: 429,
      confidence: 0.8,
      evidence: [{ dimension: 'provider', dimensionValue: 'Adyen', baselineRate: 0.909,
        observedRate: 0.4149, attempts: 429, confidence: 0.8, isRootCause: true }],
    },
  ],
};

function createService(runAgent = vi.fn(), options: { key?: string; timeout?: string } = { key: 'test-key' }) {
  const incidents = {
    findOne: vi.fn().mockResolvedValue(storedIncident),
    history: vi.fn().mockResolvedValue({ isRecurrence: true, previousOccurrences: [{ id: 'old' }] }),
  };
  const config = { get: vi.fn((key: string) => key === 'OPENAI_API_KEY' ? options.key :
    key === 'AGENT_TIMEOUT_MS' ? options.timeout : undefined) };
  const service = new AgentService(
    config as unknown as ConfigService,
    incidents as unknown as IncidentsService,
    {} as AnalyticsService,
  );
  (service as unknown as { runAgent: typeof runAgent }).runAgent = runAgent;
  return { service, incidents };
}

function completedStream(finalOutput: unknown) {
  return {
    finalOutput,
    completed: Promise.resolve(),
    async *[Symbol.asyncIterator]() {},
  };
}

function collectEvents(service: AgentService) {
  return new Promise<MessageEvent[]>((resolve, reject) => {
    const events: MessageEvent[] = [];
    service.streamAnalyzeIncident('incident-1').subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

describe('AgentService streaming analysis', () => {
  it('emits the final diagnosis with canonical incident impact', async () => {
    const runMock = vi.fn();
    runMock.mockResolvedValue(completedStream(modelDiagnosis));

    const events = await collectEvents(createService(runMock).service);
    const diagnosisEvent = events
      .map((event) => event.data as { type?: string; diagnosis?: EnrichedAgentDiagnosis })
      .find((event) => event.type === 'diagnosis');

    expect(diagnosisEvent?.diagnosis?.impact).toEqual({
      expectedApprovalRate: 0.909,
      observedApprovalRate: 0.4149,
      lossPerMinuteCents: 346_210,
      startedAt: '2026-08-29T12:00:00.000Z',
    });
  });

  it('emits deterministic diagnosis and completes when the run fails', async () => {
    const runMock = vi.fn();
    runMock.mockRejectedValue(new Error('provider payload with secret data'));

    const events = await collectEvents(createService(runMock).service);

    expect(events.some((event) => (event.data as { type: string }).type === 'diagnosis')).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({ type: 'run_completed' });
    expect(JSON.stringify(events)).not.toContain('secret data');
  });

  it('aborts its run when the SSE subscription is closed', async () => {
    const runMock = vi.fn();
    let runSignal: AbortSignal | undefined;
    runMock.mockImplementation(async (_agent, _prompt, options) => {
      runSignal = options.signal;
      const completed = new Promise<void>((resolve) =>
        options.signal.addEventListener('abort', () => resolve()),
      );
      return {
        completed,
        finalOutput: undefined,
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve()));
          yield undefined;
        },
      };
    });
    const subscription = createService(runMock).service.streamAnalyzeIncident('incident-1').subscribe();
    await vi.waitFor(() => expect(runSignal).toBeDefined());

    subscription.unsubscribe();

    expect(runSignal?.aborted).toBe(true);
  });

  it('keeps POST analysis returning the existing diagnosis contract', async () => {
    const runMock = vi.fn();
    runMock.mockResolvedValue({ finalOutput: modelDiagnosis });

    const result = await createService(runMock).service.analyzeIncident('incident-1');

    expect(result.incidentId).toBe('incident-1');
    expect(result.impact.lossPerMinuteCents).toBe(346_210);
    expect(result).toHaveProperty('confidenceAnalysis');
    expect(result).toHaveProperty('ruledOutHypotheses');
    expect(result).toHaveProperty('counterfactualImpact');
    expect(result).toHaveProperty('diagnosisTrace');
    expect(result).not.toHaveProperty('type');
  });

  it('returns deterministic diagnosis without an OpenAI key', async () => {
    const runMock = vi.fn();
    const { service, incidents } = createService(runMock, { key: '' });
    const result = await service.analyzeIncident('incident-1');
    expect(runMock).not.toHaveBeenCalled();
    expect(incidents.history).toHaveBeenCalledWith('incident-1');
    expect(result).toMatchObject({
      evidenceStatus: 'SUFFICIENT',
      recurrence: { isRecurrence: true, previousOccurrenceCount: 1 },
      recommendation: { requiresHumanApproval: true },
    });
    expect(result).toHaveProperty('confidenceAnalysis');
    expect(result).toHaveProperty('ruledOutHypotheses');
    expect(result).toHaveProperty('counterfactualImpact');
    expect(result).toHaveProperty('diagnosisTrace');
    expect(JSON.stringify(result)).not.toMatch(/Confianza|caída|intentos|evidencia insuficiente/i);
  });

  it('calculates the same backend enrichment for OpenAI success and fallback', async () => {
    const sufficientModelDiagnosis: AgentDiagnosis = {
      ...modelDiagnosis,
      evidenceStatus: 'SUFFICIENT',
      rootCause: {
        statement: 'Stored evidence isolates provider=Adyen.',
        dimensions: {
          merchant: null, provider: 'Adyen', method: null, country: null,
          issuingBank: null, failureReason: null,
        },
        confidence: 0.8,
      },
    };
    const openAi = await createService(
      vi.fn().mockResolvedValue({ finalOutput: sufficientModelDiagnosis }),
    ).service.analyzeIncident('incident-1');
    const fallback = await createService(vi.fn(), { key: '' })
      .service.analyzeIncident('incident-1');

    expect(openAi.confidenceAnalysis).toEqual(fallback.confidenceAnalysis);
    expect(openAi.ruledOutHypotheses).toEqual(fallback.ruledOutHypotheses);
    expect(openAi.counterfactualImpact).toEqual(fallback.counterfactualImpact);
    expect(openAi.diagnosisTrace).toEqual(fallback.diagnosisTrace);
  });

  it('falls back when structured output is invalid', async () => {
    const runMock = vi.fn().mockResolvedValue({ finalOutput: { invalid: true } });
    const result = await createService(runMock).service.analyzeIncident('incident-1');
    expect(result.summaries.operations).toContain('Expected approval rate');
    expect(JSON.stringify(result)).not.toMatch(/Confianza|caída|intentos|evidencia insuficiente/i);
  });

  it('replaces Spanish OpenAI copy with the English deterministic fallback', async () => {
    const spanishOutput: AgentDiagnosis = {
      ...modelDiagnosis,
      summaries: {
        operations: 'Caída consistente sobre 485 intentos.',
        executive: 'Incidente activo.',
      },
      recommendation: {
        action: 'Recomendación para el operador.',
        requiresHumanApproval: true,
      },
    };
    const result = await createService(
      vi.fn().mockResolvedValue({ finalOutput: spanishOutput }),
    ).service.analyzeIncident('incident-1');

    expect(result.summaries.operations).toContain('Expected approval rate');
    expect(result.recommendation.action).toContain('Review');
    expect(JSON.stringify(result)).not.toMatch(/Confianza|caída|intentos|evidencia insuficiente/i);
  });

  it('falls back after the configured OpenAI timeout', async () => {
    vi.useFakeTimers();
    const runMock = vi.fn((_agent, _prompt, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = createService(runMock, { key: 'test', timeout: '10' }).service.analyzeIncident('incident-1');
    await vi.advanceTimersByTimeAsync(10);
    expect((await pending).impact.lossPerMinuteCents).toBe(346_210);
    vi.useRealTimers();
  });

  it('streams the minimal fallback sequence without an OpenAI key', async () => {
    const { service } = createService(vi.fn(), { key: '' });
    const events = (await collectEvents(service)).map((event) => event.data as { type: string; phase?: string });
    expect(events.map((event) => event.type)).toEqual([
      'run_started', 'phase_changed', 'phase_changed', 'diagnosis', 'phase_changed', 'run_completed',
    ]);
    expect(events.filter((event) => event.type === 'phase_changed').map((event) => event.phase))
      .toEqual(['OBSERVE', 'DIAGNOSE', 'REPORT']);
  });
});
