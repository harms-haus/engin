// ─── Session lifecycle handlers ─────────────────────────────────────────────
//
// Handlers for session spawning, completion, and turn-level events:
// session_started, session_completed, turn_started, turn_ended.

import type { EventRecord, LogEntry, SessionEntity, WorkflowProjection } from './event-types.js';
import { MAX_SESSION_LOG, clone, extractSessionIdentity, resolveSession, sessionKey } from './evolve-utils.js';

export function handleSessionStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const { agentId, taskId, runnerRole, attempt } = extractSessionIdentity(event);
  const key = sessionKey(agentId, taskId, runnerRole, attempt);
  const existing = state.sessions[key];
  // If this session is associated with a task, copy the task's title.
  const existingTask = taskId ? state.tasks[taskId] : undefined;

  if (existing) {
    // UPSERT: preserve accumulated log/tokens/toolCallCount, update metadata.
    const entity: SessionEntity = {
      ...existing,
      profile: String(event.data.profile ?? existing.profile),
      phaseId: String(event.metadata.phaseId ?? event.data.phaseId ?? existing.phaseId ?? ''),
      sessionId: typeof event.data.sessionId === 'string' ? event.data.sessionId : existing.sessionId,
      sessionPath: typeof event.data.sessionPath === 'string' ? event.data.sessionPath : existing.sessionPath,
      contextWindow: typeof event.data.contextWindow === 'number' ? event.data.contextWindow : existing.contextWindow,
      runnerRole: runnerRole ?? existing.runnerRole,
      attempt: attempt ?? existing.attempt,
      startedAt: existing.startedAt ?? event.metadata.timestamp,
      active: true,
      status: 'running',
      completedAt: undefined,
      taskTitle: existingTask?.title ?? existing.taskTitle,
    };
    return clone(state, {
      sessions: { ...state.sessions, [key]: entity },
      // Do NOT increment sessionCount — this session was already counted.
      seq: event.seq,
    });
  }

  // First spawn — create fresh entity and increment sessionCount.
  const entity: SessionEntity = {
    uid: key,
    agentId,
    profile: String(event.data.profile ?? ''),
    phaseId: String(event.metadata.phaseId ?? event.data.phaseId ?? ''),
    taskId,
    sessionId: typeof event.data.sessionId === 'string' ? event.data.sessionId : undefined,
    sessionPath: typeof event.data.sessionPath === 'string' ? event.data.sessionPath : undefined,
    contextWindow: typeof event.data.contextWindow === 'number' ? event.data.contextWindow : undefined,
    runnerRole: runnerRole ?? 'executor',
    attempt: attempt ?? 1,
    startedAt: event.metadata.timestamp,
    active: true,
    status: 'running',
    log: [],
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    taskTitle: existingTask?.title ?? '',
  };
  return clone(state, {
    sessions: { ...state.sessions, [key]: entity },
    stats: { ...state.stats, sessionCount: state.stats.sessionCount + 1 },
    seq: event.seq,
  });
}

export function handleSessionCompleted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const { agentId, taskId, runnerRole, attempt } = extractSessionIdentity(event);
  const resolved = resolveSession(state.sessions, agentId, taskId, runnerRole, attempt);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  return clone(state, {
    sessions: {
      ...state.sessions,
      [key]: clone(existing, { active: false, status: 'completed', completedAt: event.metadata.timestamp }),
    },
    seq: event.seq,
  });
}

export function handleSessionFailed(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const { agentId, taskId, runnerRole, attempt } = extractSessionIdentity(event);
  const resolved = resolveSession(state.sessions, agentId, taskId, runnerRole, attempt);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  return clone(state, {
    sessions: {
      ...state.sessions,
      [key]: clone(existing, { active: false, status: 'failed' }),
    },
    seq: event.seq,
  });
}

export function handleTurnStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  // Record the session.log length as a turn boundary marker. The turn's
  // tool_call events append after this point; turn_ended consumes the marker
  // to splice the turn's thinking/text content blocks in at this index so
  // they render BEFORE the tool calls (think → message → tool).
  const { agentId, taskId } = extractSessionIdentity(event);
  const resolved = resolveSession(state.sessions, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  return clone(state, {
    sessions: {
      ...state.sessions,
      [key]: clone(existing, { _turnStartLogIndex: existing.log.length }),
    },
    seq: event.seq,
  });
}

export function handleTurnEnded(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const { agentId, taskId } = extractSessionIdentity(event);
  const resolved = resolveSession(state.sessions, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;

  const tokens = event.data.tokens as { input?: number; output?: number } | undefined;
  const blocks = Array.isArray(event.data.contentBlocks) ? (event.data.contentBlocks as Record<string, unknown>[]) : [];

  // Build the turn's content-block entries (thinking + text). toolCall blocks
  // are intentionally skipped — tools are logged via their own
  // tool_call_started/ended events.
  const newEntries: LogEntry[] = [];
  for (const block of blocks) {
    const blockType = String(block.type ?? '');
    if (blockType === 'text') {
      newEntries.push({
        id: `log-${event.seq}-${newEntries.length}`,
        timestamp: event.metadata.timestamp,
        type: 'text',
        content: String(block.text ?? ''),
      });
    } else if (blockType === 'thinking') {
      newEntries.push({
        id: `log-${event.seq}-${newEntries.length}`,
        timestamp: event.metadata.timestamp,
        type: 'thinking',
        content: String(block.thinking ?? ''),
      });
    }
  }

  // Insert the content blocks at the turn boundary so they precede this
  // turn's tool calls. turn_started recorded the log length; tool_call events
  // appended after it, so splicing at that index yields the desired
  // think → message → tool order instead of tool → think → message.
  let insertIndex: number;
  const marker = existing._turnStartLogIndex;
  if (typeof marker === 'number' && marker >= 0 && marker <= existing.log.length) {
    insertIndex = marker;
  } else {
    // Fallback (no marker — e.g. session restored from a snapshot mid-turn):
    // insert just before the trailing run of tool_call entries.
    insertIndex = existing.log.length;
    for (let i = existing.log.length - 1; i >= 0; i--) {
      const t = existing.log[i].type;
      if (t === 'tool_call_start' || t === 'tool_call_end') {
        insertIndex = i;
      } else {
        break;
      }
    }
  }

  const reordered = [...existing.log];
  if (newEntries.length > 0) {
    reordered.splice(insertIndex, 0, ...newEntries);
  }
  const nextLog = reordered.length > MAX_SESSION_LOG ? reordered.slice(reordered.length - MAX_SESSION_LOG) : reordered;

  const inputTokens = existing.inputTokens + (tokens?.input ?? 0);
  const outputTokens = existing.outputTokens + (tokens?.output ?? 0);

  return clone(state, {
    sessions: {
      ...state.sessions,
      [key]: clone(existing, {
        log: nextLog,
        inputTokens,
        outputTokens,
        _turnStartLogIndex: undefined,
      }),
    },
    stats: {
      ...state.stats,
      totalTokens: state.stats.totalTokens + (tokens?.input ?? 0) + (tokens?.output ?? 0),
    },
    seq: event.seq,
  });
}
