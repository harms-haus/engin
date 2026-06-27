// ─── Branch Runner ─────────────────────────────────────────────────────────
//
// Selects exactly one child Runner from a set of branches based on conditions
// evaluated in order. The first branch whose condition returns true wins.
// If no branch matches and a default is provided, the default runs.
// If no match and no default, the task fails with { status: 'failed',
// error: 'No branch matched' }.
//
// Session IDs follow the convention `branch.<role>` for the selected child's
// sessions.
//
// Conditions can be async (return Promise<boolean>). They are awaited in
// order; the first truthy result short-circuits evaluation.

import type { Runner, RunnerContext, TaskOutcome } from './types.js';

/**
 * A branch condition that selects a child Runner when its predicate
 * returns (or resolves to) true.
 */
export interface BranchCondition {
  /** Predicate receiving the full RunnerContext. Can be sync or async. */
  condition: (ctx: RunnerContext) => boolean | Promise<boolean>;
  /** The Runner to execute when this branch matches. */
  runner: Runner;
}

/** Options for creating a branch runner. */
export interface BranchRunnerOptions {
  /** Ordered list of branches; the first matching condition wins. */
  branches: BranchCondition[];
  /** Optional fallback runner when no condition matches. */
  default?: Runner;
}

/**
 * Create a Runner that selects exactly one child Runner based on the first
 * matching branch condition. If no branch matches and no default is provided,
 * the task fails.
 *
 * Conditions are evaluated in order (sync or async — both are awaited). The
 * first truthy result short-circuits; no further conditions are evaluated and
 * no later runner is invoked.
 */
export function branchRunner(options: BranchRunnerOptions): Runner {
  const { branches, default: defaultRunner } = options;

  return async (ctx: RunnerContext): Promise<TaskOutcome> => {
    // ── Evaluate conditions in order; first match wins ────────────────────
    for (const branch of branches) {
      const matched = await branch.condition(ctx);
      if (matched) {
        return branch.runner(ctx);
      }
    }

    // ── No match: fall back to default or fail ────────────────────────────
    if (defaultRunner) {
      return defaultRunner(ctx);
    }

    return { status: 'failed', error: 'No branch matched' };
  };
}
