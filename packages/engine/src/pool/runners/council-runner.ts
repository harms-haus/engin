// ─── Council Runner ──────────────────────────────────────────────────────
//
// A Runner that runs worker sessions in PARALLEL and feeds their concatenated
// results into a synthesizer session.
//
// Workers are started as independent coroutines — each acquires its own gate
// slot via `ctx.gate.run` and calls `ctx.runSession`. They are awaited together
// via `Promise.allSettled`, so no worker holds a slot while waiting for a
// sibling (deadlock-free under any gate cap ≥ 1).
//
// Successful worker results are concatenated into the synthesizer prompt:
//
//   text        → the result text
//   structured  → JSON.stringify(result.data)
//   filesystem  → "(filesystem session — see files)"
//
// Each worker's output is appended to the synthesizer's original prompt in
// order. Failed workers are silently omitted from the synthesizer prompt.
//
// If ALL workers fail, the synthesizer is NOT called and the runner returns
// `{ status: 'failed' }`.
//
// Deterministic IDs: taken directly from the provided SessionSpec objects
// (callers should use the convention `${taskId}/worker[${i}]#${attempt}`
// and `${taskId}/synthesizer#${attempt}`).

import type { SessionResult, SessionSpec } from '../session.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';
import { runSessionViaGate } from './utils.js';

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
 * Create a Runner that runs workers in parallel and feeds their results into a
 * synthesizer session.
 *
 * Workers run as independent `gate.run` coroutines awaited together via
 * `Promise.allSettled`. Partial failure is tolerated (failed workers are
 * omitted from the synthesizer prompt). All workers failing →
 * `{ status: 'failed' }` (synthesizer NOT called).
 *
 * @param workers — Array of SessionSpec for worker agents.
 * @param synthesizer — SessionSpec for the synthesizer agent.
 */
export function councilRunner(workers: SessionSpec[], synthesizer: SessionSpec): Runner {
  return async (ctx: RunnerContext): Promise<TaskOutcome> => {
    // ── 1. Start all workers as independent gate.run coroutines ────────────
    // Each promise starts executing immediately (acquiring its own gate slot);
    // they are awaited together so no worker blocks on a sibling.
    const workerPromises = workers.map((spec) => runSessionViaGate(ctx, spec));
    const settled = await Promise.allSettled(workerPromises);

    // ── 2. Collect successful worker results (omit failures) ──────────────
    const workerResults: SessionResult[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        workerResults.push(s.value);
      }
    }

    // ── 3. All workers failed → synthesizer NOT called ─────────────────────
    if (workerResults.length === 0) {
      return { status: 'failed', error: 'All council workers failed' };
    }

    // ── 4. Build synthesizer prompt (original + concatenated worker outputs) ──
    const workerOutputs = workerResults.map((r) => formatWorkerResult(r)).join(WORKER_OUTPUT_PREFIX);
    const synthPrompt = `${synthesizer.prompt}${WORKER_OUTPUT_PREFIX}${workerOutputs}`;

    const synthSpec: SessionSpec = {
      ...synthesizer,
      prompt: synthPrompt,
    };

    // ── 5. Run synthesizer ─────────────────────────────────────────────────
    await runSessionViaGate(ctx, synthSpec);

    return { status: 'completed' };
  };
}
