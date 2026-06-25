/**
 * @fileoverview mapRunner – fan-out over a collection with concurrency cap.
 *
 * Runs the same step for each item in a dynamic collection, optionally
 * limiting concurrent workers. Uses Promise.allSettled to prevent session
 * leaks on partial failure.
 */

import type { Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import { composeItemPrompt as defaultComposeItemPrompt } from './prompt-builder.js';
import { buildExecCtx, createSessionTracker, handleRunnerError } from './runner-utils.js';
import { runStep } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext } from './types.js';

// ─── Options ──────────────────────────────────────────────────────────────

export interface MapRunnerOptions {
  /** Extracts the collection of items from the task at runtime. */
  items: (task: Task) => unknown[];
  /** The step to run for each item. */
  step: StepDefinition;
  /** Maximum concurrent workers. If omitted or >= items.length, all run in parallel. */
  concurrency?: number;
  /**
   * Optional callback that composes the item-specific task from the original
   * task and the item being processed.
   *
   * When omitted the default {@link composeItemPrompt} helper is used,
   * preserving the exact legacy prompt format (`## Item X of Y` appended to
   * the task prompt). Returning a brand-new Task (rather than mutating the
   * original) keeps `ctx.task` untouched.
   *
   * This keeps the runner a simple primitive: it fans out over items with
   * concurrency control. The prompt composition is configurable from the
   * call site.
   */
  composeItemPrompt?: (task: Task, itemIndex: number, totalItems: number, item: unknown) => Task;
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
  const { items: getItems, step, concurrency: concurrencyOpt } = options;
  // Default to the shared item-prompt composer, preserving the legacy prompt
  // format unless the caller supplies a custom composition strategy.
  const composeItem = options.composeItemPrompt ?? defaultComposeItemPrompt;

  return async (ctx: TaskRunnerContext): Promise<TaskOutcome> => {
    const { task, agentId, profiles, onStatus } = ctx;

    const tracker = createSessionTracker(agentId, task.id);
    const execCtx = buildExecCtx(ctx);

    try {
      // ── Step 1: Extract items ────────────────────────────────────────
      const items = getItems(task);
      if (items.length === 0) {
        ctx.failTask({ completed: false, error: 'No items to process' });
        return { status: 'failed', error: 'No items to process' };
      }

      // ── Step 2: Worker function ──────────────────────────────────────
      const processItem = async (item: unknown, index: number): Promise<{ output: unknown }> => {
        onStatus?.onStepStart?.({
          taskId: task.id,
          stepIndex: index,
          stepName: step.name,
          agentId,
        });

        // Compose the item-specific task via the (configurable) composer. The
        // original ctx.task is never mutated — the composer returns a new Task.
        const itemTask = composeItem(task, index, items.length, item);

        const { result, trackedSession } = await runStep({
          task: itemTask,
          step,
          agentId,
          ctx: { stepIndex: index, attempt: 0, execCount: 0 },
          profiles,
          execCtx,
        });

        // CRITICAL: track the session immediately after runStep succeeds
        tracker.add(trackedSession);

        return { output: result.type === 'approved' ? result.output : result.feedback };
      };

      // ── Step 3: Execute with concurrency control ─────────────────────
      let results: PromiseSettledResult<{ output: unknown }>[];

      const concurrency = concurrencyOpt !== undefined ? Math.max(1, concurrencyOpt) : undefined;

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

      // ── Step 4: Collect outputs and errors ───────────────────────────
      const outputs: unknown[] = [];
      const errors: string[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled') {
          outputs.push(result.value.output);
        } else {
          errors.push(safeErrorMessage(result.reason));
        }
      }

      // ── Step 5: Settle the task ──────────────────────────────────────
      // NOTE: this multi-output settle is intentionally NOT delegated to the
      // single-result `settleResult` helper. The map runner collects a whole
      // outputs array (not a single StepResult) and must still honor
      // completeTask's boolean (false → "Failed to submit"). Only session
      // tracking, execCtx construction, and the outer error envelope are shared.
      if (errors.length === 0) {
        // All items succeeded
        if (ctx.completeTask(outputs)) {
          tracker.disposeAll();
          return { status: 'completed', output: outputs };
        }
        ctx.failTask({ completed: false, error: 'Failed to submit' });
        tracker.disposeAll();
        return { status: 'failed', error: 'Failed to submit' };
      }

      // Some or all items failed
      ctx.failTask({ completed: false, error: errors.join('; ') });
      tracker.disposeAll();
      return { status: 'failed', error: `${errors.length} of ${items.length} items failed` };
    } catch (err) {
      // ── Step 6: Unexpected error – never re-throw ────────────────────
      return handleRunnerError(err, ctx, tracker.disposeAll);
    }
  };
}
