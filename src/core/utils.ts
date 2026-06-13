// ─── Shared Utilities ────────────────────────────────────────────────────────

import type { AgentStatusCallbacks, StatusCallbacks } from './types.js';
import { STATUS_CALLBACK_METHODS } from './types.js';

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
 * Combines multiple {@link StatusCallbacks} consumers into a single one that
 * fans out each event to all consumers in array order.
 *
 * - If `callbacks` is empty, returns a no-op object (every method is a no-op).
 * - If `callbacks` has exactly one element, returns that element directly.
 * - Otherwise returns a composed object that calls every callback in order.
 */
export function composeStatusCallbacks(callbacks: StatusCallbacks[]): StatusCallbacks {
  if (callbacks.length === 0) {
    return Object.fromEntries(STATUS_CALLBACK_METHODS.map((name) => [name, () => undefined])) as StatusCallbacks;
  }
  if (callbacks.length === 1) {
    return callbacks[0];
  }
  return Object.fromEntries(
    STATUS_CALLBACK_METHODS.map((name) => [
      name,
      (info: unknown) => {
        for (const cb of callbacks) {
          (cb as Record<string, (info: unknown) => void>)[name]?.(info);
        }
      },
    ]),
  ) as StatusCallbacks;
}

/**
 * Forward agent-status callbacks from a {@link StatusCallbacks} object to an
 * {@link AgentStatusCallbacks} object. Returns `undefined` when `onStatus` is
 * not provided, which is the conventional "no-op" value for harness options.
 */
export function forwardAgentStatus(onStatus?: StatusCallbacks): AgentStatusCallbacks | undefined {
  if (!onStatus) return undefined;
  return {
    onTurnStart: (info) => onStatus.onTurnStart?.(info),
    onTurnEnd: (info) => onStatus.onTurnEnd?.(info),
    onToolCallStart: (info) => onStatus.onToolCallStart?.(info),
    onToolCallEnd: (info) => onStatus.onToolCallEnd?.(info),
  };
}

/** Default tool names used by the harness when no include/exclude list is specified. */
export const DEFAULT_TOOLS: readonly string[] = Object.freeze(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);

/** Append a feedback entry to the task's reviewFeedback array, initializing if needed. */
export function appendReviewFeedback(task: { reviewFeedback?: string[] }, feedback: string): void {
  if (!task.reviewFeedback) {
    task.reviewFeedback = [];
  }
  task.reviewFeedback.push(feedback);
}
