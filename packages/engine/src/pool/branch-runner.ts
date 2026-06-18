// ─── Branch Runner ─────────────────────────────────────────────────────────
//
// TaskRunner that selects a step from a set of conditions and runs exactly one
// step. The first matching branch condition wins. If no condition matches and
// a default step is provided, that step is used. If no match and no default,
// the task is failed.

import type { Task } from '../core/types.js';
import { buildExecCtx, createSessionTracker, handleRunnerError, settleResult } from './runner-utils.js';
import { runStep } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext } from './types.js';

/**
 * A branch condition that selects a step when its predicate returns true.
 */
export interface BranchCondition {
  /** Predicate that receives the current task and returns true if this branch matches. */
  condition: (task: Task) => boolean;
  /** The step to execute when this branch matches. */
  step: StepDefinition;
}

/**
 * Options for creating a branch runner.
 */
export interface BranchRunnerOptions {
  /** Ordered list of branches; the first matching condition wins. */
  branches: BranchCondition[];
  /** Optional fallback step when no condition matches. */
  default?: StepDefinition;
}

/**
 * Create a TaskRunner that selects exactly one step from a set of branch
 * conditions and executes it. The first branch whose condition returns true
 * is used. If none match and a default is provided, the default step runs.
 * If no match and no default, the task fails immediately.
 */
export function branchRunner(options: BranchRunnerOptions): TaskRunner {
  const { branches, default: defaultStep } = options;

  return async (ctx: TaskRunnerContext): Promise<TaskOutcome> => {
    const tracker = createSessionTracker(ctx.agentId, ctx.task.id);

    try {
      // ── Step 1: Evaluate conditions in order ────────────────────────
      let selectedStep: StepDefinition | undefined;

      for (const branch of branches) {
        if (branch.condition(ctx.task)) {
          selectedStep = branch.step;
          break;
        }
      }

      // ── Step 2: Fallback to default or fail ─────────────────────────
      if (!selectedStep) {
        if (defaultStep) {
          selectedStep = defaultStep;
        } else {
          ctx.failTask({ completed: false, error: 'No matching branch and no default' });
          return { status: 'failed', error: 'No matching branch and no default' };
        }
      }

      // ── Step 3: Run the selected step ───────────────────────────────
      const { result, trackedSession } = await runStep(
        ctx.task,
        selectedStep,
        ctx.agentId,
        { stepIndex: 0, attempt: 0, execCount: 0 },
        ctx.profiles,
        buildExecCtx(ctx),
      );
      tracker.add(trackedSession);

      // ── Step 4: Settle based on result ──────────────────────────────
      return settleResult(ctx, result, tracker.disposeAll);
    } catch (err) {
      // ── Step 5: Unexpected error — never re-throw ───────────────────
      return handleRunnerError(err, ctx, tracker.disposeAll);
    }
  };
}
