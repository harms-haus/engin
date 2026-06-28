// ─── Shared Runner Utilities (SessionPlan contract) ──────────────────────
//
// Shared boilerplate for SessionPlan runners. Currently:
//
//   - `defaultExecute` — delegates to `runScheduledSession` (gate-free).
//     The scheduler owns gate acquisition, so runners never touch the gate.
//     All SessionPlan runners that need a single-session execute primitive
//     should reference this instead of duplicating the inline method.
//
//   - `delegateToChild` — shared async-generator helper that fully delegates
//     to a child SessionPlanRunner's `plan()`: re-yields every batch, threads
//     results back, and returns the child's terminal value. Crucially, its
//     `try/finally` calls `childGen.return()` on early termination, so the
//     child's `finally` blocks run even when the scheduler `.return()`s the
//     parent generator. Composite runners should use `yield* delegateToChild(...)`
//     instead of duplicating the yield/next loop (fixes the resource leak and
//     keeps the delegation boilerplate DRY).

import { runScheduledSession } from '../run-scheduled-session.js';
import type { SessionResult, SessionSpec } from '../session.js';
import type { SessionPlanContext, SessionPlanRunner } from './session-plan-types.js';

/**
 * Default `execute` implementation for SessionPlan runners.
 *
 * Delegates to {@link runScheduledSession} with the given spec and context.
 * The scheduler acquires the gate slot before calling this method, so no
 * gate interaction occurs here.
 */
export const defaultExecute: SessionPlanRunner['execute'] = (ctx, spec) => runScheduledSession(spec, ctx);

/**
 * Fully delegate to a child SessionPlanRunner's `plan()` generator.
 *
 * Creates the child generator, re-yields every batch it produces, and feeds
 * the scheduler-supplied results back via `childGen.next(results)`. Returns
 * the child's terminal value (`SessionResult[] | undefined`).
 *
 * **Resource-safety:** a `try/finally` calls `childGen.return()` when this
 * generator terminates — whether normally, via an early `return()` from the
 * parent, or via a thrown error. This ensures the child's own `finally`
 * blocks always run. Composite runners should delegate via
 * `yield* delegateToChild(child, ctx)` so that `.return()` propagates from the
 * parent through to the child.
 *
 * @param child - The child SessionPlanRunner to delegate to.
 * @param ctx - The session plan context forwarded to the child's `plan()`.
 * @yields `SessionSpec[]` batches from the child.
 * @returns The child's terminal `SessionResult[] | undefined`.
 */
export async function* delegateToChild(
  child: SessionPlanRunner,
  ctx: SessionPlanContext,
): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
  const childGen = child.plan(ctx);
  try {
    let r: IteratorResult<SessionSpec[], SessionResult[] | undefined> = await childGen.next();
    while (!r.done) {
      const results: SessionResult[] = yield r.value;
      r = await childGen.next(results);
    }
    return r.value;
  } finally {
    // Ensure the child generator is always closed so its finally blocks run,
    // even on early .return() or thrown errors. The .catch() guards against
    // generators that reject on return.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await childGen.return(undefined).catch(() => {});
  }
}
