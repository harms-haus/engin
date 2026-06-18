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
   * the run is still registered AND no longer `'running'`.
   *
   * This encapsulates the reaper guard that was previously inlined in
   * RunManager.executeWorkflow's finally block
   * (`if (handle.status !== 'running') { ... }`). The two guards protect
   * against:
   *   1. reaping a run that resumed into a second execution (status back to
   *      `'running'`), and
   *   2. firing after an explicit shutdown removed the handle before the timer
   *      elapsed.
   *
   * No-op for an unknown runId (never reaps, does not throw).
   *
   * @param runId    The run to reap.
   * @param delayMs  Delay before the reaper fires (passed through to setTimeout).
   * @param onReap   Invoked when the run is registered and terminal.
   */
  scheduleReap(runId: string, delayMs: number, onReap: () => void): void {
    setTimeout(() => {
      const handle = this.runs.get(runId);
      // Only reap when the handle is still present and has left 'running'.
      if (!handle || handle.status === 'running') return;
      onReap();
    }, delayMs);
  }
}
