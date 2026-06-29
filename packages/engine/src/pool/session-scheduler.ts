// ─── SessionScheduler — task DAG + gate orchestration ────────────────────────
//
// SessionScheduler is the centerpiece of the pool refactor. It drives a
// TaskGraph through a SessionGate using a greedy tiered drain loop:
//
//   T1 (active affinity): continue specs in an active task's held batch.
//   T2 (parked):           resume parked tasks whose pending specs now fit.
//   T3 (ready):            initialize runner + first batch, start first specs
//                          (LAZY: task becomes 'active' only when its first
//                          session actually acquires a slot).
//
// Key invariants:
//
//   - BATCH ATOMICITY: gen.next(results) is called ONLY when ALL specs in the
//     current heldBatch have settled.
//   - LAZY ACTIVATION: a ready task stays 'ready' until its first session
//     actually starts (gate slot acquired). No premature 'active' transitions.
//   - SINGLE-WRITER STATUS: all status changes go through graph.setTaskStatus
//     → onStatusTransition → onStatus events.
//   - PARKING: a spec that can't acquire a slot parks the TASK (not the batch);
//     already-started siblings continue running.
//   - COALESCED DRAIN: multiple near-simultaneous completions / onRelease
//     triggers drain in ONE pass via a flag + queueMicrotask.
//
// Unlike RunnerPool (which starts unbounded coroutines that self-gate), the
// SessionScheduler owns the gate lifecycle directly: acquire before execute,
// release on settle. Runners are pure SessionPlanRunner async generators that
// never touch the gate.

import { join } from 'node:path';

import { isTerminalTaskStatus } from '@engin/shared';
import type { TaskStatus } from '@engin/shared/types';

