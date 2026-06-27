// ─── Evolve shared helpers ──────────────────────────────────────────────────
//
// Pure utilities shared by the per-event-type handler modules in
// `workflow-handlers.ts`, `phase-handlers.ts`, etc. Keeping them here avoids
// circular imports between handlers and the dispatcher in `evolve.ts`.

import type { EventRecord, SessionEntity, WorkflowProjection } from './event-types.js';

export const MAX_SESSION_LOG = 500;

/** Signature shared by every per-event-type handler. */
export type EventHandler = (state: WorkflowProjection, event: EventRecord) => WorkflowProjection;

/** Identity fields extracted from an event for session resolution. */
export interface SessionIdentity {
  agentId: string;
  taskId?: string;
  runnerRole?: string;
  attempt?: number;
}

/**
 * Extract session identity fields from an event with metadata??data precedence.
 *
 * Precedence: `event.metadata` is tried first; if undefined, `event.data` is
 * used as fallback. This ensures events that carry identity in `data` (legacy
 * producers) resolve to the same session key as those that carry it in
 * `metadata` (canonical producers), eliminating silent O(n) fallback lookups.
 */
export function extractSessionIdentity(event: EventRecord): SessionIdentity {
  return {
    agentId: String(event.metadata.agentId ?? event.data.agentId ?? ''),
    taskId: event.metadata.taskId,
    runnerRole: (event.metadata.runnerRole as string | undefined) ?? (event.data.runnerRole as string | undefined),
    attempt: (event.metadata.attempt as number | undefined) ?? (event.data.attempt as number | undefined),
  };
}

/**
 * Stable key for a session entity.
 * Combines agentId, taskId, runnerRole, and attempt into a unique string.
 * - If taskId is undefined → just agentId (non-task sessions like scouts/planners).
 * - Otherwise → agentId::taskId[::runnerRole][::attempt].
 */
export function sessionKey(agentId: string, taskId?: string, runnerRole?: string, attempt?: number): string {
  if (taskId === undefined) return agentId;
  const parts = [agentId, taskId];
  if (runnerRole !== undefined) parts.push(runnerRole);
  if (attempt !== undefined) parts.push(String(attempt));
  return parts.join('::');
}

/**
 * Resolve a session entity by session key (agentId + taskId + runnerRole + attempt).
 *
 * 1. Fast path — try exact session key match.
 * 2. Fallback — search all sessions for best match.
 *
 * Only skip a session when runnerRole differs AND attempt matches — that
 * combination means the session is a *different* session for the same retry
 * iteration (e.g. executor vs reviewer at attempt 1). When the attempt
 * differs we stay lenient to cover legacy/fuzzy resolution.
 */
export function resolveSession(
  sessions: Record<string, SessionEntity>,
  agentId: string,
  taskId?: string,
  runnerRole?: string,
  attempt?: number,
): { key: string; entity: SessionEntity } | undefined {
  // 1. Exact session key match (fast path)
  const exactKey = sessionKey(agentId, taskId, runnerRole, attempt);
  if (sessions[exactKey]) return { key: exactKey, entity: sessions[exactKey] };

  // 2. Search fallback — iterate all sessions for best match.
  let best: { key: string; entity: SessionEntity } | undefined;
  for (const [k, v] of Object.entries(sessions)) {
    if (v.agentId !== agentId) continue;
    if (taskId !== undefined && v.taskId !== taskId) continue;
    if (
      runnerRole !== undefined &&
      v.runnerRole !== undefined &&
      v.runnerRole !== runnerRole &&
      attempt !== undefined &&
      v.attempt !== undefined &&
      v.attempt === attempt
    ) {
      continue;
    }
    if (v.active) {
      best = { key: k, entity: v };
    } else if (!best) {
      best = { key: k, entity: v };
    }
  }
  return best;
}

/** Create a shallow clone with an optional field set. */
export function clone<T>(obj: T, patch: Partial<T>): T {
  return { ...obj, ...patch };
}

/**
 * Cap the log at MAX_SESSION_LOG. When `entry` is provided the append is folded
 * in, producing a single O(n) allocation instead of a spread + slice.
 */
export function capLog(log: SessionEntity['log'], entry?: SessionEntity['log'][number]): SessionEntity['log'] {
  if (entry === undefined) {
    return log.length <= MAX_SESSION_LOG ? log : log.slice(log.length - MAX_SESSION_LOG);
  }
  if (log.length < MAX_SESSION_LOG) {
    return [...log, entry];
  }
  // At capacity — drop oldest + add newest in one allocation.
  return [...log.slice(1), entry];
}
