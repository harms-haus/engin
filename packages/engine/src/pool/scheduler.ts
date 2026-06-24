// ─── Scheduler — the reusable core of LanePool.runLane ──────────────────────
//
// Extracted from LanePool (§10 step 6 of the LanePool decomposition). Owns
// ONLY the genuinely reusable lane-scheduling core:
//
//   - Spawning N lanes (workers) via Promise.allSettled.
//   - Each lane's claim → run → settle loop.
//   - Wake semantics (TaskReady / TaskSettled listeners + timeout + abort).
//   - `claimPolicy` first-wins hook (replaces the default claimTasks(1, laneId)).
//   - `concurrencyKey` first-wins hook (per-key concurrency limits).
//   - `onLaneStall` observe hook (replaces the hardcoded console.warn stall
//     warning).
//
// What the Scheduler does NOT own (stays in LanePool or the caller):
//   - Lifecycle firing (onTaskRegister/Start/Complete/Rejected) — the caller's
//     `runTask` callback handles this. The Scheduler simply calls `runTask`.
//   - Retry budgeting (maybeRetryFailedTask) — stays in LanePool / caller.
//   - Runner resolution (getRunnerForTask / getStepsForTask) — already a hook.
//   - Profile loading — stays in LanePool.
//
// The caller-provided `runTask` is responsible for SETTLING the task in the
// tracker (completeTask / failTask), exactly as the existing TaskRunner does
// via TaskRunnerContext.completeTask / failTask. The Scheduler observes the
// settled state through isPoolDone() / claimTasks() and never settles a task
// itself except in two narrow situations:
//
//   1. The ready → active transition when a `claimPolicy` hook supplies the
//      claimed task (mirroring claimTasks's internal mutation).
//   2. Settling a task to 'failed' in the orphan-prevention catch when
//      getConcurrencyKey, acquireKey, or runTask throws AFTER the task was
//      claimed (marked 'active'). Without this, the orphaned 'active' task
//      would prevent isPoolDone() from ever returning true, hanging the
//      pool forever — strictly worse than the contract deviation. See the
//      'CONTRACT DEVIATION' comment in runLane.

