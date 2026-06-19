// ─── Lane Pool ──────────────────────────────────────────────────────────────
import { clearProfileCache, loadProfilesFromDirs } from '../core/profile.js';
import type { AgentProfile, Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import { TaskTracker } from '../tracking/task-status.js';
// buildPrompt is used via prompt-builder module directly
import { linearStepsRunner } from './linear-steps-runner.js';
import { clearTaskSessions } from './step-execution.js';
import type { TaskProcessorContext } from './task-processor.js';
import { reportError, safeCompleteTask, safeFailTask } from './task-processor.js';
import type { LanePoolOptions, LanePoolResult, TaskOutcome, TaskRunner, TaskRunnerContext } from './types.js';

// ─── LanePool ───────────────────────────────────────────────────────────────

/**
 * Concurrent task processing pool where N "lanes" (workers) independently
 * claim tasks from a shared {@link TaskTracker} and process them through
 * configurable sequential steps.
 *
 * Each lane runs an async loop that:
 * 1. Claims a ready task from the tracker.
 * 2. Executes the ordered list of steps for that task.
 * 3. On step rejection, backs up to the previous step and retries
 *    (up to `maxStepRetries` per step).
 * 4. On completion or failure, marks the task accordingly.
 */
export class LanePool {
  private readonly options: LanePoolOptions;
  /** Active sessions that may be mid-prompt; aborted on SIGINT for faster shutdown. */
  private readonly activeSessions = new Set<{ abort(): Promise<void> }>();
  /** Per-task count of same-run retries already consumed (keyed by task id). */
  private readonly taskRetries = new Map<string, number>();

  constructor(options: LanePoolOptions) {
    this.options = options;
  }

  // ── Runner Resolution ──────────────────────────────────────────────────

  /**
   * Resolve a TaskRunner for the given task.
   *
   * Priority:
   * 1. If `getRunnerForTask` is provided, use it.
   * 2. Otherwise, if `getStepsForTask` is provided, wrap it in `linearStepsRunner`.
   * 3. Otherwise, throw.
   */
  private resolveRunner(task: Task): TaskRunner {
    if (this.options.getRunnerForTask) {
      return this.options.getRunnerForTask(task);
    }
    if (this.options.getStepsForTask) {
      return linearStepsRunner(this.options.getStepsForTask(task));
    }
    throw new Error(`No runner or steps provided for task "${task.id}"`);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Run the pool: spawn `maxConcurrentLanes` workers and wait for all tasks
   * to complete or fail.
   */
  async run(): Promise<LanePoolResult> {
    const { maxConcurrentLanes, taskTracker } = this.options;

    // Check for cancellation before doing any work
    if (this.options.signal?.aborted) {
      return { completedTasks: 0, failedTasks: 0 };
    }

    // Skip profile loading when there's no work
    if (taskTracker.getAllTasks().length === 0) {
      return { completedTasks: 0, failedTasks: 0 };
    }

    // Fire onTaskRegister once per task so the TUI gets the initial task layout
    // with phaseId and step definitions before any profile loading or agent spawning.
    for (const task of taskTracker.getAllTasks()) {
      const steps =
        this.options.getStepsForTask?.(task)?.map((s) => ({
          name: s.name,
          profileId: s.profileId,
          isReadOnly: s.isReadOnly,
        })) ?? [];
      this.options.onStatus?.onTaskRegister?.({
        taskId: task.id,
        phaseId: this.options.phaseId,
        title: task.title,
        dependencies: task.dependencies,
        steps,
      });
    }

    // Clear stale cached profiles before loading fresh ones
    clearProfileCache();
    const profiles = await loadProfilesFromDirs(this.options.profilesDirs);

    // When the abort signal fires, abort all active sessions so in-progress
    // LLM calls are cancelled immediately instead of running to completion.
    const abortActiveSessions = () => {
      for (const s of this.activeSessions) {
        s.abort().catch(() => {
          /* swallow — we're shutting down */
        });
      }
    };
    this.options.signal?.addEventListener('abort', abortActiveSessions, { once: true });

    try {
      const laneRunners = Array.from({ length: maxConcurrentLanes }, (_, i) => this.runLane(i, profiles));
      const settled = await Promise.allSettled(laneRunners);

      // Log any lane that threw an uncaught error
      settled.forEach((result, index) => {
        if (result.status === 'rejected') {
          const agentId = `lane-${index}`;
          const error = safeErrorMessage(result.reason);
          reportError(agentId, error, undefined, undefined, {
            options: this.options,
            activeSessions: this.activeSessions,
            phaseId: this.options.phaseId,
          });
        }
      });

      // Count results from the tracker by status
      const allTasks = taskTracker.getAllTasks();
      const completedTasks = allTasks.filter((t) => t.status === 'complete').length;
      const failedTasks = allTasks.filter((t) => t.status === 'failed').length;

      return { completedTasks, failedTasks };
    } finally {
      this.options.signal?.removeEventListener('abort', abortActiveSessions);
    }
  }

  /**
   * If the task that just ran ended up `failed`, cull its worktree (when a
   * `worktreeManager` is configured), and — if its retry budget is not
   * exhausted — clear its persisted sessions, reset it to `ready`, and announce
   * the retry. The lane loop (or a sibling lane) will then re-claim and re-run
   * it from step 1.
   *
   * The worktree is culled in BOTH the retry and permanent-failure paths:
   *   • retry — so the next attempt starts from a fresh worktree (the
   *     `createTaskWorktree` call in `runLane` re-creates it on the next claim).
   *   • permanent failure — so the failed branch is force-removed rather than
   *     left dangling for the user to clean up manually.
   *
   * No-op (aside from pruning a stale `taskRetries` entry) when the task did
   * not end up `failed`, or when `maxTaskRetries` is unset/`0` AND no
   * worktreeManager is configured.
   */
  private async maybeRetryFailedTask(task: Task, agentId: string, reason?: string): Promise<void> {
    const current = this.options.taskTracker.getTask(task.id);
    if (!current || current.status !== 'failed') {
      // Task didn't fail (e.g. completed, cancelled, or already settled by a
      // sibling lane). Prune any stale retry counter and bail out — there is
      // nothing to cull or retry.
      this.taskRetries.delete(task.id);
      return;
    }

    // The task is `failed`. Cull its worktree (force-remove + delete branch)
    // whether we're about to retry or permanently give up, so the failed
    // branch never leaks. cullTaskWorktree is idempotent and best-effort.
    if (this.options.worktreeManager) {
      try {
        await this.options.worktreeManager.cullTaskWorktree(task.id);
      } catch (err) {
        console.warn(`[${agentId}] Failed to cull worktree for task ${task.id}: ${safeErrorMessage(err)}`);
      }
    }

    const max = this.options.maxTaskRetries ?? 0;
    if (max <= 0) {
      // No retries configured — permanent failure. Prune the counter and stop.
      this.taskRetries.delete(task.id);
      return;
    }

    const used = this.taskRetries.get(task.id) ?? 0;
    if (used >= max) {
      // Retry budget exhausted — permanent failure. Prune the counter and stop.
      this.taskRetries.delete(task.id);
      return;
    }

    this.taskRetries.set(task.id, used + 1);
    const attempt = used + 2; // human-readable: the initial run is attempt #1
    try {
      clearTaskSessions(this.options.sessionBaseDir, task.id);
    } catch (err) {
      console.warn(`[${agentId}] Failed to clear sessions for task ${task.id}: ${safeErrorMessage(err)}`);
    }
    this.options.taskTracker.resetTaskForRetry(task.id);
    this.options.onStatus?.onDecision?.({
      agentId,
      decision: `Retrying failed task "${task.id}" (attempt ${attempt}/${max + 1})`,
      reasoning: reason ?? 'task failed',
      taskId: task.id,
    });
  }

  // ── Lane Runner ─────────────────────────────────────────────────────────

  /**
   * Single lane (worker) loop. Continuously claims and processes tasks until
   * all tasks are done.
   */
  private async runLane(laneIndex: number, profiles: Map<string, AgentProfile>): Promise<void> {
    const { taskTracker } = this.options;
    const agentId = `lane-${laneIndex}`;
    const waitTimeoutMs = this.options.laneWaitTimeoutMs ?? 60000;
    const STALL_WARN_THRESHOLD = 5;
    let consecutiveTimeouts = 0;
    let stallWarned = false; // Rate-limit the stall warning to once per lane

    // ── Persistent wake listeners (registered ONCE per lane) ─────────────
    // Each lane installs a single persistent listener for TaskReady,
    // TaskSettled, and the abort signal at the start of runLane, rather than
    // re-registering per-iteration once() listeners (which leaked and churned
    // O(tasks) registrations). `resolveWake` is rebound each loop iteration to
    // that iteration's wake resolver, so a persistent listener always wakes the
    // CURRENT await. All three listeners are removed in the `finally` below,
    // guaranteeing zero leaks after the lane exits.
    // `resolveWake` is rebound each loop iteration to that iteration's wake
    // resolver (see below). It is `undefined` only before the first rebind —
    // a wake in that window is a safe no-op (abort is still caught by the
    // loop-top `signal?.aborted` check).
    let resolveWake: (() => void) | undefined;
    const onWake = () => resolveWake?.();
    const onAbort = () => resolveWake?.();
    taskTracker.on(TaskTracker.Events.TaskReady, onWake);
    taskTracker.on(TaskTracker.Events.TaskSettled, onWake);
    this.options.signal?.addEventListener('abort', onAbort);

    // Hoisted so the `finally` can clear a pending stall timer if the lane
    // exits mid-iteration (e.g. on abort during task processing).
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      while (true) {
        if (this.options.signal?.aborted) {
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
        // This must precede claimTasks so a completed task is never re-armed
        // (e.g. by a spy in tests). isPoolDone returns true only when every
        // task is settled (done/failed) or deadlocked — never when any task
        // is ready, claimed, or in-flight.
        if (taskTracker.isPoolDone()) {
          clearTimeout(timer);
          pendingTimer = undefined;
          return;
        }

        const claimed = taskTracker.claimTasks(1, agentId);

        if (claimed.length > 0) {
          clearTimeout(timer);
          pendingTimer = undefined;
          consecutiveTimeouts = 0; // Reset stall counter on successful claim
          const task = claimed[0];

          // Fire onTaskStart BEFORE calling the runner
          this.options.onStatus?.onTaskStart?.({
            taskId: task.id,
            title: task.title,
            agentId,
            phaseId: this.options.phaseId,
            startedAt: Date.now(),
          });

          const processorCtx: TaskProcessorContext = {
            options: this.options,
            activeSessions: this.activeSessions,
            phaseId: this.options.phaseId,
          };

          let failureReason: string | undefined;
          try {
            const runner = this.resolveRunner(task);

            // ── Per-task worktree setup ──────────────────────────────────
            // When a worktreeManager is configured, claim a fresh per-task
            // worktree BEFORE calling the runner so the agent's `cwd` (and
            // every spawned session) operates inside the isolated branch.
            //
            // If the worktree is created successfully, the runner's
            // `completeTask` is DEFERRED: rather than settling the task in
            // the tracker immediately, the result is captured and the task is
            // settled only AFTER `mergeTaskBranch` runs. This lets a failed
            // merge downgrade the outcome to `failed` before the task is
            // marked `complete` in the tracker (a transition the tracker
            // itself forbids).
            //
            // If worktree creation throws, the agent falls back to the
            // configured `cwd` and the existing (immediate-settle) path runs.
            const useWorktree = !!this.options.worktreeManager;
            let worktreeCreated = false;
            let deferredResult: unknown;
            let deferredCompletion = false;

            const runnerCtx: TaskRunnerContext = {
              task,
              agentId,
              profiles,
              onStatus: this.options.onStatus,
              activeSessions: this.activeSessions,
              phaseId: this.options.phaseId,
              sessionBaseDir: this.options.sessionBaseDir,
              cwd: this.options.cwd,
              apiKeys: this.options.apiKeys,
              maxStepRetries: this.options.maxStepRetries ?? 5,
              rendererRegistry: this.options.rendererRegistry,
              signal: this.options.signal,
              worktreeManager: this.options.worktreeManager,
              // In worktree mode, defer settlement until after merge so a
              // failed merge can flip the outcome to `failed`. The closure
              // reads `worktreeCreated` at call time — which is set BEFORE
              // the runner is invoked below — so the deferred path is taken
              // only when the worktree was actually created.
              completeTask: (result?: unknown) => {
                if (worktreeCreated) {
                  deferredResult = result;
                  deferredCompletion = true;
                  return true;
                }
                return safeCompleteTask(task.id, result, processorCtx);
              },
              failTask: (result?: unknown) => safeFailTask(task.id, result ?? { completed: false }, processorCtx),
            };

            const worktreeManager = this.options.worktreeManager;
            if (useWorktree && worktreeManager) {
              try {
                const taskWorktreePath = await worktreeManager.createTaskWorktree(task.id, task.prompt);
                // Override cwd to the worktree path so every spawned session
                // runs inside the isolated branch.
                runnerCtx.cwd = taskWorktreePath;
                worktreeCreated = true;
              } catch (err) {
                // Fall back to the configured cwd; the task still runs.
                console.warn(`[${agentId}] Failed to create worktree for task ${task.id}: ${safeErrorMessage(err)}`);
              }
            }

            let outcome: TaskOutcome = await runner(runnerCtx);

            // ── Merge on success (worktree mode only) ──────────────────
            // After the runner reports `completed`, squash-merge the task
            // branch into the main-wt branch. If the merge fails (conflicts
            // the agent couldn't resolve, or an unexpected throw), the task
            // is settled as `failed` instead of `completed`.
            if (outcome.status === 'completed' && worktreeCreated && worktreeManager) {
              let mergeSucceeded = true;
              let mergeError: string | undefined;
              try {
                const mergeResult = await worktreeManager.mergeTaskBranch(task.id);
                mergeSucceeded = mergeResult.success;
                if (!mergeSucceeded) {
                  mergeError = 'Worktree merge failed';
                }
              } catch (err) {
                mergeSucceeded = false;
                mergeError = safeErrorMessage(err);
              }

              if (mergeSucceeded) {
                // Merge succeeded — now settle the task as completed using
                // the deferred result the runner supplied via completeTask.
                // Only settle if the runner actually called completeTask;
                // otherwise the task is left in its current (non-complete)
                // state, matching the non-worktree behavior for a runner that
                // returns `completed` without settling.
                if (deferredCompletion) {
                  safeCompleteTask(task.id, deferredResult, processorCtx);
                }
              } else {
                // Merge failed — settle as failed so the task is NOT
                // reported as complete. safeFailTask works here because the
                // task was never actually settled in the deferred path.
                const reason = mergeError ?? 'Merge failed';
                safeFailTask(task.id, { completed: false, error: reason }, processorCtx);
                outcome = { status: 'failed', error: reason };
                failureReason = reason;
              }
            }

            if (outcome.status === 'completed') {
              this.options.onStatus?.onTaskComplete?.({ taskId: task.id, title: task.title });
            } else {
              failureReason = outcome.feedback ?? outcome.error;
              if (outcome.feedback) {
                this.options.onStatus?.onTaskRejected?.({
                  taskId: task.id,
                  title: task.title,
                  reason: outcome.feedback,
                });
              } else if (outcome.error) {
                // Runner returned a failed outcome with an error message; report it
                reportError(agentId, outcome.error, undefined, task.id, processorCtx);
              }
            }
          } catch (err) {
            const error = safeErrorMessage(err);
            failureReason = error;
            reportError(agentId, error, undefined, task.id, processorCtx);
            safeFailTask(task.id, { completed: false, error: true }, processorCtx);
          }

          // ── Same-run retry: if the task just failed and its budget isn't ──
          // exhausted, cull its worktree (if any), clear its persisted sessions,
          // and reset it to `ready` so a lane re-claims it and restarts from
          // step 1. Capped at `maxTaskRetries` extra attempts to avoid
          // infinite loops. The worktree is also culled on permanent failure
          // (budget exhausted) so the failed branch is force-removed.
          await this.maybeRetryFailedTask(task, agentId, failureReason);
          continue;
        }

        // No task available — wait for an event, timeout, or abort
        await wakePromise;
        pendingTimer = undefined;

        // Only a stall-timeout (no event, no claim) advances the stall
        // counter; a real wake leaves it untouched. The counter resets on the
        // next successful claim. (Matches prior semantics.)
        if (timedOut) {
          consecutiveTimeouts++;
          if (consecutiveTimeouts >= STALL_WARN_THRESHOLD && !stallWarned) {
            console.warn(
              `[${agentId}] Lane appears stalled — no task progress for ` +
                `${consecutiveTimeouts * waitTimeoutMs}ms. Tasks may be stuck.`,
            );
            stallWarned = true; // Warn at most once per lane
          }
        }
      }
    } finally {
      if (pendingTimer) clearTimeout(pendingTimer);
      taskTracker.removeListener(TaskTracker.Events.TaskReady, onWake);
      taskTracker.removeListener(TaskTracker.Events.TaskSettled, onWake);
      this.options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
