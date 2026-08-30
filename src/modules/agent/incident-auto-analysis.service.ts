import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IncidentsService } from '../incidents/incidents.service.js';
import { AgentService } from './agent.service.js';
import type { EnrichedAgentDiagnosis } from './schemas/agent-diagnosis.schema.js';

export type IncidentAnalysisStatus = 'NOT_STARTED' | 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type IncidentAnalysisState = { incidentId: string; status: IncidentAnalysisStatus; diagnosis: EnrichedAgentDiagnosis | null; startedAt: string | null; completedAt: string | null; error: string | null };
type RegistryEntry = IncidentAnalysisState & { lossPerMinuteCents: number; promise: Promise<EnrichedAgentDiagnosis>; resolve: (diagnosis: EnrichedAgentDiagnosis) => void; reject: (error: unknown) => void };

@Injectable()
export class IncidentAutoAnalysisService implements OnModuleInit {
  private readonly logger = new Logger(IncidentAutoAnalysisService.name);
  private readonly registry = new Map<string, RegistryEntry>();
  private readonly queue: string[] = [];
  private running = 0;

  constructor(private readonly agent: AgentService, private readonly incidents: IncidentsService, private readonly config: ConfigService) {}

  async onModuleInit() { await this.reconcileOpenIncidents(); }

  async reconcileOpenIncidents() {
    const open = await this.incidents.findAll({ status: 'OPEN', limit: 1_000 });
    const candidates = open
      .filter((incident) => !this.registry.has(incident.id))
      .sort((left, right) => right.lossPerMinuteCents - left.lossPerMinuteCents);
    this.logger.log(`[WATCHTOWER] reconciliation open=${open.length} missingDiagnosis=${candidates.length}`);
    for (const incident of candidates) this.enqueueIfNeeded(incident.id, incident.lossPerMinuteCents);
    this.dispatchAvailableWorkers();
    return { open: open.length, scheduled: candidates.length };
  }

  analyzeIfNeeded(incidentId: string, lossPerMinuteCents = 0) {
    return this.enqueueIfNeeded(incidentId, lossPerMinuteCents);
  }

  async analyzeManually(incidentId: string) {
    const current = this.registry.get(incidentId);
    if (current?.status === 'QUEUED' || current?.status === 'RUNNING') return current.promise;
    const incident = await this.incidents.findOne(incidentId);
    if (current) this.registry.delete(incidentId);
    const scheduled = this.enqueueIfNeeded(incidentId, incident.lossPerMinuteCents);
    return scheduled.state.status === 'COMPLETED'
      ? scheduled.state.diagnosis!
      : this.registry.get(incidentId)!.promise;
  }

  async getDiagnosis(incidentId: string): Promise<IncidentAnalysisState> {
    await this.incidents.findOne(incidentId);
    const entry = this.registry.get(incidentId);
    return entry ? publicState(entry) : { incidentId, status: 'NOT_STARTED', diagnosis: null, startedAt: null, completedAt: null, error: null };
  }

  private enqueueIfNeeded(incidentId: string, lossPerMinuteCents: number) {
    const current = this.registry.get(incidentId);
    if (current) {
      const reason = current.status === 'COMPLETED' ? 'already_completed' : current.status === 'FAILED' ? 'already_failed' : current.status === 'QUEUED' ? 'already_queued' : 'already_running';
      this.logger.debug(`[AGENT_QUEUE] skipped incident=${incidentId} reason=${reason}`);
      return { scheduled: false, reason, state: publicState(current) };
    }
    const entry = createQueuedEntry(incidentId, lossPerMinuteCents);
    this.registry.set(incidentId, entry);
    this.queue.push(incidentId);
    this.queue.sort((left, right) => this.registry.get(right)!.lossPerMinuteCents - this.registry.get(left)!.lossPerMinuteCents);
    void entry.promise.catch(() => undefined);
    this.logger.log(`[AGENT_QUEUE] scheduled incident=${incidentId} lossPerMinuteCents=${lossPerMinuteCents}`);
    this.dispatchAvailableWorkers();
    return { scheduled: true, reason: null, state: publicState(entry) };
  }

  private dispatchAvailableWorkers() {
    while (this.running < this.concurrency() && this.queue.length > 0) {
      const incidentId = this.queue.shift()!;
      const entry = this.registry.get(incidentId);
      if (!entry || entry.status !== 'QUEUED') continue;
      this.running += 1;
      void this.execute(entry).then(entry.resolve, entry.reject);
    }
  }

  private async execute(entry: RegistryEntry): Promise<EnrichedAgentDiagnosis> {
    entry.status = 'RUNNING';
    entry.startedAt = new Date().toISOString();
    this.logger.log(`[AGENT_QUEUE] started incident=${entry.incidentId}`);
    try {
      const diagnosis = await this.agent.analyzeIncident(entry.incidentId);
      entry.status = 'COMPLETED'; entry.diagnosis = diagnosis; entry.completedAt = new Date().toISOString();
      this.logger.log(`[AGENT_QUEUE] completed incident=${entry.incidentId}`);
      return diagnosis;
    } catch (error) {
      entry.status = 'FAILED'; entry.error = 'Incident analysis failed'; entry.completedAt = new Date().toISOString();
      this.logger.error(`[AGENT_QUEUE] failed incident=${entry.incidentId} error=${safeError(error)}`);
      throw error;
    } finally {
      this.running -= 1;
      this.dispatchAvailableWorkers();
    }
  }

  private concurrency() {
    const configured = Number(this.config.get<string>('AGENT_ANALYSIS_CONCURRENCY'));
    return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 10) : 3;
  }
}

function createQueuedEntry(incidentId: string, lossPerMinuteCents: number): RegistryEntry {
  let resolve!: (diagnosis: EnrichedAgentDiagnosis) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<EnrichedAgentDiagnosis>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { incidentId, status: 'QUEUED', diagnosis: null, startedAt: null, completedAt: null, error: null, lossPerMinuteCents, promise, resolve, reject };
}

function publicState(entry: RegistryEntry): IncidentAnalysisState { return { incidentId: entry.incidentId, status: entry.status, diagnosis: entry.diagnosis, startedAt: entry.startedAt, completedAt: entry.completedAt, error: entry.error }; }
function safeError(error: unknown) { return error instanceof Error ? error.message : String(error); }
