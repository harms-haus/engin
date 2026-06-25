// ─── Evolve shared helpers ──────────────────────────────────────────────────
//
// Pure utilities shared by the per-event-type handler modules in
// `workflow-handlers.ts`, `phase-handlers.ts`, etc. Keeping them here avoids
// circular imports between handlers and the dispatcher in `evolve.ts`.

import type { AgentEntity, EventRecord, WorkflowProjection } from './event-types.js';

export const MAX_AGENT_LOG = 500;

/** Signature shared by every per-event-type handler. */
export type EventHandler = (state: WorkflowProjection, event: EventRecord) => WorkflowProjection;

/**
 * Stable key for an agent entity.
 * - If taskId is undefined → just agentId (non-task agents like scouts/planners).
 * - If taskId is defined AND stepIndex is defined → agentId::taskId::stepIndex.
 * - If taskId is defined but stepIndex is undefined → agentId::taskId (backward-compatible).
 */
export function agentKey(agentId: string, taskId?: string, stepIndex?: number): string {
  if (taskId === undefined) return agentId;
  if (stepIndex !== undefined) return `${agentId}::${taskId}::${stepIndex}`;
  return `${agentId}::${taskId}`;
}

/**
 * Resolve an agent entity by agentId (and optional taskId / stepIndex).
 *
 * 1. Fast path — try exact key match using all available identifiers.
 * 2. Fallback — search all agents for best match:
 *    - Filter by agentId (required) and taskId (if defined).
 *    - Prefer the last active agent (or any matching agent if none active).
 *
 * This unified fallback is critical because events such as `agent_completed`
 * may carry agentId + taskId but NOT stepIndex (legacy events). With per-step
 * keys, the exact-key match would fail, and the fallback ensures resolution.
 */
export function resolveAgent(
  agents: Record<string, AgentEntity>,
  agentId: string,
  taskId?: string,
  stepIndex?: number,
): { key: string; entity: AgentEntity } | undefined {
  // 1. Exact key match (fast path)
  const exactKey = agentKey(agentId, taskId, stepIndex);
  if (agents[exactKey]) return { key: exactKey, entity: agents[exactKey] };

  // 2. Search fallback — iterate all agents for best match
  let best: { key: string; entity: AgentEntity } | undefined;
  for (const [k, v] of Object.entries(agents)) {
    if (v.agentId !== agentId) continue;
    if (taskId !== undefined && v.taskId !== taskId) continue;
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
 * Cap the log at MAX_AGENT_LOG. When `entry` is provided the append is folded
 * in, producing a single O(n) allocation instead of a spread + slice.
 */
export function capLog(log: AgentEntity['log'], entry?: AgentEntity['log'][number]): AgentEntity['log'] {
  if (entry === undefined) {
    return log.length <= MAX_AGENT_LOG ? log : log.slice(log.length - MAX_AGENT_LOG);
  }
  if (log.length < MAX_AGENT_LOG) {
    return [...log, entry];
  }
  // At capacity — drop oldest + add newest in one allocation.
  return [...log.slice(1), entry];
}
