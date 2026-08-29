import type { RunStreamEvent } from '@openai/agents';
import type { AgentPhase, AgentStreamEvent } from './agent-stream.types.js';

export type AgentStreamMappingState = {
  phase: AgentPhase;
  toolNamesByCallId: Map<string, string>;
};

const TOOL_PHASES: Record<string, AgentPhase> = {
  get_incident: 'OBSERVE',
  get_breakdown: 'INVESTIGATE',
  get_timeseries: 'INVESTIGATE',
  get_decline_reason_distribution: 'INVESTIGATE',
  get_incident_history: 'DIAGNOSE',
  list_active_incidents: 'DIAGNOSE',
};

const PHASE_RANK: Record<AgentPhase, number> = {
  OBSERVE: 0,
  INVESTIGATE: 1,
  DIAGNOSE: 2,
  RECOMMEND: 3,
  REPORT: 4,
};

export function mapSdkEventToPublicAgentEvents(
  event: RunStreamEvent,
  state: AgentStreamMappingState,
  timestamp = new Date().toISOString(),
): AgentStreamEvent[] {
  if (event.type !== 'run_item_stream_event') return [];

  if (event.name === 'tool_called' && event.item.type === 'tool_call_item') {
    const toolName = event.item.toolName;
    if (!toolName) return [];
    if (event.item.callId) state.toolNamesByCallId.set(event.item.callId, toolName);
    return withPhaseChange(state, TOOL_PHASES[toolName], {
      type: 'tool_started',
      toolName,
      timestamp,
    });
  }

  if (event.name === 'tool_output' && event.item.type === 'tool_call_output_item') {
    const callId = event.item.callId;
    const toolName = callId ? state.toolNamesByCallId.get(callId) : undefined;
    if (!toolName) return [];
    state.toolNamesByCallId.delete(callId!);
    return [
      {
        type: 'tool_completed',
        toolName,
        timestamp,
      },
    ];
  }

  return [];
}

function withPhaseChange(
  state: AgentStreamMappingState,
  nextPhase: AgentPhase | undefined,
  event: AgentStreamEvent,
): AgentStreamEvent[] {
  if (!nextPhase) return [event];
  const phaseChange = advanceAgentPhase(state, nextPhase, event.timestamp);
  return phaseChange ? [phaseChange, event] : [event];
}

export function advanceAgentPhase(
  state: AgentStreamMappingState,
  nextPhase: AgentPhase,
  timestamp = new Date().toISOString(),
): AgentStreamEvent | null {
  if (PHASE_RANK[nextPhase] <= PHASE_RANK[state.phase]) return null;
  state.phase = nextPhase;
  return { type: 'phase_changed', phase: nextPhase, timestamp };
}
