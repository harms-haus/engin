// ─── Lane Pool ──────────────────────────────────────────────────────────────
import { join } from 'node:path';
import { createHarness } from '../core/harness-factory.js';
import { clearProfileCache, loadProfilesFromDirs } from '../core/profile.js';
import { promptForStructured } from '../core/structured-output.js';
import type { AgentProfile, HarnessCreationOptions, Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import type { LanePoolOptions, LanePoolResult, StepDefinition, StepResult } from './types.js';

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

  constructor(options: LanePoolOptions) {
    this.options = options;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Run the pool: spawn `maxConcurrentLanes` workers and wait for all tasks
   * to complete or fail.
   */
  async run(): Promise<LanePoolResult> {
    const startTime = Date.now();
    const { maxConcurrentLanes, taskTracker } = this.options;

    // Fire lifecycle callbacks
    this.options.onStatus?.onWorkflowStart?.({
      taskPrompt: '(pool execution)',
      resumed: false,
      workDir: this.options.sessionBaseDir ?? process.cwd(),
    });
    this.options.onStatus?.onPhaseStart?.({ phase: 'implementing', round: 1 });

    // Clear stale cached profiles before loading fresh ones
    clearProfileCache();
    const profiles = await loadProfilesFromDirs(this.options.profilesDirs);

    // Check for cancellation before spawning lanes
    if (this.options.signal?.aborted) {
      return { completedTasks: 0, failedTasks: 0 };
    }

    const laneRunners = Array.from({ length: maxConcurrentLanes }, (_, i) => this.runLane(i, profiles));
    const settled = await Promise.allSettled(laneRunners);

    // Log any lane that threw an uncaught error
    const failedLanes: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        const agentId = `lane-${index}`;
        const error = safeErrorMessage(result.reason);
        failedLanes.push(agentId);
        this.reportError(agentId, error);

        // Audit log — error event for lane failure
        this.appendAuditEvent({ type: 'error', agentId, error });
      }
    });

    // Fire phase complete callback
    this.options.onStatus?.onPhaseComplete?.({ phase: 'implementing', durationMs: Date.now() - startTime });

    // Count results from the tracker by status
    const allTasks = taskTracker.getAllTasks();
    const completedTasks = allTasks.filter((t) => t.status === 'done').length;
    const failedTasks = allTasks.filter((t) => t.status === 'failed').length;

    // Fire workflow completion or failure callback
    if (failedLanes.length > 0) {
      this.options.onStatus?.onWorkflowFailed?.({
        error: new Error(`${failedLanes.length} lane(s) failed`),
        phase: 'implementing',
      });
    } else {
      this.options.onStatus?.onWorkflowComplete?.({
        totalDurationMs: Date.now() - startTime,
        agentCount: maxConcurrentLanes,
      });
    }

    return { completedTasks, failedTasks };
  }

  // ── Lane Runner ─────────────────────────────────────────────────────────

  /**
   * Single lane (worker) loop. Continuously claims and processes tasks until
   * all tasks are done.
   */
  private async runLane(laneIndex: number, profiles: Map<string, AgentProfile>): Promise<void> {
    const { taskTracker } = this.options;
    const agentId = `lane-${laneIndex}`;
    let backoff = 50;

    while (true) {
      // Check for cancellation
      if (this.options.signal?.aborted) {
        return;
      }

      const claimed = taskTracker.claimTasks(1);
      if (claimed.length === 0) {
        if (taskTracker.areAllSettled() || taskTracker.getAllTasks().length === 0) {
          return;
        }
        // Busy-wait with exponential backoff
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 1.5, 2000);
        continue;
      }

      backoff = 50;
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
    const maxStepRetries = this.options.maxStepRetries ?? 3;

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
      const isRetry = currentAttempt > 0;

      const result = await this.runStep(task, step, agentId, currentStepIndex, isRetry, currentAttempt, profiles);

      if (result.type === 'approved') {
        currentStepIndex++;
      } else {
        // Rejected — record the retry attempt for this step, then back up
        task.reviewFeedback = result.feedback;
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
          // Max retries exhausted for this step — task failed
          this.options.onStatus?.onTaskRejected?.({
            taskId: task.id,
            title: task.title,
            reason: result.feedback,
          });
          this.safeFailTask(task.id, {
            completed: false,
            feedback: result.feedback,
          });
          return;
        }

        currentStepIndex = Math.max(0, currentStepIndex - 1);
      }
    }

    // All steps approved — task complete
    this.safeSubmitAndComplete(task.id, { completed: true });
    this.options.onStatus?.onTaskComplete?.({
      taskId: task.id,
      title: task.title,
    });
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
    stepIndex: number,
    isRetry: boolean,
    attempt: number,
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

    // Compute session directory
    const sessionDirPath = join(this.options.sessionBaseDir, task.id, `${attempt}-${stepIndex}-${step.name}`);

    // Build harness options
    const onStatus = this.options.onStatus;
    const harnessOpts: HarnessCreationOptions = {
      profile: adjustedProfile,
      cwd: this.options.cwd,
      apiKeys: this.options.apiKeys,
      sessionDir: sessionDirPath,
      onAgentStatus: onStatus
        ? {
            onTurnStart: onStatus.onTurnStart?.bind(onStatus),
            onTurnEnd: onStatus.onTurnEnd?.bind(onStatus),
            onToolCallStart: onStatus.onToolCallStart?.bind(onStatus),
            onToolCallEnd: onStatus.onToolCallEnd?.bind(onStatus),
          }
        : undefined,
    };

    // Fire status callbacks
    this.options.onStatus?.onAgentSpawn?.({
      agentId,
      profile: step.profileId,
      phase: 'implementing',
      taskId: task.id,
    });

    // Audit log
    this.appendAuditEvent({ type: 'agent_start', agentId: step.profileId, profile: adjustedProfile, taskId: task.id });

    // Create harness
    const { session, dispose } = await createHarness(harnessOpts);

    try {
      // Build prompt
      const promptText = this.buildPrompt(task, step, isRetry);

      if (step.schema) {
        // Structured output step (review)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const structuredResult: any = await promptForStructured(session, promptText, step.schema);

        const approved = step.isApproved ? step.isApproved(structuredResult) : structuredResult.approved === true;

        if (approved) {
          return { type: 'approved', output: structuredResult };
        }

        const feedback = step.getFeedback
          ? step.getFeedback(structuredResult)
          : (structuredResult.feedback ?? 'No feedback provided');

        return { type: 'rejected', feedback };
      }

      // Non-structured step — always approved
      await session.prompt(promptText);
      const output = session.getLastAssistantText();
      return { type: 'approved', output };
    } finally {
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
      this.appendAuditEvent({ type: 'agent_end', agentId: step.profileId, result: {}, taskId: task.id });
    }
  }

  // ── Prompt Building ─────────────────────────────────────────────────────

  /**
   * Build the prompt text for a step. On retry, appends review feedback.
   */
  private buildPrompt(task: Task, step: StepDefinition, isRetry: boolean): string {
    const parts: string[] = [];

    parts.push(`## Task: ${task.title}`);
    parts.push(`## Step: ${step.name}`);
    parts.push('');
    parts.push(task.prompt);

    if (task.files && task.files.length > 0) {
      parts.push('');
      parts.push(`## Relevant Files\n${task.files.join('\n')}`);
    }

    if (isRetry && task.reviewFeedback) {
      parts.push('');
      parts.push('## Review Feedback (please address)');
      parts.push(task.reviewFeedback);
    }

    return parts.join('\n');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Safely submit a task for review and complete it. Catches and logs
   * errors from invalid state transitions.
   */
  private safeSubmitAndComplete(taskId: string, result: unknown): void {
    try {
      this.options.taskTracker.submitForReview(taskId, result);
      this.options.taskTracker.completeTask(taskId);
    } catch (err) {
      const errorMsg = `safeSubmitAndComplete failed for ${taskId}: ${safeErrorMessage(err)}`;
      this.reportError('pool', errorMsg, 'implementing', taskId);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private appendAuditEvent(event: any): void {
    this.options.auditLog?.append(event).catch(() => {
      // Swallow audit log errors — they must not crash the pool.
    });
  }
}
