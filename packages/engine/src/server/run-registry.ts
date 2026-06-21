// ─── RunRegistry ────────────────────────────────────────────────────────────
//
// In-memory registry of active workflow run handles, extracted from RunManager
// (decomposition step). It owns the `Map<string, RunHandle>`: adding, removing,
// looking up, listing runs, supporting collision detection, and the reaper
// timer.
//
// `register` overwrites any previous handle for the same runId (this is what
// lets a resumed run replace its completed predecessor). The RunManager facade
// performs collision detection by inspecting `get(runId)?.status === 'running'`
// BEFORE calling register — so the registry must faithfully reflect the
// registered status.

import type { RunSummary } from '@engin/shared/protocol-types';

import type { RunHandle } from './run-manager.js';

/**
 * Owns the `Map<string, RunHandle>` for the control server's run lifecycle.
 *
 * Each run is identified by its `runId` (the work-directory basename). The
 * registry holds live {@link RunHandle} references so that mutations to a
 * handle's `status` / `summary` are observable through {@link listRuns} and
 * {@link get} without re-registration.
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunHandle>();

  /**
   * Store a handle keyed by its `runId`. Overwrites any previous handle for
   * the same runId — this is the mechanism that lets a resumed run replace its
   * completed predecessor.
   */
  register(handle: RunHandle): void {
    this.runs.set(handle.runId, handle);
  }

  /** Look up a handle by runId, or `undefined` if it is not registered. */
  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId);
  }

  /**
   * Return a {@link RunSummary} for every registered run. Because the registry
   * holds live handle references, the returned summaries reflect the current
   * status of each run (not a snapshot taken at registration time).
   */
  listRuns(): RunSummary[] {
    return Array.from(this.runs.values(), (h) => h.summary);
  }

  /**
   * Iterate over all registered handles (live references). Used by the
   * RunManager facade for operations that need the full handle — e.g.
   * disconnecting a WebSocket from every run's subscriber set, or shutting
   * down all runs (abort + flush + dispose).
   */
  values(): IterableIterator<RunHandle> {
    return this.runs.values();
  }

  /** Remove a handle from the registry. No-op for an unknown runId. */
  remove(runId: string): void {
    this.runs.delete(runId);
  }

  /**
   * Schedule a reaper timer that fires `onReap` after `delayMs`, but ONLY when
   * the run is still registered, no longer `'running'`, AND has no active
   * subscribers.
   *
   * This encapsulates the reaper guard that was previously inlined in
   * RunManager.executeWorkflow's finally block
   * (`if (handle.status !== 'running') { ... }`). The guards protect against:
   *   1. reaping a run that resumed into a second execution (status back to
   *      `'running'`),
   *   2. firing after an explicit shutdown removed the handle before the timer
   *      elapsed, and
   *   3. reaping a terminal run while a client is still subscribed.
   *
   * The subscriber guard (3) is what keeps the post-run worktree final-merge
   * flow working: the merge prompt runs on the CLIENT (after the TUI's
   * post-completion inspection pause) and round-trips a `worktree_action` +
   * `worktree_merge_result` through this handle's bridge. The merge itself can
   * take many seconds (an LLM generates the squash-commit message, and conflict
   * resolution may run), and the user may linger on the inspection screen for
   * minutes before answering. Reaping during that window would dispose the
   * bridge and drop the handle from the registry BEFORE the merge completes, so
   * the result broadcast is lost and the worktree is left unmerged. Deferring
   * while subscribers are present keeps the handle alive; it is reaped once the
   * last subscriber disconnects (a WS `close` triggers `unsubscribeAll`, which
   * removes the socket from every handle's subscriber set).
   *
   * No-op for an unknown runId (never reaps, does not throw).
   *
   * @param runId    The run to reap.
   * @param delayMs  Delay before each reaper check (passed through to
   *                 setTimeout). Re-checked on this cadence while subscribers
   *                 remain.
   * @param onReap   Invoked when the run is registered, terminal, and has no
   *                 subscribers.
   */
  scheduleReap(runId: string, delayMs: number, onReap: () => void): void {
    const tick = (): void => {
      const handle = this.runs.get(runId);
      // Only reap when the handle is still present and has left 'running'.
      if (!handle || handle.status === 'running') return;
      // Defer while clients are subscribed (inspection pause / merge in flight)
      // so the final-merge result broadcast can be delivered. Reschedule on
      // the same cadence and re-check; the handle reaps once the last
      // subscriber disconnects.
      if (handle.subscribers.size > 0) {
        setTimeout(tick, delayMs);
        return;
      }
      onReap();
    };
    setTimeout(tick, delayMs);
  }
}
