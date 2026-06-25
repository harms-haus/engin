// ─── Reflection Runner ──────────────────────────────────────────────────────
//
// A reusable two-step primitive: the draftStep produces work, the criticStep
// reviews it; if the critic rejects, feedback is appended and the draft runs
// again (with session resume). This loop continues until the critic approves
// or maxRounds is exhausted.

import { appendReviewFeedback } from '../core/task-feedback.js';
import { buildExecCtx, createSessionMap, handleRunnerError, settleBySeverity, settleResult } from './runner-utils.js';
import { runStep } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext } from './types.js';

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
    const { task, agentId, profiles, onStatus } = ctx;

    // ── Step 1: Session tracking ────────────────────────────────────────
    // createSessionMap keys sessions by step index (0 = draft, 1 = critic) and
    // disposes the previous entry when overwriting a key (session resume).
    const sessionMap = createSessionMap(agentId, task.id);

    // ── Step 2: Execution context ───────────────────────────────────────
    const execCtx = buildExecCtx(ctx);

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

        const existingDraftSession = sessionMap.sessions.get(0);
        const draftExistingSessionPath = existingDraftSession?.sessionPath;

        const { result: draftResult, trackedSession: draftTrackedSession } = await runStep({
          task,
          step: options.draftStep,
          agentId,
          ctx: { stepIndex: 0, attempt: zeroStepAttempt, execCount: draftExecCount },
          profiles,
          execCtx,
          existingSessionPath: draftExistingSessionPath,
        });

        // set() disposes the previous draft session (if any) before storing the new one
        sessionMap.set(0, draftTrackedSession);

        // If draft result is 'rejected' (structured output failure), fail immediately
        if (draftResult.type === 'rejected') {
          ctx.failTask({ completed: false, feedback: draftResult.feedback });
          sessionMap.disposeAll();
          return { status: 'failed', feedback: draftResult.feedback };
        }

        // ── Step 4b: Run criticStep (stepIndex 1) ───────────────────────
        // onStepStart is fired by runStep() after onAgentSpawn for correct
        // event ordering (agent_spawned → step_started).
        criticExecCount++;

        const existingCriticSession = sessionMap.sessions.get(1);
        const criticExistingSessionPath = existingCriticSession?.sessionPath;

        const { result: criticResult, trackedSession: criticTrackedSession } = await runStep({
          task,
          step: options.criticStep,
          agentId,
          ctx: { stepIndex: 1, attempt: zeroStepAttempt, execCount: criticExecCount },
          profiles,
          execCtx,
          existingSessionPath: criticExistingSessionPath,
        });

        // set() disposes the previous critic session (if any) before storing the new one
        sessionMap.set(1, criticTrackedSession);

        // Capture last result for post-loop use
        lastCriticResult = criticResult;

        // ── Step 4c: Critic approved → complete ─────────────────────────
        if (criticResult.type === 'approved') {
          return settleResult(ctx, criticResult, sessionMap.disposeAll);
        }

        // ── Step 4d: Critic rejected → append feedback and retry ────────
        appendReviewFeedback(task, criticResult.feedback ?? 'No feedback provided');

        onStatus?.onDecision?.({
          agentId,
          decision: `Critic rejected (round ${round + 1}/${maxRounds}), retrying`,
          reasoning: criticResult.feedback ?? 'No feedback provided',
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
              decision: `Critic rejected (round ${round + 1}/${maxRounds}), retrying`,
              reasoning: criticResult.feedback ?? 'No feedback provided',
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

        // Continue to next round
      }

      // ── Step 5: Max rounds exhausted ──────────────────────────────────
      // lastCriticResult is guaranteed to be set here because maxRounds > 0.
      // settleBySeverity branches on severity to decide whether to fail
      // (critical/high) or accept with caveats (medium/low/none), and
      // respects the completeTask boolean for the accepted case.
      if (!lastCriticResult) {
        ctx.failTask({ completed: false, error: 'No critic result produced' });
        sessionMap.disposeAll();
        return { status: 'failed', error: 'No critic result produced' };
      }
      return settleBySeverity(
        ctx,
        lastCriticResult.output,
        lastCriticResult.feedback ?? 'No feedback provided',
        sessionMap.disposeAll,
      );
    } catch (err) {
      // ── Step 6: Unexpected error – never re-throw ────────────────────
      return handleRunnerError(err, ctx, sessionMap.disposeAll);
    }
  };
}
