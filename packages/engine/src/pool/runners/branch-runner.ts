// ─── Branch Runner (SessionPlan contract) ─────────────────────────────────
//
// Selects exactly one child SessionPlanRunner from a set of branches based on
// conditions evaluated in order. The first branch whose condition returns true
// wins. If no branch matches and a default is provided, the default runs.
// If no match and no default, the task fails (plan throws).
//
// Conditions can be async (return Promise<boolean>). They are awaited in
// order; the first truthy result short-circuits evaluation.
//
// The selected branch's `plan()` generator is fully delegated to — all its
// yielded batches are re-yielded and results are threaded back.
//
// `execute()` delegates to {@link defaultExecute} (the scheduler calls
// `execute` for each spec yielded by `plan`, regardless of which branch).

import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute, delegateToChild } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

/**
 * A branch condition that selects a child SessionPlanRunner when its predicate
 * returns (or resolves to) true.
 */
export interface BranchCondition {
  /** Predicate receiving the full SessionPlanContext. Can be sync or async. */
  condition: (ctx: SessionPlanContext) => boolean | Promise<boolean>;
  /** The SessionPlanRunner to execute when this branch matches. */
  runner: SessionPlanRunner;
}

/** Options for creating a branch runner. */
export interface BranchRunnerOptions {
  /** Ordered list of branches; the first matching condition wins. */
  branches: BranchCondition[];
  /** Optional fallback runner when no condition matches. */
  default?: SessionPlanRunner;
}

/**
 * Create a SessionPlanRunner that selects exactly one child based on the first
 * matching branch condition. If no branch matches and no default is provided,
 * the runner's plan throws (task fails).
 *
 * Conditions are evaluated in order (sync or async — both are awaited). The
 * first truthy result short-circuits; no further conditions are evaluated and
 * no later runner is invoked.
 *
 * @param options - Branches and optional default runner.
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function branchRunner(options: BranchRunnerOptions): SessionPlanFactory {
  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        const { branches, default: defaultRunner } = options;

        // ── Evaluate conditions in order; first match wins ────────────────
        for (const branch of branches) {
          const matched = await branch.condition(ctx);
          if (matched) {
            // Delegate to selected branch's plan (resource-safe: childGen.return()
            // runs in the finally on early termination).
            return yield* delegateToChild(branch.runner, ctx);
          }
        }

        // ── No match: fall back to default or throw ───────────────────────
        if (defaultRunner) {
          return yield* delegateToChild(defaultRunner, ctx);
        }

        // No match and no default — fail the task
        throw new Error('No branch matched');
      },

      execute: defaultExecute,
    };
  };
}
