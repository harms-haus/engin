// ─── Reflection Runner ──────────────────────────────────────────────────────
//
// A reusable two-step primitive: the draftStep produces work, the criticStep
// reviews it; if the critic rejects, feedback is appended and the draft runs
// again (with session resume). This loop continues until the critic approves
// or maxRounds is exhausted.

import { appendReviewFeedback, safeErrorMessage } from '../core/utils.js';
import { extractSeverity, isFailingSeverity } from './severity.js';
import { runStep, type StepExecutionContext } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext, TrackedSession } from './types.js';

// ─── Options ─────────────────────────────────────────────────────────────

export interface ReflectionRunnerOptions {
  /** Step that produces the draft for the critic to review. */
  draftStep: StepDefinition;
  /** Step that reviews the draft. Should have a schema with approved/feedback fields. */
  criticStep: StepDefinition;
  /** Maximum number of draft/critic rounds. Default: 3. */
  maxRounds?: number;
}

/**
 * Create a TaskRunner that implements the reviewer-loop pattern.
 *
 * The draftStep produces work; the criticStep reviews it. If the critic
 * rejects, feedback is appended to the task and the draft runs again
 * (with session resume). This loop continues until the critic approves
 * or maxRounds is exhausted.
 */
export function reflectionRunner(options: ReflectionRunnerOptions): TaskRunner {
  const maxRounds = Math.max(1, options.maxRounds ?? 3);

  return async (ctx: TaskRunnerContext): Promise<TaskOutcome> => {
    const { task, agentId, profiles, onStatus, phaseId, sessionBaseDir, cwd, apiKeys } = ctx;

    // ── Step 1: Session tracking ────────────────────────────────────────
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

    // ── Step 2: Execution context ───────────────────────────────────────
    const execCtx: StepExecutionContext = {
      sessionBaseDir,
      cwd,
      apiKeys,
      onStatus,
      activeSessions: ctx.activeSessions,
      phaseId,
    };

    // ── Step 3: Per-step execution state ────────────────────────────────
    let draftExecCount = 0;
    let criticExecCount = 0;
    let lastCriticResult: { type: 'approved' | 'rejected'; feedback?: string; output?: unknown } | undefined;
    const zeroStepAttempt = 0; // Always 0 for reflection runner — retries are done via the round loop

    // ── Step 4: Main loop ──────────────────────────────────────────────
    try {
      for (let round = 0; round < maxRounds; round++) {
        // ── Step 4a: Run draftStep (stepIndex 0) ────────────────────────
        // onStepStart is fired by runStep() after onAgentSpawn for correct
        // event ordering (agent_spawned → step_started).
        draftExecCount++;

        const existingDraftSession = taskSessions.get(0);
        const draftExistingSessionPath = existingDraftSession?.sessionPath;

        const { result: draftResult, trackedSession: draftTrackedSession } = await runStep(
          task,
          options.draftStep,
          agentId,
          { stepIndex: 0, attempt: zeroStepAttempt, execCount: draftExecCount },
          profiles,
          execCtx,
          draftExistingSessionPath,
        );

        // Dispose old draft session if exists, store new one
        const oldDraftSession = taskSessions.get(0);
        if (oldDraftSession) {
          try {
            oldDraftSession.dispose();
          } catch (err) {
            console.error(`[${agentId}] Error disposing old draft session for task ${task.id}:`, safeErrorMessage(err));
          }
        }
        taskSessions.set(0, draftTrackedSession);

        // If draft result is 'rejected' (structured output failure), fail immediately
        if (draftResult.type === 'rejected') {
          ctx.failTask({ completed: false, feedback: draftResult.feedback });
          disposeAllTaskSessions();
          return { status: 'failed', feedback: draftResult.feedback };
        }

        // ── Step 4b: Run criticStep (stepIndex 1) ───────────────────────
        // onStepStart is fired by runStep() after onAgentSpawn for correct
        // event ordering (agent_spawned → step_started).
        criticExecCount++;

        const existingCriticSession = taskSessions.get(1);
        const criticExistingSessionPath = existingCriticSession?.sessionPath;

        const { result: criticResult, trackedSession: criticTrackedSession } = await runStep(
          task,
          options.criticStep,
          agentId,
          { stepIndex: 1, attempt: zeroStepAttempt, execCount: criticExecCount },
          profiles,
          execCtx,
          criticExistingSessionPath,
        );

        // Dispose old critic session if exists, store new one
        const oldCriticSession = taskSessions.get(1);
        if (oldCriticSession) {
          try {
            oldCriticSession.dispose();
          } catch (err) {
            console.error(
              `[${agentId}] Error disposing old critic session for task ${task.id}:`,
              safeErrorMessage(err),
            );
          }
        }
        taskSessions.set(1, criticTrackedSession);

        // Capture last result for post-loop use
        lastCriticResult = criticResult;

        // ── Step 4c: Critic approved → complete ─────────────────────────
        if (criticResult.type === 'approved') {
          if (ctx.completeTask(criticResult.output)) {
            disposeAllTaskSessions();
            return { status: 'completed', output: criticResult.output };
          }

          ctx.failTask({ completed: false, error: 'Failed to submit' });
          disposeAllTaskSessions();
          return { status: 'failed', error: 'Failed to submit' };
        }

        // ── Step 4d: Critic rejected → append feedback and retry ────────
        appendReviewFeedback(task, criticResult.feedback ?? 'No feedback provided');

        onStatus?.onDecision?.({
          agentId,
          decision: `Critic rejected (round ${round + 1}/${maxRounds}), retrying`,
          reasoning: criticResult.feedback ?? 'No feedback provided',
          taskId: task.id,
        });

        // Continue to next round
      }

      // ── Step 5: Max rounds exhausted ──────────────────────────────────
      // lastCriticResult is guaranteed to be set here because maxRounds > 0
      if (!lastCriticResult) {
        ctx.failTask({ completed: false, error: 'No critic result produced' });
        disposeAllTaskSessions();
        return { status: 'failed', error: 'No critic result produced' };
      }
      const finalCriticResult = lastCriticResult;
      const severity = extractSeverity(finalCriticResult.output);
      const feedback = finalCriticResult.feedback ?? 'No feedback provided';

      if (isFailingSeverity(severity)) {
        // Critical/high → task failed
        ctx.failTask({ completed: false, feedback, severity });
        disposeAllTaskSessions();
        return { status: 'failed', feedback };
      }

      // Medium/low/none → accept as completed with caveats
      if (ctx.completeTask(finalCriticResult.output)) {
        disposeAllTaskSessions();
        return { status: 'completed', output: finalCriticResult.output };
      }

      ctx.failTask({ completed: false, error: 'Failed to submit' });
      disposeAllTaskSessions();
      return { status: 'failed', error: 'Failed to submit' };
    } catch (err) {
      // ── Step 6: Unexpected error – never re-throw ────────────────────
      disposeAllTaskSessions();
      const errorMsg = safeErrorMessage(err);
      ctx.failTask({ completed: false, error: errorMsg });
      return { status: 'failed', error: errorMsg };
    }
  };
}
