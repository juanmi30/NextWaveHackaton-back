import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { BaselinesService } from '../baselines/baselines.service.js';
import type { DemoService } from '../demo/demo.service.js';
import type { DetectionService } from '../detection/detection.service.js';
import type { TransactionsRepository } from '../transactions/transactions.repository.js';
import { LiveEventService } from './live-event.service.js';
import { LiveMonitoringService } from './live-monitoring.service.js';
import type { LiveTransactionGeneratorService } from './live-transaction-generator.service.js';

function setup(options: { detection?: ReturnType<typeof vi.fn>; ready?: boolean } = {}) {
  const generator = {
    reset: vi.fn(),
    generate: vi.fn().mockResolvedValue({ generated: 10, approved: 9, declined: 1, rows: [] }),
  };
  const detection = options.detection ??
    vi.fn().mockResolvedValue({ runId: 'run-1', outcome: 'NO_ANOMALY', incidents: [] });
  const events = new LiveEventService();
  const eventSpy = vi.spyOn(events, 'emit');
  const service = new LiveMonitoringService(
    { get: vi.fn(() => undefined) } as unknown as ConfigService,
    { count: vi.fn().mockResolvedValue(options.ready === false ? 0 : 100) } as unknown as TransactionsRepository,
    {
      count: vi.fn().mockResolvedValue(options.ready === false ? 0 : 10),
      rebuild: vi.fn(),
    } as unknown as BaselinesService,
    { seed: vi.fn() } as unknown as DemoService,
    { run: detection } as unknown as DetectionService,
    generator as unknown as LiveTransactionGeneratorService,
    events,
  );
  return { service, generator, detection, events, eventSpy };
}

describe('LiveMonitoringService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions STOPPED -> RUNNING and starts only one set of loops', async () => {
    const { service, generator } = setup();
    await service.start({ tickIntervalMs: 250, detectionIntervalMs: 1_000 });
    await service.start({ tickIntervalMs: 250, detectionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(250);

    expect(service.status().state).toBe('RUNNING');
    expect(generator.generate).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('stops idempotently and clears generator/detection timers', async () => {
    const { service, generator, detection } = setup();
    await service.start({ tickIntervalMs: 250, detectionIntervalMs: 1_000 });
    service.stop();
    service.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(service.status().state).toBe('STOPPED');
    expect(generator.generate).not.toHaveBeenCalled();
    expect(detection).not.toHaveBeenCalled();
  });

  it('cleans timers during module destruction', async () => {
    const { service, generator } = setup();
    await service.start({ tickIntervalMs: 250 });
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('requires historical data and baselines before starting', async () => {
    const { service } = setup({ ready: false });
    await expect(service.start({})).rejects.toMatchObject({ status: 409 });
  });

  it('expires and removes degradations deterministically', () => {
    const { service, eventSpy } = setup();
    const degradation = service.addDegradation({
      dimensions: { provider: 'Adyen' },
      approvalRate: 0.4,
      durationSeconds: 1,
    });
    expect(service.listDegradations()).toHaveLength(1);
    vi.advanceTimersByTime(1_001);
    expect(service.listDegradations()).toHaveLength(0);
    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'degradation_expired', degradationId: degradation.id }),
    );
  });

  it('allows multiple degradations and explicit removal', () => {
    const { service } = setup();
    const first = service.addDegradation({ dimensions: { country: 'BR' }, approvalRate: 0.3 });
    service.addDegradation({ dimensions: { country: 'MX' }, approvalRate: 0.4 });
    expect(service.listDegradations()).toHaveLength(2);
    service.removeDegradation(first.id);
    expect(service.listDegradations()).toHaveLength(1);
  });

  it('runs automatic detection and emits aggregate detection events', async () => {
    const { service, detection, eventSpy } = setup();
    await service.start({ detectionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(detection).toHaveBeenCalledWith({ windowMinutes: 5 });
    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'detection_completed', runId: 'run-1' }),
    );
    service.stop();
  });

  it('skips overlapping detection runs', async () => {
    let resolveDetection!: (value: unknown) => void;
    const slowDetection = vi.fn(
      () => new Promise((resolve) => {
        resolveDetection = resolve;
      }),
    );
    const { service } = setup({ detection: slowDetection });
    await service.start({ detectionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(slowDetection).toHaveBeenCalledTimes(1);
    expect(service.status().detection.skippedDetectionRuns).toBe(1);
    resolveDetection({ runId: 'run-1', outcome: 'NO_ANOMALY', incidents: [] });
    await Promise.resolve();
    service.stop();
  });

  it('waits for an in-flight Detection run before returning STOPPED', async () => {
    let resolveDetection!: (value: unknown) => void;
    const slowDetection = vi.fn(
      () => new Promise((resolve) => {
        resolveDetection = resolve;
      }),
    );
    const { service } = setup({ detection: slowDetection });
    await service.start({ detectionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    let stopResolved = false;
    const stopping = service.stop().then((status) => {
      stopResolved = true;
      return status;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(service.status().detection.running).toBe(true);

    resolveDetection({ runId: 'run-1', outcome: 'NO_ANOMALY', incidents: [] });
    const stopped = await stopping;
    expect(stopped).toMatchObject({ state: 'STOPPED', detection: { running: false } });
  });

  it('isolates detection errors while generation continues', async () => {
    const detection = vi.fn().mockRejectedValue(new Error('database timeout'));
    const { service, generator } = setup({ detection });
    await service.start({ tickIntervalMs: 250, detectionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_250);
    expect(generator.generate).toHaveBeenCalled();
    expect(service.status()).toMatchObject({
      state: 'RUNNING',
      detection: { lastError: 'database timeout' },
    });
    service.stop();
  });

  it('isolates generator errors and retries on the next tick', async () => {
    const { service, generator } = setup();
    generator.generate
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({ generated: 10, approved: 9, declined: 1, rows: [] });
    await service.start({ tickIntervalMs: 250, detectionIntervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(500);
    expect(generator.generate).toHaveBeenCalledTimes(2);
    expect(service.status()).toMatchObject({
      state: 'RUNNING',
      generator: { generatedTransactions: 10, lastError: null },
    });
    service.stop();
  });

  it('emits monitor start and stop events', async () => {
    const { service, eventSpy } = setup();
    await service.start({});
    service.stop();
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'monitor_started' }));
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'monitor_stopped' }));
  });

  it('multicasts monitor and degradation events over SSE without history storage', async () => {
    const { service, events } = setup();
    const nextEvent = firstValueFrom(events.events());
    service.addDegradation({ dimensions: { provider: 'Adyen' }, approvalRate: 0.4 });
    await expect(nextEvent).resolves.toMatchObject({
      data: { type: 'degradation_started', timestamp: expect.any(String) },
    });
  });
});
