// ─── Lane Pool ──────────────────────────────────────────────────────────────
import { clearProfileCache, loadProfilesFromDirs } from '../core/profile.js';
import type { AgentProfile } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import { TaskTracker } from '../tracking/task-status.js';
// buildPrompt is used via prompt-builder module directly
import { appendAuditEvent, processTask, reportError, safeFailTask } from './task-processor.js';
import type { LanePoolOptions, LanePoolResult } from './types.js';

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

  constructor(options: LanePoolOptions) {
    this.options = options;
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

    // Fire onTasksAdded so the TUI gets the initial task layout immediately,
    // before any profile loading or agent spawning.
    this.options.onStatus?.onTasksAdded?.({
      tasks: taskTracker.getAllTasks().map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dependencies: t.dependencies,
      })),
    });

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
            phase: this.options.phase,
          });
          appendAuditEvent(
            { type: 'error', agentId, error },
            {
              options: this.options,
              activeSessions: this.activeSessions,
              phase: this.options.phase,
            },
          );
        }
      });

      // Count results from the tracker by status
      const allTasks = taskTracker.getAllTasks();
      const completedTasks = allTasks.filter((t) => t.status === 'done').length;
      const failedTasks = allTasks.filter((t) => t.status === 'failed').length;

      return { completedTasks, failedTasks };
    } finally {
      this.options.signal?.removeEventListener('abort', abortActiveSessions);
    }
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
        console.debug(`[${agentId}] Lane wait timeout after ${waitTimeoutMs}ms, retrying`);
        consecutiveTimeouts++;
        if (consecutiveTimeouts >= STALL_WARN_THRESHOLD) {
          console.warn(
            `[${agentId}] Lane appears stalled — no task progress for ` +
              `${consecutiveTimeouts * waitTimeoutMs}ms. Tasks may be stuck.`,
          );
          consecutiveTimeouts = 0; // Re-arm so warn doesn't spam every poll
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

      const claimed = taskTracker.claimTasks(1);

      if (claimed.length > 0) {
        cleanup();
        consecutiveTimeouts = 0; // Reset stall counter on successful claim
        const task = claimed[0];

        try {
          // startTask lives inside the try block so a tracker error is caught
          taskTracker.startTask(task.id, agentId);
          await processTask(task, agentId, profiles, {
            options: this.options,
            activeSessions: this.activeSessions,
            phase: this.options.phase,
          });
        } catch (err) {
          // Fire onError callback on task processing error
          const error = safeErrorMessage(err);
          reportError(agentId, error, undefined, task.id, {
            options: this.options,
            activeSessions: this.activeSessions,
            phase: this.options.phase,
          });
          // Error during task processing — mark as failed to prevent the lane
          // from getting stuck.
          safeFailTask(
            task.id,
            { completed: false, error: true },
            {
              options: this.options,
              activeSessions: this.activeSessions,
              phase: this.options.phase,
            },
          );

          // Audit log — error event
          appendAuditEvent(
            { type: 'error', agentId, error, taskId: task.id },
            {
              options: this.options,
              activeSessions: this.activeSessions,
              phase: this.options.phase,
            },
          );
        }
        continue;
      }

      // No task available — wait for an event, timeout, or abort
      await wakePromise;
    }
  }
}
