// ─── Lane Pool ──────────────────────────────────────────────────────────────
import { join } from 'node:path';
import { createHarness } from '../core/harness-factory.js';
import { clearProfileCache, loadProfilesFromDirs } from '../core/profile.js';
import { promptForStructured } from '../core/structured-output.js';
import type { AgentProfile, AuditEvent, HarnessCreationOptions, Task } from '../core/types.js';
import { appendReviewFeedback, forwardAgentStatus, safeErrorMessage } from '../core/utils.js';
import { TaskTracker } from '../tracking/task-status.js';
import type { LanePoolOptions, LanePoolResult, StepDefinition, StepResult } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────

/** Distributive Omit that preserves discriminated union structure. */
type WithoutTimestamp<T> = T extends infer U ? (U extends T ? Omit<U, 'timestamp'> : never) : never;

type Severity = 'critical' | 'high' | 'medium' | 'low';

function isFailingSeverity(severity: Severity | string): boolean {
  return severity === 'critical' || severity === 'high';
}

function extractSeverity(output: unknown): string {
  if (typeof output === 'object' && output !== null && 'severity' in output) {
    const sev = (output as Record<string, unknown>).severity;
    return typeof sev === 'string' ? sev : 'medium';
  }
  return 'medium';
}

// ─── Path safety ─────────────────────────────────────────────────────────

