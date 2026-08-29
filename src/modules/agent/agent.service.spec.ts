import { describe, expect, it, vi } from 'vitest';
import type { MessageEvent } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AnalyticsService } from '../analytics/analytics.service.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { AgentDiagnosis } from './schemas/agent-diagnosis.schema.js';

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
  startedAt: new Date('2026-08-29T12:00:00.000Z'),
  detectedAt: new Date('2026-08-29T12:05:00.000Z'),
  lastSeenAt: new Date('2026-08-29T12:20:00.000Z'),
  diagnoses: [
    {
      baselineRate: 0.909,
      observedRate: 0.4149,
      observedAttempts: 429,
    },
  ],
};

function createService(runAgent = vi.fn()) {
  const incidents = { findOne: vi.fn().mockResolvedValue(storedIncident) };
  const config = { get: vi.fn((key: string) => (key === 'OPENAI_API_KEY' ? 'test-key' : undefined)) };
  const service = new AgentService(
    config as unknown as ConfigService,
    incidents as unknown as IncidentsService,
    {} as AnalyticsService,
  );
  (service as unknown as { runAgent: typeof runAgent }).runAgent = runAgent;
  return service;
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

    const events = await collectEvents(createService(runMock));
    const diagnosisEvent = events
      .map((event) => event.data as { type?: string; diagnosis?: AgentDiagnosis })
      .find((event) => event.type === 'diagnosis');

    expect(diagnosisEvent?.diagnosis?.impact).toEqual({
      expectedApprovalRate: 0.909,
      observedApprovalRate: 0.4149,
      lossPerMinuteCents: 346_210,
      startedAt: '2026-08-29T12:00:00.000Z',
    });
  });

  it('emits a safe error event and closes when the run fails', async () => {
    const runMock = vi.fn();
    runMock.mockRejectedValue(new Error('provider payload with secret data'));

    const events = await collectEvents(createService(runMock));

    expect(events.at(-1)?.data).toMatchObject({
      type: 'error',
      message: 'Unable to complete incident analysis',
    });
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
    const subscription = createService(runMock).streamAnalyzeIncident('incident-1').subscribe();
    await vi.waitFor(() => expect(runSignal).toBeDefined());

    subscription.unsubscribe();

    expect(runSignal?.aborted).toBe(true);
  });

  it('keeps POST analysis returning the existing diagnosis contract', async () => {
    const runMock = vi.fn();
    runMock.mockResolvedValue({ finalOutput: modelDiagnosis });

    const result = await createService(runMock).analyzeIncident('incident-1');

    expect(result.incidentId).toBe('incident-1');
    expect(result.impact.lossPerMinuteCents).toBe(346_210);
    expect(result).not.toHaveProperty('type');
  });
});
