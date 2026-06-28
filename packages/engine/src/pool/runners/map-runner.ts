// ─── Map Runner (SessionPlan contract) ────────────────────────────────────
//
// Fans out over a collection of items, yielding one batch with one
// SessionSpec per item. The per-item prompt is composed as:
//
//   spec.prompt + "\n\nItem: " + JSON.stringify(item)
//
// Session IDs follow the convention:
//
//   `${taskId}/map[${index}].${role}#${attempt}`
//
// Concurrency is NOT managed here — the scheduler/gate is the sole
// concurrency authority. All specs in the batch are available to the
// scheduler simultaneously; the gate decides how many run at once.
//
// `execute()` delegates to {@link defaultExecute} (gate-free).

import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

/** Options for creating a map runner (SessionPlan contract). */
export interface MapRunnerOptions {
  /** Static array of items to fan out over. */
  items: unknown[];
  /**
   * Base session spec. The `id` is computed automatically per item as
   * `map[${index}].<role>`. The per-item prompt is composed as
   * `spec.prompt + "\n\nItem: " + JSON.stringify(item)`.
   */
  spec: SessionSpec;
  /** Role segment for session IDs (default: "worker"). */
  role?: string;
}

/**
 * Create a SessionPlanRunner that fans out over a collection of items,
 * yielding one batch with one spec per item.
 *
 * IDs: `map[${index}].<role>` for each item.
 * Concurrency: the gate is the sole concurrency authority.
 *
 * @param options - Items, base spec, and optional role.
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function mapRunner(options: MapRunnerOptions): SessionPlanFactory {
  const { items, spec, role = 'worker' } = options;

  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        // ── Edge: empty items → done immediately ──────────────────────────
        if (items.length === 0) {
          return;
        }

        const attempt = spec.attempt ?? 1;

        // ── Build per-item specs ─────────────────────────────────────────
        const batch: SessionSpec[] = items.map((item, index) => {
          const id = `${ctx.task.id}/map[${index}].${role}#${attempt}`;
          const prompt = `${spec.prompt}\n\nItem: ${JSON.stringify(item)}`;

          return {
            id,
            profile: spec.profile,
            prompt,
            outputMode: spec.outputMode,
            runnerRole: role,
            attempt,
            ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
            ...(spec.isReadOnly !== undefined ? { isReadOnly: spec.isReadOnly } : {}),
          };
        });

        // ── Yield the single batch ───────────────────────────────────────
        const _results: SessionResult[] = yield batch;

        // ── Done ─────────────────────────────────────────────────────────
        return;
      },

      execute: defaultExecute,
    };
  };
}
