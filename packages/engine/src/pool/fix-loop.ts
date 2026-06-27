// fixLoop: hook-driven review → fix → re-review loop. Composes with `runStep`
// (from step-execution.ts) for both the review and fixer steps — it does NOT
// re-implement agent spawning or session management.
// Also exports `defaultOnLaneError` (logs via console.warn) and
// `defaultShouldIsolate` (returns false — cull by default).

import type { AgentProfile, Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import type {
  FirstWinsHook,
  HookContext,
  HookRegistry,
  ObserveHook,
  OnLaneErrorArgs,
  ShouldIsolateArgs,
} from '../hooks/types.js';
import { DEFAULT_MAX_ROUNDS } from './constants.js';
import type { StepExecutionContext } from './step-execution.js';
import { runStep } from './step-execution.js';
import type { StepDefinition, StepResult, TaskOutcome } from './types.js';

// ─── Options ──────────────────────────────────────────────────────────────

/**
 * Options for {@link fixLoop}.
 *
 * The loop composes with {@link runStep} for both the review and fixer steps.
 * It does NOT re-implement agent spawning or session management — every step
 * runs through the existing step-execution infrastructure so worktree cwd,
 * hookRegistry, rendererRegistry, signal, and activeSessions threading all
 * behave identically to a normal step run.
 */
export interface FixLoopOptions {
  /** The task under review (its prompt, files, profile, etc.). */
  task: Task;
  /** The review step definition. Re-run after every fixer round. */
  reviewStep: StepDefinition;
  /** The ordered fixer steps run between review rounds. May be empty. */
  fixerSteps: StepDefinition[];
  /** Agent profile map (passed through to `runStep`). */
  profiles: Map<string, AgentProfile>;
  /** Step execution context (cwd, sessions, worktreeManager, etc.). */
  execCtx: StepExecutionContext;
  /**
   * Optional registry of workflow hooks. When present AND it has subscribers
   * for `shouldIsolate` / `onLaneError`, those hooks fire during the loop.
   * When absent (or without subscribers) the loop runs with the default
   * "don't isolate / swallow lane errors" behavior. Defaults to
   * `execCtx.hookRegistry` when not provided explicitly so a caller that
   * already threads the registry through the StepExecutionContext gets the
   * hook integration for free.
   */
  hookRegistry?: HookRegistry;
  /**
   * Maximum number of fixer rounds (default 3). A "round" is one pass of the
   * fixer steps followed by a re-review. The initial review runs before any
   * round; total reviews = `maxRounds + 1`.
   */
  maxRounds?: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────

/**
 * DEFAULT `onLaneError` (observe) hook.
 *
 * Logs the lane error via `console.warn`. Mirrors the legacy behavior where
 * lane errors are surfaced as warnings rather than thrown — observe hooks are
 * fire-and-forget by contract, so this MUST NOT throw (and it does not).
 *
 * The log line includes the lane id, phase id, task id, and the error message
 * so a human reading the console can correlate the warning with the failing
 * task without further context.
 */
export const defaultOnLaneError: ObserveHook<OnLaneErrorArgs> = async (args, _ctx) => {
  console.warn(
    `[fix-loop] Lane "${args.laneId}" error in phase "${args.phaseId}" ` + `for task "${args.task.id}": ${args.error}`,
  );
};

/**
 * DEFAULT `shouldIsolate` (first-wins) hook.
 *
 * Returns `false` — do NOT isolate. The failed task's worktree is culled on
 * exhaustion (the historical "clean up failed branches" behavior). Workflows
 * override this to isolate specific failure types (e.g. a security-sensitive
 * failure that should preserve the worktree for forensic inspection).
 *
 * Returns a non-`undefined` value so it WINS in a first-wins composition when
 * no earlier subscriber has decided.
 */
export const defaultShouldIsolate: FirstWinsHook<boolean | undefined, ShouldIsolateArgs> = async (_args, _ctx) => false;

// ─── fixLoop ──────────────────────────────────────────────────────────────

/**
 * Run the review → fix → re-review loop until the review approves or
 * `maxRounds` is exhausted.
 *
 * Composes with {@link runStep} for every step (both review and fixer). Each
 * step's tracked session is disposed immediately after the step returns so
 * the loop never accumulates live sessions — mirroring the disposal discipline
 * of `linear-steps-runner.ts::taskSessions.disposeAll()` but applied per-step
 * (the fixLoop never resumes a step from its persisted session file: every
 * round is a fresh agent turn against the latest on-disk state).
 *
 * Worktree handling:
 *  - On exhaustion with `shouldIsolate` returning false (the default), the
 *    task worktree is CULLED via
 *    `worktreeManager.cullOrPreserve(task.id, false)` when a `worktreeManager`
 *    is present. The best-effort cull + error-swallowing discipline lives in
 *    `WorktreeManager` (separation of concerns — `fixLoop` only decides
 *    isolate-vs-cull, it does not orchestrate the cleanup).
 *  - On isolation (`shouldIsolate` returns true), the worktree is PRESERVED
 *    via `worktreeManager.cullOrPreserve(task.id, true)` (cull is skipped) so
 *    a human can inspect the failed branch.
 *  - When no `worktreeManager` is configured, the loop is a no-op for culling
 *    (nothing to cull, nothing to preserve).
 *
 * Hook integration:
 *  - `shouldIsolate` (first-wins) is consulted BEFORE each fixer round with
 *    the latest review feedback as the `error` field. A `true` result short-
 *    circuits the loop (the fixer is NOT run for that round) and preserves
 *    the worktree.
 *  - `onLaneError` (observe) is fired when a fixer step REJECTS or THROWS.
 *    Review rejections do NOT fire `onLaneError` — they are the loop's normal
 *    control-flow signal, not a lane error. A fixer failure does NOT abort
 *    the round: the loop continues to the re-review step (the review may
 *    still approve if the failure was recoverable).
 *
 * Returns a {@link TaskOutcome} — `{ status: 'completed', output }` on
 * approval, `{ status: 'failed', feedback }` on exhaustion or isolation.
 */
export async function fixLoop(options: FixLoopOptions): Promise<TaskOutcome> {
  const { task, reviewStep, fixerSteps, profiles, execCtx } = options;
  // Source the hookRegistry from the explicit option first, falling back to
  // the one already threaded through the StepExecutionContext. This lets a
  // caller that constructs execCtx with hookRegistry (the step-execution
  // pattern) get the fixLoop hook integration without re-passing it.
  const hookRegistry = options.hookRegistry ?? execCtx.hookRegistry;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  // Stable lane id for hook args + runStep's agentId. Embeds the task id so
  // log lines and audit entries are correlatable back to the failing task.
  const laneId = `fixLoop:${task.id}`;

  // ── Hook helpers ──────────────────────────────────────────────────────
  //
  // Both helpers short-circuit to the default behavior when no registry is
  // configured OR the registry has no subscribers for the hook — so a caller
  // that passes no hookRegistry gets the exact pre-hook behavior (fixers run,
  // worktree culled on exhaustion, lane errors swallowed).

  /** Build the HookContext passed to every hook invocation. */
  const buildHookCtx = (): HookContext => {
    // narrows the type — callers guard on hookRegistry before calling.
    if (!hookRegistry) throw new Error('buildHookCtx called without a hookRegistry');
    return {
      registry: hookRegistry,
      cwd: execCtx.worktreeCwd ?? execCtx.cwd,
      workDir: execCtx.cwd,
      ...(execCtx.signal !== undefined && { signal: execCtx.signal }),
    };
  };

  /**
   * Consult `shouldIsolate` (first-wins). Returns true when the workflow
   * decides the failing task should be isolated. Returns false when there is
   * no registry, no subscribers, or every subscriber abstains/returns false.
   */
  const shouldIsolate = async (error: string): Promise<boolean> => {
    if (!hookRegistry) return false;
    if (!hookRegistry.hasSubscribers('shouldIsolate')) return false;
    const result = await hookRegistry.invokeFirstWins(
      'shouldIsolate',
      { task, error, laneId } satisfies ShouldIsolateArgs,
      buildHookCtx(),
    );
    // Coerce to boolean — only an explicit `true` isolates. `undefined`
    // (every subscriber abstained) and any other value fall through to the
    // default "don't isolate" behavior.
    return result === true;
  };

  /**
   * Fire `onLaneError` (observe) with the error message. No-op when there is
   * no registry or no subscribers — lane errors are silently swallowed in
   * the default configuration (the loop continues regardless).
   */
  const fireOnLaneError = async (error: string): Promise<void> => {
    if (!hookRegistry) return;
    if (!hookRegistry.hasSubscribers('onLaneError')) return;
    await hookRegistry.invokeObserve(
      'onLaneError',
      { laneId, task, error, phaseId: execCtx.phaseId } satisfies OnLaneErrorArgs,
      buildHookCtx(),
    );
  };

  // ── Step runner ───────────────────────────────────────────────────────
  //
  // Thin wrapper around `runStep` that disposes the resulting tracked session
  // immediately. The fixLoop never reuses a step's session across rounds —
  // every round is a fresh agent turn — so we dispose as soon as the step
  // has produced its StepResult. Disposal errors are swallowed + warned so a
  // session-teardown failure never masks the actual step outcome.

  /** Run a single step via `runStep` and dispose its session. */
  const runOnce = async (step: StepDefinition): Promise<StepResult> => {
    const { result, trackedSession } = await runStep({
      task,
      step,
      agentId: laneId,
      // `attempt` is 0 — the fixLoop does not implement per-step retry (the
      // surrounding LanePool / TaskRunner handles retries via maxStepRetries).
      // `execCount` mirrors the stepIndex so the persisted session directory
      // is unique per step position; the value is opaque to the loop logic.
      ctx: { stepIndex: 0, attempt: 0, execCount: 0 },
      profiles,
      execCtx,
    });
    try {
      trackedSession.dispose();
    } catch (err) {
      console.warn(
        `[fix-loop] Error disposing session for step "${step.name}" on task ${task.id}: ${safeErrorMessage(err)}`,
      );
    }
    return result;
  };

  // ── Initial review ────────────────────────────────────────────────────
  //
  // The review step runs once BEFORE the fixer loop. An immediate approval
  // short-circuits to { status: 'completed' } with no fixer work and no
  // worktree culling (the worktree is preserved for the merge step).

  let reviewResult = await runOnce(reviewStep);
  if (reviewResult.type === 'approved') {
    return { status: 'completed', output: reviewResult.output };
  }

  // ── Fix loop ──────────────────────────────────────────────────────────
  //
  // Up to `maxRounds` iterations of: shouldIsolate → fixers → re-review.
  // `isolated` records whether the loop exited via shouldIsolate=true so the
  // post-loop cull step knows to PRESERVE the worktree in that case.

  let isolated = false;

  for (let round = 0; round < maxRounds; round++) {
    // a. shouldIsolate consultation BEFORE the fixer attempt. Uses the most
    //    recent review feedback as the failure signal. A `true` result short-
    //    circuits the loop immediately (the fixer is NOT run for this round).
    if (await shouldIsolate(reviewResult.feedback)) {
      isolated = true;
      break;
    }

    // b. Run each fixer step in order. A fixer rejection or throw fires
    //    `onLaneError` but does NOT abort the round: subsequent fixer steps
    //    still run, and the re-review still runs. This matches the contract
    //    ("Run each fixer step via runStep (in order). If a fixer step is
    //    rejected or throws → fire onLaneError (observe) with the error.").
    for (const fixerStep of fixerSteps) {
      try {
        const fixerResult = await runOnce(fixerStep);
        if (fixerResult.type === 'rejected') {
          await fireOnLaneError(fixerResult.feedback);
        }
      } catch (err) {
        await fireOnLaneError(safeErrorMessage(err));
      }
    }

    // c. Re-run the review. An approval short-circuits to { status:
    //    'completed' } — the worktree is preserved for the merge step (cull
    //    only happens on exhaustion).
    reviewResult = await runOnce(reviewStep);
    if (reviewResult.type === 'approved') {
      return { status: 'completed', output: reviewResult.output };
    }
  }

  // ── Exhaustion / isolation cleanup ────────────────────────────────────
  //
  // Cull the task worktree UNLESS the loop exited via shouldIsolate=true
  // (the worktree is PRESERVED for inspection in that case). The cull-
  // or-preserve decision is delegated to `worktreeManager.cullOrPreserve`,
  // which owns the best-effort cull + error-swallowing discipline. When no
  // worktreeManager is configured the cleanup is a no-op (nothing to cull,
  // nothing to preserve).

  if (execCtx.worktreeManager) {
    await execCtx.worktreeManager.cullOrPreserve(task.id, isolated);
  }

  // The failed outcome surfaces the most recent review feedback so callers
  // (and the LanePool's onTaskRejected path) can report WHY the loop gave up.
  return { status: 'failed', feedback: reviewResult.feedback };
}
