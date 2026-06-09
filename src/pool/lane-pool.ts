// ─── Lane Pool ──────────────────────────────────────────────────────────────
import { join } from 'node:path';
import { createHarness } from '../core/harness-factory.js';
import { loadProfilesFromDirs } from '../core/profile.js';
import { promptForStructured } from '../core/structured-output.js';
import type { AgentProfile, AuditEvent, HarnessCreationOptions, Task } from '../core/types.js';
import type { AuditLog } from '../tracking/audit-log.js';
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
 *    (up to `maxStepRetries`).
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
    const { maxConcurrentLanes, taskTracker } = this.options;

    // Fix 1: Load profiles once before spawning lanes
    const profiles = await loadProfilesFromDirs(this.options.profilesDirs);

    const laneRunners = Array.from({ length: maxConcurrentLanes }, (_, i) => this.runLane(i, profiles));
    await Promise.all(laneRunners);

    // Count results from the tracker — distinguish successful vs failed by the result payload
    const allTasks = taskTracker.getAllTasks();
    const completedTasks = allTasks.filter(
      (t) => t.status === 'done' && (t.result as Record<string, unknown> | undefined)?.completed === true,
    ).length;
    const failedTasks = allTasks.length - completedTasks;

    return { completedTasks, failedTasks };
  }

  // ── Lane Runner ─────────────────────────────────────────────────────────

  /**
   * Single lane (worker) loop. Continuously claims and processes tasks until
   * all tasks are done.
   */
  private async runLane(laneIndex: number, profiles: Map<string, AgentProfile>): Promise<void> {
    const { taskTracker } = this.options;
    const agentId = `lane-${laneIndex}`; // Fix 5: Compute agentId once
    let backoff = 50; // Fix 3: Exponential backoff

    while (true) {
      const claimed = taskTracker.claimTasks(1);
      if (claimed.length === 0) {
        if (taskTracker.areAllDone() || taskTracker.getAllTasks().length === 0) {
          return;
        }
        // Fix 3: Busy-wait with exponential backoff
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 1.5, 2000);
        continue;
      }

      backoff = 50; // Fix 3: Reset backoff when a task is successfully claimed
      const task = claimed[0];
      taskTracker.startTask(task.id, agentId);

      try {
        await this.processTask(task, agentId, profiles);
      } catch (err) {
        // Fix 7: Fire onError callback on task processing error
        const message = err instanceof Error ? err.message : String(err);
        this.options.onStatus?.onError?.({
          agentId,
          error: message,
          phase: 'implementing',
          taskId: task.id,
        });
        // Error during task processing — mark as done to prevent the lane
        // from getting stuck. The task is considered failed.
        this.safeSubmitAndComplete(task.id, { completed: false, error: true });
      }
    }
  }

  // ── Task Processing ─────────────────────────────────────────────────────

  /**
   * Execute all steps for a task. On rejection, back up one step and retry
   * up to `maxStepRetries` times.
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
    let attempt = 0;

    while (currentStepIndex < steps.length) {
      const step = steps[currentStepIndex];
      const isRetry = attempt > 0;

      const result = await this.runStep(task, step, agentId, currentStepIndex, isRetry, attempt, profiles);

      if (result.type === 'approved') {
        currentStepIndex++;
        // Note: do NOT reset attempt here. The attempt counter tracks total
        // rejections in the current retry cycle so that maxStepRetries caps the
        // total number of rejection rounds, even when earlier steps succeed on
        // re-run.
      } else {
        // Rejected — go back to the previous step
        task.reviewFeedback = result.feedback; // Fix 7: Wire retry feedback
        currentStepIndex = Math.max(0, currentStepIndex - 1);
        attempt++;

        if (attempt >= maxStepRetries) {
          // Max retries exhausted — task failed
          this.options.onStatus?.onTaskRejected?.({
            taskId: task.id,
            title: task.title,
            reason: result.feedback,
          });
          this.safeSubmitAndComplete(task.id, {
            completed: false,
            feedback: result.feedback,
          });
          return;
        }
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
    // 1. Use pre-loaded profile (Fix 1)
    const profile = profiles.get(step.profileId);
    if (!profile) {
      throw new Error(`Profile "${step.profileId}" not found in directories: ${this.options.profilesDirs.join(', ')}`);
    }

    // 2. Adjust profile for read-only steps
    let adjustedProfile: AgentProfile = profile;
    if (step.isReadOnly) {
      adjustedProfile = {
        ...profile,
        excludeTools: [...new Set([...profile.excludeTools, 'write', 'edit'])], // Fix 6: Use Set for dedup
      };
    }

    // 3. Compute session directory
    const sessionDirPath = join(this.options.sessionBaseDir, task.id, `${attempt}-${stepIndex}-${step.name}`);

    // 4. Build harness options
    const onStatus = this.options.onStatus;
    const harnessOpts: HarnessCreationOptions = {
      profile: adjustedProfile,
      cwd: this.options.cwd,
      apiKeys: this.options.apiKeys,
      sessionDir: sessionDirPath,
      // Fix 4: Simplified callback forwarding
      onAgentStatus: onStatus
        ? {
            onTurnStart: onStatus.onTurnStart?.bind(onStatus),
            onTurnEnd: onStatus.onTurnEnd?.bind(onStatus),
            onToolCallStart: onStatus.onToolCallStart?.bind(onStatus),
            onToolCallEnd: onStatus.onToolCallEnd?.bind(onStatus),
          }
        : undefined,
    };

    // 5. Fire status callbacks
    this.options.onStatus?.onAgentSpawn?.({
      agentId,
      profile: step.profileId,
      phase: 'implementing',
      taskId: task.id,
    });

    // 6. Audit log
    this.appendAuditLog(step, adjustedProfile, task.id);

    // 7. Create harness
    const { session, dispose } = await createHarness(harnessOpts);

    try {
      // 8. Build prompt
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
      dispose();

      // 9. Fire completion callback
      this.options.onStatus?.onAgentComplete?.({
        agentId,
        profile: step.profileId,
        phase: 'implementing',
        taskId: task.id,
      });
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
   * Safely submit a task for review and complete it. Catches and ignores
   * errors from invalid state transitions.
   */
  private safeSubmitAndComplete(taskId: string, result: unknown): void {
    try {
      this.options.taskTracker.submitForReview(taskId, result);
      this.options.taskTracker.completeTask(taskId);
    } catch (err) {
      // Fix 2: Fire onError callback instead of silently swallowing
      const message = err instanceof Error ? err.message : String(err);
      this.options.onStatus?.onError?.({
        agentId: 'pool',
        error: `safeSubmitAndComplete failed for ${taskId}: ${message}`,
        phase: 'implementing',
        taskId,
      });
    }
  }

  /**
   * Append an agent_start event to the audit log if available.
   */
  private appendAuditLog(step: StepDefinition, profile: AgentProfile, taskId: string): void {
    const auditLog: AuditLog | undefined = this.options.auditLog;
    if (!auditLog) return;

    // Fire-and-forget — audit log writes should not block the lane.
    const event: Omit<Extract<AuditEvent, { type: 'agent_start' }>, 'timestamp'> = {
      type: 'agent_start',
      agentId: step.profileId,
      profile,
      taskId,
    };
    auditLog.append(event).catch(() => {
      // Swallow audit log errors — they must not crash the pool.
    });
  }
}
