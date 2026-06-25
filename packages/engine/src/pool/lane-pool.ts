// ─── Lane Pool ──────────────────────────────────────────────────────────────
import { classify } from '../core/error-classifier.js';
import { relativizePathsIn } from '../core/path-relativizer.js';
import { clearProfileCache, loadProfilesFromDirs } from '../core/profile.js';
import type { AgentProfile, Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import { createDefaultAuditor } from '../hooks/defaults/auditor.js';
import type { BeforeTaskResult, HookContext, HookRegistry } from '../hooks/types.js';
import { TaskTracker } from '../tracking/task-status.js';
// buildPrompt is used via prompt-builder module directly
import { linearStepsRunner } from './linear-steps-runner.js';
import { Scheduler } from './scheduler.js';
import { clearTaskSessions } from './step-execution.js';
import type { TaskProcessorContext } from './task-processor.js';
import { reportError, safeCompleteTask, safeFailTask } from './task-processor.js';
import type { LanePoolOptions, LanePoolResult, TaskOutcome, TaskRunner, TaskRunnerContext } from './types.js';

/** Default maximum retries per step on agent crash. */
const DEFAULT_MAX_STEP_RETRIES = 5;

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
 *
 * The reusable lane-scheduling CORE (spawning lanes, the claim → wake loop,
 * the `claimPolicy` / `concurrencyKey` / `onLaneStall` hooks) has been
 * extracted to {@link Scheduler}. `LanePool` owns everything the Scheduler
 * deliberately does NOT: lifecycle firing, retry budgeting, runner
 * resolution, worktree setup, profile loading, and default auditor
 * registration. `run()` constructs a {@link Scheduler} and binds
 * {@link LanePool.processTask} as its `runTask`.
 */
export class LanePool {
  private readonly options: LanePoolOptions;
  /** Active sessions that may be mid-prompt; aborted on SIGINT for faster shutdown. */
  private readonly activeSessions = new Set<{ abort(): Promise<void> }>();
  /** Per-task count of same-run retries already consumed (keyed by task id). */
  private readonly taskRetries = new Map<string, number>();
  /** Pending skip reason set by the `beforeTask` hook; consumed in the SKIP path of processTask. */
  private pendingSkipReason?: string;
  /** Scoped clone of `options.hookRegistry` created at the start of `run()` so pool-internal subscriber registrations (e.g. the default auditor) never mutate the original. */
  private scopedHookRegistry?: HookRegistry;

  constructor(options: LanePoolOptions) {
    this.options = options;
  }

  // ── Runner Resolution ──────────────────────────────────────────────────

  /**
   * Sentinel returned by {@link resolveRunner} when the `beforeTask` hook
   * requests that a task be SKIPPED. {@link processTask} cancels the task in
   * the tracker and returns immediately without running any steps, firing the
   * merge lifecycle, or budgeting a retry.
   */
  private static readonly SKIP = Symbol('LanePool.skip');

  /**
   * Resolve a TaskRunner for the given task.
   *
   * Resolution order:
   * 1. Seed the step list from `getStepsForTask` (if provided).
   * 2. When a `hookRegistry` with at least one `beforeTask` subscriber is
   *    threaded through {@link LanePoolOptions}, invoke the first-wins hook
   *    seeded with `{ task, steps }`. A subscriber may:
   *      • return `{ skip: true }`  → the task is skipped (this method returns
   *        the {@link SKIP} sentinel; {@link processTask} cancels the task).
   *      • return `{ steps: [...] }` → override the seed step list.
   *      • return `undefined`        → abstain (the seed is kept).
   *    Zero behavior change when no `hookRegistry` or no `beforeTask`
   *    subscribers: the seed from `getStepsForTask` drives the steps.
   * 3. If `getRunnerForTask` is provided, use it (takes precedence over steps).
   * 4. Otherwise wrap the resolved steps in `linearStepsRunner`.
   * 5. Otherwise throw.
   */
  private async resolveRunner(task: Task): Promise<TaskRunner | typeof LanePool.SKIP> {
    const hookRegistry = this.scopedHookRegistry;
    const seed = this.options.getStepsForTask?.(task) ?? [];

    // `beforeTask` first-wins hook seam: mirrors the `beforeStepPrompt` /
    // `onStructuredOutput` seams in step-execution.ts — gated on
    // `hasSubscribers` so an empty / no-subscriber registry falls through to
    // the seed (backward compat: identical to today when no hookRegistry).
    let steps = seed;
    if (hookRegistry && hookRegistry.hasSubscribers('beforeTask')) {
      const result = (await hookRegistry.invokeFirstWins('beforeTask', { task, steps: seed }, {
        registry: hookRegistry,
        cwd: this.options.cwd,
        workDir: this.options.cwd,
        signal: this.options.signal,
      } satisfies HookContext)) as BeforeTaskResult | undefined;

      if (result?.skip === true) {
        this.pendingSkipReason = result.reason;
        return LanePool.SKIP;
      }
      if (Array.isArray(result?.steps) && result.steps.length > 0) {
        steps = result.steps;
      }
    }

    if (this.options.getRunnerForTask) {
      return this.options.getRunnerForTask(task);
    }
    if (steps.length > 0) {
      return linearStepsRunner(steps);
    }
    throw new Error(`No runner or steps provided for task "${task.id}"`);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Run the pool: spawn `maxConcurrentLanes` workers and wait for all tasks
   * to complete or fail.
   *
   * The lane loop is delegated to {@link Scheduler}; this method owns the
   * pre-lane setup (onTaskRegister, profile loading, default auditor
   * registration, abort-session wiring) and binds {@link LanePool.processTask}
   * as the Scheduler's `runTask` callback.
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

    // Create a scoped clone of the hook registry so pool-internal subscriber
    // registrations (e.g. the default auditor) never mutate the original
    // `options.hookRegistry`. All downstream code (resolveRunner, auditor
    // registration, TaskRunnerContext, Scheduler config) uses this clone.
    this.scopedHookRegistry = this.options.hookRegistry?.clone();

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

    // Register the default auditor BEFORE starting lanes so structured-output
    // and decision events land in the durable AuditLog WITHOUT any manual
    // `auditLog.append` call in workflow code. The auditor is registered as a
    // hook SUBSCRIBER; observe = fan-out, so a workflow that provides its OWN
    // `onStructuredOutput` / `onDecision` subscribers sees BOTH fire (the
    // workflow's subscriber AND the default auditor). Registered only when
    // BOTH `auditLog` and `hookRegistry` are present — when either is absent,
    // no auditor is registered (backward compat: manual `auditLog.append`
    // calls in workflow code still work).
    if (this.options.auditLog && this.scopedHookRegistry) {
      const auditor = createDefaultAuditor(this.options.auditLog);
      this.scopedHookRegistry.register({
        onStructuredOutput: auditor.onStructuredOutput,
        onDecision: auditor.onDecision,
      });
    }

    // ── Deadlock onTaskRejected observer ──────────────────────────────
    // The tracker fails deadlocked tasks but doesn't fire onStatus callbacks,
    // so we listen to TaskSettled and surface deadlocked tasks (result.error
    // starts with 'deadlocked:') via onTaskRejected. The Set deduplicates.
    const deadlockedSurfaced = new Set<string>();
    const onTaskSettled = () => {
      // Scan ONLY failed tasks (O(failed), typically O(1)) instead of the
      // full task set. isPoolDone() marks deadlocked tasks as 'failed' with a
      // result.error starting with 'deadlocked:', so filtering the failed set
      // is sufficient to detect freshly-deadlocked tasks.
      for (const t of taskTracker.getFailedTasks()) {
        if (!deadlockedSurfaced.has(t.id)) {
          const resultErr = (t.result as Record<string, unknown> | undefined)?.error;
          if (typeof resultErr === 'string' && resultErr.startsWith('deadlocked:')) {
            deadlockedSurfaced.add(t.id);
            this.options.onStatus?.onTaskRejected?.({
              taskId: t.id,
              title: t.title,
              reason: resultErr,
            });
          }
        }
      }
    };
    taskTracker.on(TaskTracker.Events.TaskSettled, onTaskSettled);

    try {
      const scheduler = new Scheduler({
        maxConcurrentLanes,
        taskTracker,
        hookRegistry: this.scopedHookRegistry,
        signal: this.options.signal,
        laneWaitTimeoutMs: this.options.laneWaitTimeoutMs,
        // The Scheduler drives the lane loop; LanePool.processTask owns
        // lifecycle firing, runner resolution, worktree setup, and retry
        // budgeting. The outer try/catch below mirrors the prior
        // Promise.allSettled rejected-lane logging: an unexpected error that
        // escapes processTask's own try/catch (e.g. from maybeRetryFailedTask)
        // is reported via `reportError` and re-thrown so the Scheduler's lane
        // rejects — reproducing the previous behavior where any uncaught lane
        // error was logged and then swallowed by Promise.allSettled.
        runTask: async (task, laneId) => {
          try {
            await this.processTask(task, laneId, profiles);
          } catch (err) {
            const error = safeErrorMessage(err);
            reportError(laneId, error, undefined, task.id, {
              options: this.options,
              activeSessions: this.activeSessions,
              phaseId: this.options.phaseId,
            });
            throw err;
          }
        },
        // The Scheduler silently swallows lane rejections (one crashed lane
        // must not abort the others); this callback re-surfaces them to
        // `reportError` so the legacy lane-crash logging is preserved.
        onLaneError: (laneId, err) => {
          const error = safeErrorMessage(err);
          reportError(laneId, error, undefined, undefined, {
            options: this.options,
            activeSessions: this.activeSessions,
            phaseId: this.options.phaseId,
          });
        },
      });
      return await scheduler.run();
    } finally {
      taskTracker.removeListener(TaskTracker.Events.TaskSettled, onTaskSettled);
      this.options.signal?.removeEventListener('abort', abortActiveSessions);
      this.scopedHookRegistry = undefined;
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
   *     `createTaskWorktree` call in `processTask` re-creates it on the next claim).
   *   • permanent failure — so the failed branch is force-removed rather than
   *     left dangling for the user to clean up manually.
   *
   * No-op (aside from pruning a stale `taskRetries` entry) when the task did
   * not end up `failed`, or when `maxTaskRetries` is unset/`0` AND no
   * worktreeManager is configured.
   */
  private async maybeRetryFailedTask(
    task: Task,
    agentId: string,
    reason?: string,
    opts?: { retriable?: boolean },
  ): Promise<void> {
    const current = this.options.taskTracker.getTask(task.id);
    if (!current || current.status !== 'failed') {
      // Task didn't fail (e.g. completed, cancelled, or already settled by a
      // sibling lane). Prune any stale retry counter and bail out — there is
      // nothing to cull or retry.
      this.taskRetries.delete(task.id);
      return;
    }

    // Integration failure (e.g. the task's approved work could not be merged
    // even after the merge-commit fix-up retry). Re-running the task is futile
    // — the WORK is done and approved; the integration is the problem — so do
    // NOT retry it. PRESERVE the task worktree (do NOT cull) so the approved
    // work remains on its branch for a manual merge / inspection instead of
    // being force-removed.
    if (opts?.retriable === false) {
      this.taskRetries.delete(task.id);
      this.options.onStatus?.onDecision?.({
        agentId,
        decision: `Task "${task.id}" failed on integration (merge unresolvable) — worktree preserved`,
        reasoning: reason ?? 'merge failed',
        taskId: task.id,
      });
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

    // ── Classify the failure to decide retryability ─────────────────────
    // Use the error classifier so permanent errors (model-not-found, auth
    // failures, billing limits) fail fast instead of burning retry budget
    // on futile re-runs. Transient errors (rate limits, overloads) get an
    // abortable backoff delay before reset.
    //
    // Enrich the reason with the task's stored result error so classify's
    // regex-based checks (CONFIG_ERROR_RE, TRANSIENT_RE) can match the
    // provider error text even when `failureReason` was undefined (e.g. a
    // runner that settled the task via failTask without returning an
    // error/feedback string). PROVIDER_LIMIT_RE (billing/quota) only fires
    // when `lastAssistant.errorMessage` is available (step-execution layer);
    // billing errors that surface here as plain reason strings fall through
    // to 'unknown' (still retryable=false). We do NOT have access to the
    // session's last assistant message here (it lives in step-execution and
    // is not threaded into the outcome), so assistant-message-based
    // classification (stopReason === 'error', empty content, overflow) is
    // not possible at this layer — the enriched reason string is the
    // primary classification input.
    const max = this.options.maxTaskRetries ?? 0;
    const used = this.taskRetries.get(task.id) ?? 0;

    // Fall back to the task's stored result error when reason is absent.
    let enrichedReason = reason;
    if (!enrichedReason && task.result) {
      const resultErr = (task.result as Record<string, unknown> | undefined)?.error;
      if (typeof resultErr === 'string') {
        enrichedReason = resultErr;
      }
    }

    // Pass { attempt: used + 1 } so computeTransientDelay scales across
    // successive retries (2s → 4s → 8s → 16s → 30s cap). Without this, every
    // transient retry gets a flat ~2s delay (attempt defaults to 1).
    const classification = classify(enrichedReason, { attempt: used + 1 });

    if (!classification.retryable) {
      // Permanent / abort / unknown — do not retry. Prune the counter and
      // surface the verdict so the TUI / workflow can display it.
      this.taskRetries.delete(task.id);
      const reasonSuffix = enrichedReason ? `: ${enrichedReason}` : '';
      this.options.onStatus?.onDecision?.({
        agentId,
        decision: `Task "${task.title}" failed with a non-retryable error${reasonSuffix} — not retried`,
        reasoning: enrichedReason ?? 'non-retryable error',
        taskId: task.id,
      });
      return;
    }

    if (max <= 0) {
      // No retries configured — permanent failure. Prune the counter and stop.
      this.taskRetries.delete(task.id);
      return;
    }

    if (used >= max) {
      // Retry budget exhausted — permanent failure. Prune the counter and stop.
      this.taskRetries.delete(task.id);
      return;
    }

    // ── Backoff delay (abortable) ────────────────────────────────────────
    // For transient/empty retries, wait before resetting so the provider
    // has time to recover. The delay is raced against the abort signal so
    // SIGINT cancels promptly instead of blocking for the full backoff.
    // The abort listener is removed in BOTH the timer callback (normal
    // completion) and the abort handler (cancellation) to prevent listener
    // leaks across retries.
    const delayMs = classification.delayMs ?? Math.min(2000 * Math.pow(2, used), 30000);
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
          this.options.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        this.options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    // If aborted during the delay, bail out — do not retry.
    if (this.options.signal?.aborted) {
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

  // ── Task Processor (Scheduler's runTask) ────────────────────────────────

  /**
   * Process a single claimed task: fire lifecycle events, resolve + invoke the
   * runner, manage per-task worktrees and merges, and budget same-run retries.
   *
   * This is the caller-supplied `runTask` bound into the {@link Scheduler}.
   * It owns everything the Scheduler deliberately does NOT:
   *   - Lifecycle firing (onTaskStart / onTaskComplete / onTaskRejected).
   *   - Runner resolution + the worktree create/merge lifecycle.
   *   - Retry budgeting ({@link maybeRetryFailedTask}).
   *
   * Unexpected errors (anything that escapes the inner try/catch) are logged
   * via {@link reportError} and re-thrown so the Scheduler's lane rejects —
   * reproducing the prior `Promise.allSettled` rejected-lane logging path.
   */
  private async processTask(task: Task, agentId: string, profiles: Map<string, AgentProfile>): Promise<void> {
    const processorCtx: TaskProcessorContext = {
      options: this.options,
      activeSessions: this.activeSessions,
      phaseId: this.options.phaseId,
    };

    // ── Pre-try orphan prevention ──────────────────────────────────────
    // If onTaskStart (or any pre-try code) throws, the task was claimed
    // ('active') by the Scheduler but processTask would exit without
    // settling it — leaving an orphaned active task that hangs the pool
    // forever. Catch the pre-try failure and settle the task to 'failed'
    // before re-throwing so isPoolDone() returns true and the pool
    // completes. processorCtx is constructed BEFORE this block so the
    // catch can use safeFailTask.
    try {
      this.options.onStatus?.onTaskStart?.({
        taskId: task.id,
        title: task.title,
        agentId,
        phaseId: this.options.phaseId,
        startedAt: Date.now(),
      });
    } catch (err) {
      // Intentional permanent failure: an onTaskStart crash is deterministic
      // (the callback will crash again on the same task on retry), so
      // retrying would just re-fire the same crashing callback. The re-throw
      // below bypasses maybeRetryFailedTask entirely, making this a permanent
      // failure — which is correct for a deterministic callback error.
      //
      // NOTE: no reportError here — the outer runTask wrapper in
      // LanePool.run() already reports on re-throw (single report).
      //
      // safeFailTask guards against double-settlement internally (swallows
      // errors from invalid state transitions via try/catch).
      safeFailTask(task.id, { completed: false, error: safeErrorMessage(err) }, processorCtx);
      throw err;
    }

    let failureReason: string | undefined;
    // True when the task's approved work could not be MERGED (the steps
    // themselves succeeded). Such a failure is an integration problem, not a
    // work-quality problem — re-running the task is futile, so it is routed as
    // non-retriable and the task worktree is PRESERVED (see maybeRetryFailedTask).
    let mergeFailure = false;
    try {
      const resolved = await this.resolveRunner(task);

      // ── beforeTask skip path ─────────────────────────────────────────────
      // When the `beforeTask` hook returned `{ skip: true }`, cancel the task
      // (currently `active` — just claimed — so `cancelTask` is a valid
      // transition) and return WITHOUT running any steps, setting up a
      // worktree, firing the merge lifecycle, or budgeting a retry. The task
      // reaches the terminal `cancelled` status; `isPoolDone()` treats
      // `cancelled` as settled so the scheduler's lane loop proceeds.
      if (resolved === LanePool.SKIP) {
        const reason = this.pendingSkipReason ?? 'Skipped by beforeTask hook';
        this.pendingSkipReason = undefined;
        try {
          this.options.taskTracker.cancelTask(task.id);
        } catch {
          // Defensive: the task may already be settled by a sibling lane.
        }
        // Surface the skip to the status projection: cancelTask mutates the
        // tracker only and emits no event, so without this the TUI/web would
        // show the task stuck at 'active' forever.
        this.options.onStatus?.onTaskRejected?.({
          taskId: task.id,
          title: task.title,
          reason,
        });
        return;
      }
      const resolvedRunner = resolved;

      // ── Per-task worktree setup ──────────────────────────────────────────
      // Claim a fresh worktree before invoking the runner so the agent runs
      // inside the isolated branch. On success, `completeTask` is DEFERRED
      // until after mergeTaskBranch so a failed merge can downgrade the
      // outcome to `failed` (the tracker forbids complete→failed). On
      // failure, fall back to the configured cwd with immediate settlement.
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
        maxStepRetries: this.options.maxStepRetries ?? DEFAULT_MAX_STEP_RETRIES,
        rendererRegistry: this.options.rendererRegistry,
        hookRegistry: this.scopedHookRegistry,
        auditLog: this.options.auditLog,
        signal: this.options.signal,
        worktreeManager: this.options.worktreeManager,
        stepTimeoutMs: this.options.stepTimeoutMs,
        // In worktree mode, defer settlement until after merge so a failed
        // merge can downgrade the outcome (reads worktreeCreated at call time).
        completeTask: (result?: unknown) => {
          if (worktreeCreated) {
            deferredResult = result;
            deferredCompletion = true;
            return true;
          }
          // Non-worktree path: no worktree-rooted paths to relativize.
          return safeCompleteTask(task.id, result, processorCtx);
        },
        failTask: (result?: unknown) => safeFailTask(task.id, result ?? { completed: false }, processorCtx),
      };

      const worktreeManager = this.options.worktreeManager;
      if (useWorktree && worktreeManager) {
        try {
          const taskWorktreePath = await worktreeManager.createTaskWorktree(task.id, task.prompt, task);
          // Override cwd to the worktree path so every spawned session
          // runs inside the isolated branch.
          runnerCtx.cwd = taskWorktreePath;
          // Surface the per-task worktree path on the runner context so
          // the `beforeStepPrompt` hook (and any file-resolution logic)
          // can resolve files against the isolated worktree rather than
          // the run/pool cwd.
          runnerCtx.worktreeCwd = taskWorktreePath;
          worktreeCreated = true;
        } catch (err) {
          // Fall back to the configured cwd; the task still runs.
          console.warn(`[${agentId}] Failed to create worktree for task ${task.id}: ${safeErrorMessage(err)}`);
        }
      }

      let outcome: TaskOutcome = await resolvedRunner(runnerCtx);

      // ── Merge on success (worktree mode only) ────────────────────────
      // Squash-merge the task branch into the main branch. A failed merge
      // settles the task as `failed` instead of `completed`.
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
          // Settle as completed using the deferred result (only if the
          // runner actually called completeTask — otherwise leave the
          // task unsettled, matching the non-worktree behavior).
          if (deferredCompletion) {
            // Relativize absolute worktree paths (e.g. issues[].file) to repo-relative
            // before settling. Implementation tasks run via LanePool→linearStepsRunner,
            // so this deferred seam is what relativizes their results.
            deferredResult = relativizePathsIn(deferredResult, [runnerCtx.cwd, worktreeManager.mainWorktreePath]);
            safeCompleteTask(task.id, deferredResult, processorCtx);
          }
        } else {
          // Merge failed — settle as failed (task was never settled in the deferred path).
          const reason = mergeError ?? 'Merge failed';
          safeFailTask(task.id, { completed: false, error: reason }, processorCtx);
          outcome = { status: 'failed', error: reason };
          failureReason = reason;
          mergeFailure = true;
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
      safeFailTask(task.id, { completed: false, error }, processorCtx);
    }

    // ── Same-run retry: if the task just failed and its budget isn't ────────
    // exhausted, cull its worktree (if any), clear its persisted sessions,
    // and reset it to `ready` so a lane re-claims it and restarts from
    // step 1. Capped at `maxTaskRetries` extra attempts to avoid
    // infinite loops. The worktree is also culled on permanent failure
    // (budget exhausted) so the failed branch is force-removed.
    await this.maybeRetryFailedTask(task, agentId, failureReason, { retriable: !mergeFailure });
  }
}
