// ─── Coalescing Runner (SessionPlan contract) ────────────────────────────
//
// A Runner that runs a coordinator → children → coordinator loop. Each round:
//
//   1. Yield coordinator batch (id `${taskId}/coordinator#${round}`).
//      The coordinator must FULLY resolve (persist) before children spawn.
//   2. Parse the coordinator's structured output:
//        { done: boolean, children?: Array<unknown>, feedback?: string }
//      - done === true  → generator returns (completed).
//      - done === false → proceed to step 3.
//   3. Delegate to `opts.childRunner(coordResult, round)` → SessionPlanRunner,
//      re-yield its batches and thread results back.
//   4. Increment round; loop back to step 1.
//
// If `maxRounds` is exhausted without `done: true`, the generator throws
// (scheduler treats a thrown generator error as task failure).
//
// Deadlock-safety: the coordinator completes and releases its gate slot BEFORE
// children are spawned (serial yield per round). Children spawned by the
// childRunner manage their own concurrency.

import { DEFAULT_MAX_ROUNDS } from '../constants.js';
import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute, delegateToChild } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

export interface CoalescingRunnerOptions {
  /** Factory: given the coordinator's SessionResult + round number, return a
   *  SessionPlanRunner that runs the children for this round. */
  childRunner: (coordinatorResult: SessionResult, round: number) => SessionPlanRunner;
  /** Maximum number of coordinator+children rounds. Defaults to DEFAULT_MAX_ROUNDS. */
  maxRounds?: number;
}

/**
 * Create a SessionPlanRunner that runs a coordinator loop: coordinator →
 * children → coordinator → done/more decision. Loop to `maxRounds` →
 * throws (task fails).
 *
 * The coordinator's structured output must have shape:
 *   `{ done: boolean, children?: Array<unknown>, feedback?: string }`
 *
 * When `done === true`, the generator returns (task completes).
 * Otherwise the coordinator result is passed to `childRunner`, which returns
 * a SessionPlanRunner for the children of that round.
 *
 * @param coordinatorSpec — SessionSpec for the coordinator agent.
 * @param opts — childRunner factory + optional maxRounds.
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function coalescingRunner(coordinatorSpec: SessionSpec, opts: CoalescingRunnerOptions): SessionPlanFactory {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;

  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        for (let round = 1; round <= maxRounds; round++) {
          // ── 1. Build round-specific coordinator spec ─────────────────────
          const roundSpec: SessionSpec = {
            ...coordinatorSpec,
            id: `${ctx.task.id}/coordinator#${round}`,
            attempt: round,
          };

          // ── 2. Yield coordinator for this round ──────────────────────────
          const coordinatorResults: SessionResult[] = yield [roundSpec];
          const coordResult = coordinatorResults[0];

          // ── 3. Parse the coordinator's decision ──────────────────────────
          const data = (coordResult.mode === 'structured' ? coordResult.data : {}) as Record<string, unknown>;

          // ── 4. done === true → generator returns (completed) ─────────────
          if (data.done === true) {
            return;
          }

          // ── 5. Run children for this round via childRunner ───────────────
          // delegateToChild re-yields the child's batches, threads results
          // back, and ensures childGen.return() runs on early termination.
          const childRunner = opts.childRunner(coordResult, round);
          yield* delegateToChild(childRunner, ctx);

          // If the child's plan threw, the error propagates to the scheduler.
          // Otherwise, continue to next round.

          // ── 6. Loop back to yield coordinator again ──────────────────────
        }

        // ── maxRounds exhausted without done === true ─────────────────────
        throw new Error(`Coalescing runner exhausted maxRounds (${maxRounds})`);
      },

      execute: defaultExecute,
    };
  };
}
