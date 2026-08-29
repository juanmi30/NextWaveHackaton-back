import { describe, expect, it } from 'vitest';
import type { RunStreamEvent } from '@openai/agents';
import {
  advanceAgentPhase,
  mapSdkEventToPublicAgentEvents,
  type AgentStreamMappingState,
} from './agent-stream.mapper.js';

function state(): AgentStreamMappingState {
  return { phase: 'OBSERVE', toolNamesByCallId: new Map() };
}

describe('mapSdkEventToPublicAgentEvents', () => {
  it('maps tool_called to tool_started without exposing arguments', () => {
    const mappingState = state();
    const events = mapSdkEventToPublicAgentEvents(
      {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: { type: 'tool_call_item', toolName: 'get_breakdown', callId: 'call-1' },
      } as RunStreamEvent,
      mappingState,
      '2026-08-29T12:00:00.000Z',
    );

    expect(events).toEqual([
      {
        type: 'phase_changed',
        phase: 'INVESTIGATE',
        timestamp: '2026-08-29T12:00:00.000Z',
      },
      {
        type: 'tool_started',
        toolName: 'get_breakdown',
        timestamp: '2026-08-29T12:00:00.000Z',
      },
    ]);
  });

  it('correlates tool_output by callId and maps it to tool_completed', () => {
    const mappingState = state();
    mappingState.toolNamesByCallId.set('call-1', 'get_incident');

    const events = mapSdkEventToPublicAgentEvents(
      {
        type: 'run_item_stream_event',
        name: 'tool_output',
        item: { type: 'tool_call_output_item', callId: 'call-1', output: { secret: true } },
      } as RunStreamEvent,
      mappingState,
      '2026-08-29T12:00:01.000Z',
    );

    expect(events).toEqual([
      {
        type: 'tool_completed',
        toolName: 'get_incident',
        timestamp: '2026-08-29T12:00:01.000Z',
      },
    ]);
  });

  it('does not expose raw model stream events', () => {
    const events = mapSdkEventToPublicAgentEvents(
      { type: 'raw_model_stream_event', data: { hidden: 'reasoning' } } as RunStreamEvent,
      state(),
    );

    expect(events).toEqual([]);
  });

  it('does not expose reasoning items', () => {
    const events = mapSdkEventToPublicAgentEvents(
      {
        type: 'run_item_stream_event',
        name: 'reasoning_item_created',
        item: { type: 'reasoning_item', rawItem: { hidden: 'reasoning' } },
      } as RunStreamEvent,
      state(),
    );

    expect(events).toEqual([]);
  });

  it('keeps public phase progression monotonic while still emitting regressive tool events', () => {
    const mappingState = state();
    const publicEvents = [
      { type: 'phase_changed', phase: 'OBSERVE' as const, timestamp: 't0' },
      ...mapSdkEventToPublicAgentEvents(
        {
          type: 'run_item_stream_event',
          name: 'tool_called',
          item: { type: 'tool_call_item', toolName: 'get_breakdown', callId: 'call-1' },
        } as RunStreamEvent,
        mappingState,
        't1',
      ),
      ...mapSdkEventToPublicAgentEvents(
        {
          type: 'run_item_stream_event',
          name: 'tool_called',
          item: { type: 'tool_call_item', toolName: 'get_incident_history', callId: 'call-2' },
        } as RunStreamEvent,
        mappingState,
        't2',
      ),
      ...mapSdkEventToPublicAgentEvents(
        {
          type: 'run_item_stream_event',
          name: 'tool_called',
          item: { type: 'tool_call_item', toolName: 'get_breakdown', callId: 'call-3' },
        } as RunStreamEvent,
        mappingState,
        't3',
      ),
      advanceAgentPhase(mappingState, 'RECOMMEND', 't4'),
      advanceAgentPhase(mappingState, 'REPORT', 't5'),
    ].filter((event) => event !== null);

    expect(
      publicEvents
        .filter((event) => event.type === 'phase_changed')
        .map((event) => ('phase' in event ? event.phase : null)),
    ).toEqual(['OBSERVE', 'INVESTIGATE', 'DIAGNOSE', 'RECOMMEND', 'REPORT']);
    expect(
      publicEvents.filter((event) => event.type === 'tool_started').map((event) => event.toolName),
    ).toEqual(['get_breakdown', 'get_incident_history', 'get_breakdown']);
  });
});
