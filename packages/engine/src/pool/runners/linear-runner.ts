// ─── Linear Runner ─────────────────────────────────────────────────────────
//
// Runs children in strict sequential order. If any child returns
// `{ status: 'failed' }` the runner short-circuits and returns that outcome
// immediately, skipping all remaining children.
//
// Deterministic ID convention: children that delegate to `singleSession`
// should use the role prefix `linear[i].<childrole>` so session IDs follow
// the convention `${taskId}/linear[i].<childrole>#<attempt>`. The prefix is
// applied by the child runner (or its caller), not injected here —
// `linearRunner` is a pure ordering/short-circuit combinator over arbitrary
// Runner functions.

import type { Runner, RunnerContext, TaskOutcome } from './types.js';

/**
 * Create a Runner that runs children in order.
 * IDs: `linear[i].<childrole>` for each child.
 * If any child returns failed → return failed immediately.
 */
export function linearRunner(children: Runner[]): Runner {
  return async (ctx: RunnerContext): Promise<TaskOutcome> => {
    for (const child of children) {
      const outcome = await child(ctx);
      if (outcome.status === 'failed') {
        return outcome;
      }
    }
    return { status: 'completed' };
  };
}
