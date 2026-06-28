// ─── Linear Runner (SessionPlan contract) ──────────────────────────────────
//
// Runs children in strict sequential order. Each child is a
// {@link SessionPlanRunner} — the linear runner iterates through the child's
// `plan()` generator, forwarding every yielded batch and feeding results back
// to the child. Only when the current child's plan is exhausted does it move
// to the next child.
//
// The linear runner does NOT inspect results to decide whether to short-
// circuit — that is the scheduler's responsibility. If a child's `execute()`
// throws, the scheduler marks the task failed and does not advance the
// generator, so remaining children are naturally skipped.
//
// `execute()` delegates to {@link runScheduledSession} (gate-free).

import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute, delegateToChild } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

/**
 * Create a SessionPlanRunner that runs children in strict sequential order.
 *
 * Each child's `plan()` generator is fully consumed (all batches forwarded)
 * before advancing to the next child.
 *
 * @param children - The child runners to execute in order.
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function linearRunner(children: SessionPlanRunner[]): SessionPlanFactory {
  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        for (const child of children) {
          // Fully delegate to the child's plan: re-yield every batch, thread
          // results back, and ensure childGen.return() runs on early
          // termination (resource-safety). The child's terminal value is
          // ignored — the scheduler tracks terminal results itself.
          yield* delegateToChild(child, ctx);
        }

        // All children completed. Return undefined (no aggregated terminal results).
        return;
      },

      execute: defaultExecute,
    };
  };
}
