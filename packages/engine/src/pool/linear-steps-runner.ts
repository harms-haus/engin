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

import { appendReviewFeedback, safeErrorMessage } from '../core/utils.js';
import { extractSeverity, isFailingSeverity } from './severity.js';
import { runStep, type StepExecutionContext } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext, TrackedSession } from './types.js';

/**
 * Create a TaskRunner that executes the given steps sequentially.
 *
 * When a step is rejected, the runner backs up one step and retries,
 * up to `maxStepRetries` attempts per step.
 */
export function linearStepsRunner(steps: StepDefinition[]): TaskRunner {
  return async (ctx: TaskRunnerContext): Promise<TaskOutcome> => {
    const { task, agentId, profiles, onStatus, phaseId, sessionBaseDir, cwd, apiKeys, maxStepRetries } = ctx;

    // ── Step 1: No steps ───────────────────────────────────────────────
    if (steps.length === 0) {
      ctx.failTask({ completed: false, error: 'No steps defined for task' });
      return { status: 'failed', error: 'No steps defined for task' };
    }

    // ── Step 2: Per-step state ─────────────────────────────────────────
    const stepAttempts = new Map<number, number>();
    const stepExecutions = new Map<number, number>();
    const taskSessions = new Map<number, TrackedSession>();

    const disposeAllTaskSessions = () => {
      for (const ts of taskSessions.values()) {
        try {
          ts.dispose();
        } catch (err) {
          console.error(`[${agentId}] Error disposing harness for task ${task.id}:`, safeErrorMessage(err));
        }
      }
      taskSessions.clear();
    };

    // ── Step 3: Execution context ──────────────────────────────────────
    const execCtx: StepExecutionContext = {
      sessionBaseDir,
      cwd,
      apiKeys,
      onStatus,
      activeSessions: ctx.activeSessions,
      phaseId,
      rendererRegistry: ctx.rendererRegistry,
    };

    // ── Step 4: Main loop ─────────────────────────────────────────────
    try {
      let currentStepIndex = 0;
      let lastOutput: unknown = undefined;

      while (currentStepIndex < steps.length) {
        const step = steps[currentStepIndex];

        // Step 4a: Fire onStepStart
        onStatus?.onStepStart?.({
          taskId: task.id,
          stepIndex: currentStepIndex,
          stepName: step.name,
          agentId,
        });

        // Step 4b: Track attempt count and execution count
        const currentAttempt = stepAttempts.get(currentStepIndex) ?? 0;
        const execCount = stepExecutions.get(currentStepIndex) ?? 0;
        stepExecutions.set(currentStepIndex, execCount + 1);

        // Step 4c: Check for existing session to resume
        let existingSessionPath: string | undefined;
        const existing = taskSessions.get(currentStepIndex);
        if (existing) {
          existingSessionPath = existing.sessionPath;
        }

        // Step 4d: Execute the step
        const { result, trackedSession } = await runStep(
          task,
          step,
          agentId,
          { stepIndex: currentStepIndex, attempt: currentAttempt, execCount },
          profiles,
          execCtx,
          existingSessionPath,
        );

        // Step 4e: Dispose old session for this step, store new one
        const oldSession = taskSessions.get(currentStepIndex);
        if (oldSession) {
          try {
            oldSession.dispose();
          } catch (err) {
            console.error(
              `[${agentId}] Error disposing old session for step ${currentStepIndex} of task ${task.id}:`,
              safeErrorMessage(err),
            );
          }
        }
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

        // Step 4h: Max retries reached
        if (newAttempt >= maxStepRetries) {
          const severity = extractSeverity(result.output);

          if (isFailingSeverity(severity)) {
            // Critical/high → task failed
            ctx.failTask({ completed: false, feedback: result.feedback, severity });
            disposeAllTaskSessions();
            return { status: 'failed', feedback: result.feedback };
          }

          // Medium/low → accept as completed with caveats
          if (ctx.completeTask(result.output)) {
            disposeAllTaskSessions();
            return { status: 'completed', output: result.output };
          }

          ctx.failTask({
            completed: false,
            error: 'Failed to submit task for review after max retries exceeded',
          });
          disposeAllTaskSessions();
          return { status: 'failed', error: 'Failed to submit' };
        }

        // Step 4i: Retry – back up one step
        currentStepIndex = Math.max(0, currentStepIndex - 1);
      }

      // ── Step 5: All steps approved ─────────────────────────────────
      if (ctx.completeTask(lastOutput)) {
        disposeAllTaskSessions();
        return { status: 'completed', output: lastOutput };
      }

      ctx.failTask({ completed: false, error: 'Failed to submit completed task for review' });
      disposeAllTaskSessions();
      return { status: 'failed', error: 'Failed to submit completed task' };
    } catch (err) {
      // ── Step 6: Unexpected error – never re-throw ───────────────────
      disposeAllTaskSessions();
      const errorMsg = safeErrorMessage(err);
      ctx.failTask({ completed: false, error: errorMsg });
      return { status: 'failed', error: errorMsg };
    }
  };
}
