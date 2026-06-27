// ─── Parallel Runner ─────────────────────────────────────────────────────
//
// A pure combinator that starts ALL children as coroutines and awaits them
// together via `Promise.allSettled`. Each child is an arbitrary Runner
// function — `parallelRunner` does not inject IDs or session specs; each child
// assigns its own IDs per its nature.
//
// If any child returns `{ status: 'failed' }`, `parallelRunner` returns that
// outcome. Siblings are NOT cancelled — they were already started as
// independent coroutines and complete naturally (their gate slots release on
// their own). This is deadlock-free: no child holds a resource while waiting
// for another.
//
// The returned failed outcome is the first (by array index) child whose result
// is `{ status: 'failed' }`.

import type { Runner, RunnerContext, TaskOutcome } from './types.js';

/**
 * Create a Runner that runs children in parallel (concurrent coroutines).
 * If any child returns `{ status: 'failed' }` → returns that outcome.
 * Siblings are NOT cancelled (they complete; their resources release
 * naturally).
 *
 * @param children — Array of Runner functions to execute concurrently.
 */
export function parallelRunner(children: Runner[]): Runner {
  return async (ctx: RunnerContext): Promise<TaskOutcome> => {
    // ── 1. Start all children as coroutines, await together ──────────────
    // Each child(ctx) call starts immediately; Promise.allSettled waits for
    // ALL to settle (no early bail-out → no cancellation).
    const results = await Promise.allSettled(children.map((child) => child(ctx)));

    // ── 2. Find the first failed child (by array index) ──────────────────
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.status === 'failed') {
        return r.value;
      }
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        return { status: 'failed', error: msg };
      }
    }

    // ── 3. All children completed ────────────────────────────────────────
    return { status: 'completed' };
  };
}
