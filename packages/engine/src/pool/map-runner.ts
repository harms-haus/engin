/**
 * @fileoverview mapRunner – fan-out over a collection with concurrency cap.
 *
 * Runs the same step for each item in a dynamic collection, optionally
 * limiting concurrent workers. Uses Promise.allSettled to prevent session
 * leaks on partial failure.
 */

import type { Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import { runStep, type StepExecutionContext } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext, TrackedSession } from './types.js';

// ─── Options ──────────────────────────────────────────────────────────────

export interface MapRunnerOptions {
  /** Extracts the collection of items from the task at runtime. */
  items: (task: Task) => unknown[];
  /** The step to run for each item. */
  step: StepDefinition;
  /** Maximum concurrent workers. If omitted or >= items.length, all run in parallel. */
  concurrency?: number;
}

// ─── Factory ──────────────────────────────────────────────────────────────

/**
 * Create a TaskRunner that fans out over a dynamic collection, running the
 * same step for each item with an optional concurrency cap.
 *
 * Uses `Promise.allSettled` to ensure all worker sessions are tracked even
 * when some items fail, preventing session leaks.
 */
export function mapRunner(options: MapRunnerOptions): TaskRunner {
  return async (ctx: TaskRunnerContext): Promise<TaskOutcome> => {
    const { task, agentId, profiles, onStatus, phaseId, sessionBaseDir, cwd, apiKeys } = ctx;

    // ── Step 2: Sessions for disposal tracking ─────────────────────────
    const sessions: TrackedSession[] = [];

    const disposeAllSessions = () => {
      for (const ts of sessions) {
        try {
          ts.dispose();
        } catch (err) {
          console.error(`[${agentId}] Error disposing session for task ${task.id}:`, safeErrorMessage(err));
        }
      }
      sessions.length = 0;
    };

    try {
      // ── Step 1: Extract items ────────────────────────────────────────
      const items = options.items(ctx.task);
      if (items.length === 0) {
        ctx.failTask({ completed: false, error: 'No items to process' });
        return { status: 'failed', error: 'No items to process' };
      }

      // ── Step 3: Execution context ────────────────────────────────────
      const execCtx: StepExecutionContext = {
        sessionBaseDir,
        cwd,
        apiKeys,
        onStatus,
        activeSessions: ctx.activeSessions,
        phaseId,
      };

      // ── Step 4: Worker function ──────────────────────────────────────
      const processItem = async (item: unknown, index: number): Promise<{ output: unknown }> => {
        onStatus?.onStepStart?.({
          taskId: task.id,
          stepIndex: index,
          stepName: options.step.name,
          agentId,
        });

        // Build an item-specific task with prompt including the item
        const itemStr = typeof item === 'string' ? item : JSON.stringify(item);
        const itemTask: Task = {
          ...task,
          prompt: task.prompt + '\n' + `## Item ${index + 1} of ${items.length}` + '\n' + itemStr,
        };

        const { result, trackedSession } = await runStep(
          itemTask,
          options.step,
          agentId,
          { stepIndex: index, attempt: 0, execCount: 0 },
          profiles,
          execCtx,
        );

        // CRITICAL: track the session immediately after runStep succeeds
        sessions.push(trackedSession);

        return { output: result.type === 'approved' ? result.output : result.feedback };
      };

      // ── Step 5: Execute with concurrency control ─────────────────────
      let results: PromiseSettledResult<{ output: unknown }>[];

      const concurrency = options.concurrency !== undefined ? Math.max(1, options.concurrency) : undefined;

      if (concurrency === undefined || concurrency >= items.length) {
        // Run all items in parallel — allSettled ensures all sessions are tracked
        results = await Promise.allSettled(items.map((item, i) => processItem(item, i)));
      } else {
        // Worker-pool pattern with concurrency cap
        results = new Array<PromiseSettledResult<{ output: unknown }>>(items.length);
        let nextIndex = 0;

        const poolWorker = async (): Promise<void> => {
          while (nextIndex < items.length) {
            const i = nextIndex++;
            try {
              const value = await processItem(items[i], i);
              results[i] = { status: 'fulfilled', value };
            } catch (err) {
              results[i] = { status: 'rejected', reason: err };
            }
          }
        };

        await Promise.all(Array.from({ length: concurrency }, () => poolWorker()));
      }

      // ── Step 6: Collect outputs and errors ───────────────────────────
      const outputs: unknown[] = [];
      const errors: string[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled') {
          outputs.push(result.value.output);
        } else {
          errors.push(safeErrorMessage(result.reason));
        }
      }

      // ── Step 7: Settle the task ──────────────────────────────────────
      if (errors.length === 0) {
        // All items succeeded
        if (ctx.completeTask()) {
          disposeAllSessions();
          return { status: 'completed', output: outputs };
        }
        ctx.failTask({ completed: false, error: 'Failed to submit' });
        disposeAllSessions();
        return { status: 'failed', error: 'Failed to submit' };
      }

      // Some or all items failed
      ctx.failTask({ completed: false, error: errors.join('; ') });
      disposeAllSessions();
      return { status: 'failed', error: `${errors.length} of ${items.length} items failed` };
    } catch (err) {
      // ── Step 8: Unexpected error – never re-throw ────────────────────
      disposeAllSessions();
      const errorMsg = safeErrorMessage(err);
      ctx.failTask({ completed: false, error: errorMsg });
      return { status: 'failed', error: errorMsg };
    }
  };
}
