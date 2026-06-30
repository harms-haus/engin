// ─── Shared Utilities ────────────────────────────────────────────────────────

import type { AgentStatusCallbacks, StatusCallbacks } from './types.js';

/**
 * Validates a workflow name, throwing if it contains path separators or "..".
 */
export function validateWorkflowName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid workflow name: "${name}". Names must not contain path separators or "..".`);
  }
}

/**
 * Returns true when `err` is a non-null object with a `code` property
 * equal to `'ENOENT'`.
 */
export function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT';
}

/**
 * Extracts a human-readable error message from an unknown thrown value.
 */
export function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Forward agent-status callbacks from a {@link StatusCallbacks} object to an
 * {@link AgentStatusCallbacks} object. Returns `undefined` when `onStatus` is
 * not provided, which is the conventional "no-op" value for harness options.
 *
 * `taskId` / `phaseId` (when supplied by the session layer) are injected into
 * the auto-retry callbacks so retry events carry enough identity for the event
 * log prefix to name the owning task / phase. Other agent-status callbacks
 * (turn / tool) are intentionally left untouched — they are silent in the
 * event log and already carry `agentId`.
 */
export function forwardAgentStatus(
  onStatus: StatusCallbacks | undefined,
  ctx?: { taskId?: string; phaseId?: string },
): AgentStatusCallbacks | undefined {
  if (!onStatus) return undefined;
  const taskId = ctx?.taskId;
  const phaseId = ctx?.phaseId;
  const idPatch =
    taskId !== undefined || phaseId !== undefined
      ? {
          ...(taskId !== undefined ? { taskId } : {}),
          ...(phaseId !== undefined ? { phaseId } : {}),
        }
      : undefined;
  return {
    onTurnStart: (info) => onStatus.onTurnStart?.(info),
    onTurnEnd: (info) => onStatus.onTurnEnd?.(info),
    onToolCallStart: (info) => onStatus.onToolCallStart?.(info),
    onToolCallEnd: (info) => onStatus.onToolCallEnd?.(info),
    onAutoRetryStart: (info) => onStatus.onAutoRetryStart?.(idPatch ? { ...info, ...idPatch } : info),
    onAutoRetryCompleted: (info) => onStatus.onAutoRetryCompleted?.(idPatch ? { ...info, ...idPatch } : info),
  };
}

/** Default tool names used by the harness when no include/exclude list is specified. */
export const DEFAULT_TOOLS: readonly string[] = Object.freeze(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);

// Re-export for backwards compatibility — `appendReviewFeedback` now lives in
// `./task-feedback.js` (core layer) so that `tracking` can import it without a
// `tracking → pool` dependency. New consumers should import directly from
// `./task-feedback.js`.
export { appendReviewFeedback } from './task-feedback.js';
