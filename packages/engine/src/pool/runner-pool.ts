// ─── RunnerPool (replaces LanePool+Scheduler) ───────────────────────────────
//
// RunnerPool is the new concurrent task execution pool that replaces
// LanePool + Scheduler. Key simplifications over LanePool:
//
//   • NO `getStepsForTask` — only `getRunnerForTask`.
//   • NO `maxConcurrentLanes` / `laneWaitTimeoutMs` — replaced by
//     `maxConcurrentSessions` + `modelConcurrency` (passed to SessionGate).
//   • Runner returns `TaskOutcome` (no callbacks) — NO `completeTask`/
//     `failTask` on RunnerContext.
//   • Internally constructs `new SessionGate({total: maxConcurrentSessions,
//     perModel: modelConcurrency})`.
//
// Drain-loop model: all ready tasks are claimed and their runner coroutines
// started immediately (unbounded). The SessionGate is the sole concurrency
// cap — runners gate themselves via `ctx.gate.run()` so at most
// `maxConcurrentSessions` sessions execute simultaneously; the rest block
// inside the gate FIFO.

import type { Classification } from '../core/error-classifier.js';
import { classify } from '../core/error-classifier.js';
import { clearProfileCache, loadProfilesFromDirs } from '../core/profile.js';
import type { RendererRegistry } from '../core/renderer-registry.js';
import type { AgentProfile, StatusCallbacks, Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import type { WorktreeManager } from '../core/worktree-manager.js';
import { createDefaultAuditor } from '../hooks/defaults/auditor.js';
import type { HookContext, HookRegistry } from '../hooks/types.js';
import type { AuditLog } from '../tracking/audit-log.js';
import { TaskTracker } from '../tracking/task-status.js';
import type { Runner, RunnerContext, TaskOutcome } from './runners/types.js';
import { SessionGate } from './session-gate.js';
import type { RunSessionContext, SessionResult } from './session.js';
import { clearTaskSessions, runSession, SessionError } from './session.js';

// ─── Options ───────────────────────────────────────────────────────────────

export interface RunnerPoolOptions {
  /** Hard cap on concurrent in-flight sessions across ALL models. */
  maxConcurrentSessions: number;
  /** Per-model concurrency caps, passed to SessionGate. */
  modelConcurrency: Record<string, number>;
  /** Directories containing .md agent profile files. */
  profilesDirs: string[];
  /** Base directory for persisted session storage. */
  sessionBaseDir: string;
  /** Working directory for agent operations. */
  cwd: string;
  /** Optional API key overrides by provider. */
  apiKeys?: Record<string, string>;
  /** Status callback handlers. */
  onStatus?: StatusCallbacks;
  /** Audit log for recording events. */
  auditLog?: AuditLog;
  /** Shared task tracker — the pool claims tasks from here. */
  taskTracker: TaskTracker;
  /** Given a task, return a Runner to execute it. */
  getRunnerForTask?: (task: Task) => Runner;
  /** Maximum times a failed task is retried within a single pool run.
   *  Total attempts = 1 + maxTaskRetries. Default 0 (no retries). */
  maxTaskRetries?: number;
  /** Optional per-prompt timeout in milliseconds. */
  stepTimeoutMs?: number;
  /** Abort signal for cooperative cancellation. */
  signal?: AbortSignal;
  /** Optional registry of custom output renderers. */
  rendererRegistry?: RendererRegistry;
  /** Optional registry of workflow hooks. */
  hookRegistry?: HookRegistry;
  /** Phase identifier set by the workflow orchestrator. */
  phaseId: string;
  /** WorktreeManager for isolated git worktree execution. */
  worktreeManager?: WorktreeManager;
  /** SessionGate instance (optional — defaults to a new gate). */
  gate?: SessionGate;
}

// ─── RunnerPool ────────────────────────────────────────────────────────────

export class RunnerPool {
  private readonly options: RunnerPoolOptions;
  private readonly gate: SessionGate;
  /** Active sessions that may be mid-prompt; aborted on SIGINT for faster shutdown. */
  private readonly activeSessions = new Set<{ abort(): Promise<void> }>();
  /** Per-task count of same-run retries already consumed (keyed by task id). */
  private readonly taskRetries = new Map<string, number>();
  /** Scoped clone of `options.hookRegistry` created at the start of `run()`. */
  private scopedHookRegistry?: HookRegistry;

  constructor(options: RunnerPoolOptions) {
    this.options = options;
    this.gate =
      options.gate ??
      new SessionGate({ total: options.maxConcurrentSessions, perModel: options.modelConcurrency }, options.signal);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Run the pool: process all tasks, respecting concurrency limits via the
   * SessionGate.
   *
   * Drain-loop model: each iteration claims all ready tasks and starts their
   * runner coroutines immediately (unbounded). Each runner gates itself via
   * `ctx.gate.run()` so at most `maxConcurrentSessions` sessions execute
   * simultaneously. The loop then awaits the first settlement and repeats
   * until the pool is done (all tasks settled or deadlocked) or aborted.
   */
  async run(): Promise<{ completedTasks: number; failedTasks: number }> {
    const { taskTracker } = this.options;

    // Check for cancellation before doing any work.
    if (this.options.signal?.aborted) {
      return { completedTasks: 0, failedTasks: 0 };
    }

    // Skip profile loading when there's no work.
    if (taskTracker.getAllTasks().length === 0) {
      return { completedTasks: 0, failedTasks: 0 };
    }

    // Create a scoped clone of the hook registry so pool-internal subscriber
    // registrations never mutate the original.
    this.scopedHookRegistry = this.options.hookRegistry?.clone();

    // Fire onTaskRegister once per task (NO steps in the new Runner API).
    for (const task of taskTracker.getAllTasks()) {
      this.options.onStatus?.onTaskRegister?.({
        taskId: task.id,
        phaseId: this.options.phaseId,
        title: task.title,
        dependencies: task.dependencies,
      });
    }

    clearProfileCache();
    const profiles = await loadProfilesFromDirs(this.options.profilesDirs);

    // Abort listener: abort all active sessions on signal so in-progress
    // LLM calls are cancelled immediately.
    const abortActiveSessions = () => {
      for (const s of this.activeSessions) {
        s.abort().catch(() => {
          /* swallow — we're shutting down */
        });
      }
    };
    this.options.signal?.addEventListener('abort', abortActiveSessions, { once: true });

    // Register the default auditor BEFORE starting tasks so structured-output
    // and decision events land in the durable AuditLog.
    if (this.options.auditLog && this.scopedHookRegistry) {
      const auditor = createDefaultAuditor(this.options.auditLog);
      this.scopedHookRegistry.register({
        onStructuredOutput: auditor.onStructuredOutput,
        onDecision: auditor.onDecision,
      });
    }

    // ── Deadlock TaskSettled observer ──────────────────────────────────
    // The tracker fails deadlocked tasks but doesn't fire onStatus callbacks.
    const deadlockedSurfaced = new Set<string>();
    const onTaskSettled = () => {
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

    const inflight = new Set<Promise<void>>();

    try {
      while (true) {
        if (this.options.signal?.aborted) break;

        // ── Claim + start all ready tasks ──────────────────────────────
        // All ready tasks are claimed and their coroutines started. The
        // SessionGate is the sole concurrency cap — each runner gates itself
        // via ctx.gate.run so excess sessions block until a slot frees.
        const ready = taskTracker.getReadyTasks();
        if (ready.length > 0) {
          const claimed = taskTracker.claimTasks(ready.length, 'runner-pool');
          for (const t of claimed) {
            const agentId = `runner-${t.id}`;
            const p = this.processTask(t, agentId, profiles);
            inflight.add(p);
            p.then(
              () => inflight.delete(p),
              () => inflight.delete(p),
            );
          }
        }

        if (inflight.size === 0) {
          // Nothing ready and nothing in flight — trigger deadlock detection
          // (isPoolDone mutates deadlocked blocked tasks to 'failed') and stop.
          taskTracker.isPoolDone();
          // isPoolDone schedules the TaskSettled event via queueMicrotask.
          // Flush the microtask queue BEFORE the finally block detaches the
          // listener so deadlocked tasks are surfaced via onTaskRejected.
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          break;
        }

        // Wait for at least one coroutine to settle, then loop to start
        // newly-ready tasks (dependents unblocked, or retried tasks reset).
        await Promise.race(inflight);
      }

      // Drain any remaining inflight coroutines (e.g. after abort).
      if (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    } finally {
      taskTracker.removeListener(TaskTracker.Events.TaskSettled, onTaskSettled);
      this.options.signal?.removeEventListener('abort', abortActiveSessions);
      this.scopedHookRegistry = undefined;
    }

    // Count results.
    let completedTasks = 0;
    let failedTasks = 0;
    for (const task of taskTracker.getAllTasks()) {
      if (task.status === 'complete') completedTasks++;
      else if (task.status === 'failed') failedTasks++;
    }
    return { completedTasks, failedTasks };
  }

  // ── Per-Task Processing ──────────────────────────────────────────────────

  /**
   * Process a single claimed task: fire lifecycle events, resolve + invoke the
   * runner (no pool-level gate — runners gate themselves via ctx.gate.run),
   * manage per-task worktrees and merges, and budget same-run retries.
   *
   * Never throws — all errors are caught and the task is settled to 'failed'.
   */
  private async processTask(task: Task, agentId: string, profiles: Map<string, AgentProfile>): Promise<void> {
    const { taskTracker } = this.options;
    const hookRegistry = this.scopedHookRegistry;

    // ── Fire onTaskStart ───────────────────────────────────────────────
    try {
      this.options.onStatus?.onTaskStart?.({
        taskId: task.id,
        title: task.title,
        agentId,
        phaseId: this.options.phaseId,
        startedAt: Date.now(),
      });
    } catch (err) {
      // Deterministic callback crash — permanent failure (will crash again on retry).
      this.safeFail(task.id, { completed: false, error: safeErrorMessage(err) });
      return;
    }

    try {
      // ── Resolve runner ──────────────────────────────────────────────
      const resolved = await this.resolveRunner(task, hookRegistry);

      if (resolved.kind === 'skip') {
        try {
          taskTracker.cancelTask(task.id);
        } catch {
          // Defensive: the task may already be settled by a sibling.
        }
        this.options.onStatus?.onTaskRejected?.({
          taskId: task.id,
          title: task.title,
          reason: resolved.reason,
        });
        return;
      }

      const runner = resolved.runner;
      if (!runner) {
        const error = `No runner for task "${task.id}"`;
        this.safeFail(task.id, { completed: false, error });
        this.options.onStatus?.onTaskRejected?.({
          taskId: task.id,
          title: task.title,
          reason: error,
        });
        return;
      }

      // ── Per-task worktree setup ──────────────────────────────────────
      const worktreeManager = this.options.worktreeManager;
      let worktreeCreated = false;
      let worktreeCwd: string | undefined;
      if (worktreeManager && task.worktree === 'code') {
        try {
          worktreeCwd = await worktreeManager.createTaskWorktree(task.id, task.prompt, task);
          worktreeCreated = true;
        } catch (err) {
          console.warn(`[${agentId}] Failed to create worktree for task ${task.id}: ${safeErrorMessage(err)}`);
        }
      }

      // ── Build RunnerContext ──────────────────────────────────────────
      const ctx: RunnerContext = {
        task,
        gate: this.gate,
        // ctx.runSession is a direct passthrough to the session primitive.
        // The pool does NOT gate at the coroutine level — runners call
        // gate.run internally for each session, so runSession itself is NOT
        // re-gated. SessionError (a structured failure with
        // a classification) is allowed to propagate so the runner (and
        // ultimately the pool's retry valve) can classify it correctly —
        // permanent errors fail fast, transient errors are retried. Unexpected
        // non-SessionError throws are caught and surfaced as a minimal text
        // result so the runner can decide the task outcome rather than
        // crashing the coroutine.
        runSession: async (sctx: RunSessionContext): Promise<SessionResult> => {
          try {
            return await runSession(sctx);
          } catch (err) {
            if (err instanceof SessionError) throw err;
            console.warn(`[${agentId}] runSession threw non-SessionError: ${safeErrorMessage(err)}`);
            return { mode: 'text', text: '' };
          }
        },
        profiles,
        sessionBaseDir: this.options.sessionBaseDir,
        cwd: this.options.cwd,
        ...(worktreeCwd !== undefined ? { worktreeCwd } : {}),
        ...(this.options.apiKeys ? { apiKeys: this.options.apiKeys } : {}),
        activeSessions: this.activeSessions,
        ...(this.options.onStatus ? { onStatus: this.options.onStatus } : {}),
        ...(hookRegistry ? { hookRegistry } : {}),
        ...(this.options.rendererRegistry ? { rendererRegistry: this.options.rendererRegistry } : {}),
        ...(this.options.auditLog ? { auditLog: this.options.auditLog } : {}),
        ...(this.options.signal ? { signal: this.options.signal } : {}),
        ...(this.options.stepTimeoutMs !== undefined ? { stepTimeoutMs: this.options.stepTimeoutMs } : {}),
        phaseId: this.options.phaseId,
        agentId,
        ...(this.options.maxTaskRetries !== undefined ? { maxTaskRetries: this.options.maxTaskRetries } : {}),
      };

      // ── Invoke runner (no pool-level gate — runners gate themselves via ctx.gate.run) ─
      let outcome: TaskOutcome;
      let thrownClassification: Classification | undefined;
      try {
        outcome = await runner(ctx);
      } catch (err) {
        // SessionError carries its own structured classification — thread it
        // through to the retry valve so permanent errors fail fast instead of
        // being re-classified from the message text (which may not match a
        // known pattern).
        if (err instanceof SessionError) thrownClassification = err.classification;
        outcome = { status: 'failed', error: safeErrorMessage(err) };
      }

      // ── Handle outcome ───────────────────────────────────────────────
      if (outcome.status === 'completed') {
        if (worktreeCreated && worktreeManager) {
          // Merge before completing so a failed merge can downgrade to 'failed'.
          let mergeSucceeded = true;
          let mergeError: string | undefined;
          try {
            const mergeResult = await worktreeManager.mergeTaskBranch(task.id);
            mergeSucceeded = mergeResult.success;
            if (!mergeSucceeded) mergeError = 'Worktree merge failed';
          } catch (err) {
            mergeSucceeded = false;
            mergeError = safeErrorMessage(err);
          }

          if (mergeSucceeded) {
            this.safeComplete(task.id);
          } else {
            const reason = mergeError ?? 'Merge failed';
            this.safeFail(task.id, { completed: false, error: reason });
            // Merge failures are integration problems — NOT retriable.
            await this.maybeRetry(task, agentId, reason, { retriable: false });
            return;
          }
        } else {
          this.safeComplete(task.id);
        }
        this.options.onStatus?.onTaskComplete?.({ taskId: task.id, title: task.title });
        return;
      }

      // Failed outcome.
      const error = outcome.error;
      this.safeFail(task.id, error !== undefined ? { completed: false, error } : { completed: false });
      if (error) {
        this.reportError(agentId, error, task.id);
      }
      await this.maybeRetry(task, agentId, error, { retriable: true, classification: thrownClassification });
    } catch (err) {
      // Unexpected error escaping the inner logic — fail the task defensively.
      const error = safeErrorMessage(err);
      this.reportError(agentId, error, task.id);
      this.safeFail(task.id, { completed: false, error });
    }
  }

  // ── Runner Resolution ────────────────────────────────────────────────────

  /**
   * Resolve a Runner for the given task.
   *
   * Resolution order:
   * 1. When a scoped `hookRegistry` with at least one `beforeTask` subscriber
   *    is present, invoke the first-wins hook seeded with `{ task }`.
   *    A subscriber may:
   *      • return `{ skip: true }`   → skip the task (cancelTask).
   *      • return `{ runner: ... }`  → use the provided runner.
   *      • return `undefined`        → abstain (fall through).
   * 2. `getRunnerForTask` (if provided).
   * 3. Otherwise no runner is available.
   */
  private async resolveRunner(
    task: Task,
    hookRegistry: HookRegistry | undefined,
  ): Promise<{ kind: 'runner'; runner: Runner | undefined } | { kind: 'skip'; reason: string }> {
    if (hookRegistry && hookRegistry.hasSubscribers('beforeTask')) {
      let result: Record<string, unknown> | undefined;
      try {
        result = (await hookRegistry.invokeFirstWins('beforeTask', { task }, {
          registry: hookRegistry,
          cwd: this.options.cwd,
          workDir: this.options.cwd,
          signal: this.options.signal,
        } satisfies HookContext)) as Record<string, unknown> | undefined;
      } catch {
        // Hook threw — treat as abstain.
        result = undefined;
      }

      if (result?.skip === true) {
        const reason = typeof result.reason === 'string' ? result.reason : 'Skipped by beforeTask hook';
        return { kind: 'skip', reason };
      }
      if (result && typeof result.runner === 'function') {
        return { kind: 'runner', runner: result.runner as Runner };
      }
    }

    let runner: Runner | undefined;
    try {
      runner = this.options.getRunnerForTask?.(task);
    } catch {
      runner = undefined;
    }
    return { kind: 'runner', runner };
  }

  // ── Retry Valve ──────────────────────────────────────────────────────────

  /**
   * If the task that just ran ended up `failed`, cull its worktree (when
   * configured), and — if the error is retryable and the retry budget is not
   * exhausted — clear its persisted sessions, reset it to `ready`, and
   * announce the retry. The drain loop will then re-claim and re-run it.
   *
   * Retryability is determined by the error classifier: `permanent` and
   * `abort` errors are NOT retried; `transient`, `empty`, and `unknown`
   * errors ARE retried (subject to budget). This differs from LanePool (which
   * treats `unknown` as non-retriable) because RunnerPool runners return
   * explicit `{ status: 'failed' }` outcomes whose error strings may not
   * match a known classifier pattern — treating them as retryable-by-default
   * avoids silently abandoning tasks whose failures are unlabeled.
   *
   * Merge failures (`retriable: false`) preserve the worktree for manual
   * inspection and are never retried.
   */
  private async maybeRetry(
    task: Task,
    agentId: string,
    reason: string | undefined,
    opts: { retriable: boolean; classification?: Classification },
  ): Promise<void> {
    const { taskTracker } = this.options;
    const current = taskTracker.getTask(task.id);
    if (!current || current.status !== 'failed') {
      this.taskRetries.delete(task.id);
      return;
    }

    // Non-retriable (e.g. merge failure) — preserve worktree, don't retry.
    if (!opts.retriable) {
      this.taskRetries.delete(task.id);
      this.options.onStatus?.onDecision?.({
        agentId,
        decision: `Task "${task.id}" failed on integration (merge unresolvable) — worktree preserved`,
        reasoning: reason ?? 'merge failed',
        taskId: task.id,
      });
      return;
    }

    // Cull worktree whether we're about to retry or permanently give up,
    // so the failed branch never leaks.
    if (this.options.worktreeManager) {
      try {
        await this.options.worktreeManager.cullTaskWorktree(task.id);
      } catch (err) {
        console.warn(`[${agentId}] Failed to cull worktree for task ${task.id}: ${safeErrorMessage(err)}`);
      }
    }

    const max = this.options.maxTaskRetries ?? 0;
    const used = this.taskRetries.get(task.id) ?? 0;

    // Enrich reason from the task's stored result error.
    let enrichedReason = reason;
    if (!enrichedReason && current.result) {
      const resultErr = (current.result as Record<string, unknown> | undefined)?.error;
      if (typeof resultErr === 'string') enrichedReason = resultErr;
    }

    // Use the provided classification (e.g. from a propagated SessionError)
    // when available; otherwise classify from the error message text.
    const classification = opts.classification ?? classify(enrichedReason, { attempt: used + 1 });

    // Retry only for non-permanent, non-abort errors.
    const retryWorthy = classification.kind !== 'permanent' && classification.kind !== 'abort';
    if (!retryWorthy) {
      this.taskRetries.delete(task.id);
      const reasonSuffix = enrichedReason ? `: ${enrichedReason}` : '';
      this.options.onStatus?.onDecision?.({
        agentId,
        decision: `Task "${current.title}" failed with a non-retryable error${reasonSuffix} — not retried`,
        reasoning: enrichedReason ?? 'non-retryable error',
        taskId: task.id,
      });
      return;
    }

    if (max <= 0 || used >= max) {
      this.taskRetries.delete(task.id);
      return;
    }

    // ── Backoff delay (abortable) ────────────────────────────────────────
    const delayMs = opts.classification?.delayMs ?? classification.delayMs ?? Math.min(2000 * Math.pow(2, used), 30000);
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

    taskTracker.resetTaskForRetry(task.id);

    this.options.onStatus?.onDecision?.({
      agentId,
      decision: `Retrying failed task "${task.id}" (attempt ${attempt}/${max + 1})`,
      reasoning: reason ?? 'task failed',
      taskId: task.id,
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Safely mark a task as complete. */
  private safeComplete(taskId: string): void {
    try {
      this.options.taskTracker.completeTask(taskId);
    } catch (err) {
      this.reportError('pool', `safeComplete failed for ${taskId}: ${safeErrorMessage(err)}`, taskId);
    }
  }

  /** Safely mark a task as failed. */
  private safeFail(taskId: string, result: unknown): void {
    try {
      this.options.taskTracker.failTask(taskId, result);
    } catch (err) {
      this.reportError('pool', `safeFail failed for ${taskId}: ${safeErrorMessage(err)}`, taskId);
    }
  }

  /** Report an error via the onStatus callback or console.error fallback. */
  private reportError(agentId: string, error: string, taskId?: string): void {
    if (this.options.onStatus?.onError) {
      this.options.onStatus.onError({ agentId, error, phaseId: this.options.phaseId, taskId });
    } else {
      console.error(`[${agentId}] ${error}`);
    }
  }
}
