// ─── Session lifecycle handlers ─────────────────────────────────────────────
//
// Handlers for session spawning, completion, and turn-level events:
// session_started, session_completed, turn_started, turn_ended.

import type { EventRecord, SessionEntity, WorkflowProjection } from './event-types.js';
import { capLog, clone, extractSessionIdentity, resolveSession, sessionKey } from './evolve-utils.js';

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
      [key]: clone(existing, { active: false, completedAt: event.metadata.timestamp }),
    },
    seq: event.seq,
  });
}

export function handleTurnStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  // No-op — just bump seq
  return clone(state, { seq: event.seq });
}

export function handleTurnEnded(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const { agentId, taskId } = extractSessionIdentity(event);
  const resolved = resolveSession(state.sessions, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;

  const tokens = event.data.tokens as { input?: number; output?: number } | undefined;
  const blocks = Array.isArray(event.data.contentBlocks) ? (event.data.contentBlocks as Record<string, unknown>[]) : [];

  const newLog = [...existing.log];
  for (const block of blocks) {
    const blockType = String(block.type ?? '');
    if (blockType === 'text') {
      newLog.push({
        id: `log-${event.seq}-${newLog.length}`,
        timestamp: event.metadata.timestamp,
        type: 'text',
        content: String(block.text ?? ''),
      });
    } else if (blockType === 'thinking') {
      newLog.push({
        id: `log-${event.seq}-${newLog.length}`,
        timestamp: event.metadata.timestamp,
        type: 'thinking',
        content: String(block.thinking ?? ''),
      });
    }
  }

  const inputTokens = existing.inputTokens + (tokens?.input ?? 0);
  const outputTokens = existing.outputTokens + (tokens?.output ?? 0);

  return clone(state, {
    sessions: {
      ...state.sessions,
      [key]: clone(existing, { log: capLog(newLog), inputTokens, outputTokens }),
    },
    stats: {
      ...state.stats,
      totalTokens: state.stats.totalTokens + (tokens?.input ?? 0) + (tokens?.output ?? 0),
    },
    seq: event.seq,
  });
}
