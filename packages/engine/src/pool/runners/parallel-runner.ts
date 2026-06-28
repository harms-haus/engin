// ─── Parallel Runner (SessionPlan contract) ──────────────────────────────
//
// A pure combinator that runs children's FIRST batches as a single parallel
// batch. Each child is a {@link SessionPlanRunner} — `parallelRunner` calls
// each child's `plan(ctx).next()` to get its first batch, concatenates all
// yielded specs into ONE batch, and yields them together (all simultaneously
// runnable).
//
// After the batch settles, the results are split by child (based on how many
// specs each child contributed) and forwarded back to each child's generator
// via `childGen.next(childResults)`. If a child's plan is exhausted after its
// first batch (done === true), it contributes nothing more.
//
// `execute()` delegates to {@link defaultExecute} (gate-free).

import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

/**
 * Create a SessionPlanRunner that runs children's first batches as a single
 * parallel batch.
 *
 * Each child's `plan()` generator is started and its first batch is collected.
 * All first batches are concatenated and yielded as one combined batch. After
 * settlement, results are split by child and forwarded back via
 * `childGen.next(childResults)`.
 *
 * @param children - The child runners to run in parallel (first batch only).
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function parallelRunner(children: SessionPlanRunner[]): SessionPlanFactory {
  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        // ── 1. Start each child's plan generator and get first batch ──────
        // Capture both the generator and the spec batch for each child whose
        // plan is not immediately exhausted.
        const childEntries: {
          gen: AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]>;
          batch: SessionSpec[];
        }[] = [];

        for (const child of children) {
          const childGen = child.plan(ctx);
          const first = await childGen.next();

          if (!first.done) {
            childEntries.push({
              gen: childGen,
              batch: first.value,
            });
          }
        }

        // ── 2. Build combined batch from all children's first batches ────
        // Concatenate all specs in order — the combined batch is the union of
        // every child's first batch.
        const combinedBatch: SessionSpec[] = [];
        for (const entry of childEntries) {
          combinedBatch.push(...entry.batch);
        }

        // ── 3. Yield combined batch ──────────────────────────────────────
        // The scheduler will execute all specs in this batch and feed results
        // back via gen.next(results).
        const results: SessionResult[] = yield combinedBatch;

        // ── 4. Split results by child and forward back ────────────────────
        // Partition the flat results array by each child's batch size and
        // forward the portion back to the child's generator.
        let offset = 0;
        for (const entry of childEntries) {
          const childResults = results.slice(offset, offset + entry.batch.length);
          offset += entry.batch.length;
          // Forward results to the child's generator. We ignore the return
          // value — the child's plan may be exhausted or yield nothing more.
          await entry.gen.next(childResults);
        }

        // ── 5. All done ──────────────────────────────────────────────────
        return;
      },

      execute: defaultExecute,
    };
  };
}
