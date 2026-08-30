import type { EnrichedAgentDiagnosis } from './schemas/agent-diagnosis.schema.js';

export type AgentPhase = 'OBSERVE' | 'INVESTIGATE' | 'DIAGNOSE' | 'RECOMMEND' | 'REPORT';

export type AgentStreamEvent =
  | { type: 'run_started'; incidentId: string; timestamp: string }
  | { type: 'phase_changed'; phase: AgentPhase; timestamp: string }
  | { type: 'tool_started'; toolName: string; timestamp: string }
  | { type: 'tool_completed'; toolName: string; timestamp: string }
  | { type: 'diagnosis'; diagnosis: EnrichedAgentDiagnosis; timestamp: string }
  | { type: 'run_completed'; incidentId: string; timestamp: string }
  | { type: 'error'; message: string; timestamp: string };
