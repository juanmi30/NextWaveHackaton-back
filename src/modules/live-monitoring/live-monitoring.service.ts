import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  RequestTimeoutException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { BaselinesService } from '../baselines/baselines.service.js';
import { DemoService } from '../demo/demo.service.js';
import { DetectionService } from '../detection/detection.service.js';
import { TransactionsRepository } from '../transactions/transactions.repository.js';
import type { CreateLiveDegradationDto } from './dto/create-live-degradation.dto.js';
import type { StartLiveMonitorDto } from './dto/start-live-monitor.dto.js';
import { LiveEventService } from './live-event.service.js';
import type { LiveConfig, LiveDegradation, LiveMonitorState } from './live-monitoring.types.js';
import { LiveTransactionGeneratorService } from './live-transaction-generator.service.js';

const DEFAULT_CONFIG: LiveConfig = {
  tickIntervalMs: 1_000,
  transactionsPerTick: 50,
  detectionIntervalMs: 5_000,
  detectionWindowMinutes: 5,
  randomSeed: 1_337,
};

@Injectable()
export class LiveMonitoringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveMonitoringService.name);
  private state: LiveMonitorState = 'STOPPED';
  private config: LiveConfig = DEFAULT_CONFIG;
  private startedAt: Date | null = null;
  private generatorTimer?: ReturnType<typeof setInterval>;
  private detectionTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private generatorRunning = false;
  private detectionRunning = false;
  private detectionSettled: Promise<void> | null = null;
  private resolveDetectionSettled: (() => void) | null = null;
  private generatedTransactions = 0;
  private generatorTicks = 0;
  private detectionRuns = 0;
  private skippedDetectionRuns = 0;
  private lastRunAt: string | null = null;
  private lastOutcome: string | null = null;
  private lastRunId: string | null = null;
  private latestIncidentCount = 0;
  private lastGeneratorError: string | null = null;
  private lastDetectionError: string | null = null;
  private readonly degradations = new Map<string, LiveDegradation>();

  constructor(
    private readonly configService: ConfigService,
    private readonly transactions: TransactionsRepository,
    private readonly baselines: BaselinesService,
    private readonly demo: DemoService,
    private readonly detection: DetectionService,
    private readonly generator: LiveTransactionGeneratorService,
    private readonly events: LiveEventService,
  ) {}

  async onModuleInit() {
    if (this.configService.get<string>('LIVE_MONITOR_AUTO_START') === 'true') {
      try {
        await this.start({});
      } catch (error) {
        this.logger.warn(`Live monitor auto-start skipped: ${safeError(error)}`);
      }
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  async start(dto: StartLiveMonitorDto) {
    if (this.state === 'RUNNING') return this.status();

    let [transactionCount, baselineCount] = await Promise.all([
      this.transactions.count(),
      this.baselines.count(),
    ]);
    if ((transactionCount === 0 || baselineCount === 0) && dto.autoSeed) {
      if (transactionCount === 0) await this.demo.seed();
      else if (baselineCount === 0) await this.baselines.rebuild();
      [transactionCount, baselineCount] = await Promise.all([
        this.transactions.count(),
        this.baselines.count(),
      ]);
    }
    if (transactionCount === 0 || baselineCount === 0) {
      throw new ConflictException({
        code: 'LIVE_MONITOR_NOT_READY',
        message: 'Historical transaction data and baselines are required. Run demo seed first.',
      });
    }

    this.config = { ...DEFAULT_CONFIG, ...definedConfig(dto) };
    this.generator.reset(this.config.randomSeed);
    this.generatedTransactions = 0;
    this.generatorTicks = 0;
    this.detectionRuns = 0;
    this.skippedDetectionRuns = 0;
    this.lastRunAt = null;
    this.lastOutcome = null;
    this.lastRunId = null;
    this.latestIncidentCount = 0;
    this.state = 'RUNNING';
    this.startedAt = new Date();
    this.lastGeneratorError = null;
    this.lastDetectionError = null;
    this.generatorTimer = setInterval(() => void this.transactionTick(), this.config.tickIntervalMs);
    this.detectionTimer = setInterval(() => void this.detectionTick(), this.config.detectionIntervalMs);
    this.heartbeatTimer = setInterval(
      () => this.events.emit({ type: 'heartbeat', state: this.state }),
      15_000,
    );
    this.events.emit({ type: 'monitor_started', config: this.config });
    return this.status();
  }

  async stop() {
    const wasRunning = this.state === 'RUNNING';
    this.clearTimers();
    this.state = 'STOPPED';
    if (this.detectionSettled) await this.waitForDetectionToSettle(this.detectionSettled);
    if (wasRunning) this.events.emit({ type: 'monitor_stopped' });
    return this.status();
  }

  status() {
    this.expireDegradations();
    const uptimeSeconds = this.startedAt
      ? Math.max(0, Math.floor((Date.now() - this.startedAt.getTime()) / 1_000))
      : 0;
    return {
      state: this.state,
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeSeconds: this.state === 'RUNNING' ? uptimeSeconds : 0,
      generator: {
        tickIntervalMs: this.config.tickIntervalMs,
        transactionsPerTick: this.config.transactionsPerTick,
        ticks: this.generatorTicks,
        generatedTransactions: this.generatedTransactions,
        lastError: this.lastGeneratorError,
      },
      detection: {
        intervalMs: this.config.detectionIntervalMs,
        windowMinutes: this.config.detectionWindowMinutes,
        runs: this.detectionRuns,
        skippedDetectionRuns: this.skippedDetectionRuns,
        running: this.detectionRunning,
        lastRunAt: this.lastRunAt,
        lastOutcome: this.lastOutcome,
        lastRunId: this.lastRunId,
        latestIncidentCount: this.latestIncidentCount,
        lastError: this.lastDetectionError,
      },
      activeDegradationCount: this.degradations.size,
      activeDegradations: this.listDegradations(),
    };
  }

  addDegradation(dto: CreateLiveDegradationDto) {
    this.expireDegradations();
    const startedAt = new Date();
    const degradation: LiveDegradation = {
      id: randomUUID(),
      dimensions: dto.dimensions,
      approvalRate: dto.approvalRate,
      failureReason: dto.failureReason ?? 'DO_NOT_HONOR',
      targetTransactionsPerTick: dto.targetTransactionsPerTick ?? 20,
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + (dto.durationSeconds ?? 60) * 1_000).toISOString(),
      status: 'ACTIVE',
    };
    this.degradations.set(degradation.id, degradation);
    this.events.emit({ type: 'degradation_started', degradation });
    return degradation;
  }

  listDegradations() {
    this.expireDegradations();
    return [...this.degradations.values()];
  }

  removeDegradation(id: string) {
    const degradation = this.degradations.get(id);
    if (!degradation) throw new NotFoundException(`Live degradation ${id} not found`);
    this.degradations.delete(id);
    this.events.emit({ type: 'degradation_removed', degradationId: id });
    return { removed: true, id };
  }

  private async transactionTick() {
    if (this.state !== 'RUNNING' || this.generatorRunning) return;
    this.generatorRunning = true;
    try {
      const batch = await this.generator.generate(
        this.config.transactionsPerTick,
        this.listDegradations(),
      );
      this.generatorTicks += 1;
      this.generatedTransactions += batch.generated;
      this.lastGeneratorError = null;
      this.events.emit({
        type: 'transaction_batch',
        generated: batch.generated,
        approved: batch.approved,
        declined: batch.declined,
      });
    } catch (error) {
      this.lastGeneratorError = safeError(error);
      this.logger.error(`Live transaction batch failed: ${this.lastGeneratorError}`);
    } finally {
      this.generatorRunning = false;
    }
  }

  private async detectionTick() {
    if (this.state !== 'RUNNING') return;
    if (this.detectionRunning) {
      this.skippedDetectionRuns += 1;
      this.events.emit({ type: 'detection_skipped', reason: 'previous_run_still_active' });
      return;
    }
    this.detectionRunning = true;
    this.detectionSettled = new Promise<void>((resolve) => {
      this.resolveDetectionSettled = resolve;
    });
    this.events.emit({ type: 'detection_started' });
    try {
      const result = await this.detection.run({
        windowMinutes: this.config.detectionWindowMinutes,
      });
      this.detectionRuns += 1;
      this.lastRunAt = new Date().toISOString();
      this.lastOutcome = result.outcome;
      this.lastRunId = result.runId;
      this.latestIncidentCount = result.incidents.length;
      this.lastDetectionError = null;
      this.events.emit({
        type: 'detection_completed',
        runId: result.runId,
        outcome: result.outcome,
        incidentCount: result.incidents.length,
      });
      for (const incident of result.incidents) {
        this.events.emit({
          type: 'incident_detected',
          incidentId: incident.incidentId,
          isNew: incident.isNew,
          priorityRank: incident.priorityRank,
        });
      }
    } catch (error) {
      this.lastDetectionError = safeError(error);
      this.logger.error(`Automatic detection failed: ${this.lastDetectionError}`);
    } finally {
      this.detectionRunning = false;
      this.resolveDetectionSettled?.();
      this.resolveDetectionSettled = null;
      this.detectionSettled = null;
    }
  }

  private async waitForDetectionToSettle(inFlight: Promise<void>, timeoutMs = 30_000) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        inFlight,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new RequestTimeoutException('Timed out waiting for active Detection run')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private expireDegradations() {
    const now = Date.now();
    for (const degradation of this.degradations.values()) {
      if (new Date(degradation.expiresAt).getTime() > now) continue;
      this.degradations.delete(degradation.id);
      this.events.emit({ type: 'degradation_expired', degradationId: degradation.id });
    }
  }

  private clearTimers() {
    if (this.generatorTimer) clearInterval(this.generatorTimer);
    if (this.detectionTimer) clearInterval(this.detectionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.generatorTimer = undefined;
    this.detectionTimer = undefined;
    this.heartbeatTimer = undefined;
  }
}

function definedConfig(dto: StartLiveMonitorDto): Partial<LiveConfig> {
  return Object.fromEntries(
    Object.entries({
      tickIntervalMs: dto.tickIntervalMs,
      transactionsPerTick: dto.transactionsPerTick,
      detectionIntervalMs: dto.detectionIntervalMs,
      detectionWindowMinutes: dto.detectionWindowMinutes,
      randomSeed: dto.randomSeed,
    }).filter((entry): entry is [keyof LiveConfig, number] => entry[1] !== undefined),
  );
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}