import type { RendererRegistry } from '../core/renderer-registry.js';
import type { AgentProfile, StatusCallbacks, Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import type { WorktreeManager } from '../core/worktree-manager.js';
import type { HookContext, HookRegistry } from '../hooks/types.js';
import type { AuditLog } from '../tracking/audit-log.js';

import type { SessionPlanContext, SessionPlanRunner } from './runners/session-plan-types.js';
import type { CandidateTrace } from './scheduler-audit.js';
import { buildCapacityFailureDescription } from './scheduler-audit.js';
import { GENERATOR_TIMEOUT_MS, withTimeout } from './scheduler-timeout.js';
import type { SessionGate } from './session-gate.js';
import type { SessionResult, SessionSpec } from './session.js';
import { isSessionCached } from './session.js';
import type { TaskGraph, TaskGraphEntry } from './task-graph.js';

// ─── Internal constants ───────────────────────────────────────────────────

/** Re-export {@link GeneratorTimeoutError} for callers that depend on the
 *  historical pool surface (`pool/index.ts` → `session-scheduler.ts`). */
export { GeneratorTimeoutError } from './scheduler-timeout.js';

/** Maximum number of blank-slate retries a failed task gets after its initial
 *  attempt. Attempt 1 is the first run; up to MAX_RETRIES retries on top → at
 *  most MAX_RETRIES + 1 total executions before a task fails permanently.
 *
 *  Only EXECUTION failures (a session execute()/plan-generator/merge throw)
 *  are retryable. Structural failures (resource deadlock, missing dependency,
 *  profile-not-found → cancelled) are non-retryable and fail the task at
 *  once — they are deterministic and would fail identically every time. */
export const MAX_RETRIES = 3;

/** Maximum number of consecutive empty batches (`[]`) the plan generator may
 *  yield before {@link SessionScheduler.nextNonEmptyBatch} gives up. This is
 *  purely an infinite-loop guard: a healthy runner either yields a non-empty
 *  batch or completes, so exceeding this threshold signals a broken generator. */
export const MAX_EMPTY_BATCHES = 1000;

/** Subdirectory under {@link SessionSchedulerOptions.sessionBaseDir} used to
 *  namespace per-attempt retry session data so a failed attempt's persisted
 *  sessions are preserved for tracing instead of being overwritten.
 *
 *  Attempt 1 writes to `{sessionBaseDir}/{spec.id}/`; attempt N (>1) writes to
 *  `{sessionBaseDir}/{RETRY_SUBDIR}/{taskId}/{N}/{spec.id}/`. */
const RETRY_SUBDIR = '.retries';

// ─── Options ───────────────────────────────────────────────────────────────

export interface SessionSchedulerOptions {
  /** The task DAG with status tracking + blocking-pressure ranking. */
  graph: TaskGraph;
  /** Two-level concurrency gate (total + per-model). */
  gate: SessionGate;
  /** Resolved agent profiles keyed by profile id. */
  profiles: Map<string, AgentProfile>;
  /** Base directory for persisted session storage. */
  sessionBaseDir: string;
  /** Working directory for agent operations. */
  cwd: string;
  /** Status callback handlers. */
  onStatus?: StatusCallbacks;
  /** Hook registry (for beforeTask lifecycle hooks). */
  hookRegistry?: HookRegistry;
  /** Renderer registry (for output rendering). */
  rendererRegistry?: RendererRegistry;
  /** Audit log (for tracking session events). */
  auditLog?: AuditLog;
  /** Cooperative cancellation signal. */
  signal?: AbortSignal;
  /** Step timeout in milliseconds. */
  stepTimeoutMs?: number;
  /** Phase identifier. */
  phaseId: string;
  /** Optional API key overrides by provider. */
  apiKeys?: Record<string, string>;
  /** Mutable set of active sessions (for cooperative abort). */
  activeSessions: Set<{ abort(): Promise<void> }>;
  /** WorktreeManager for isolated git worktree execution. */
  worktreeManager?: WorktreeManager;
}

// ─── Internal resolution result ─────────────────────────────────────────────

type ResolveResult = { kind: 'runner'; runner: SessionPlanRunner } | { kind: 'skip'; reason: string };

// ─── SessionScheduler ──────────────────────────────────────────────────────

export class SessionScheduler {
  private readonly options: SessionSchedulerOptions;

  /** Inflight session-completion promises (including batch-advance handler). */
  private readonly inflight = new Set<Promise<void>>();

  /** Per-task runner instance (constructed from entry.runnerFactory on init). */
  private readonly runners = new Map<string, SessionPlanRunner>();

  /** Per-task: set of started spec indices for the current held batch. */
  private readonly batchStarted = new Map<string, Set<number>>();

  /** Per-task: accumulated error messages from failed sessions. */
  private readonly taskErrors = new Map<string, string[]>();

  /** Per-task: worktree was created (for merge/cull lifecycle). */
  private readonly worktreeCreated = new Set<string>();

  /** Per-task: worktree cwd (set when a worktree is created). */
  private readonly worktreeCwds = new Map<string, string>();

  /** Per-task: cached resolveRunner result (beforeTask hook fires once). */
  private readonly resolveCache = new Map<string, ResolveResult>();

  /** Per-task: previous status (for event-emission differentiation). */
  private readonly prevStatuses = new Map<string, TaskStatus>();

  /** Per-task: true while advanceBatch is awaiting gen.next (prevents spurious
   *  parking during the async gap — H1). */
  private readonly advancing = new Set<string>();

  /** Per-task: count of settled specs in the current held batch (O(1)
   *  isBatchComplete — E2). Reset whenever a new batch is held. */
  private readonly batchSettledCount = new Map<string, number>();

  /** Per-task: cached SessionPlanContext for plan() calls (no apiKeys — S4). */
  private readonly planCtxCache = new Map<string, SessionPlanContext>();

  /** Per-task: cached SessionPlanContext for execute() calls (with apiKeys — S4). */
  private readonly executeCtxCache = new Map<string, SessionPlanContext>();

  /** Per-task: 1-based attempt number (attempt 1 = first run; >1 = retry).
   *  Absent means the task has not been initialized yet (treated as 1). */
  private readonly taskAttempts = new Map<string, number>();

  /** Per-task: session base directory for the CURRENT attempt. Absent falls
   *  back to {@link SessionSchedulerOptions.sessionBaseDir}. Set in
   *  {@link initializeReadyTask} (attempt 1) and {@link resetForRetry} (>1). */
  private readonly taskSessionBaseDir = new Map<string, string>();

  /** Task ids currently in 'failed' status with retry budget remaining — i.e.
   *  scheduled for a blank-slate retry. Reset to 'ready' at the start of the
   *  next drain pass (then picked up by T3 like any ready task). */
  private readonly retryEligible = new Set<string>();

  /** Scoped clone of options.hookRegistry (created at start of run()). */
  private scopedHookRegistry?: HookRegistry;

  /** Why the next drain pass was triggered, for audit logging. Set at each
   *  trigger origin (gate release, session completion, abort) and reset after
   *  the drain pass consumes it. Coalescing keeps the most informative value. */
  private pendingDrainTrigger: 'init' | 'release' | 'completion' | 'abort' = 'init';

  // ── Convenience accessors ─────────────────────────────────────────────

  /** The task graph (from options). */
  private get graph(): TaskGraph {
    return this.options.graph;
  }

  /** The session gate (from options). */
  private get gate(): SessionGate {
    return this.options.gate;
  }

  // ── Coalesced drain + wake ──────────────────────────────────────────────

  private drainScheduled = false;
  private wakePromise: Promise<void> = Promise.resolve();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private wakeResolve: () => void = () => {};

  constructor(options: SessionSchedulerOptions) {
    this.options = options;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Run the scheduler: process all tasks through the gate until every task
   * reaches a terminal state, the pool deadlocks, or the signal aborts.
   *
   * @returns counts of completed and failed (failed + cancelled) tasks.
   */
  async run(): Promise<{ completedTasks: number; failedTasks: number }> {
    // Early exits.
    if (this.options.signal?.aborted) {
      return { completedTasks: 0, failedTasks: 0 };
    }
    if (this.graph.getAllTasks().length === 0) {
      return { completedTasks: 0, failedTasks: 0 };
    }

    // ── Setup ────────────────────────────────────────────────────────────
    this.scopedHookRegistry = this.options.hookRegistry?.clone();

    // Track initial statuses + fire onTaskRegister for each task.
    for (const entry of this.graph.getAllTasks()) {
      this.prevStatuses.set(entry.task.id, entry.status);
      this.options.onStatus?.onTaskRegister?.({
        taskId: entry.task.id,
        phaseId: this.options.phaseId,
        title: entry.task.title,
        dependencies: entry.task.dependencies,
      });
    }

    // Wire status-transition callback → emit onStatus events.
    this.graph.onStatusTransition = (taskId, status) => {
      const prev = this.prevStatuses.get(taskId);
      this.prevStatuses.set(taskId, status);
      this.emitStatusEvent(taskId, prev, status);
    };

    // RESUME: a task that permanently failed in a PRIOR (persisted) run gets
    // a fresh chance when the phase is re-run (e.g. via `engine resume`). A
    // freshly-built graph never carries a 'failed' status — new tasks start
    // 'ready'/'blocked' — so any 'failed' task present at run() start MUST be
    // a resumed permanent failure. Reset it to 'ready' (clearing its result)
    // so the drain loop re-attempts it with a full retry budget. This runs
    // BEFORE failDeadlockedTasks so genuinely-deadlocked tasks (missing deps)
    // are still re-detected below; a retry-exhausted task whose deps exist is
    // unaffected by failDeadlockedTasks (it only inspects 'blocked' tasks).
    // Cancelled tasks (intentional skips / aborts) are intentionally NOT
    // reset — only permanently-failed tasks get re-attempted on resume.
    for (const entry of this.graph.getAllTasks()) {
      if (entry.status === 'failed') {
        entry.task.result = undefined;
        this.taskAttempts.delete(entry.task.id);
        this.graph.setTaskStatus(entry.task.id, 'ready');
      }
    }

    // Fail deadlocked tasks (missing deps) immediately.
    this.graph.failDeadlockedTasks();

    // Wire gate.onRelease → coalesced drain trigger.
    this.gate.onRelease = () => {
      this.pendingDrainTrigger = 'release';
      this.scheduleDrain();
    };

    // Abort listener: abort active sessions + cancel remaining tasks.
    const abortActiveSessions = () => {
      for (const s of this.options.activeSessions) {
        s.abort().catch(() => {
          /* swallow — shutting down */
        });
      }
      for (const entry of this.graph.getAllTasks()) {
        if (!isTerminalTaskStatus(entry.status)) {
          this.graph.setTaskStatus(entry.task.id, 'cancelled');
          // Fire-and-forget generator cleanup so finally blocks run.
          entry.planGen?.return(undefined).catch(() => {
            /* swallow — shutting down */
          });
        }
      }
      // 'failed' is a terminal status, so the cancel loop above skips
      // retry-eligible failed tasks — but they must not be retried after an
      // abort. Clear them so the abort-triggered drain pass does not reset
      // them to 'ready' (resetRetryEligibleTasks) and re-initialize them.
      this.retryEligible.clear();
      // Wake the main loop so it exits.
      this.pendingDrainTrigger = 'abort';
      this.scheduleDrain();
    };
    this.options.signal?.addEventListener('abort', abortActiveSessions, { once: true });

    // ── Main drain loop ──────────────────────────────────────────────────
    try {
      // Resume initialization: reconstruct plan generators for tasks that
      // were mid-flight ('active' or 'parked') when the prior run ended.
      // Creates fresh generators; cached sessions return instantly via the
      // session idempotency mechanism during the subsequent drain pass.
      await this.initializeResumedTasks();

      // Initial drain — start as many sessions as possible.
      await this.drainPass();

      while (true) {
        if (this.options.signal?.aborted) break;

        // If there are in-flight sessions, wait for one to settle or for a
        // drain trigger. If none are in-flight, skip the wait and drain
        // immediately (avoids hanging on Promise.race([], freshWakePromise)).
        if (this.inflight.size > 0) {
          this.rearmWake();
          await Promise.race([...this.inflight, this.wakePromise]);
        }

        // Drain again — capacity freed or batches advanced.
        await this.drainPass();

        // After drain: if nothing is in-flight and we're not done, deadlock.
        if (this.inflight.size === 0) {
          if (this.isDone()) break;
          // False-deadlock guard: re-verify with one more drain pass.
          // Capacity may have freed during T3's async initialization,
          // or a batch-advance may have just completed.
          await this.drainPass();
          if (this.inflight.size > 0) continue;
          if (this.isDone()) break;
          // Resource deadlock — escalate.
          await this.handleResourceDeadlock();
          break;
        }
      }

      // Drain any remaining inflight sessions (e.g. after abort).
      if (this.inflight.size > 0) {
        await Promise.allSettled([...this.inflight]);
      }
    } finally {
      this.gate.onRelease = undefined;
      this.graph.onStatusTransition = undefined;
      this.options.signal?.removeEventListener('abort', abortActiveSessions);
      this.scopedHookRegistry = undefined;
    }

    // A phase that ends with permanently-failed tasks is a FAILED phase — it
    // MUST NOT advance to the next phase. Cancelled tasks (intentional skips /
    // cooperative aborts) are NOT failures and do not block advancement, so
    // only status 'failed' triggers this guard. Throw so the failure
    // propagates through the phase's run() callback → PhaseRunner → workflow,
    // aborting the run instead of continuing. (Skipped when the run was
    // aborted — in that case tasks are 'cancelled', not 'failed', but the
    // guard keeps the abort path explicit.)
    if (!this.options.signal?.aborted) {
      const failedEntries = this.graph.getAllTasks().filter((e) => e.status === 'failed');
      if (failedEntries.length > 0) {
        const ids = failedEntries.map((e) => e.task.id).join(', ');
        throw new Error(
          `Phase '${this.options.phaseId}' ended with ${failedEntries.length} permanently-failed task(s): ${ids}. Phase cannot continue — use 'engine resume' to re-attempt the failed tasks.`,
        );
      }
    }

    // Count results.
    let completedTasks = 0;
    let failedTasks = 0;
    for (const entry of this.graph.getAllTasks()) {
      if (entry.status === 'complete') completedTasks++;
      else if (entry.status === 'failed' || entry.status === 'cancelled') failedTasks++;
    }
    return { completedTasks, failedTasks };
  }

  /** Best-effort audit append: never throws, never produces an unhandled
   *  rejection. Audit failures are diagnostic — a logging failure must not
   *  affect scheduling. */
  private audit(event: Parameters<NonNullable<SessionSchedulerOptions['auditLog']>['append']>[0]): void {
    this.options.auditLog?.append(event).catch(() => {
      /* best-effort — swallow audit write failures */
    });
  }

  // ─── Coalesced drain scheduling ──────────────────────────────────────────

  /**
   * Schedule a drain pass, coalescing multiple near-simultaneous triggers
   * (completions, gate.onRelease) into ONE microtask. The microtask resolves
   * the wake signal so the main loop can re-evaluate.
   */
  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.wakeResolve();
    });
  }

  private rearmWake(): void {
    this.wakePromise = new Promise<void>((res) => {
      this.wakeResolve = res;
    });
  }

  // ─── Resume reconstruction ────────────────────────────────────────────────

  /**
   * Initialize tasks that were mid-flight ('active' or 'parked') when the
   * prior run was interrupted and are now being resumed from a reconstructed
   * TaskGraph. Async generators are not serializable, so the scheduler creates
   * a FRESH generator via `runner.plan(ctx)` and re-fetches the first batch.
   *
   * The session idempotency mechanism (`.complete` sentinel + `result.json` in
   * session.ts) ensures that specs whose sessions already completed return the
   * CACHED result instantly when `execute()` is called during the subsequent
   * drain pass — only sessions that never completed actually re-run.
   *
   * ## Resume trade-offs
   *
   * - **Determinism requirement:** `plan()` generators MUST be deterministic
   *   given the persisted session cache. If a runner's plan is non-deterministic
   *   (e.g. random branching), resume may produce a different session sequence.
   *
   * - **Incomplete sessions re-run:** sessions that were started but never
   *   completed (no `.complete` sentinel) are re-executed from scratch. For
   *   council/parallel runners, worker outputs may mix cached results (from
   *   completed siblings) with fresh results (from re-run siblings). This is
   *   acceptable per the locked design.
   *
   * - **No status change during init:** the task's status stays 'active' or
   *   'parked' — the normal drain pass handles session starting and any status
   *   transitions (parking, activation, completion).
   *
   * - **Deadlock on resume:** `failDeadlockedTasks()` (missing-dep detection)
   *   runs BEFORE this method in `run()`, so deadlocked tasks are already
   *   terminal by the time resume init runs. Resource deadlocks (all stuck,
   *   nothing in-flight) are caught by `handleResourceDeadlock()` in the main
   *   loop after the drain pass.
   */
  private async initializeResumedTasks(): Promise<void> {
    for (const entry of this.graph.getAllTasks()) {
      // Skip terminal tasks.
      if (isTerminalTaskStatus(entry.status)) continue;
      // Skip tasks already initialized (have a live generator).
      if (entry.planGen) continue;
      // 'ready' tasks are initialized by T3 in the drain pass.
      if (entry.status === 'ready') continue;
      // 'blocked' tasks wait for their dependencies to settle.
      if (entry.status === 'blocked') continue;

      // 'active' or 'parked' task without a generator — resume it.
      // initializeReadyTask handles runner resolution (beforeTask hook),
      // worktree creation, planGen creation, and first-batch fetch. If the
      // generator returns immediately (all sessions cached), the task is
      // finalized here. Otherwise heldBatch is set and the drain pass starts
      // sessions — cached ones return instantly via session idempotency.
      await this.initializeReadyTask(entry);
    }
  }

  // ─── Drain pass: greedy tiered session starter ───────────────────────────

  /**
   * The greedy tiered session-starter. Processes three tiers in priority order:
   *
   *   T1 (active): continue specs in active tasks' held batches.
   *   T2 (parked): resume parked tasks whose specs now fit gate capacity.
   *   T3 (ready):  initialize runner + first batch, start specs (lazy activate).
   *
   * Within each tier, specs are started greedily until gate capacity is
   * exhausted. A spec that can't start parks an active task (emit task_parked).
   * A parked task that resumes emits task_unparked. A ready task only becomes
   * active when its first spec actually acquires a slot (lazy activation).
   */
  private async drainPass(): Promise<void> {
    const trigger = this.pendingDrainTrigger;
    this.pendingDrainTrigger = 'completion'; // default if re-armed mid-pass
    const candidates: CandidateTrace[] = [];

    // T0: reset retry-eligible failed tasks → 'ready' (blank-slate retry).
    // Each reset increments the attempt counter, clears per-attempt execution
    // state, assigns a NEW per-attempt session base dir (preserving the failed
    // attempt's data), and transitions failed → ready. They are then picked up
    // by T3 below like any other ready task — retries are identical to ready
    // tasks for scheduling, just processed once their failed attempt settles.
    this.resetRetryEligibleTasks();

    // T1: Active tasks — continue their held batch specs.
    for (const entry of this.graph.getActiveTasks()) {
      const trace = this.tryStartBatchSpecs(entry);
      if (trace) candidates.push(trace);
    }

    // T2: Parked tasks — resume specs that now fit.
    for (const entry of this.graph.getParkedTasks()) {
      const trace = this.tryStartBatchSpecs(entry);
      if (trace) candidates.push(trace);
    }

    // T3: Ready tasks — initialize + start first specs (lazy activation).
    for (const entry of this.graph.getReadyTasks()) {
      if (!entry.heldBatch) {
        const ok = await this.initializeReadyTask(entry);
        if (!ok) {
          candidates.push({
            taskId: entry.task.id,
            status: entry.status,
            dependents: this.graph.transitiveDependentCount(entry.task.id),
            started: [],
            parkedSpecs: [],
            skipped: true,
            skipReason: 'initialize failed / finalized',
          });
          continue;
        }
      }
      // After init the task may no longer be ready (it became active, parked,
      // or terminal). Only start specs if still non-terminal with a held batch.
      if (!isTerminalTaskStatus(entry.status) && entry.heldBatch) {
        const trace = this.tryStartBatchSpecs(entry);
        if (trace) candidates.push(trace);
      }
    }

    // ── Audit: record why each candidate was started / parked / skipped. ──
    this.audit({
      type: 'scheduler_drain',
      phaseId: this.options.phaseId,
      trigger,
      gate: this.gate.snapshot(),
      candidates,
    });
  }

  // ─── Retry reset (T0) ────────────────────────────────────────────────────

  /**
   * Reset every retry-eligible 'failed' task for a blank-slate retry. Called
   * at the START of each drain pass. A task marked retry-eligible (by
   * {@link failTask}) is transitioned 'failed' → 'ready' here so T3 picks it
   * up like any ready task.
   *
   * A retry is a BLANK-SLATE re-run, NOT a resume: the per-attempt session
   * base directory changes (the failed attempt's data is preserved at its own
   * path), a fresh plan generator is created, and the worktree is recreated on
   * the SAME branch name. Failed tasks remain 'failed' between the failure and
   * this reset (i.e. until the scheduler picks them up again).
   */
  private resetRetryEligibleTasks(): void {
    if (this.retryEligible.size === 0) return;
    // Snapshot — resetForRetry mutates the set.
    for (const taskId of [...this.retryEligible]) {
      const entry = this.graph.getTask(taskId);
      if (!entry) {
        this.retryEligible.delete(taskId);
        continue;
      }
      // Only reset tasks still 'failed'. A concurrent terminal transition
      // (e.g. abort → cancelled, or permanent failure) removes retry eligibility.
      if (entry.status !== 'failed') {
        this.retryEligible.delete(taskId);
        continue;
      }
      this.resetForRetry(entry);
    }
  }

  /**
   * Reset a single 'failed' task for its next attempt: increment the attempt
   * counter, clear ALL per-attempt execution state (runners, caches, batch
   * state, worktree tracking, errors), assign a NEW per-attempt session base
   * directory, drop the stale result, and transition 'failed' → 'ready'.
   *
   * Mirrors {@link cleanupTaskState} but ALSO resets the entry's session-plan
   * fields (heldBatch, batchResults, counters) so initializeReadyTask starts
   * cleanly. The generator was already cleaned up in {@link failTask}.
   */
  private resetForRetry(entry: TaskGraphEntry): void {
    const taskId = entry.task.id;
    const attempt = (this.taskAttempts.get(taskId) ?? 1) + 1;
    this.taskAttempts.set(taskId, attempt);
    this.retryEligible.delete(taskId);

    // Clear per-attempt execution state (blank slate).
    this.clearTaskMaps(taskId);

    // Reset entry session-plan fields.
    entry.planGen = undefined;
    entry.heldBatch = undefined;
    entry.batchResults = [];
    entry.completedSessions = 0;
    entry.totalSessions = 0;
    entry.task.result = undefined;

    // NEW per-attempt session base dir (attempt 1 lives at the base; retries
    // under .retries/{taskId}/{N}/ so the failed attempt's data is preserved).
    const base = this.sessionBaseDirFor(taskId, attempt);
    this.taskSessionBaseDir.set(taskId, base);

    // Transition failed → ready. T3 initializes + starts it this drain pass.
    this.graph.setTaskStatus(taskId, 'ready');

    this.audit({
      type: 'scheduler_task_retry_reset',
      phaseId: this.options.phaseId,
      taskId,
      attempt,
      sessionBaseDir: base,
    });
  }

  /**
   * Resolve the session base directory for a given attempt of a task.
   *
   * Attempt 1 (the initial run) uses {@link SessionSchedulerOptions.sessionBaseDir}
   * directly — sessions land at `{sessionBaseDir}/{spec.id}/`. Attempts > 1
   * (retries) are namespaced under `{sessionBaseDir}/{RETRY_SUBDIR}/{taskId}/{N}/`
   * so the failed attempt's persisted sessions remain at their original paths
   * for problem tracing instead of being overwritten.
   */
  private sessionBaseDirFor(taskId: string, attempt: number): string {
    if (attempt <= 1) return this.options.sessionBaseDir;
    return join(this.options.sessionBaseDir, RETRY_SUBDIR, taskId, String(attempt));
  }

  /**
   * The session base directory currently in effect for a task (its active
   * attempt). Falls back to {@link SessionSchedulerOptions.sessionBaseDir} when
   * no per-task override is set (attempt 1 before initializeReadyTask runs).
   */
  private sessionBase(taskId: string): string {
    return this.taskSessionBaseDir.get(taskId) ?? this.options.sessionBaseDir;
  }

  // ─── Tier helper: start pending specs from a held batch ───────────────────

  /**
   * Iterate specs in the entry's held batch (in order) and start as many as
   * gate capacity allows. Already-started specs are skipped. When a spec
   * can't start:
   *   - If the task is 'active' → park it (emit task_parked).
   *   - If 'ready' or 'parked' → leave as-is (continue — try subsequent specs
   *     for mixed-profile batches that may use a different model with capacity).
   *
   * On the first successful start:
   *   - 'ready' → 'active' (emit task_started — lazy activation).
   *   - 'parked' → 'active' (emit task_unparked).
   *   - 'active' → stays active (no re-emit).
   *
   * Profile-not-found is treated the same as canStart=false (can't start).
   *
   * H1: Entries currently advancing (mid-advanceBatch) are skipped entirely —
   * their heldBatch is the old settled batch and must not be re-processed.
   * A task whose heldBatch is already fully settled is also never parked.
   */
  private tryStartBatchSpecs(entry: TaskGraphEntry): CandidateTrace | undefined {
    const trace: CandidateTrace = {
      taskId: entry.task.id,
      status: entry.status,
      dependents: this.graph.transitiveDependentCount(entry.task.id),
      started: [],
      parkedSpecs: [],
      skipped: true,
    };

    // H1: skip tasks mid-advance — their heldBatch is the old settled batch.
    if (this.advancing.has(entry.task.id)) {
      trace.skipReason = 'advancing (batch mid-advance)';
      return trace;
    }

    const batch = entry.heldBatch;
    if (!batch || batch.length === 0) {
      trace.skipReason = 'no held batch';
      return trace;
    }

    let startedAny = false;
    trace.skipped = false;

    for (let i = 0; i < batch.length; i++) {
      // Skip already-started specs. Only count toward startedAny if the spec
      // is still running (batchResults[i] is undefined). Completed specs don't
      // keep the task out of 'parked'.
      if (this.batchStarted.get(entry.task.id)?.has(i)) {
        if (entry.batchResults[i] === undefined) {
          startedAny = true; // still running — counts as active
        }
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const spec = batch[i]!;
      const profile = this.options.profiles.get(spec.profile);

      if (!profile) {
        trace.parkedSpecs.push({
          specId: spec.id,
          profile: spec.profile,
          reason: `profile '${spec.profile}' not found`,
        });
        continue;
      }
      if (!this.gate.canStart(profile)) {
        trace.parkedSpecs.push({
          specId: spec.id,
          profile: spec.profile,
          reason: buildCapacityFailureDescription(profile, this.gate.snapshot()),
        });
        continue;
      }

      // Transition status on first start of this batch run.
      if (entry.status === 'ready') {
        this.graph.setTaskStatus(entry.task.id, 'active'); // emits task_started
      } else if (entry.status === 'parked') {
        this.graph.setTaskStatus(entry.task.id, 'active'); // emits task_unparked
      }

      this.startSession(entry, i, profile);
      startedAny = true;
      trace.started.push({ specId: spec.id, profile: spec.profile });
    }

    // If the task is active and NONE of its un-started specs could start
    // (profiles missing / gate saturated / no capacity), park the task.
    // H1: never park a task whose heldBatch is already fully settled
    // (isBatchComplete) — it's about to advance.
    if (!startedAny && entry.status === 'active' && !this.isBatchComplete(entry)) {
      this.graph.setTaskStatus(entry.task.id, 'parked');
    }
    return trace;
  }

  // ─── T3 initialization: resolve runner, create worktree, get first batch ─

  /**
   * Initialize a ready task: resolve its runner (beforeTask hook), create a
   * worktree if configured, create the plan generator, and fetch the first
   * batch. Returns false if the task was skipped or finalized (no sessions
   * to run); true if a heldBatch is ready.
   */
  private async initializeReadyTask(entry: TaskGraphEntry): Promise<boolean> {
    // Resolve runner (beforeTask hook + factory fallback).
    const resolved = await this.resolveRunner(entry.task);
    if (resolved.kind === 'skip') {
      this.options.onStatus?.onTaskRejected?.({
        taskId: entry.task.id,
        title: entry.task.title,
        phaseId: this.options.phaseId,
        reason: resolved.reason,
      });
      this.graph.setTaskStatus(entry.task.id, 'cancelled');
      return false;
    }

    const runner = resolved.runner;
    this.runners.set(entry.task.id, runner);

    // Create per-task worktree if configured.
    if (this.options.worktreeManager && entry.task.worktree === 'code' && !this.worktreeCreated.has(entry.task.id)) {
      try {
        const worktreeCwd = await this.options.worktreeManager.createTaskWorktree(
          entry.task.id,
          entry.task.prompt,
          entry.task,
        );
        this.worktreeCreated.add(entry.task.id);
        this.worktreeCwds.set(entry.task.id, worktreeCwd);
      } catch (err) {
        console.warn(`[scheduler-${entry.task.id}] Failed to create worktree: ${safeErrorMessage(err)}`);
      }
    }

    // Create the plan generator and fetch the first batch.
    const agentId = `scheduler-${entry.task.id}`;
    // Record the attempt number + per-attempt session base dir. Attempt 1 uses
    // the base dir directly; retries (>1, set by resetForRetry) are namespaced
    // under .retries/{taskId}/{N}/ so the failed attempt's data is preserved.
    if (!this.taskAttempts.has(entry.task.id)) this.taskAttempts.set(entry.task.id, 1);
    const attempt = this.taskAttempts.get(entry.task.id) ?? 1;
    this.taskSessionBaseDir.set(entry.task.id, this.sessionBaseDirFor(entry.task.id, attempt));
    // E3 + S4: build and cache two contexts — plan (no apiKeys) and execute
    // (with apiKeys). plan() never needs credentials; execute() does.
    const planCtx = this.buildPlanContext(entry, agentId, false);
    const executeCtx = this.buildPlanContext(entry, agentId, true);
    this.planCtxCache.set(entry.task.id, planCtx);
    this.executeCtxCache.set(entry.task.id, executeCtx);
    entry.planGen = runner.plan(planCtx);

    // Fetch the first non-empty batch (skipping empty yields).
    let batchResult: IteratorResult<SessionSpec[], SessionResult[] | undefined>;
    try {
      batchResult = await this.nextNonEmptyBatch(entry, []);
    } catch (err) {
      // nextNonEmptyBatch can throw if the generator yielded too many empty batches.
      await this.failTask(entry, `Session plan generator error: ${safeErrorMessage(err)}`);
      return false;
    }

    if (batchResult.done) {
      // Generator returned immediately (no batches) — finalize.
      await this.finalizeTask(entry);
      return false;
    }

    entry.heldBatch = batchResult.value;
    entry.batchResults = new Array(batchResult.value.length);
    entry.totalSessions += batchResult.value.length;
    this.batchStarted.set(entry.task.id, new Set());
    this.batchSettledCount.set(entry.task.id, 0); // E2: O(1) isBatchComplete

    return true;
  }

  // ─── Start a single session ───────────────────────────────────────────────

  /**
   * Acquire a gate slot (caller verified canStart), execute the session via
   * runner.execute(), and handle completion (release, store result, advance
   * batch if complete, schedule drain).
   *
   * E1: when the session is already cached (`.complete` sentinel exists and
   * the spec is NOT a resume), the gate acquire/release is skipped entirely —
   * the runner.execute() call returns the cached result instantly.
   *
   * S1: runner.execute() is NOT wrapped in an external timeout here — freeze
   * detection is handled by the in-session watchdog inside runSession
   * (session.ts). The gate slot is ALWAYS released via try/finally so a hung
   * runner cannot leak a slot or deadlock the scheduler.
   *
   * On session settle: slot released, result stored at specIndex,
   * completedSessions incremented. When all specs in the heldBatch settle,
   * the generator is advanced (gen.next(results)).
   */
  private startSession(entry: TaskGraphEntry, specIndex: number, profile: AgentProfile): void {
    const taskId = entry.task.id;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const spec = entry.heldBatch![specIndex]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const executeCtx = this.executeCtxCache.get(taskId)!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const runner = this.runners.get(taskId)!;

    // E1: idempotency pre-check — if the session is already cached, skip gate
    // acquire/release entirely. The runner.execute() call will return the
    // cached result instantly (via runSession's idempotency mechanism).
    // Uses the per-attempt session base dir so a retry (fresh dir) never sees
    // a stale cache hit from a failed attempt.
    const cached = spec.resume !== true && isSessionCached(this.sessionBase(taskId), spec.id);

    let acquired = false;
    if (!cached) {
      // Acquire the gate slot (should always succeed — caller checked canStart).
      if (!this.gate.acquire(profile)) {
        // Race: capacity vanished between canStart and acquire. Park if active.
        if (entry.status === 'active') {
          this.graph.setTaskStatus(taskId, 'parked');
        }
        return;
      }
      acquired = true;
    }

    // Mark as started only after successful acquire (or cache hit).
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.batchStarted.get(taskId)!.add(specIndex);

    const sessionPromise = (async (): Promise<void> => {
      let result: SessionResult | undefined;
      let executeError: string | undefined;
      try {
        // The in-session inactivity watchdog (runSession, fed by stepTimeoutMs)
        // is the SINGLE authority for model-freeze detection: it RESETS on every
        // activity event and only fires when the model goes silent. A wall-clock
        // race here would fire mid-progress on legitimately long (but active)
        // sessions, leak the still-running session, poison taskErrors, and cause
        // approved tasks to be marked failed. A genuine freeze surfaces as a
        // thrown WatchdogTimeoutError from runner.execute() — handled below.
        result = await runner.execute(executeCtx, spec);
      } catch (err) {
        executeError = safeErrorMessage(err);
        const errs = this.taskErrors.get(taskId) ?? [];
        errs.push(executeError);
        this.taskErrors.set(taskId, errs);
      }

      let batchComplete = false;
      let advanced = false;
      try {
        if (executeError !== undefined) {
          // A session that throws has exhausted EVERY internal retry — the SDK
          // auto-retry ladder, the in-session watchdog resumes, and the
          // structured-output validation retries all live INSIDE runSession and
          // have already had their chances. Fail the task immediately rather
          // than storing a synthetic empty result and advancing the runner:
          // continuing would proceed to the next session in the plan (e.g. a
          // review session) with nothing to act on, masking the failure.
          await this.failTask(entry, executeError);
        } else {
          // Store the result at the spec's position (spec order preserved).
          // E2: track batchSettledCount for O(1) isBatchComplete.
          if (entry.batchResults[specIndex] === undefined) {
            const count = this.batchSettledCount.get(taskId) ?? 0;
            this.batchSettledCount.set(taskId, count + 1);
          }
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          entry.batchResults[specIndex] = result!;
          entry.completedSessions++;

          // If the entire batch has settled, advance the generator.
          batchComplete = this.isBatchComplete(entry);
          if (batchComplete) {
            await this.advanceBatch(entry);
            advanced = true;
          }
        }
      } catch (err) {
        // advanceBatch (gen.next) threw — convert to task failure.
        const errorMsg = `Session plan generator error: ${safeErrorMessage(err)}`;
        const errs = this.taskErrors.get(taskId) ?? [];
        errs.push(errorMsg);
        this.taskErrors.set(taskId, errs);
        // Force terminal: finalize the task as failed.
        await this.failTask(entry, errorMsg);
      } finally {
        // S1: ALWAYS release the gate slot (even on throw/timeout).
        //
        // The release is deferred until AFTER batch advancement (not in the
        // execute-finally) so the completing task retains first claim on its
        // own freed slot for the next session. Releasing before advance let a
        // ready (T3) task steal the slot during the advancing window, parking
        // an active task that had capacity for its continuation. With the
        // release here, the post-advance drain processes the active task (T1)
        // before ready tasks (T3), letting it reclaim the slot it just freed.
        // (Slot accounting is unaffected: every successful acquire is still
        // matched by exactly one release on this path.)
        if (acquired) this.gate.release(profile);
      }

      // ── Audit: record this session's settle outcome + batch effect. ──────
      this.audit({
        type: 'scheduler_session_settle',
        phaseId: this.options.phaseId,
        taskId,
        specId: spec.id,
        profile: spec.profile,
        success: executeError === undefined,
        ...(executeError !== undefined ? { error: executeError } : {}),
        batchComplete,
        advanced,
      });

      // Schedule a drain — capacity freed and/or batch advanced.
      this.pendingDrainTrigger = 'completion';
      this.scheduleDrain();
    })();

    this.inflight.add(sessionPromise);
    sessionPromise.then(
      () => this.inflight.delete(sessionPromise),
      () => this.inflight.delete(sessionPromise),
    );
  }

  // ─── Batch advancement ───────────────────────────────────────────────────

  /**
   * Returns true when every spec in the held batch has settled (started AND
   * has a result).
   *
   * E2: O(1) — uses batchSettledCount (incremented when batchResults[i]
   * transitions undefined→defined) instead of scanning the results array.
   */
  private isBatchComplete(entry: TaskGraphEntry): boolean {
    const batch = entry.heldBatch;
    if (!batch || batch.length === 0) return true;

    const started = this.batchStarted.get(entry.task.id);
    if (!started || started.size < batch.length) return false;

    return (this.batchSettledCount.get(entry.task.id) ?? 0) === batch.length;
  }

  /**
   * Advance the plan generator: pass the current batch's results (in spec
   * order) to gen.next(results). If the generator yields a new batch, store
   * it as the new heldBatch. If done, finalize the task.
   *
   * H1: sets the `advancing` flag for the duration of the async gen.next call
   * so a coalesced drainPass doesn't try to start/park on the OLD settled
   * heldBatch.
   */
  private async advanceBatch(entry: TaskGraphEntry): Promise<void> {
    const taskId = entry.task.id;
    this.advancing.add(taskId);
    try {
      const results = [...entry.batchResults] as SessionResult[];
      const next = await this.nextNonEmptyBatch(entry, results);

      if (next.done) {
        await this.finalizeTask(entry);
        return;
      }

      // New batch — reset per-batch state.
      entry.heldBatch = next.value;
      entry.batchResults = new Array(next.value.length);
      entry.totalSessions += next.value.length;
      this.batchStarted.set(taskId, new Set());
      this.batchSettledCount.set(taskId, 0); // E2: O(1) isBatchComplete
    } finally {
      this.advancing.delete(taskId);
    }
  }

  /**
   * Fetch the next non-empty batch from the plan generator, skipping empty
   * yields (`[]`). Throws if the generator yields more than
   * {@link MAX_EMPTY_BATCHES} consecutive empty batches (infinite-loop guard).
   */
  private async nextNonEmptyBatch(
    entry: TaskGraphEntry,
    seed: SessionResult[],
  ): Promise<IteratorResult<SessionSpec[], SessionResult[] | undefined>> {
    let emptyCount = 0;
    // S2: wrap gen.next in a timeout race so a hanging generator can't block
    // the scheduler. Accept a leaked generator over blocking.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    let next = await withTimeout(entry.planGen!.next(seed), GENERATOR_TIMEOUT_MS, 'plan generator next()');
    while (!next.done && next.value.length === 0) {
      emptyCount++;
      if (emptyCount > MAX_EMPTY_BATCHES) {
        throw new Error(`Session plan generator yielded ${emptyCount}+ empty batches without completing`);
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      next = await withTimeout(entry.planGen!.next([]), GENERATOR_TIMEOUT_MS, 'plan generator next()');
    }
    return next;
  }

  // ─── Task finalization ──────────────────────────────────────────────────

  /**
   * Fail a task: push the error message, cull the worktree (best-effort),
   * clean up the plan generator, and route the failure.
   *
   * When `retryable` is true (the default — execution failures: a session
   * execute()/plan-generator/merge throw) AND the task still has retry budget
   * ({@link MAX_RETRIES}), the task is left in 'failed' status and marked
   * retry-eligible. The NEXT drain pass resets it to 'ready' for a blank-slate
   * retry: a fresh plan generator, a NEW per-attempt session base directory
   * (the failed attempt's data is preserved), and a fresh worktree on the SAME
   * branch name. Blocked dependents are NOT promoted (the task may yet succeed).
   *
   * When `retryable` is false (structural failures: resource deadlock) OR the
   * retry budget is exhausted, the failure is PERMANENT: status set 'failed',
   * blocked dependents promoted via {@link TaskGraph.recalculateReady}.
   *
   * This is the single failure path used by finalizeTask (merge failure), the
   * session IIFE (execute throw / gen.next throw), initializeReadyTask (plan
   * generator error), and {@link handleResourceDeadlock}. Callers must NOT
   * cull the worktree before/after calling failTask — culling is owned here.
   */
  private async failTask(entry: TaskGraphEntry, errorMsg: string, retryable = true): Promise<void> {
    const taskId = entry.task.id;

    // Defensive: if the task already reached a terminal state (e.g., cancelled
    // by abort), don't overwrite it.
    if (isTerminalTaskStatus(entry.status)) return;

    // Accumulate the error.
    const errs = this.taskErrors.get(taskId) ?? [];
    errs.push(errorMsg);
    this.taskErrors.set(taskId, errs);

    // Cull the worktree (best-effort). This is the single cull owner for all
    // failure paths — callers must NOT cull before/after calling failTask.
    // On a retry, initializeReadyTask recreates a fresh worktree on the SAME
    // branch name (engin/{mainSlug}--{taskId}), so culling here is correct.
    await this.cullWorktree(taskId);

    entry.task.result = { completed: false, error: errs.join('; ') };

    // Determine whether this failure is retryable.
    const attempt = this.taskAttempts.get(taskId) ?? 1;
    const retriesLeft = MAX_RETRIES - (attempt - 1); // attempt 1 → 3 retries left
    const willRetry = retryable && retriesLeft > 0;

    if (willRetry) {
      // Retry-eligible: stay 'failed' until the next drain resets it.
      this.retryEligible.add(taskId);
      this.graph.setTaskStatus(taskId, 'failed');
      // Do NOT recalculateReady — dependents stay blocked (task may yet
      // succeed on retry). They are promoted only on permanent failure.
      this.audit({
        type: 'scheduler_task_retry_scheduled',
        phaseId: this.options.phaseId,
        taskId,
        attempt,
        retriesLeft,
        error: errs.join('; '),
      });
    } else {
      // Permanent failure.
      this.retryEligible.delete(taskId);
      this.graph.setTaskStatus(taskId, 'failed');
      this.graph.recalculateReady(taskId);
      this.audit({
        type: 'scheduler_task_failed_permanent',
        phaseId: this.options.phaseId,
        taskId,
        attempt,
        reason: retryable ? 'retry budget exhausted' : 'non-retryable failure',
        error: errs.join('; '),
      });
      // The task is permanently terminal — release per-task state (fix 8).
      // Safe now: entry.task.result (with the aggregated error) is already set.
      this.cleanupTaskState(taskId);
    }

    // Clean up the plan generator so any finally blocks run. On a retry,
    // initializeReadyTask creates a fresh generator (the old one is dropped).
    await this.cleanupGenerator(taskId);
  }

  /**
   * Finalize a task on NORMAL plan completion: handle the worktree merge, then
   * mark the task 'complete'. Reached only when the runner's plan generator
   * returns normally (advanceBatch's `next.done` / initializeReadyTask's
   * `batchResult.done`). A session that throws routes through {@link failTask}
   * INSTEAD — so reaching here means every session in the plan succeeded and
   * the plan genuinely completed.
   *
   * Accumulated {@link taskErrors} are NOT consulted here: with session throws
   * routed to failTask, a task only reaches finalizeTask when all its sessions
   * returned results normally. Per-session errors remain visible in the audit
   * trail via `scheduler_session_settle` events, so they are diagnosable.
   *
   * The only other failure path from here is a worktree merge failure
   * (delegated to {@link failTask}). Triggers recalculateReady so blocked
   * dependents promote.
   */
  private async finalizeTask(entry: TaskGraphEntry): Promise<void> {
    const taskId = entry.task.id;

    // Defensive: if the task already reached a terminal state (e.g., cancelled
    // by abort), don't overwrite it.
    if (isTerminalTaskStatus(entry.status)) return;

    // Worktree lifecycle. failTask is the single cull owner, so we only
    // handle the merge-on-success path here; failure culling is delegated to
    // failTask.
    if (this.worktreeCreated.has(taskId) && this.options.worktreeManager) {
      // Merge on success.
      let mergeFailed = false;
      let mergeErrMsg = '';
      try {
        const mergeResult = await this.options.worktreeManager.mergeTaskBranch(taskId);
        if (!mergeResult.success) {
          mergeFailed = true;
          mergeErrMsg = 'Worktree merge failed';
        }
      } catch (err) {
        mergeFailed = true;
        mergeErrMsg = safeErrorMessage(err);
      }
      if (mergeFailed) {
        await this.failTask(entry, mergeErrMsg);
        return;
      }
    }

    entry.task.result = { completed: true };
    this.graph.setTaskStatus(taskId, 'complete');
    // Promote blocked dependents whose deps are now all settled.
    this.graph.recalculateReady(taskId);
    // The task is permanently terminal — release per-task state (fix 8).
    this.cleanupTaskState(taskId);

    // Clean up the plan generator so any finally blocks run.
    await this.cleanupGenerator(taskId);
  }

  // ─── Worktree cull helper ────────────────────────────────────────────────

  /**
   * Cull a task's worktree (best-effort). This is the single cull owner —
   * all failure paths go through failTask, which calls this. Callers must
   * NOT cull before/after calling failTask.
   */
  private async cullWorktree(taskId: string): Promise<void> {
    if (this.worktreeCreated.has(taskId) && this.options.worktreeManager) {
      try {
        await this.options.worktreeManager.cullTaskWorktree(taskId);
      } catch (err) {
        const msg = safeErrorMessage(err);
        console.warn(`[scheduler-${taskId}] Worktree cull failed: ${msg}`);
      }
    }
  }

  // ─── Per-task map clearing ─────────────────────────────────────────────

  /**
   * Clear the per-task execution-state Map/Set entries shared by both the
   * retry-reset path ({@link resetForRetry}) and the permanent-terminal
   * cleanup path ({@link cleanupTaskState}).
   *
   * This is exactly the 10-field intersection of the two paths. The fields
   * that diverge between them — `retryEligible`, `taskSessionBaseDir`, and
   * `taskAttempts` — are owned by each caller and deliberately NOT touched
   * here.
   */
  private clearTaskMaps(taskId: string): void {
    this.batchStarted.delete(taskId);
    this.batchSettledCount.delete(taskId);
    this.resolveCache.delete(taskId);
    this.runners.delete(taskId);
    this.planCtxCache.delete(taskId);
    this.executeCtxCache.delete(taskId);
    this.advancing.delete(taskId);
    this.worktreeCreated.delete(taskId);
    this.worktreeCwds.delete(taskId);
    this.taskErrors.delete(taskId);
  }

  // ─── Generator cleanup helper ────────────────────────────────────────────

  /**
   * Call `planGen.return()` on a task's session-plan generator, if one
   * exists and isn't already done. This lets the generator run any `finally`
   * blocks, releasing resources.
   *
   * S2: wrapped in a timeout race so a hanging generator finally/await can't
   * block the scheduler. Accept a leaked generator over blocking.
   *
   * Safe to call multiple times — calling `.return()` on a generator that
   * has already completed or been `.return()`ed is a no-op.
   */
  private async cleanupGenerator(taskId: string): Promise<void> {
    const entry = this.graph.getTask(taskId);
    if (!entry?.planGen) return;
    try {
      await withTimeout(entry.planGen.return(undefined), GENERATOR_TIMEOUT_MS, 'plan generator return()');
    } catch (err) {
      console.warn(`[scheduler-${taskId}] Generator cleanup failed: ${safeErrorMessage(err)}`);
    }
  }

  /** Per-task state cleanup: delete all scheduler-side map entries for a task
   *  that has reached a terminal state. Bounds memory across long runs (fix 8). */
  private cleanupTaskState(taskId: string): void {
    this.clearTaskMaps(taskId);
    // Retry state (cleared once the task is permanently terminal).
    this.retryEligible.delete(taskId);
    this.taskSessionBaseDir.delete(taskId);
    // taskAttempts is retained for result/audit reporting even after terminal.
  }

  // ─── Runner resolution (beforeTask hook + factory fallback) ──────────────

  /**
   * Resolve a SessionPlanRunner for the given task.
   *
   * Resolution order:
   * 1. When a scoped hookRegistry with at least one `beforeTask` subscriber is
   *    present, invoke the first-wins hook seeded with `{ task }`.
   *    - `{ skip: true }` → skip (cancel) the task.
   *    - `{ runner: ... }` → use the provided runner.
   *    - `undefined` → abstain (fall through).
   * 2. Fall through to the entry's runnerFactory.
   *
   * Results are cached per task so beforeTask fires once.
   */
  private async resolveRunner(task: Task): Promise<ResolveResult> {
    const cached = this.resolveCache.get(task.id);
    if (cached) return cached;

    const entry = this.graph.getTask(task.id);
    if (!entry) {
      const result: ResolveResult = { kind: 'skip', reason: `Task "${task.id}" not found` };
      this.resolveCache.set(task.id, result);
      return result;
    }

    const hookRegistry = this.scopedHookRegistry;
    if (hookRegistry && hookRegistry.hasSubscribers('beforeTask')) {
      let result: Record<string, unknown> | undefined;
      try {
        result = (await hookRegistry.invokeFirstWins('beforeTask', { task }, {
          registry: hookRegistry,
          cwd: this.options.cwd,
          workDir: this.options.cwd,
          signal: this.options.signal,
        } satisfies HookContext)) as Record<string, unknown> | undefined;
      } catch (err) {
        // Hook threw — log warning and treat as abstain.
        console.warn(`[scheduler-${task.id}] beforeTask hook threw: ${safeErrorMessage(err)}`);
        result = undefined;
      }

      if (result?.skip === true) {
        const reason = typeof result.reason === 'string' ? result.reason : 'Skipped by beforeTask hook';
        const resolved: ResolveResult = { kind: 'skip', reason };
        this.resolveCache.set(task.id, resolved);
        return resolved;
      }
      if (result && typeof result.runner === 'object' && result.runner !== null) {
        const resolved: ResolveResult = {
          kind: 'runner',
          runner: result.runner as SessionPlanRunner,
        };
        this.resolveCache.set(task.id, resolved);
        return resolved;
      }
    }

    // Fall through to entry's runnerFactory.
    const resolved: ResolveResult = { kind: 'runner', runner: entry.runnerFactory() };
    this.resolveCache.set(task.id, resolved);
    return resolved;
  }

  // ─── Status event emission ───────────────────────────────────────────────

  /**
   * Emit onStatus events based on a status transition. Differentiates
   * ready→active (task_started) from parked→active (task_unparked).
   */
  private emitStatusEvent(taskId: string, prev: TaskStatus | undefined, status: TaskStatus): void {
    const entry = this.graph.getTask(taskId);
    if (!entry) return;
    const { title } = entry.task;
    const agentId = `scheduler-${taskId}`;
    const phaseId = this.options.phaseId;

    switch (status) {
      case 'active':
        if (prev === 'parked') {
          this.options.onStatus?.onTaskUnparked?.({ taskId, title, agentId, phaseId });
        } else {
          this.options.onStatus?.onTaskStart?.({ taskId, title, agentId, phaseId });
        }
        break;
      case 'complete':
        this.options.onStatus?.onTaskComplete?.({ taskId, title, phaseId });
        break;
      case 'failed':
        this.options.onStatus?.onTaskRejected?.({
          taskId,
          title,
          phaseId,
          reason: ((entry.task.result as { error?: string } | undefined)?.error as string | undefined) ?? 'task failed',
        });
        break;
      case 'cancelled':
        this.options.onStatus?.onTaskRejected?.({
          taskId,
          title,
          phaseId,
          reason: 'task cancelled',
        });
        break;
      case 'parked':
        this.options.onStatus?.onTaskParked?.({ taskId, title, agentId, phaseId });
        break;
      // 'ready' and 'blocked' have no dedicated onStatus events.
    }
  }

  // ─── Resource deadlock detection ─────────────────────────────────────────

  /**
   * Returns true when every task is in a terminal state (complete / failed /
   * cancelled) AND no failed task is awaiting a blank-slate retry. A
   * retry-eligible 'failed' task is NOT done — the run continues so the next
   * drain pass can reset and re-run it.
   */
  private isDone(): boolean {
    if (this.retryEligible.size > 0) return false;
    for (const entry of this.graph.getAllTasks()) {
      if (!isTerminalTaskStatus(entry.status)) return false;
    }
    return true;
  }

  /**
   * Resource deadlock: drainPass started nothing, nothing is in-flight, but
   * non-terminal tasks remain. This happens when tasks are stuck (e.g., spec
   * references a profile that doesn't exist, or all remaining tasks are
   * blocked/parked with no path forward). Route each stuck task through
   * failTask so generator cleanup and status transitions are handled
   * consistently.
   */
  private async handleResourceDeadlock(): Promise<void> {
    for (const entry of this.graph.getAllTasks()) {
      if (!isTerminalTaskStatus(entry.status)) {
        // Structural failure — non-retryable (a deadlock will recur every
        // attempt; retrying would only burn the budget).
        await this.failTask(
          entry,
          `resource deadlock: task "${entry.task.id}" cannot start (status: ${entry.status})`,
          false,
        );
      }
    }
  }

  // ─── Timeout helper (delegates to the standalone utility) ───────────────

  /**
   * Race a promise against a timeout. Thin delegate over the standalone
   * {@link withTimeout} utility in `scheduler-timeout.ts`, retained so the
   * scheduler surface stays backward-compatible. The implementation lives in
   * the extracted module so workflow code outside the scheduler can reuse it.
   */
  private withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T> {
    return withTimeout(p, ms, label);
  }

  // ─── Context builder ─────────────────────────────────────────────

  /**
   * Build a SessionPlanContext from the scheduler options + entry state.
   * Includes worktreeCwd when a worktree was created for this task.
   *
   * @param includeApiKeys - When true (default), apiKeys from options are
   *   included in the context. Pass false for plan() which never needs
   *   credentials (S4 security boundary).
   */
  private buildPlanContext(entry: TaskGraphEntry, agentId: string, includeApiKeys = true): SessionPlanContext {
    const worktreeCwd = this.worktreeCwds.get(entry.task.id);
    const ctx: SessionPlanContext = {
      task: entry.task,
      profiles: this.options.profiles,
      sessionBaseDir: this.sessionBase(entry.task.id),
      cwd: this.options.cwd,
      activeSessions: this.options.activeSessions,
      phaseId: this.options.phaseId,
      agentId,
    };
    if (worktreeCwd !== undefined) ctx.worktreeCwd = worktreeCwd;
    if (includeApiKeys && this.options.apiKeys) ctx.apiKeys = this.options.apiKeys;
    if (this.options.onStatus) ctx.onStatus = this.options.onStatus;
    if (this.scopedHookRegistry) ctx.hookRegistry = this.scopedHookRegistry;
    if (this.options.rendererRegistry) ctx.rendererRegistry = this.options.rendererRegistry;
    if (this.options.auditLog) ctx.auditLog = this.options.auditLog;
    if (this.options.signal) ctx.signal = this.options.signal;
    if (this.options.stepTimeoutMs !== undefined) ctx.stepTimeoutMs = this.options.stepTimeoutMs;
    return ctx;
  }
}
