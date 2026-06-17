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
   * If the task that just ran ended up `failed` and its retry budget is not
   * exhausted, clear its persisted sessions, reset it to `ready`, and announce
   * the retry. The lane loop (or a sibling lane) will then re-claim and re-run
   * it from step 1.
   *
   * No-op when `maxTaskRetries` is unset/`0` (the historical behavior: failed
   * tasks stay failed).
   */
  private maybeRetryFailedTask(task: Task, agentId: string, reason?: string): void {
    const max = this.options.maxTaskRetries ?? 0;
    if (max <= 0) return;

    const current = this.options.taskTracker.getTask(task.id);
    if (!current || current.status !== 'failed') return;

    const used = this.taskRetries.get(task.id) ?? 0;
    if (used >= max) return;

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

    while (true) {
      if (this.options.signal?.aborted) {
        return;
      }

      // ── Register wait listeners FIRST to close the TOCTOU gap ──────────
      // Any TaskReady/TaskSettled event that fires during the subsequent
      // claimTasks/isPoolDone check is guaranteed to be caught.
      let resolveWait!: () => void;
      const wakePromise = new Promise<void>((resolve) => {
        resolveWait = resolve;
      });

      let cleanedUp = false;
      const onWake = () => {
        cleanup();
        resolveWait();
      };
      const onAbort = () => {
        cleanup();
        resolveWait();
      };
      const timer = setTimeout(() => {
        cleanup();
        consecutiveTimeouts++;
        if (consecutiveTimeouts >= STALL_WARN_THRESHOLD && !stallWarned) {
          console.warn(
            `[${agentId}] Lane appears stalled — no task progress for ` +
              `${consecutiveTimeouts * waitTimeoutMs}ms. Tasks may be stuck.`,
          );
          stallWarned = true; // Warn at most once per lane
        }
        resolveWait();
      }, waitTimeoutMs);
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(timer);
        taskTracker.removeListener(TaskTracker.Events.TaskReady, onWake);
        taskTracker.removeListener(TaskTracker.Events.TaskSettled, onWake);
        this.options.signal?.removeEventListener('abort', onAbort);
      };

      taskTracker.once(TaskTracker.Events.TaskReady, onWake);
      taskTracker.once(TaskTracker.Events.TaskSettled, onWake);
      this.options.signal?.addEventListener('abort', onAbort, { once: true });

      // ── Check for pool completion BEFORE claiming ──────────────────────
      // This must precede claimTasks so a completed task is never re-armed
      // (e.g. by a spy in tests). isPoolDone returns true only when every
      // task is settled (done/failed) or deadlocked — never when any task
      // is ready, claimed, or in-flight.
      if (taskTracker.isPoolDone()) {
        cleanup();
        return;
      }

      const claimed = taskTracker.claimTasks(1, agentId);

      if (claimed.length > 0) {
        cleanup();
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
            completeTask: (result?: unknown) => safeCompleteTask(task.id, result, processorCtx),
            failTask: (result?: unknown) => safeFailTask(task.id, result ?? { completed: false }, processorCtx),
          };

          const outcome: TaskOutcome = await runner(runnerCtx);
          if (outcome.status === 'completed') {
            this.options.onStatus?.onTaskComplete?.({ taskId: task.id, title: task.title });
          } else {
            failureReason = outcome.feedback ?? outcome.error;
            if (outcome.feedback) {
              this.options.onStatus?.onTaskRejected?.({ taskId: task.id, title: task.title, reason: outcome.feedback });
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
        // exhausted, clear its persisted sessions and reset it to `ready` so a
        // lane re-claims it and restarts from step 1. Capped at
        // `maxTaskRetries` extra attempts to avoid infinite loops.
        this.maybeRetryFailedTask(task, agentId, failureReason);
        continue;
      }

      // No task available — wait for an event, timeout, or abort
      await wakePromise;
    }
  }
}
