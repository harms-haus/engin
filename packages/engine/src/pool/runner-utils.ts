// ─── Runner Utilities ───────────────────────────────────────────────────────
//
// Shared boilerplate extracted from branch-runner / council-runner / map-runner
// / reflection-runner / linear-steps-runner. These five runners duplicated
// nearly identical logic for:
//
//   1. Tracking + disposing TrackedSession instances (array or step-indexed Map)
//   2. Building a StepExecutionContext from a TaskRunnerContext
//   3. Settling a StepResult into a TaskOutcome (approved → completed,
//      rejected → failed)
//   4. Wrapping runner bodies in a uniform error envelope that disposes
//      sessions, fails the task, and never re-throws.
//
// IMPORTANT: the runners themselves are NOT refactored in this task — that is
// done in subsequent tasks. This module is additive only.

import { safeErrorMessage } from '../core/utils.js';
import type { StepExecutionContext } from './step-execution.js';
import type { StepResult, TaskOutcome, TaskRunnerContext, TrackedSession } from './types.js';

// ─── Session tracking (array-backed) ────────────────────────────────────────

/**
 * Create an array-backed session tracker.
 *
 * Mirrors the disposable-session pattern in the branch/council/map runners:
 * collect {@link TrackedSession}s, then `disposeAll()` them with try/catch +
 * `console.error` so one failing dispose cannot leak the remaining sessions.
 */
export function createSessionTracker(
  agentId: string,
  taskId: string,
): {
  sessions: TrackedSession[];
  add(ts: TrackedSession): void;
  disposeAll(): void;
} {
  const sessions: TrackedSession[] = [];

  const disposeAll = (): void => {
    for (const ts of sessions) {
      try {
        ts.dispose();
      } catch (err) {
        console.error(`[${agentId}] Error disposing session for task ${taskId}:`, safeErrorMessage(err));
      }
    }
    sessions.length = 0;
  };

  return {
    sessions,
    add: (ts: TrackedSession) => sessions.push(ts),
    disposeAll,
  };
}

// ─── Session tracking (step-indexed Map) ────────────────────────────────────

/**
 * Create a step-indexed (`Map<number, TrackedSession>`) session tracker.
 *
 * Mirrors the pattern in the reflection / linear-steps runners, where each
 * step keeps at most one session keyed by its index. `set()` disposes the
 * previous entry at the same key before overwriting it (errors are swallowed
 * and logged, so the new entry is always stored).
 */
export function createSessionMap(
  agentId: string,
  taskId: string,
): {
  sessions: Map<number, TrackedSession>;
  set(stepIndex: number, ts: TrackedSession): void;
  disposeAll(): void;
} {
  const sessions = new Map<number, TrackedSession>();

  const set = (stepIndex: number, ts: TrackedSession): void => {
    const prev = sessions.get(stepIndex);
    if (prev) {
      try {
        prev.dispose();
      } catch (err) {
        console.error(
          `[${agentId}] Error disposing old session for step ${stepIndex} of task ${taskId}:`,
          safeErrorMessage(err),
        );
      }
    }
    sessions.set(stepIndex, ts);
  };

  const disposeAll = (): void => {
    for (const ts of sessions.values()) {
      try {
        ts.dispose();
      } catch (err) {
        console.error(`[${agentId}] Error disposing session for task ${taskId}:`, safeErrorMessage(err));
      }
    }
    sessions.clear();
  };

  return { sessions, set, disposeAll };
}

// ─── Execution context builder ──────────────────────────────────────────────

/**
 * Build a {@link StepExecutionContext} from a {@link TaskRunnerContext}.
 *
 * This is the identical object every runner constructs inline before calling
 * `runStep`. Optional fields (`apiKeys`, `rendererRegistry`) are forwarded as-is
 * so they remain `undefined` when the context omits them.
 */
export function buildExecCtx(ctx: TaskRunnerContext): StepExecutionContext {
  return {
    sessionBaseDir: ctx.sessionBaseDir,
    cwd: ctx.cwd,
    apiKeys: ctx.apiKeys,
    onStatus: ctx.onStatus,
    activeSessions: ctx.activeSessions,
    phaseId: ctx.phaseId,
    rendererRegistry: ctx.rendererRegistry,
    signal: ctx.signal,
    worktreeManager: ctx.worktreeManager,
  };
}

// ─── Settle helper ──────────────────────────────────────────────────────────

/**
 * Settle a {@link StepResult} into a {@link TaskOutcome}.
 *
 * - `approved` → `ctx.completeTask(output)`. If it returns `true`, then
 *   `disposeAll()` and return `{ status: 'completed', output }`. If it
 *   returns `false` (task was cancelled/raced), call `failTask` with the
 *   error, `disposeAll()`, and return `{ status: 'failed', error }`.
 * - `rejected` → `ctx.failTask({ feedback })`, then `disposeAll()`, then
 *   return `{ status: 'failed', feedback }`.
 *
 * In both cases `disposeAll()` runs AFTER the task settle call, matching the
 * ordering used by every runner's settle block.
 */
export function settleResult(ctx: TaskRunnerContext, result: StepResult, disposeAll: () => void): TaskOutcome {
  if (result.type === 'approved') {
    if (ctx.completeTask(result.output)) {
      disposeAll();
      return { status: 'completed', output: result.output };
    }
    ctx.failTask({ completed: false, error: 'Failed to submit' });
    disposeAll();
    return { status: 'failed', error: 'Failed to submit' };
  }

  ctx.failTask({ completed: false, feedback: result.feedback });
  disposeAll();
  return { status: 'failed', feedback: result.feedback };
}

// ─── Error envelope ─────────────────────────────────────────────────────────

/**
 * Uniform error envelope shared by every runner's outer try/catch.
 *
 * Disposes all tracked sessions FIRST, then fails the task with the error
 * message (coerced via {@link safeErrorMessage}), then returns a failed
 * outcome. Never re-throws — the returned outcome always carries the message.
 */
export function handleRunnerError(err: unknown, ctx: TaskRunnerContext, disposeAll: () => void): TaskOutcome {
  const errorMsg = safeErrorMessage(err);
  disposeAll();
  ctx.failTask({ completed: false, error: errorMsg });
  return { status: 'failed', error: errorMsg };
}
