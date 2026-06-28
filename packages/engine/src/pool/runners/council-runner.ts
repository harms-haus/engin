// ─── Council Runner (SessionPlan contract) ───────────────────────────────
//
// A SessionPlanRunner that runs worker sessions in parallel (Phase1) and
// feeds their concatenated results into a synthesizer session (Phase2).
//
// Phase1: yields all worker specs as a single batch. The scheduler runs them
//   concurrently through the gate. Results come back as SessionResult[] —
//   one per worker, in spec order.
//
// Phase2: builds the synthesizer prompt by concatenating the successful
//   worker outputs (using the same formatting convention as the old
//   council-runner). The enriched synthesizer spec is yielded as a second
//   batch. The synthesizer spec's prompt is enriched BEFORE it is yielded
//   (execute() runs the spec as-is).
//
// Worker output formatting:
//   text        → the result text
//   structured  → JSON.stringify(result.data)
//   filesystem  → "(filesystem session — see files)"
//
// `execute()` delegates to {@link defaultExecute} (gate-free).

import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

/** Prefix prepended before each worker's result in the synthesizer prompt. */
const WORKER_OUTPUT_PREFIX = '\n\n---\nWorker output:\n';

/**
 * Format a worker {@link SessionResult} into a string suitable for inclusion
 * in the synthesizer prompt.
 */
function formatWorkerResult(result: SessionResult): string {
  switch (result.mode) {
    case 'text':
      return result.text;
    case 'structured':
      return JSON.stringify(result.data);
    case 'filesystem':
      return '(filesystem session — see files)';
  }
}

/**
 * Create a SessionPlanRunner that runs workers in parallel and feeds their
 * results into a synthesizer session.
 *
 * Phase1: all workers run concurrently (the scheduler manages gate capacity).
 * Phase2: worker outputs are concatenated into the synthesizer prompt.
 *
 * @param workers - Array of SessionSpec for worker agents.
 * @param synthesizer - SessionSpec for the synthesizer agent.
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function councilRunner(workers: SessionSpec[], synthesizer: SessionSpec): SessionPlanFactory {
  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        _ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        // ── Phase1: Yield all workers as a single batch ──────────────────
        const workerResults: SessionResult[] = yield workers;

        // ── Phase2: Build synthesizer prompt from worker outputs ─────────
        // Format each worker result and concatenate with the prefix separator.
        const workerOutputs = workerResults
          .map((r) => formatWorkerResult(r))
          .filter((text) => text.length > 0)
          .join(WORKER_OUTPUT_PREFIX);

        const synthPrompt =
          workerOutputs.length > 0
            ? `${synthesizer.prompt}${WORKER_OUTPUT_PREFIX}${workerOutputs}`
            : synthesizer.prompt;

        const synthSpec: SessionSpec = {
          ...synthesizer,
          prompt: synthPrompt,
        };

        // Yield the synthesizer batch. The scheduler will run it and feed
        // the result back.
        const _synthResult: SessionResult[] = yield [synthSpec];

        // ── All done ─────────────────────────────────────────────────────
        return;
      },

      execute: defaultExecute,
    };
  };
}
