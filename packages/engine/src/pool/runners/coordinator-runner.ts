// ─── Coordinator Runner (SessionPlan contract) ───────────────────────────
//
// A Runner that runs a coordinator session to produce a structured result,
// then delegates to a `childRunner` factory to build and run the children.
//
// CRITICAL ordering guarantee: the coordinator's session fully resolves (and
// its result is persisted) BEFORE any child is spawned. This is enforced by
// yielding the coordinator spec FIRST and only calling `childRunner` after
// the coordinator result is received via `gen.next([coordResult])`.
//
// The coordinator runs via the scheduler (which calls `execute()` for each
// spec). Its structured output (the `data` field) is passed to
// `opts.childRunner(coordResult)`, which returns a SessionPlanRunner that
// executes the children. The coordinator runner delegates entirely to that
// child's `plan()` generator — whatever its plan yields is re-yielded, and
// results are threaded back.
//
// Deterministic IDs: taken from the coordinator SessionSpec directly.
// Children assign their own IDs per the childRunner's convention
// (typically `${taskId}/worker[${i}]#${attempt}`).

import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute, delegateToChild } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

export interface CoordinatorRunnerOptions {
  /** Factory: given the coordinator's SessionResult, return a
   *  SessionPlanRunner that runs the children. */
  childRunner: (coordinatorResult: SessionResult) => SessionPlanRunner;
}

/**
 * Create a SessionPlanRunner that runs a coordinator session, then spawns
 * children via `childRunner`. The coordinator must fully persist before any
 * child is invoked (enforced by yielding the coordinator spec first and only
 * calling childRunner after the result is received).
 *
 * @param coordinatorSpec — SessionSpec for the coordinator agent (structured output).
 * @param opts — childRunner factory.
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function coordinatorRunner(coordinatorSpec: SessionSpec, opts: CoordinatorRunnerOptions): SessionPlanFactory {
  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        // ── 1. Yield coordinator spec — FULLY await before children ───────
        // The scheduler runs the coordinator session via execute(), then
        // feeds back the result via gen.next([coordResult]). Only after this
        // does the childRunner get called.
        const coordinatorResults: SessionResult[] = yield [coordinatorSpec];
        const coordResult = coordinatorResults[0];

        // ── 2. Build + delegate to child's plan ──────────────────────────
        // delegateToChild re-yields the child's batches, threads results back,
        // and ensures childGen.return() runs on early termination.
        const childRunner = opts.childRunner(coordResult);
        return yield* delegateToChild(childRunner, ctx);
      },

      execute: defaultExecute,
    };
  };
}
