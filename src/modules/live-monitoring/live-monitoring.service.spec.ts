import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { BaselinesService } from '../baselines/baselines.service.js';
import type { DemoService } from '../demo/demo.service.js';
import type { DetectionService } from '../detection/detection.service.js';
import type { PredictionService } from '../prediction/prediction.service.js';
import type { TransactionsRepository } from '../transactions/transactions.repository.js';
import { LiveEventService } from './live-event.service.js';
import { LiveMonitoringService } from './live-monitoring.service.js';
import type { LiveTransactionGeneratorService } from './live-transaction-generator.service.js';

const scanResult = {
  scannedAt: '2026-08-29T12:00:10.000Z', evaluatedSegments: 2, predictions: 2,
  insufficientEvidence: 0,
  watchRisks: [{
    segment: { provider: 'Adyen' }, evidence: { sufficientEvidence: true }, features: {},
    failureContext: {}, prediction: { riskLevel: 'WATCH', failureProbability: 0.4,
      failureProbabilityPercent: 40, predictionHorizonMinutes: 15, signals: [], elevatedRisk: false },
  }],
  elevatedRisks: [{
    segment: { provider: 'Stripe' }, evidence: { sufficientEvidence: true }, features: {},
    failureContext: {}, prediction: { riskLevel: 'HIGH', failureProbability: 0.8,
      failureProbabilityPercent: 80, predictionHorizonMinutes: 15, signals: [], elevatedRisk: true },
  }],
};

function setup(options: {
  detection?: ReturnType<typeof vi.fn>;
  prediction?: ReturnType<typeof vi.fn>;
  ready?: boolean;
} = {}) {
  const generator = {
    reset: vi.fn(),
    generate: vi.fn().mockResolvedValue({ generated: 10, approved: 9, declined: 1, rows: [] }),
  };
  const detection = options.detection ??
    vi.fn().mockResolvedValue({ runId: 'run-1', outcome: 'NO_ANOMALY', incidents: [] });
  const events = new LiveEventService();
  const prediction = options.prediction ?? vi.fn().mockResolvedValue(scanResult);
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
    { scan: prediction } as unknown as PredictionService,
    generator as unknown as LiveTransactionGeneratorService,
    events,
  );
  return { service, generator, detection, prediction, events, eventSpy };
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

  it('clears runtime degradations on stop', async () => {
    const { service } = setup();
    await service.start({});
    service.addDegradation({ dimensions: { provider: 'Adyen' }, approvalRate: 0.2 });
    expect(service.status().activeDegradationCount).toBe(1);
    const stopped = await service.stop();
    expect(stopped).toMatchObject({ state: 'STOPPED', activeDegradationCount: 0 });
  });

  it('schedules and runs automatic prediction when enabled', async () => {
    const { service, prediction } = setup();
    await service.start({ predictionEnabled: true, predictionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prediction).toHaveBeenCalledTimes(1);
    expect(service.status().prediction.runs).toBe(1);
    await service.stop();
  });

  it('does not schedule prediction when explicitly disabled', async () => {
    const { service, prediction } = setup();
    await service.start({ predictionEnabled: false, predictionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prediction).not.toHaveBeenCalled();
    await service.stop();
  });

  it('skips overlapping prediction scans', async () => {
    let resolvePrediction!: (value: unknown) => void;
    const prediction = vi.fn(() => new Promise((resolve) => { resolvePrediction = resolve; }));
    const { service } = setup({ prediction });
    await service.start({ predictionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prediction).toHaveBeenCalledTimes(1);
    expect(service.status().prediction.skippedRuns).toBe(1);
    resolvePrediction(scanResult);
    await Promise.resolve();
    await service.stop();
  });

  it('isolates prediction failures from generation and Detection', async () => {
    const prediction = vi.fn().mockRejectedValue(new Error('model unavailable'));
    const { service, generator, detection } = setup({ prediction });
    await service.start({ tickIntervalMs: 250, detectionIntervalMs: 1_000, predictionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_250);
    expect(generator.generate).toHaveBeenCalled();
    expect(detection).toHaveBeenCalled();
    expect(service.status()).toMatchObject({ state: 'RUNNING', prediction: { lastError: 'model unavailable' } });
    await service.stop();
  });

  it('exposes bounded predictive risks ordered HIGH before WATCH', async () => {
    const { service } = setup();
    await service.start({ predictionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.status().latestPredictiveRisks).toHaveLength(2);
    expect(service.status().latestPredictiveRisks.map((risk) => risk.riskLevel)).toEqual(['HIGH', 'WATCH']);
    await service.stop();
  });

  it('emits aggregate prediction and predictive-risk events', async () => {
    const { service, eventSpy } = setup();
    await service.start({ predictionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'prediction_started' }));
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'prediction_completed', evaluatedSegments: 2 }));
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'predictive_risk_detected' }));
    await service.stop();
  });

  it('does not create incidents or trigger Detection from a prediction scan', async () => {
    const { service, detection } = setup();
    await service.start({ detectionIntervalMs: 5_000, predictionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(detection).not.toHaveBeenCalled();
    expect(service.status().prediction.runs).toBe(1);
    await service.stop();
  });

  it('waits for an in-flight Prediction scan before returning STOPPED', async () => {
    let resolvePrediction!: (value: unknown) => void;
    const prediction = vi.fn(() => new Promise((resolve) => { resolvePrediction = resolve; }));
    const { service } = setup({ prediction });
    await service.start({ predictionIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    let stopped = false;
    const stopping = service.stop().then((status) => { stopped = true; return status; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolvePrediction(scanResult);
    expect(await stopping).toMatchObject({ state: 'STOPPED', prediction: { running: false } });
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
