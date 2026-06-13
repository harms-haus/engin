// ─── Lane Pool ──────────────────────────────────────────────────────────────
import { clearProfileCache, loadProfilesFromDirs } from '../core/profile.js';
import type { AgentProfile, AuditEvent, Task } from '../core/types.js';
import { appendReviewFeedback, safeErrorMessage } from '../core/utils.js';
import { TaskTracker } from '../tracking/task-status.js';
// buildPrompt is used via prompt-builder module directly
import { extractSeverity, isFailingSeverity } from './severity.js';
import type { StepExecutionContext } from './step-execution.js';
import { runStep } from './step-execution.js';
import type { LanePoolOptions, LanePoolResult, TrackedSession, WithoutTimestamp } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface _RunStepContext {
  stepIndex: number;
  attempt: number;
  execCount: number;
}

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
        phase: this.options.phase,
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
          this.reportError(agentId, error);
          this.appendAuditEvent({ type: 'error', agentId, error });
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
    const WAIT_TIMEOUT_MS = 30000;

    while (true) {
      // Check for cancellation
      if (this.options.signal?.aborted) {
        return;
      }

      const claimed = taskTracker.claimTasks(1);
      if (claimed.length === 0) {
        if (taskTracker.isPoolDone()) {
          return;
        }
        // ── Dual-listener wait with safety timeout ────────────────────────
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            cleanup();
            console.warn(`[${agentId}] Lane wait timeout after ${WAIT_TIMEOUT_MS}ms, retrying`);
            resolve();
          }, WAIT_TIMEOUT_MS);
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onAbort = () => {
            cleanup();
            resolve();
          };
          const cleanup = () => {
            clearTimeout(timer);
            taskTracker.removeListener(TaskTracker.Events.TaskReady, onReady);
            taskTracker.removeListener(TaskTracker.Events.TaskSettled, onReady);
            this.options.signal?.removeEventListener('abort', onAbort);
          };
          taskTracker.once(TaskTracker.Events.TaskReady, onReady);
          taskTracker.once(TaskTracker.Events.TaskSettled, onReady);
          this.options.signal?.addEventListener('abort', onAbort, { once: true });
        });
        continue;
      }

      const task = claimed[0];

      try {
        // startTask lives inside the try block so a tracker error is caught
        taskTracker.startTask(task.id, agentId);
        await this.processTask(task, agentId, profiles);
      } catch (err) {
        // Fire onError callback on task processing error
        const error = safeErrorMessage(err);
        this.reportError(agentId, error, 'implementing', task.id);
        // Error during task processing — mark as failed to prevent the lane
        // from getting stuck.
        this.safeFailTask(task.id, { completed: false, error: true });

        // Audit log — error event
        this.appendAuditEvent({ type: 'error', agentId, error, taskId: task.id });
      }
    }
  }

  // ── Task Processing ─────────────────────────────────────────────────────

  /**
   * Execute all steps for a task. On rejection, back up one step and retry
   * up to `maxStepRetries` times **per step**.
   */
  private async processTask(task: Task, agentId: string, profiles: Map<string, AgentProfile>): Promise<void> {
    const steps = this.options.getStepsForTask(task);

    if (steps.length === 0) {
      this.safeFailTask(task.id, { completed: false, error: 'No steps defined for task' });
      return;
    }

    const maxStepRetries = this.options.maxStepRetries ?? 5;

    this.options.onStatus?.onTaskStart?.({
      taskId: task.id,
      title: task.title,
      agentId,
      phase: this.options.phase,
      startedAt: Date.now(),
    });

    let currentStepIndex = 0;
    let lastOutput: unknown = undefined;
    // Per-step retry counter: each step tracks its own rejection count
    const stepAttempts = new Map<number, number>();
    // Per-step execution counter: increments each time a step is executed
    const stepExecutions = new Map<number, number>();
    // Track sessions for disposal at task completion
    const taskSessions = new Map<number, TrackedSession>();

    const disposeAllTaskSessions = () => {
      for (const ts of taskSessions.values()) {
        try {
          ts.dispose();
        } catch (err) {
          console.error(`[${agentId}] Error disposing harness for task ${task.id}:`, safeErrorMessage(err));
        }
      }
      taskSessions.clear();
    };

    const execCtx: StepExecutionContext = {
      sessionBaseDir: this.options.sessionBaseDir,
      cwd: this.options.cwd,
      apiKeys: this.options.apiKeys,
      onStatus: this.options.onStatus,
      activeSessions: this.activeSessions,
      appendAuditEvent: (event) => this.appendAuditEvent(event),
    };

    try {
      while (currentStepIndex < steps.length) {
        const step = steps[currentStepIndex];
        const currentAttempt = stepAttempts.get(currentStepIndex) ?? 0;
        const execCount = stepExecutions.get(currentStepIndex) ?? 0;
        stepExecutions.set(currentStepIndex, execCount + 1);

        // Check for an existing session to resume
        let existingSessionPath: string | undefined;
        const existing = taskSessions.get(currentStepIndex);
        if (existing) {
          existingSessionPath = existing.sessionPath;
        }

        const { result, trackedSession } = await runStep(
          task,
          step,
          agentId,
          { stepIndex: currentStepIndex, attempt: currentAttempt, execCount },
          profiles,
          execCtx,
          existingSessionPath,
        );

        // Dispose old tracked session for this step (if any) now that we have the new one
        const oldSession = taskSessions.get(currentStepIndex);
        if (oldSession) {
          try {
            oldSession.dispose();
          } catch (err) {
            console.error(
              `[${agentId}] Error disposing old session for step ${currentStepIndex} of task ${task.id}:`,
              safeErrorMessage(err),
            );
          }
        }
        taskSessions.set(currentStepIndex, trackedSession);

        if (result.type === 'approved') {
          lastOutput = result.output;
          currentStepIndex++;
        } else {
          // Rejected — record the retry attempt for this step, then back up
          appendReviewFeedback(task, result.feedback);
          const newAttempt = currentAttempt + 1;
          stepAttempts.set(currentStepIndex, newAttempt);

          // Log the retry decision
          this.options.onStatus?.onDecision?.({
            agentId,
            decision: `Step "${step.name}" rejected (attempt ${newAttempt}/${maxStepRetries}), retrying`,
            reasoning: result.feedback,
            taskId: task.id,
          });

          if (newAttempt >= maxStepRetries) {
            // Extract severity from the last structured rejection result
            const severity = extractSeverity(result.output);

            if (isFailingSeverity(severity)) {
              // Critical/high → task failed
              this.options.onStatus?.onTaskRejected?.({
                taskId: task.id,
                title: task.title,
                reason: result.feedback,
              });
              this.safeFailTask(task.id, { completed: false, feedback: result.feedback, severity });
            } else {
              // Medium/low/missing → accept as completed with caveats
              if (
                this.safeSubmitAndComplete(task.id, {
                  completed: true,
                  feedback: result.feedback,
                  severity,
                  output: result.output,
                })
              ) {
                this.options.onStatus?.onTaskComplete?.({
                  taskId: task.id,
                  title: task.title,
                });
              }
            }
            disposeAllTaskSessions();
            return;
          }

          currentStepIndex = Math.max(0, currentStepIndex - 1);
        }
      }

      // All steps approved — dispose sessions, then task complete
      disposeAllTaskSessions();
      if (this.safeSubmitAndComplete(task.id, { completed: true, output: lastOutput })) {
        this.options.onStatus?.onTaskComplete?.({
          taskId: task.id,
          title: task.title,
        });
      }
    } catch (err) {
      // Unexpected error during while loop — clean up sessions
      disposeAllTaskSessions();
      throw err;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Safely submit a task for review and complete it. Catches and logs
   * errors from invalid state transitions.
   */
  private safeSubmitAndComplete(taskId: string, result: unknown): boolean {
    try {
      this.options.taskTracker.submitForReview(taskId, result);
      this.options.taskTracker.completeTask(taskId);
      return true;
    } catch (err) {
      const errorMsg = `safeSubmitAndComplete failed for ${taskId}: ${safeErrorMessage(err)}`;
      this.reportError('pool', errorMsg, 'implementing', taskId);
      return false;
    }
  }

  /**
   * Safely mark a task as failed. Catches and logs errors from invalid
   * state transitions.
   */
  private safeFailTask(taskId: string, result: unknown): void {
    try {
      this.options.taskTracker.failTask(taskId, result);
    } catch (err) {
      const errorMsg = `safeFailTask failed for ${taskId}: ${safeErrorMessage(err)}`;
      this.reportError('pool', errorMsg, 'implementing', taskId);
    }
  }

  // ── Error & Audit Helpers ─────────────────────────────────────────────

  /**
   * Report an error via the onStatus callback or console.error fallback.
   */
  private reportError(agentId: string, error: string, phase = 'implementing', taskId?: string): void {
    if (this.options.onStatus?.onError) {
      this.options.onStatus.onError({ agentId, error, phase, taskId });
    } else {
      console.error(`[${agentId}] ${error}`);
    }
  }

  /**
   * Append an event to the audit log if available (fire-and-forget).
   */
  private appendAuditEvent(event: WithoutTimestamp<AuditEvent>): void {
    this.options.auditLog?.append(event).catch(() => {
      // Swallow audit log errors — they must not crash the pool.
    });
  }
}
