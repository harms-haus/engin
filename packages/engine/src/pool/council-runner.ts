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
import { runStep, type StepExecutionContext } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext, TrackedSession } from './types.js';

/**
 * Create a TaskRunner that runs multiple workers in parallel and
 * then passes their outputs to a synthesizer step that merges them
 * into a single result.
 */
export function councilRunner(options: { workers: StepDefinition[]; synthesizer: StepDefinition }): TaskRunner {
  return async (ctx: TaskRunnerContext): Promise<TaskOutcome> => {
    // ── Step 1: No workers ──────────────────────────────────────────────
    if (options.workers.length === 0) {
      ctx.failTask({ completed: false, error: 'No workers defined' });
      return { status: 'failed', error: 'No workers defined' };
    }

    // ── Step 2: Tracked sessions + dispose helper ───────────────────────
    const sessions: TrackedSession[] = [];
    const disposeAllSessions = () => {
      for (const ts of sessions) {
        try {
          ts.dispose();
        } catch (err) {
          console.error(`[${ctx.agentId}] Error disposing harness for task ${ctx.task.id}:`, safeErrorMessage(err));
        }
      }
      sessions.length = 0;
    };

    // ── Step 3: Execution context ───────────────────────────────────────
    const execCtx: StepExecutionContext = {
      sessionBaseDir: ctx.sessionBaseDir,
      cwd: ctx.cwd,
      apiKeys: ctx.apiKeys,
      onStatus: ctx.onStatus,
      activeSessions: ctx.activeSessions,
      phaseId: ctx.phaseId,
    };

    try {
      // ── Step 4: Run all workers in parallel ─────────────────────────
      const workerPromises = options.workers.map((worker, i) => {
        ctx.onStatus?.onStepStart?.({
          taskId: ctx.task.id,
          stepIndex: i,
          stepName: worker.name,
          agentId: ctx.agentId,
        });
        return runStep(
          ctx.task,
          worker,
          ctx.agentId,
          { stepIndex: i, attempt: 0, execCount: 0 },
          ctx.profiles,
          execCtx,
        );
      });

      const workerResults = await Promise.allSettled(workerPromises);

      // ── Step 5: Process settled results (session-leak fix) ──────────
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
          // CRITICAL: track the session so disposeAllSessions cleans it up later.
          // Without this, worker sessions leak because only the synthesizer's
          // session would be tracked.
          sessions.push(trackedSession);
        } else {
          // runStep already disposed its own session in its catch block on throw,
          // so do NOT push anything to sessions for rejected results.
          errors.push(safeErrorMessage(result.reason));
        }
      }

      // ── Step 6: All workers failed ─────────────────────────────────
      if (outputs.length === 0 && errors.length > 0) {
        ctx.failTask({ completed: false, error: errors.join('; ') });
        disposeAllSessions();
        return { status: 'failed', error: 'All workers failed' };
      }

      // ── Step 7: Run synthesizer ─────────────────────────────────────
      ctx.onStatus?.onStepStart?.({
        taskId: ctx.task.id,
        stepIndex: options.workers.length,
        stepName: options.synthesizer.name,
        agentId: ctx.agentId,
      });

      // Build a modified task with worker outputs appended to the prompt
      const workerOutputsText = outputs
        .map((output, i) => {
          const formatted = typeof output === 'string' ? output : JSON.stringify(output);
          return `### Worker ${i}\n${formatted}`;
        })
        .join('\n\n');

      const modifiedTask: Task = {
        ...ctx.task,
        prompt: ctx.task.prompt + '\n\n## Worker Outputs\n' + workerOutputsText,
      };

      const synthResult = await runStep(
        modifiedTask,
        options.synthesizer,
        ctx.agentId,
        { stepIndex: options.workers.length, attempt: 0, execCount: 0 },
        ctx.profiles,
        execCtx,
      );
      sessions.push(synthResult.trackedSession);

      // ── Step 8: Settle based on synthesizer result ─────────────────
      if (synthResult.result.type === 'approved') {
        if (ctx.completeTask(synthResult.result.output)) {
          disposeAllSessions();
          return { status: 'completed', output: synthResult.result.output };
        }
        ctx.failTask({ completed: false, error: 'Failed to submit' });
        disposeAllSessions();
        return { status: 'failed', error: 'Failed to submit' };
      }

      // Synthesizer rejected
      ctx.failTask({ completed: false, feedback: synthResult.result.feedback });
      disposeAllSessions();
      return { status: 'failed', feedback: synthResult.result.feedback };
    } catch (err) {
      // ── Step 9: Unexpected error – never re-throw ──────────────────
      disposeAllSessions();
      const errorMsg = safeErrorMessage(err);
      ctx.failTask({ completed: false, error: errorMsg });
      return { status: 'failed', error: errorMsg };
    }
  };
}
