import { Injectable, Logger } from '@nestjs/common';
import { IncidentsService } from '../incidents/incidents.service.js';
import { AgentService } from './agent.service.js';
import type { EnrichedAgentDiagnosis } from './schemas/agent-diagnosis.schema.js';

export type IncidentAnalysisStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED';

export type IncidentAnalysisState = {
  incidentId: string;
  status: IncidentAnalysisStatus;
  diagnosis: EnrichedAgentDiagnosis | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

type RegistryEntry = IncidentAnalysisState & {
  promise: Promise<EnrichedAgentDiagnosis> | null;
};

@Injectable()
export class IncidentAutoAnalysisService {
  private readonly logger = new Logger(IncidentAutoAnalysisService.name);
  private readonly registry = new Map<string, RegistryEntry>();

  constructor(
    private readonly agent: AgentService,
    private readonly incidents: IncidentsService,
  ) {}

  analyzeIfNeeded(incidentId: string) {
    const current = this.registry.get(incidentId);
    if (current) {
      const reason =
        current.status === 'COMPLETED'
          ? 'already_completed'
          : current.status === 'FAILED'
            ? 'already_failed'
            : 'already_running';
      this.logger.debug(`[AUTO_ANALYSIS] skipped incident=${incidentId} reason=${reason}`);
      return { scheduled: false, reason, state: publicState(current) };
    }

    const entry = this.createPendingEntry(incidentId);
    this.registry.set(incidentId, entry);
    entry.promise = Promise.resolve().then(() => this.execute(entry));
    void entry.promise.catch(() => undefined);
    this.logger.log(`[AUTO_ANALYSIS] scheduled incident=${incidentId}`);
    return { scheduled: true, reason: null, state: publicState(entry) };
  }

  async analyzeManually(incidentId: string) {
    const current = this.registry.get(incidentId);
    if (
      current?.promise &&
      (current.status === 'PENDING' || current.status === 'RUNNING')
    ) {
      return current.promise;
    }

    const entry = this.createPendingEntry(incidentId);
    this.registry.set(incidentId, entry);
    entry.promise = Promise.resolve().then(() => this.execute(entry));
    return entry.promise;
  }

  async getDiagnosis(incidentId: string): Promise<IncidentAnalysisState> {
    await this.incidents.findOne(incidentId);
    const entry = this.registry.get(incidentId);
    return entry
      ? publicState(entry)
      : {
          incidentId,
          status: 'NOT_STARTED',
          diagnosis: null,
          startedAt: null,
          completedAt: null,
          error: null,
        };
  }

  private createPendingEntry(incidentId: string): RegistryEntry {
    return {
      incidentId,
      status: 'PENDING',
      diagnosis: null,
      startedAt: null,
      completedAt: null,
      error: null,
      promise: null,
    };
  }

  private async execute(entry: RegistryEntry): Promise<EnrichedAgentDiagnosis> {
    entry.status = 'RUNNING';
    entry.startedAt = new Date().toISOString();
    try {
      const diagnosis = await this.agent.analyzeIncident(entry.incidentId);
      entry.status = 'COMPLETED';
      entry.diagnosis = diagnosis;
      entry.completedAt = new Date().toISOString();
      this.logger.log(`[AUTO_ANALYSIS] completed incident=${entry.incidentId}`);
      return diagnosis;
    } catch (error) {
      entry.status = 'FAILED';
      entry.error = 'Incident analysis failed';
      entry.completedAt = new Date().toISOString();
      this.logger.error(
        `[AUTO_ANALYSIS] failed incident=${entry.incidentId} error=${safeError(error)}`,
      );
      throw error;
    } finally {
      entry.promise = null;
    }
  }
}

function publicState(entry: RegistryEntry): IncidentAnalysisState {
  return {
    incidentId: entry.incidentId,
    status: entry.status,
    diagnosis: entry.diagnosis,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    error: entry.error,
  };
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
