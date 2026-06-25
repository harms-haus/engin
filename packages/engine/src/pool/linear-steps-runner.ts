// ─── Linear Steps Runner ───────────────────────────────────────────────────
//
// TaskRunner that reproduces the exact behavior of processTask – the linear
// step loop with reviewer back-up retry and severity-based fail/approve.
//
// Key differences from processTask:
//   1. Uses ctx.completeTask() / ctx.failTask() instead of
//      safeCompleteTask / safeFailTask.
//   2. Does NOT fire onTaskStart, onTaskComplete, or onTaskRejected – those
//      are now the LanePool's responsibility based on the returned TaskOutcome.
//   3. NEVER re-throws errors. All exceptions are caught, sessions disposed,
//      ctx.failTask called, and { status: 'failed', error: msg } returned.
//   4. Returns TaskOutcome directly instead of mutating the TaskTracker.

import { appendReviewFeedback } from '../core/task-feedback.js';
import { buildExecCtx, createSessionMap, handleRunnerError, settleBySeverity } from './runner-utils.js';
import { runStep } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext } from './types.js';

/**
 * Create a TaskRunner that executes the given steps sequentially.
 *
 * When a step is rejected, the runner backs up one step and retries,
 * up to `maxStepRetries` attempts per step.
 */
export function linearStepsRunner(steps: StepDefinition[]): TaskRunner {
  return async (ctx: TaskRunnerContext): Promise<TaskOutcome> => {
    const { task, agentId, profiles, onStatus, maxStepRetries } = ctx;

    // ── Step 1: No steps ───────────────────────────────────────────────
    if (steps.length === 0) {
      ctx.failTask({ completed: false, error: 'No steps defined for task' });
      return { status: 'failed', error: 'No steps defined for task' };
    }

    // ── Step 2: Per-step state ─────────────────────────────────────────
    const stepAttempts = new Map<number, number>();
    const stepExecutions = new Map<number, number>();
    // createSessionMap provides step-indexed tracking with automatic disposal
    // of the previous entry on overwrite (via set()) and a uniform disposeAll().
    const taskSessions = createSessionMap(agentId, task.id);

    // ── Step 3: Execution context ──────────────────────────────────────
    const execCtx = buildExecCtx(ctx);

    // ── Step 4: Main loop ─────────────────────────────────────────────
    try {
      let currentStepIndex = 0;
      let lastOutput: unknown = undefined;

      while (currentStepIndex < steps.length) {
        const step = steps[currentStepIndex];

        // Step 4a: Track attempt count and execution count
        const currentAttempt = stepAttempts.get(currentStepIndex) ?? 0;
        const execCount = stepExecutions.get(currentStepIndex) ?? 0;
        stepExecutions.set(currentStepIndex, execCount + 1);

        // Step 4c: Check for existing session to resume
        const existing = taskSessions.sessions.get(currentStepIndex);
        const existingSessionPath = existing?.sessionPath;

        // Step 4d: Execute the step
        const { result, trackedSession } = await runStep({
          task,
          step,
          agentId,
          ctx: { stepIndex: currentStepIndex, attempt: currentAttempt, execCount },
          profiles,
          execCtx,
          existingSessionPath,
        });

        // Step 4e: Dispose old session for this step, store new one.
        // createSessionMap.set() disposes the previous entry at this key
        // (errors swallowed + logged) before overwriting it.
        taskSessions.set(currentStepIndex, trackedSession);

        // Step 4f: Approved → move forward
        if (result.type === 'approved') {
          lastOutput = result.output;
          currentStepIndex++;
          continue;
        }

        // Step 4g: Rejected → record feedback and increment attempt
        appendReviewFeedback(task, result.feedback);
        const newAttempt = currentAttempt + 1;
        stepAttempts.set(currentStepIndex, newAttempt);

        onStatus?.onDecision?.({
          agentId,
          decision: `Step "${step.name}" rejected (attempt ${newAttempt}/${maxStepRetries}), retrying`,
          reasoning: result.feedback,
          taskId: task.id,
        });

        // `onDecision` observe hook seam: fire ALONGSIDE the existing
        // `onStatus?.onDecision?.(...)` store callback — BOTH fire into
        // different sinks (event store vs. audit log). The default auditor
        // (registered by LanePool.run() when an `auditLog` is available)
        // appends a `decision` event to the durable AuditLog. Zero behavior
        // change when no `hookRegistry` or no subscribers. The hook context
        // mirrors the `beforeStepPrompt` seam (same cwd / workDir / signal).
        if (ctx.hookRegistry?.hasSubscribers('onDecision')) {
          await ctx.hookRegistry.invokeObserve(
            'onDecision',
            {
              agentId,
              decision: `Step "${step.name}" rejected (attempt ${newAttempt}/${maxStepRetries}), retrying`,
              reasoning: result.feedback,
              taskId: task.id,
              phaseId: ctx.phaseId,
            },
            {
              registry: ctx.hookRegistry,
              cwd: ctx.worktreeCwd ?? ctx.cwd,
              workDir: ctx.cwd,
              signal: ctx.signal,
            },
          );
        }

        // Step 4h: Max retries reached — severity-based settle
        if (newAttempt >= maxStepRetries) {
          return settleBySeverity(ctx, result.output, result.feedback, taskSessions.disposeAll);
        }

        // Step 4i: Retry – back up one step
        currentStepIndex = Math.max(0, currentStepIndex - 1);
      }

      // ── Step 5: All steps approved ─────────────────────────────────
      if (ctx.completeTask(lastOutput)) {
        taskSessions.disposeAll();
        return { status: 'completed', output: lastOutput };
      }

      ctx.failTask({ completed: false, error: 'Failed to submit completed task for review' });
      taskSessions.disposeAll();
      return { status: 'failed', error: 'Failed to submit completed task' };
    } catch (err) {
      // ── Step 6: Unexpected error – never re-throw ───────────────────
      return handleRunnerError(err, ctx, taskSessions.disposeAll);
    }
  };
}
