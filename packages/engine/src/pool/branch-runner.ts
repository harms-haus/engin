// ─── Branch Runner ─────────────────────────────────────────────────────────
//
// TaskRunner that selects a step from a set of conditions and runs exactly one
// step. The first matching branch condition wins. If no condition matches and
// a default step is provided, that step is used. If no match and no default,
// the task is failed.

import type { Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import { runStep, type StepExecutionContext } from './step-execution.js';
import type { StepDefinition, TaskOutcome, TaskRunner, TaskRunnerContext, TrackedSession } from './types.js';

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
    const sessions: TrackedSession[] = [];

    const disposeAllSessions = () => {
      for (const ts of sessions) {
        try {
          ts.dispose();
        } catch (err) {
          console.error(`[${ctx.agentId}] Error disposing session for task ${ctx.task.id}:`, safeErrorMessage(err));
        }
      }
      sessions.length = 0;
    };

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

      // ── Step 3: Initialize sessions (already done above) ────────────

      // ── Step 4: Construct execution context ─────────────────────────
      const execCtx: StepExecutionContext = {
        sessionBaseDir: ctx.sessionBaseDir,
        cwd: ctx.cwd,
        apiKeys: ctx.apiKeys,
        onStatus: ctx.onStatus,
        activeSessions: ctx.activeSessions,
        phaseId: ctx.phaseId,
      };

      // ── Step 5: Fire onStepStart ────────────────────────────────────
      ctx.onStatus?.onStepStart?.({
        taskId: ctx.task.id,
        stepIndex: 0,
        stepName: selectedStep.name,
        agentId: ctx.agentId,
      });

      // ── Step 6: Run the selected step ───────────────────────────────
      const { result, trackedSession } = await runStep(
        ctx.task,
        selectedStep,
        ctx.agentId,
        { stepIndex: 0, attempt: 0, execCount: 0 },
        ctx.profiles,
        execCtx,
      );
      sessions.push(trackedSession);

      // ── Step 7: Settle based on result ──────────────────────────────
      if (result.type === 'approved') {
        if (ctx.completeTask(result.output)) {
          disposeAllSessions();
          return { status: 'completed', output: result.output };
        }
        ctx.failTask({ completed: false, error: 'Failed to submit' });
        disposeAllSessions();
        return { status: 'failed', error: 'Failed to submit' };
      }

      // result.type === 'rejected'
      ctx.failTask({ completed: false, feedback: result.feedback });
      disposeAllSessions();
      return { status: 'failed', feedback: result.feedback };
    } catch (err) {
      // ── Step 8: Unexpected error — never re-throw ───────────────────
      disposeAllSessions();
      const errorMsg = safeErrorMessage(err);
      ctx.failTask({ completed: false, error: errorMsg });
      return { status: 'failed', error: errorMsg };
    }
  };
}
