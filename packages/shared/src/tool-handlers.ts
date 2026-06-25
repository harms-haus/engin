// ─── Tool call handlers ─────────────────────────────────────────────────────
//
// Handlers for tool invocation lifecycle events:
// tool_call_started, tool_call_ended.

import type { EventRecord, WorkflowProjection } from './event-types.js';
import { capLog, clone, resolveAgent } from './evolve-utils.js';

export function handleToolCallStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const agentId = String(event.metadata.agentId ?? '');
  const taskId = event.metadata.taskId;
  const resolved = resolveAgent(state.agents, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  const entry = {
    id: `log-${event.seq}`,
    timestamp: event.metadata.timestamp,
    type: 'tool_call_start' as const,
    content: String(event.data.toolName ?? ''),
    // Preserve tool arguments so renderers (TUI + web) can produce
    // human-readable summaries like `read → ./path` via formatToolCall.
    metadata: {
      toolName: event.data.toolName,
      toolCallId: event.data.toolCallId,
      arguments: event.data.arguments ?? {},
    },
  };
  return clone(state, {
    agents: {
      ...state.agents,
      [key]: clone(existing, {
        log: capLog(existing.log, entry),
        toolCallCount: existing.toolCallCount + 1,
      }),
    },
    seq: event.seq,
  });
}

export function handleToolCallEnded(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const agentId = String(event.metadata.agentId ?? '');
  const taskId = event.metadata.taskId;
  const resolved = resolveAgent(state.agents, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  const entry = {
    id: `log-${event.seq}`,
    timestamp: event.metadata.timestamp,
    type: 'tool_call_end' as const,
    content: String(event.data.toolName ?? ''),
    metadata: { toolName: event.data.toolName, toolCallId: event.data.toolCallId, isError: event.data.isError },
  };
  return clone(state, {
    agents: {
      ...state.agents,
      [key]: clone(existing, { log: capLog(existing.log, entry) }),
    },
    seq: event.seq,
  });
}
