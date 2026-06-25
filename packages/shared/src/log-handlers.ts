// ─── Log / decision / render handlers ───────────────────────────────────────
//
// Handlers for agent log entries, decisions, errors, renders, server-captured
// console output, and sidebar updates:
// decision, error, agent_rendered, log, sidebar_updated.

import type { EventRecord, LogEntry, WorkflowProjection } from './event-types.js';
import { MAX_RUN_LOG } from './event-types.js';
import { capLog, clone, resolveAgent } from './evolve-utils.js';

export function handleDecision(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const agentId = String(event.metadata.agentId ?? '');
  const taskId = event.metadata.taskId;
  const resolved = resolveAgent(state.agents, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  const entry = {
    id: `log-${event.seq}`,
    timestamp: event.metadata.timestamp,
    type: 'decision' as const,
    content: String(event.data.decision ?? ''),
    metadata: { reasoning: event.data.reasoning },
  };
  return clone(state, {
    agents: {
      ...state.agents,
      [key]: clone(existing, { log: capLog(existing.log, entry) }),
    },
    seq: event.seq,
  });
}

export function handleError(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const agentId = String(event.metadata.agentId ?? '');
  const taskId = event.metadata.taskId;
  const resolved = resolveAgent(state.agents, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  const entry = {
    id: `log-${event.seq}`,
    timestamp: event.metadata.timestamp,
    type: 'error' as const,
    content: String(event.data.error ?? ''),
  };
  return clone(state, {
    agents: {
      ...state.agents,
      [key]: clone(existing, { log: capLog(existing.log, entry) }),
    },
    seq: event.seq,
  });
}

export function handleAgentRendered(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const agentId = String(event.metadata.agentId ?? '');
  const taskId = event.metadata.taskId;
  const resolved = resolveAgent(state.agents, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  const entry = {
    id: `log-${event.seq}`,
    timestamp: event.metadata.timestamp,
    type: 'render' as const,
    content: String(event.data.rendered ?? ''),
  };
  return clone(state, {
    agents: {
      ...state.agents,
      [key]: clone(existing, { log: capLog(existing.log, entry) }),
    },
    seq: event.seq,
  });
}

export function handleLog(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const level = String(event.data.level ?? 'info');
  const entry: LogEntry = {
    id: `log-${event.seq}`,
    timestamp: event.metadata.timestamp,
    type: level === 'error' ? 'error' : 'text',
    content: String(event.data.message ?? ''),
  };
  const nextRunLog = [...state.runLog, entry];
  return clone(state, {
    runLog: nextRunLog.length > MAX_RUN_LOG ? nextRunLog.slice(nextRunLog.length - MAX_RUN_LOG) : nextRunLog,
    seq: event.seq,
  });
}

export function handleSidebarUpdated(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const sidebar = { ...state.sidebar };
  if (event.data.title !== undefined) sidebar.title = String(event.data.title);
  if (event.data.indicator !== undefined) sidebar.indicator = String(event.data.indicator);
  // NOTE: phases is no longer updated via sidebar_updated; use phase_registered instead.
  return clone(state, { sidebar, seq: event.seq });
}
