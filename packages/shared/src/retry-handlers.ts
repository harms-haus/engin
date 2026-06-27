// ─── Auto-retry handlers ────────────────────────────────────────────────────
//
// Handlers for the auto-retry lifecycle:
// auto_retry_started, auto_retry_completed.

import type { EventRecord, LogEntry, WorkflowProjection } from './event-types.js';
import { capLog, clone, extractSessionIdentity, resolveSession } from './evolve-utils.js';
import { formatDuration, sanitizeDisplayText } from './text-utils.js';

export function handleAutoRetryStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const { agentId, taskId } = extractSessionIdentity(event);
  const resolved = resolveSession(state.sessions, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  const attempt = Number(event.data.attempt ?? 1);
  const maxAttempts = Number(event.data.maxAttempts ?? 1);
  const delayMs = Number(event.data.delayMs ?? 0);
  const delayStr = delayMs > 0 ? ` in ${formatDuration(delayMs)}` : '';
  const errorMessage = sanitizeDisplayText(String(event.data.errorMessage ?? ''));
  const suffix = errorMessage ? `: ${errorMessage}` : '';
  const entry = {
    id: `log-${event.seq}`,
    timestamp: event.metadata.timestamp,
    type: 'text' as const,
    content: `Retrying (attempt ${attempt}/${maxAttempts})${delayStr}${suffix}`,
    metadata: { attempt, maxAttempts, delayMs, errorMessage },
  };
  return clone(state, {
    sessions: {
      ...state.sessions,
      [key]: clone(existing, { log: capLog(existing.log, entry) }),
    },
    seq: event.seq,
  });
}

export function handleAutoRetryCompleted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const { agentId, taskId } = extractSessionIdentity(event);
  const resolved = resolveSession(state.sessions, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;
  const success = event.data.success === true;
  const finalError = sanitizeDisplayText(String(event.data.finalError ?? ''));
  const attempt = Number(event.data.attempt ?? 1);
  const entry = {
    id: `log-${event.seq}`,
    timestamp: event.metadata.timestamp,
    type: (success ? 'text' : 'error') as LogEntry['type'],
    content: success ? 'Retry succeeded' : `Retry failed: ${finalError}`,
    metadata: { success, attempt, finalError },
  };
  return clone(state, {
    sessions: {
      ...state.sessions,
      [key]: clone(existing, { log: capLog(existing.log, entry) }),
    },
    seq: event.seq,
  });
}
