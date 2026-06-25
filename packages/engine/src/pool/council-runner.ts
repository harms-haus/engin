// ─── Council Runner ────────────────────────────────────────────────────────
//
// TaskRunner that runs multiple worker steps in parallel (the "council"),
// collects their outputs, and then passes them all to a synthesizer step
// that merges them into a single result.
//
// This is useful for scenarios where multiple independent agents should
// work on the same task simultaneously and their outputs are then combined.

import type { Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import { composeWorkerOutputsPrompt } from './prompt-builder.js';
import { buildExecCtx, createSessionTracker, handleRunnerError, settleResult } from './runner-utils.js';
import { runStep } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext } from './types.js';

/** Options for {@link councilRunner}. */
export interface CouncilRunnerOptions {
  /** Worker steps run in parallel against the same task. */
  workers: StepDefinition[];
  /** Synthesizer step that merges worker outputs into a single result. */
  synthesizer: StepDefinition;
  /**
   * Optional callback that composes the synthesizer task from the original
   * task and the collected worker outputs.
   *
   * When omitted the default {@link composeWorkerOutputsPrompt} helper is
   * used, preserving the exact legacy prompt format (`## Worker Outputs`
   * appended to the task prompt). Returning a brand-new Task (rather than
   * mutating the original) keeps `ctx.task` untouched.
   *
   * This keeps the runner a simple primitive: it runs workers, collects
   * outputs, and passes them to a prompt composer. The orchestration logic
   * (how to format worker outputs into a prompt) is configurable from the
   * call site.
   */
  composeSynthesizerPrompt?: (task: Task, workerOutputs: unknown[]) => Task;
}

/**
 * Create a TaskRunner that runs multiple workers in parallel and
 * then passes their outputs to a synthesizer step that merges them
 * into a single result.
 */
export function councilRunner(options: CouncilRunnerOptions): TaskRunner {
  const { workers, synthesizer } = options;
  // Default to the shared worker-outputs composer, preserving the legacy
  // prompt format unless the caller supplies a custom composition strategy.
  const composeSynthesizerPrompt = options.composeSynthesizerPrompt ?? composeWorkerOutputsPrompt;

  return async (ctx: TaskRunnerContext): Promise<TaskOutcome> => {
    const tracker = createSessionTracker(ctx.agentId, ctx.task.id);
    const execCtx = buildExecCtx(ctx);

    try {
      // ── Step 1: No workers ──────────────────────────────────────────────
      if (workers.length === 0) {
        ctx.failTask({ completed: false, error: 'No workers defined' });
        return { status: 'failed', error: 'No workers defined' };
      }

      // ── Step 2: Run all workers in parallel ─────────────────────────────
      const workerPromises = workers.map((worker, i) => {
        ctx.onStatus?.onStepStart?.({
          taskId: ctx.task.id,
          stepIndex: i,
          stepName: worker.name,
          agentId: ctx.agentId,
        });
        return runStep({
          task: ctx.task,
          step: worker,
          agentId: ctx.agentId,
          ctx: { stepIndex: i, attempt: 0, execCount: 0 },
          profiles: ctx.profiles,
          execCtx,
        });
      });

      const workerResults = await Promise.allSettled(workerPromises);

      // ── Step 3: Process settled results (session-leak fix) ──────────────
      const outputs: unknown[] = [];
      const errors: string[] = [];

      for (const result of workerResults) {
        if (result.status === 'fulfilled') {
          const { result: stepResult, trackedSession } = result.value;
          // Capture output: approved → result.output, rejected → result.feedback
          if (stepResult.type === 'approved') {
            outputs.push(stepResult.output);
          } else {
            outputs.push(stepResult.feedback);
          }
          // CRITICAL: track the session so tracker.disposeAll cleans it up later.
          // Without this, worker sessions leak because only the synthesizer's
          // session would be tracked.
          tracker.add(trackedSession);
        } else {
          // runStep already disposed its own session in its catch block on throw,
          // so do NOT track anything for rejected results.
          errors.push(safeErrorMessage(result.reason));
        }
      }

      // ── Step 4: All workers failed ─────────────────────────────────────
      if (outputs.length === 0 && errors.length > 0) {
        ctx.failTask({ completed: false, error: errors.join('; ') });
        tracker.disposeAll();
        return { status: 'failed', error: 'All workers failed' };
      }

      // ── Step 5: Run synthesizer ────────────────────────────────────────
      ctx.onStatus?.onStepStart?.({
        taskId: ctx.task.id,
        stepIndex: workers.length,
        stepName: synthesizer.name,
        agentId: ctx.agentId,
      });

      // Compose the synthesizer task from the worker outputs. The composer is
      // configurable from the call site; the default preserves the legacy
      // prompt format. The original ctx.task is never mutated.
      const synthTask = composeSynthesizerPrompt(ctx.task, outputs);

      const synthResult = await runStep({
        task: synthTask,
        step: synthesizer,
        agentId: ctx.agentId,
        ctx: { stepIndex: workers.length, attempt: 0, execCount: 0 },
        profiles: ctx.profiles,
        execCtx,
      });
      tracker.add(synthResult.trackedSession);

      // ── Step 6: Settle based on synthesizer result ─────────────────────
      return settleResult(ctx, synthResult.result, tracker.disposeAll);
    } catch (err) {
      // ── Step 7: Unexpected error – never re-throw ──────────────────────
      return handleRunnerError(err, ctx, tracker.disposeAll);
    }
  };
}