/** Reject values that could escape the session directory via path traversal. */
function assertSafeName(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: "${value}" contains unsafe characters`);
  }
}

// ─── RunStepContext ───────────────────────────────────────────────────────

interface RunStepContext {
  stepIndex: number;
  attempt: number;
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
        // Note: taskReady handlers run cleanup synchronously, which removes the
        // taskSettled listener. This prevents a double-wake when
        // recalculateStatuses emits taskReady before taskSettled fires.
        await new Promise<void>((resolve) => {
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onAbort = () => {
            cleanup();
            resolve();
          };
          const cleanup = () => {
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
    const maxStepRetries = this.options.maxStepRetries ?? 5;

    this.options.onStatus?.onTaskStart?.({
      taskId: task.id,
      title: task.title,
      agentId,
    });

    let currentStepIndex = 0;
    // Per-step retry counter: each step tracks its own rejection count
    const stepAttempts = new Map<number, number>();

    while (currentStepIndex < steps.length) {
      const step = steps[currentStepIndex];
      const currentAttempt = stepAttempts.get(currentStepIndex) ?? 0;

      const result = await this.runStep(
        task,
        step,
        agentId,
        { stepIndex: currentStepIndex, attempt: currentAttempt },
        profiles,
      );

      if (result.type === 'approved') {
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
            if (this.safeSubmitAndComplete(task.id, { completed: true, feedback: result.feedback, severity })) {
              this.options.onStatus?.onTaskComplete?.({
                taskId: task.id,
                title: task.title,
              });
            }
          }
          return;
        }

        currentStepIndex = Math.max(0, currentStepIndex - 1);
      }
    }

    // All steps approved — task complete
    if (this.safeSubmitAndComplete(task.id, { completed: true })) {
      this.options.onStatus?.onTaskComplete?.({
        taskId: task.id,
        title: task.title,
      });
    }
  }

  // ── Step Execution ──────────────────────────────────────────────────────

  /**
   * Run a single step: load the profile, create a harness session, prompt
   * the agent, and determine approval.
   */
  private async runStep(
    task: Task,
    step: StepDefinition,
    agentId: string,
    ctx: RunStepContext,
    profiles: Map<string, AgentProfile>,
  ): Promise<StepResult> {
    // Use pre-loaded profile
    const profile = profiles.get(step.profileId);
    if (!profile) {
      throw new Error(`Profile "${step.profileId}" not found in directories: ${this.options.profilesDirs.join(', ')}`);
    }

    // Adjust profile for read-only steps — strip write and edit tools
    let adjustedProfile: AgentProfile = profile;
    if (step.isReadOnly) {
      adjustedProfile = {
        ...profile,
        excludeTools: [...new Set([...profile.excludeTools, 'write', 'edit'])],
      };
    }

    // Validate task id and step name against path traversal
    assertSafeName(task.id, 'task id');
    assertSafeName(step.name, 'step name');

    // Compute session directory
    const sessionDirPath = join(this.options.sessionBaseDir, task.id, `${ctx.attempt}-${ctx.stepIndex}-${step.name}`);

    // Build harness options
    const harnessOpts: HarnessCreationOptions = {
      profile: adjustedProfile,
      cwd: this.options.cwd,
      apiKeys: this.options.apiKeys,
      sessionDir: sessionDirPath,
      agentId,
      onAgentStatus: forwardAgentStatus(this.options.onStatus),
    };

    // Fire status callbacks
    this.options.onStatus?.onAgentSpawn?.({
      agentId,
      profile: step.profileId,
      phase: 'implementing',
      taskId: task.id,
    });

    // Audit log
    this.appendAuditEvent({
      type: 'agent_start',
      agentId: step.profileId,
      profile: adjustedProfile,
      phase: 'implementing',
      taskId: task.id,
    });

    // Create harness
    const { session, dispose } = await createHarness(harnessOpts);

    // Track the session so the abort listener can cancel in-progress prompts
    this.activeSessions.add(session);

    try {
      // Build prompt
      const promptText = this.buildPrompt(task, step);

      if (step.schema) {
        // Structured output step (review)
        let structuredResult: unknown;
        try {
          structuredResult = await promptForStructured(session, promptText, step.schema, {
            maxRetries: ctx.attempt === 0 ? 3 : 1,
          });
        } catch (err) {
          const errorMsg = safeErrorMessage(err);
          // Log the structured output failure for observability
          this.appendAuditEvent({
            type: 'error',
            agentId,
            error: `promptForStructured failed: ${errorMsg}`,
            taskId: task.id,
          });
          // Treat as critical — the reviewer never produced valid output, so fail-safe
          return { type: 'rejected', feedback: errorMsg, output: { severity: 'critical' } };
        }

        const approved = step.isApproved
          ? step.isApproved(structuredResult)
          : (structuredResult as Record<string, unknown>)?.approved === true;

        if (approved) {
          return { type: 'approved', output: structuredResult };
        }

        const feedback = step.getFeedback
          ? step.getFeedback(structuredResult)
          : (((structuredResult as Record<string, unknown>)?.feedback as string) ?? 'No feedback provided');

        return { type: 'rejected', feedback, output: structuredResult };
      }

      // Non-structured step — always approved
      await session.prompt(promptText);
      const output = session.getLastAssistantText();
      return { type: 'approved', output };
    } finally {
      this.activeSessions.delete(session);

      // Dispose the harness in its own try/catch so dispose errors don't
      // suppress the onAgentComplete callback below.
      try {
        dispose();
      } catch (err) {
        console.error(`[${agentId}] Error disposing harness for task ${task.id}:`, safeErrorMessage(err));
      }

      // Fire completion callback — always runs even if dispose failed
      this.options.onStatus?.onAgentComplete?.({
        agentId,
        profile: step.profileId,
        phase: 'implementing',
        taskId: task.id,
      });

      // Audit log — agent_end event
      this.appendAuditEvent({
        type: 'agent_end',
        agentId: step.profileId,
        result: {},
        phase: 'implementing',
        taskId: task.id,
      });
    }
  }

  // ── Prompt Building ─────────────────────────────────────────────────────

  /**
   * Build the prompt text for a step. On retry, appends review feedback.
   */
  private buildPrompt(task: Task, step: StepDefinition): string {
    const parts: string[] = [];

    parts.push(`## Task: ${task.title}`);
    parts.push(`## Step: ${step.name}`);
    parts.push('');
    parts.push(task.prompt);

    if (task.files && task.files.length > 0) {
      parts.push('');
      parts.push(`## Relevant Files\n${task.files.join('\n')}`);
    }

    if (task.reviewFeedback && task.reviewFeedback.length > 0) {
      parts.push('');
      parts.push('## Review Feedback History (please address all items)');
      task.reviewFeedback.forEach((fb, i) => {
        parts.push(`Attempt ${i + 1}: ${fb}`);
      });
    }

    return parts.join('\n');
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
