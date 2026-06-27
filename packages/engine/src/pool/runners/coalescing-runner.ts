// ─── Coalescing Runner ───────────────────────────────────────────────────
//
// A Runner that runs a coordinator → children → coordinator loop. Each round:
//
//   1. Run coordinator session (id `${taskId}/coordinator#${round}`).
//      The coordinator must FULLY resolve (persist) before children spawn.
//   2. Parse the coordinator's structured output:
//        { done: boolean, children?: Array<unknown>, feedback?: string }
//      - done === true  → return `{ status: 'completed' }`.
//      - done === false → proceed to step 3.
//   3. Build + run children for this round via `opts.childRunner(data)`.
//   4. Increment round; loop back to step 1.
//
// If `maxRounds` is exhausted without `done: true`, the runner returns
// `{ status: 'failed' }`.
//
// Deadlock-safety: the coordinator completes and releases its gate slot BEFORE
// children are spawned (serial await per round). Children spawned by the
// childRunner manage their own concurrency.

import { DEFAULT_MAX_ROUNDS } from '../constants.js';
import type { SessionSpec } from '../session.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';
import { runSessionViaGate } from './utils.js';

export interface CoalescingRunnerOptions {
  /** Factory: given the coordinator's structured result, return a Runner that
   *  runs the children for this round. */
  childRunner: (coordinatorResult: unknown) => Runner;
  /** Maximum number of coordinator+children rounds. Defaults to DEFAULT_MAX_ROUNDS. */
  maxRounds?: number;
}

/** Expected shape of the coordinator's structured output. */
interface CoalescingDecision {
  done: boolean;
  children?: unknown[];
  feedback?: string;
}

/**
 * Create a Runner that runs a coordinator loop: coordinator → children →
 * coordinator → done/more decision. Loop to `maxRounds` → `{ status: 'failed' }`.
 *
 * The coordinator's structured output must have shape:
 *   `{ done: boolean, children?: Array<unknown>, feedback?: string }`
 *
 * When `done === true`, the runner returns `{ status: 'completed' }`.
 * Otherwise the coordinator result is passed to `childRunner`, which runs
 * the children for that round, and the next round begins.
 *
 * @param coordinatorSpec — SessionSpec for the coordinator agent.
 * @param opts — childRunner factory + optional maxRounds.
 */
export function coalescingRunner(coordinatorSpec: SessionSpec, opts: CoalescingRunnerOptions): Runner {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;

  return async (ctx: RunnerContext): Promise<TaskOutcome> => {
    for (let round = 1; round <= maxRounds; round++) {
      // ── 1. Run coordinator for this round (fully await before children) ──
      const roundSpec: SessionSpec = {
        ...coordinatorSpec,
        id: `${ctx.task.id}/coordinator#${round}`,
        attempt: round,
      };

      const coordinatorResult = await runSessionViaGate(ctx, roundSpec);

      // ── 2. Parse the coordinator's decision ─────────────────────────────
      const data = (coordinatorResult.mode === 'structured' ? coordinatorResult.data : {}) as CoalescingDecision;

      // ── 3. done === true → completed ────────────────────────────────────
      if (data.done === true) {
        return { status: 'completed' };
      }

      // ── 4. Run children for this round via childRunner ──────────────────
      const childR = opts.childRunner(data);
      const childOutcome = await childR(ctx);
      if (childOutcome.status === 'failed') {
        return childOutcome;
      }

      // ── 5. Continue to next round ───────────────────────────────────────
    }

    // ── maxRounds exhausted without done === true ────────────────────────
    return { status: 'failed', error: `Coalescing runner exhausted maxRounds (${maxRounds})` };
  };
}
