// ─── Map Runner ────────────────────────────────────────────────────────────
//
// Fans out over a collection of items, running one session per item with an
// optional concurrency cap. Session IDs follow the convention:
//
//   `${taskId}/map[${index}].${role}#${attempt}`
//
// The per-item prompt is composed as:
//
//   sessionSpec.prompt + "\n\nItem: " + JSON.stringify(item)
//
// Uses Promise.allSettled to avoid session leaks on partial failure.
// Returns { status: 'completed' } if all items succeed;
// { status: 'failed' } if any item fails (all items still settle — no leak).
//
// Concurrency: when `concurrency` is omitted or >= items.length, all items run
// in parallel through the gate. Otherwise a worker-pool of size `concurrency`
// serializes items. The gate additionally throttles per-provider/model.
// This dual-layer approach is deadlock-free: the local pool never holds a gate
// slot while waiting for another, and the gate is FIFO with RAII release.

import { safeErrorMessage } from '../../core/utils.js';
import type { SessionSpec } from '../session.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';
import { runSessionViaGate } from './utils.js';

/** Options for creating a map runner. */
export interface MapRunnerOptions {
  /** Static array of items to fan out over. */
  items: unknown[];
  /**
   * Base session spec shared across all items. The `id` is computed
   * automatically as `map[${index}].${role}`. The per-item prompt is
   * composed as `sessionSpec.prompt + "\n\nItem: " + JSON.stringify(item)`.
   */
  sessionSpec: Omit<SessionSpec, 'id'> & { role: string };
  /** Maximum concurrent items. When omitted, all items run in parallel. */
  concurrency?: number;
}

/**
 * Create a Runner that fans out over a collection of items, running one
 * session per item with an optional concurrency cap.
 *
 * IDs: `map[${index}].<role>` for each item.
 * Concurrency: enforced by a local worker pool (delegating through the gate).
 * AllSettled: ensures all sessions settle even on partial failure.
 */
export function mapRunner(options: MapRunnerOptions): Runner {
  const { items, sessionSpec, concurrency: concurrencyOpt } = options;

  return async (ctx: RunnerContext): Promise<TaskOutcome> => {
    // ── Edge: empty items → fail immediately ──────────────────────────────
    if (items.length === 0) {
      return { status: 'failed', error: 'No items to process' };
    }

    // ── Resolve profile once (early-return if missing) ────────────────────
    const resolvedProfile = ctx.profiles.get(sessionSpec.profile);
    if (!resolvedProfile) {
      return { status: 'failed', error: `Profile "${sessionSpec.profile}" not found in profiles map` };
    }

    const role = sessionSpec.role;
    const attempt = sessionSpec.attempt;

    // ── Per-item session execution ────────────────────────────────────────
    const processItem = async (item: unknown, index: number): Promise<void> => {
      const id = `${ctx.task.id}/map[${index}].${role}#${attempt}`;
      const prompt = `${sessionSpec.prompt}\n\nItem: ${JSON.stringify(item)}`;

      const perItemSpec: SessionSpec = {
        id,
        profile: sessionSpec.profile,
        prompt,
        ...(sessionSpec.schema !== undefined ? { schema: sessionSpec.schema } : {}),
        outputMode: sessionSpec.outputMode,
        ...(sessionSpec.isReadOnly !== undefined ? { isReadOnly: sessionSpec.isReadOnly } : {}),
        runnerRole: sessionSpec.runnerRole,
        attempt,
      };

      await runSessionViaGate(ctx, perItemSpec);
    };

    // ── Execute with concurrency control ──────────────────────────────────
    const concurrency = concurrencyOpt !== undefined ? Math.max(1, concurrencyOpt) : undefined;

    let results: PromiseSettledResult<void>[];

    if (concurrency === undefined || concurrency >= items.length) {
      // Run all items in parallel — allSettled ensures all sessions are tracked.
      results = await Promise.allSettled(items.map((item, i) => processItem(item, i)));
    } else {
      // Worker-pool pattern with concurrency cap.
      // Each worker pulls the next index and processes it; no gate slot is
      // held while waiting for another, so this is deadlock-free.
      results = new Array<PromiseSettledResult<void>>(items.length);
      let nextIndex = 0;

      const poolWorker = async (): Promise<void> => {
        while (nextIndex < items.length) {
          const i = nextIndex++;
          try {
            await processItem(items[i], i);
            results[i] = { status: 'fulfilled', value: undefined };
          } catch (err) {
            results[i] = { status: 'rejected', reason: err };
          }
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => poolWorker()));
    }

    // ── Settle: all succeed → completed; any fail → failed ────────────────
    const failures = results.filter((r) => r.status === 'rejected');

    if (failures.length === 0) {
      return { status: 'completed' };
    }

    const errorMessages = failures.map((r) => (r.status === 'rejected' ? safeErrorMessage(r.reason) : ''));

    return {
      status: 'failed',
      error: `${failures.length} of ${items.length} items failed: ${errorMessages.join('; ')}`,
    };
  };
}
