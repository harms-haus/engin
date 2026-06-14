// ─── Task Processor ─────────────────────────────────────────────────────────
//
// Extracted from LanePool.processTask. Contains the core step-execution loop
// with retry logic, plus internal helper functions for error/audit reporting.

import type { AgentProfile, Task } from '../core/types.js';
import { appendReviewFeedback, safeErrorMessage } from '../core/utils.js';
import { extractSeverity, isFailingSeverity } from './severity.js';
import type { StepExecutionContext } from './step-execution.js';
import { runStep } from './step-execution.js';
import type { LanePoolOptions, TrackedSession } from './types.js';

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
  phase?: string;
}

// ─── Task Processing ─────────────────────────────────────────────────────

/**
 * Execute all steps for a task. On rejection, back up one step and retry
 * up to `maxStepRetries` times **per step**.
 */
export async function processTask(
  task: Task,
  agentId: string,
  profiles: Map<string, AgentProfile>,
  ctx: TaskProcessorContext,
): Promise<void> {
  const { options } = ctx;
  const steps = options.getStepsForTask(task);

  if (steps.length === 0) {
    safeFailTask(task.id, { completed: false, error: 'No steps defined for task' }, ctx);
    return;
  }

  const maxStepRetries = options.maxStepRetries ?? 5;

  options.onStatus?.onTaskStart?.({
    taskId: task.id,
    title: task.title,
    agentId,
    phase: ctx.phase ?? options.phase,
    startedAt: Date.now(),
  });

  let currentStepIndex = 0;
  let lastOutput: unknown = undefined;
  // Per-step retry counter: each step tracks its own rejection count
  const stepAttempts = new Map<number, number>();
  // Per-step execution counter: increments each time a step is executed
  const stepExecutions = new Map<number, number>();
  // Track sessions for disposal at task completion
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

  const execCtx: StepExecutionContext = {
    sessionBaseDir: options.sessionBaseDir,
    cwd: options.cwd,
    apiKeys: options.apiKeys,
    onStatus: options.onStatus,
    activeSessions: ctx.activeSessions,
    phase: ctx.phase ?? options.phase,
  };

  try {
    while (currentStepIndex < steps.length) {
      const step = steps[currentStepIndex];

      // Fire onTaskStepStart before executing the step
      options.onStatus?.onTaskStepStart?.({
        taskId: task.id,
        stepName: step.name,
        stepIndex: currentStepIndex,
        totalSteps: steps.length,
      });

      const currentAttempt = stepAttempts.get(currentStepIndex) ?? 0;
      const execCount = stepExecutions.get(currentStepIndex) ?? 0;
      stepExecutions.set(currentStepIndex, execCount + 1);

      // Check for an existing session to resume
      let existingSessionPath: string | undefined;
      const existing = taskSessions.get(currentStepIndex);
      if (existing) {
        existingSessionPath = existing.sessionPath;
      }

      const { result, trackedSession } = await runStep(
        task,
        step,
        agentId,
        { stepIndex: currentStepIndex, attempt: currentAttempt, execCount },
        profiles,
        execCtx,
        existingSessionPath,
      );

      // Dispose old tracked session for this step (if any) now that we have the new one
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

      if (result.type === 'approved') {
        lastOutput = result.output;
        currentStepIndex++;
      } else {
        // Rejected — record the retry attempt for this step, then back up
        appendReviewFeedback(task, result.feedback);
        const newAttempt = currentAttempt + 1;
        stepAttempts.set(currentStepIndex, newAttempt);

        // Log the retry decision
        options.onStatus?.onDecision?.({
          agentId,
          decision: `Step "${step.name}" rejected (attempt ${newAttempt}/${maxStepRetries}), retrying`,
          reasoning: result.feedback,
          taskId: task.id,
        });

        if (newAttempt >= maxStepRetries) {
          // Extract severity from the last structured rejection result
          const severity = extractSeverity(result.output);

          if (isFailingSeverity(severity)) {
            // Critical/high → task failed
            options.onStatus?.onTaskRejected?.({
              taskId: task.id,
              title: task.title,
              reason: result.feedback,
            });
            safeFailTask(task.id, { completed: false, feedback: result.feedback, severity }, ctx);
          } else {
            // Medium/low/missing → accept as completed with caveats
            if (
              safeSubmitAndComplete(
                task.id,
                {
                  completed: true,
                  feedback: result.feedback,
                  severity,
                  output: result.output,
                },
                ctx,
              )
            ) {
              options.onStatus?.onTaskComplete?.({
                taskId: task.id,
                title: task.title,
              });
            } else {
              safeFailTask(
                task.id,
                {
                  completed: false,
                  error: 'Failed to submit task for review after max retries exceeded',
                },
                ctx,
              );
            }
          }
          disposeAllTaskSessions();
          return;
        }

        currentStepIndex = Math.max(0, currentStepIndex - 1);
      }
    }

    // All steps approved — dispose sessions, then task complete
    disposeAllTaskSessions();
    if (safeSubmitAndComplete(task.id, { completed: true, output: lastOutput }, ctx)) {
      options.onStatus?.onTaskComplete?.({
        taskId: task.id,
        title: task.title,
      });
    } else {
      safeFailTask(
        task.id,
        {
          completed: false,
          error: 'Failed to submit completed task for review',
        },
        ctx,
      );
    }
  } catch (err) {
    // Unexpected error during while loop — clean up sessions
    disposeAllTaskSessions();
    throw err;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Safely submit a task for review and complete it. Catches and logs
 * errors from invalid state transitions.
 */
export function safeSubmitAndComplete(taskId: string, result: unknown, ctx: TaskProcessorContext): boolean {
  try {
    ctx.options.taskTracker.submitForReview(taskId, result);
    ctx.options.taskTracker.completeTask(taskId);
    return true;
  } catch (err) {
    const errorMsg = `safeSubmitAndComplete failed for ${taskId}: ${safeErrorMessage(err)}`;
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
  phase?: string,
  taskId?: string,
  ctx?: TaskProcessorContext,
): void {
  const effectivePhase = phase ?? ctx?.options.phase ?? ctx?.phase ?? 'implementing';
  if (ctx?.options.onStatus?.onError) {
    ctx.options.onStatus.onError({ agentId, error, phase: effectivePhase, taskId });
  } else {
    console.error(`[${agentId}] ${error}`);
  }
}
