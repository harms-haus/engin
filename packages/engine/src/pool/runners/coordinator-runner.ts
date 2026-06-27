// ─── Coordinator Runner ──────────────────────────────────────────────────
//
// A Runner that runs a coordinator session to produce a structured result,
// then delegates to a `childRunner` factory to build and run the children.
//
// CRITICAL ordering guarantee: the coordinator's `runSession` fully resolves
// (and its result is persisted) BEFORE any child is spawned. This is enforced
// by fully awaiting the coordinator session before calling `childRunner`.
//
// The coordinator runs via `ctx.gate.run` + `ctx.runSession`. Its structured
// output (the `data` field) is passed to `opts.childRunner`, which returns a
// Runner that executes the children. The coordinator runner delegates entirely
// to that child Runner — whatever outcome it produces is returned.
//
// Deterministic IDs: taken from the coordinator SessionSpec directly.
// Children assign their own IDs per the childRunner's convention
// (typically `${taskId}/worker[${i}]#${attempt}`).

import type { SessionSpec } from '../session.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';
import { runSessionViaGate } from './utils.js';

export interface CoordinatorRunnerOptions {
  /** Factory: given the coordinator's structured result, return a Runner that
   *  runs the children. */
  childRunner: (coordinatorResult: unknown) => Runner;
}

/**
 * Create a Runner that runs a coordinator session, then spawns children via
 * `childRunner`. The coordinator must fully persist before any child is
 * invoked (enforced by serial `await`).
 *
 * @param coordinatorSpec — SessionSpec for the coordinator agent (structured output).
 * @param opts — childRunner factory.
 */
export function coordinatorRunner(coordinatorSpec: SessionSpec, opts: CoordinatorRunnerOptions): Runner {
  return async (ctx: RunnerContext): Promise<TaskOutcome> => {
    // ── 1. Run coordinator session — FULLY await before children ──────────
    // The await guarantees the coordinator's runSession (including persistence)
    // resolves completely before childRunner is called.
    const coordinatorResult = await runSessionViaGate(ctx, coordinatorSpec);

    // ── 2. Extract structured data (the coordinator's decision) ───────────
    const coordinatorData = coordinatorResult.mode === 'structured' ? coordinatorResult.data : coordinatorResult;

    // ── 3. Build + run children via the factory ───────────────────────────
    const childR = opts.childRunner(coordinatorData);
    return childR(ctx);
  };
}
