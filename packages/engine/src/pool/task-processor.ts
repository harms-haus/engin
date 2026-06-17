// ─── Task Processor ─────────────────────────────────────────────────────────
//
// Shared helper functions for task error/audit reporting used by LanePool
// and other task runners.

import { safeErrorMessage } from '../core/utils.js';
import type { LanePoolOptions } from './types.js';

// ─── Context ───────────────────────────────────────────────────────────────

/**
 * Context passed from the LanePool to the task processor.
 * Contains all external dependencies needed to process a task without
 * referencing the LanePool class directly.
 */
export interface TaskProcessorContext {
  options: LanePoolOptions;
  activeSessions: Set<{ abort(): Promise<void> }>;
  /** Phase identifier set by the workflow orchestrator. */
  phaseId: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Safely mark a task as complete. Catches and logs errors from invalid
 * state transitions. The `result` is persisted onto `task.result`.
 */
export function safeCompleteTask(taskId: string, result: unknown, ctx: TaskProcessorContext): boolean {
  try {
    ctx.options.taskTracker.completeTask(taskId, result);
    return true;
  } catch (err) {
    const errorMsg = `safeCompleteTask failed for ${taskId}: ${safeErrorMessage(err)}`;
    reportError('pool', errorMsg, undefined, taskId, ctx);
    return false;
  }
}

/**
 * Safely mark a task as failed. Catches and logs errors from invalid
 * state transitions.
 */
export function safeFailTask(taskId: string, result: unknown, ctx: TaskProcessorContext): void {
  try {
    ctx.options.taskTracker.failTask(taskId, result);
  } catch (err) {
    const errorMsg = `safeFailTask failed for ${taskId}: ${safeErrorMessage(err)}`;
    reportError('pool', errorMsg, undefined, taskId, ctx);
  }
}

// ── Error & Audit Helpers ─────────────────────────────────────────────

/**
 * Report an error via the onStatus callback or console.error fallback.
 */
export function reportError(
  agentId: string,
  error: string,
  phaseId?: string,
  taskId?: string,
  ctx?: TaskProcessorContext,
): void {
  const effectivePhaseId = phaseId ?? ctx?.options.phaseId ?? ctx?.phaseId ?? 'implementing';
  if (ctx?.options.onStatus?.onError) {
    ctx.options.onStatus.onError({ agentId, error, phaseId: effectivePhaseId, taskId });
  } else {
    console.error(`[${agentId}] ${error}`);
  }
}
