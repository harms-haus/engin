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
   * Once true, {@link scheduleReap} executes its callback synchronously
   * instead of arming a `setTimeout`. Armed by {@link beginShutdown} at the
   * start of {@link RunManager.shutdownAll} so the executor's finally-block
   * reap (which runs AFTER `cancelAllReap`) cannot re-arm a deferred timer
   * that survives shutdown.
   */
  private shutdown = false;

  /**
   * Mark the registry as shutting down. Subsequent {@link scheduleReap}
   * calls execute their callback immediately rather than scheduling a timer,
   * closing the shutdown reap race. Idempotent.
   */
  beginShutdown(): void {
    this.shutdown = true;
  }

  /**
   * Tracked pending reap timers, keyed by runId. Every timer armed by
   * {@link scheduleReap} is recorded here so it can be cancelled via
   * {@link cancelReap} / {@link cancelAllReap} — preventing the recursive
   * `setTimeout` chain from rescheduling itself after the run is removed or
   * the registry is shut down.
   */
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  /**
   * Remove a handle from the registry AND cancel any pending reap timer for
   * it. No-op for an unknown runId. Cancelling the timer here is what closes
   * the recursive `setTimeout` leak: without it, a removed run's reaper would
   * keep rescheduling itself even though the handle is gone.
   */
  remove(runId: string): void {
    this.cancelReap(runId);
    this.runs.delete(runId);
  }

  /**
   * Schedule a reaper timer that fires `onReap` after `delayMs`, but ONLY when
   * the run is still registered, no longer `'running'`, AND has no active
   * subscribers.
   *
   * The reaper guards protect against:
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
    // Shutdown mode: execute the reap callback immediately so the
    // finally-block re-arm (which runs AFTER cancelAllReap during
    // shutdownAll) cannot leak a deferred timer past teardown.
    if (this.shutdown) {
      onReap();
      return;
    }
    // Re-arming replaces any previous timer for this runId so we never hold
    // two dangling timers for the same run.
    this.cancelReap(runId);
    const tick = (): void => {
      const handle = this.runs.get(runId);
      // Only reap when the handle is still present and has left 'running'.
      if (!handle || handle.status === 'running') {
        this.reapTimers.delete(runId);
        return;
      }
      // Defer while clients are subscribed (inspection pause / merge in flight)
      // so the final-merge result broadcast can be delivered. Reschedule on
      // the same cadence and re-check; the handle reaps once the last
      // subscriber disconnects. Track the new timer so cancelReap / remove
      // can still clear it.
      if (handle.subscribers.size > 0) {
        this.reapTimers.set(runId, setTimeout(tick, delayMs));
        return;
      }
      this.reapTimers.delete(runId);
      onReap();
    };
    this.reapTimers.set(runId, setTimeout(tick, delayMs));
  }

  /**
   * Cancel a pending reap timer for a single runId. No-op if no timer is
   * armed for that runId (including unknown runIds).
   */
  cancelReap(runId: string): void {
    const timer = this.reapTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.reapTimers.delete(runId);
    }
  }

  /**
   * Cancel every pending reap timer across all runIds. Used during graceful
   * shutdown to ensure no reaper survives the registry.
   */
  cancelAllReap(): void {
    for (const timer of this.reapTimers.values()) clearTimeout(timer);
    this.reapTimers.clear();
  }
}