import type { Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import type { HookContext, HookRegistry, OnLaneStallArgs } from '../hooks/types.js';
import { TaskTracker } from '../tracking/task-status.js';

// ── Options / result ───────────────────────────────────────────────────────

/**
 * Options for constructing a {@link Scheduler}.
 *
 * `runTask` is the caller-supplied task runner. It is invoked as
 * `runTask(task, laneId)` after a lane claims a task and (optionally) acquires
 * its concurrency key. The callback OWNS settling the task in the tracker
 * (`completeTask` / `failTask`); the Scheduler only observes the resulting
 * status via `isPoolDone()` / `claimTasks()`, except in two narrow situations:
 * (1) the ready → active status change the Scheduler applies when a
 * `claimPolicy` hook returns a task (mirroring `claimTasks`'s internal
 * mutation), and (2) the orphan-prevention path where the Scheduler settles a
 * claimed task to `'failed'` when getConcurrencyKey / acquireKey / runTask
 * throws (see the 'CONTRACT DEVIATION' comment in runLane).
 *
 * `onLaneError` is an optional lane-crash observability callback. The
 * Scheduler spawns lanes via `Promise.allSettled` so one crashed lane does
 * NOT abort the others; rejections are therefore swallowed internally.
 * Callers that need to observe lane-level crashes (e.g. LanePool's legacy
 * `reportError` logging) pass an `onLaneError` callback, invoked once per
 * rejected lane after all lanes have settled.
 */
export interface SchedulerOptions {
  /** Maximum number of concurrent lanes (workers). */
  maxConcurrentLanes: number;
  /** Shared task tracker — lanes claim tasks from here. */
  taskTracker: TaskTracker;
  /** Optional registry of workflow hooks (`claimPolicy`, `concurrencyKey`,
   *  `onLaneStall`). When absent, the Scheduler uses its built-in defaults. */
  hookRegistry?: HookRegistry;
  /** Abort signal for cooperative cancellation. */
  signal?: AbortSignal;
  /** Maximum time (ms) a lane waits for new work before polling again.
   *  Default: 60000. */
  laneWaitTimeoutMs?: number;
  /** Caller-provided task runner. Responsible for SETTLING the task in the
   *  tracker (completeTask / failTask). */
  runTask: (task: Task, laneId: string) => Promise<void>;
  /** Optional callback invoked once per lane that rejected with an uncaught
   *  error. The Scheduler silently swallows lane rejections (via
   *  `Promise.allSettled`) so one crashed lane does not abort the others;
   *  this callback is the only way for callers to observe lane-level
   *  crashes. */
  onLaneError?: (laneId: string, error: unknown) => void;
}

/**
 * Aggregate result from {@link Scheduler.run}. The counts are derived from the
 * tracker's settled statuses after every lane has exited.
 */
export interface SchedulerResult {
  completedTasks: number;
  failedTasks: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Default lane wait timeout (ms) — reproduces the historical LanePool default
 * of 60s when `SchedulerOptions.laneWaitTimeoutMs` is omitted.
 */
const DEFAULT_LANE_WAIT_TIMEOUT_MS = 60_000;

/**
 * Consecutive stall timeouts required before the `onLaneStall` hook (or the
 * fallback `console.warn`) fires. Mirrors the historical LanePool
 * `STALL_WARN_THRESHOLD` of 5.
 */
const STALL_WARN_THRESHOLD = 5;

// ── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Reusable scheduler core: spawns N lanes (workers) that independently claim
 * tasks from a shared {@link TaskTracker} and process them through a
 * caller-provided `runTask` callback.
 *
 * The Scheduler owns ONLY the lane loop, claim semantics, wake/sleep
 * behaviour, and the `claimPolicy` / `concurrencyKey` / `onLaneStall` hooks.
 * Lifecycle firing, retry budgeting, runner resolution, and profile loading
 * stay with the caller — the Scheduler simply calls `runTask(task, laneId)`
 * for every claimed task.
 *
 * Lanes are identified by `lane-${index}` (matching the LanePool convention),
 * surfaced to the caller as the `laneId` argument to `runTask`.
 */
export class Scheduler {
  private readonly options: SchedulerOptions;
  /** In-flight task count per concurrency key (undefined key = unlimited). */
  private readonly inFlightByKey = new Map<string, number>();
  /** FIFO queue of waiters blocked on a concurrency-key slot. */
  private readonly waitersByKey = new Map<string, (() => void)[]>();

  constructor(options: SchedulerOptions) {
    this.options = options;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Spawn `maxConcurrentLanes` workers and wait for all tasks to settle (or
   * the abort signal to fire). Returns the count of completed and failed
   * tasks derived from the tracker's settled statuses.
   *
   * Returns `{ completedTasks: 0, failedTasks: 0 }` immediately (without
   * spawning any lanes) when the abort signal is already aborted or the
   * tracker has no tasks.
   */
  async run(): Promise<SchedulerResult> {
    const { maxConcurrentLanes, taskTracker, signal } = this.options;

    // Check for cancellation before doing any work.
    if (signal?.aborted) {
      return { completedTasks: 0, failedTasks: 0 };
    }

    // Skip lane spawning when there's no work.
    if (taskTracker.getAllTasks().length === 0) {
      return { completedTasks: 0, failedTasks: 0 };
    }

    const laneRunners = Array.from({ length: maxConcurrentLanes }, (_, i) => this.runLane(i));
    const settled = await Promise.allSettled(laneRunners);

    // Surface any lane that rejected with an uncaught error via the optional
    // `onLaneError` callback. The Scheduler itself swallows rejections (one
    // crashed lane must NOT abort the others), so callers that need
    // lane-crash observability pass a callback here.
    const onLaneError = this.options.onLaneError;
    if (onLaneError) {
      settled.forEach((result, index) => {
        if (result.status === 'rejected') {
          onLaneError(`lane-${index}`, result.reason);
        }
      });
    }

    // Count results from the tracker by status.
    // Single pass over the task list (avoids two `.filter()` allocations +
    // two full iterations of the snapshot returned by getAllTasks()).
    let completedTasks = 0;
    let failedTasks = 0;
    for (const t of taskTracker.getAllTasks()) {
      if (t.status === 'complete') completedTasks++;
      else if (t.status === 'failed') failedTasks++;
    }

    return { completedTasks, failedTasks };
  }

  // ── Lane Runner ────────────────────────────────────────────────────────

  /**
   * Single lane (worker) loop. Continuously claims and processes tasks until
   * all tasks are settled, the lane stalls past the threshold, or the abort
   * signal fires.
   *
   * Wake semantics: a single persistent listener is registered ONCE per lane
   * for `TaskReady`, `TaskSettled`, and the abort signal. `resolveWake` is
   * rebound each loop iteration to that iteration's wake resolver, so a
   * persistent listener always wakes the CURRENT await. All three listeners
   * are removed in the `finally`, guaranteeing zero leaks after the lane
   * exits.
   */
  private async runLane(laneIndex: number): Promise<void> {
    const { taskTracker, signal } = this.options;
    const laneId = `lane-${laneIndex}`;
    const waitTimeoutMs = this.options.laneWaitTimeoutMs ?? DEFAULT_LANE_WAIT_TIMEOUT_MS;
    let consecutiveTimeouts = 0;
    let stallWarned = false; // Rate-limit the stall warning to once per lane

    // ── Persistent wake listeners (registered ONCE per lane) ─────────────
    let resolveWake: (() => void) | undefined;
    const onWake = () => resolveWake?.();
    const onAbort = () => resolveWake?.();
    taskTracker.on(TaskTracker.Events.TaskReady, onWake);
    taskTracker.on(TaskTracker.Events.TaskSettled, onWake);
    signal?.addEventListener('abort', onAbort);

    // Hoisted so the `finally` can clear a pending stall timer if the lane
    // exits mid-iteration (e.g. on abort during task processing).
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      while (true) {
        if (signal?.aborted) {
          return;
        }

        // ── Per-iteration wake promise + stall timer ────────────────────
        // Wire `resolveWake` to THIS iteration's resolver BEFORE the
        // isPoolDone/claimTasks check to close the TOCTOU gap: any
        // TaskReady/TaskSettled/abort event fired during the check resolves
        // the promise we'll await if no task is claimed.
        let wakeResolve!: () => void;
        const wakePromise = new Promise<void>((resolve) => {
          wakeResolve = resolve;
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          wakeResolve();
        }, waitTimeoutMs);
        pendingTimer = timer;
        resolveWake = () => {
          clearTimeout(timer);
          wakeResolve();
        };

        // ── Check for pool completion BEFORE claiming ────────────────────
        if (taskTracker.isPoolDone()) {
          clearTimeout(timer);
          pendingTimer = undefined;
          return;
        }

        const claimed = await this.claimNextTask(laneId);

        if (claimed.length > 0) {
          clearTimeout(timer);
          pendingTimer = undefined;
          consecutiveTimeouts = 0; // Reset stall counter on successful claim
          const task = claimed[0];

          // ── Per-key concurrency gating ────────────────────────────────
          // Tasks sharing a concurrency key serialize (max one in-flight per
          // key). When no key is configured (default), this is a no-op and
          // the task runs immediately.
          //
          // CONTRACT DEVIATION: The Scheduler normally never settles tasks —
          // the caller's runTask owns that. But if getConcurrencyKey or
          // acquireKey throws AFTER the task was claimed (marked 'active'),
          // the task would be orphaned: 'active' with no lane owning it,
          // isPoolDone() never true, and the pool hangs forever. An orphaned
          // active task is strictly worse than a contract deviation, so we
          // settle the task to 'failed' in the catch before re-throwing.
          let release: (() => void) | undefined;
          try {
            const key = await this.getConcurrencyKey(task);
            release = await this.acquireKey(key);
            if (signal?.aborted) {
              return;
            } // finally handles release
            await this.options.runTask(task, laneId);
          } catch (err) {
            // Settle the orphaned active task to 'failed' so isPoolDone()
            // returns true and the pool does not hang forever. Guard with
            // try/catch because the task may already be settled (e.g. the
            // caller's runTask caught and failed it before re-throwing).
            try {
              taskTracker.failTask(task.id, { completed: false, error: safeErrorMessage(err) });
            } catch {
              /* already settled by a sibling lane — swallow */
            }
            throw err; // re-throw so the lane rejects (swallowed by allSettled)
          } finally {
            // Exactly-once release: release() iff acquireKey succeeded;
            // no-op when getConcurrencyKey/acquireKey threw first.
            release?.();
          }
          continue;
        }

        // No task available — wait for an event, timeout, or abort.
        await wakePromise;
        pendingTimer = undefined;

        // Only a stall-timeout (no event, no claim) advances the stall
        // counter; a real wake leaves it untouched. The counter resets on the
        // next successful claim.
        if (timedOut) {
          consecutiveTimeouts++;
          if (consecutiveTimeouts >= STALL_WARN_THRESHOLD && !stallWarned) {
            await this.fireOnLaneStall(laneId, consecutiveTimeouts, STALL_WARN_THRESHOLD, waitTimeoutMs);
            stallWarned = true; // Warn at most once per lane
          }
        }
      }
    } finally {
      if (pendingTimer) clearTimeout(pendingTimer);
      taskTracker.removeListener(TaskTracker.Events.TaskReady, onWake);
      taskTracker.removeListener(TaskTracker.Events.TaskSettled, onWake);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // ── Claim (hook-aware) ──────────────────────────────────────────────────

  /**
   * Claim the next task for `laneId`. When a `claimPolicy` first-wins
   * subscriber is registered and returns a non-empty `Task[]`, those tasks
   * are used directly (the hook DECIDES which tasks to claim; the Scheduler
   * still owns the ready → active transition). Otherwise the default
   * `claimTasks(1, laneId)` path runs.
   */
  private async claimNextTask(laneId: string): Promise<Task[]> {
    const { taskTracker, hookRegistry } = this.options;

    if (hookRegistry?.hasSubscribers('claimPolicy')) {
      const result = await hookRegistry.invokeFirstWins(
        'claimPolicy',
        { tracker: taskTracker, laneId, maxClaim: 1 },
        this.makeHookContext(),
      );
      if (Array.isArray(result) && result.length > 0) {
        // The lane loop processes exactly one task per claim cycle. Only the
        // first selected task is claimed (marked active); extras the hook
        // returned are left 'ready' (NOT marked active) and a warning is
        // emitted so the divergence is observable. Batch claiming is not
        // supported — see claimPolicy docstring in hooks/types.ts.
        if (result.length > 1) {
          console.warn(
            `[Scheduler] claimPolicy returned ${result.length} tasks but only one is claimed per cycle; extras remain ready.`,
          );
        }
        const claimed = result[0];
        claimed.status = 'active';
        claimed.assignedAgent = laneId;
        return [claimed];
      }
    }

    return taskTracker.claimTasks(1, laneId);
  }

  // ── Concurrency key (hook-aware) ────────────────────────────────────────

  /**
   * Resolve the concurrency key for `task` via the `concurrencyKey`
   * first-wins hook. Returns `undefined` when no subscriber is registered or
   * every subscriber abstains (returning `undefined`) — meaning "no
   * concurrency limit" (the default).
   */
  private async getConcurrencyKey(task: Task): Promise<string | undefined> {
    const { hookRegistry } = this.options;
    if (!hookRegistry?.hasSubscribers('concurrencyKey')) return undefined;
    const result = await hookRegistry.invokeFirstWins('concurrencyKey', { task }, this.makeHookContext());
    return typeof result === 'string' ? result : undefined;
  }

  /**
   * Acquire the per-key concurrency slot. If `key` is `undefined`, no limit
   * applies and a no-op release is returned. Otherwise the caller blocks
   * until no other task with the same key is in-flight (max one in-flight
   * per key).
   *
   * The returned release function MUST be called exactly once.
   */
  private async acquireKey(key: string | undefined): Promise<() => void> {
    if (key === undefined) return () => undefined;

    // Fast path: the slot is free — take it synchronously.
    if ((this.inFlightByKey.get(key) ?? 0) === 0) {
      this.inFlightByKey.set(key, 1);
      return () => this.releaseKey(key);
    }

    // Slot occupied — wait until the holder passes it to us.
    await new Promise<void>((resolve) => {
      const waiters = this.waitersByKey.get(key) ?? [];
      waiters.push(resolve);
      this.waitersByKey.set(key, waiters);
    });

    // Woken by releaseKey "passing" the slot to us — take it.
    this.inFlightByKey.set(key, 1);
    return () => this.releaseKey(key);
  }

  /**
   * Release the per-key slot. If a waiter is queued, the slot is "passed"
   * directly to the next waiter (inFlight stays at 1) so a racing acquirer
   * cannot steal the slot between the release and the waiter waking.
   * Otherwise the slot is freed (decremented / deleted).
   */
  private releaseKey(key: string): void {
    const waiters = this.waitersByKey.get(key);
    if (waiters && waiters.length > 0) {
      const next = waiters.shift();
      if (next) next();
      // Drop the now-empty waiter list so waitersByKey doesn't accumulate
      // empty arrays across a run with many distinct concurrency keys.
      if (waiters.length === 0) this.waitersByKey.delete(key);
      return;
    }
    const current = this.inFlightByKey.get(key) ?? 1;
    if (current <= 1) {
      this.inFlightByKey.delete(key);
    } else {
      this.inFlightByKey.set(key, current - 1);
    }
  }

  // ── Observe hooks ───────────────────────────────────────────────────────

  /**
   * Fire the `onLaneStall` observe hook (replacing the legacy `console.warn`
   * stall warning). When no `onLaneStall` subscriber is registered, falls
   * back to `console.warn` with the historical message — preserving the
   * LanePool's prior behaviour for callers that supply no hook registry.
   */
  private async fireOnLaneStall(
    laneId: string,
    consecutiveTimeouts: number,
    threshold: number,
    waitTimeoutMs: number,
  ): Promise<void> {
    const { hookRegistry } = this.options;
    const args: OnLaneStallArgs = { laneId, consecutiveTimeouts, threshold };
    if (hookRegistry?.hasSubscribers('onLaneStall')) {
      await hookRegistry.invokeObserve('onLaneStall', args, this.makeHookContext());
      return;
    }
    console.warn(
      `[${laneId}] Lane appears stalled — no task progress for ` +
        `${consecutiveTimeouts * waitTimeoutMs}ms. Tasks may be stuck.`,
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Build the {@link HookContext} forwarded to every hook invocation. Carries
   * the registry (so hooks may invoke sub-hooks) and the abort signal. `cwd`
   * / `workDir` are not Scheduler-level concerns (the caller owns them), so
   * they are surfaced as empty strings; no shipped hook reads them.
   */
  private makeHookContext(): HookContext {
    return {
      registry: this.options.hookRegistry as HookRegistry,
      cwd: '',
      workDir: '',
      signal: this.options.signal,
    };
  }
}
