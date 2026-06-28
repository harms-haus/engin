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

import { isTerminalTaskStatus } from '@engin/shared';
import type { TaskStatus } from '@engin/shared/types';

import type { RendererRegistry } from '../core/renderer-registry.js';
import type { AgentProfile, StatusCallbacks, Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import type { WorktreeManager } from '../core/worktree-manager.js';
import type { HookContext, HookRegistry } from '../hooks/types.js';
import type { AuditLog } from '../tracking/audit-log.js';

import type { SessionPlanContext, SessionPlanRunner } from './runners/session-plan-types.js';
import type { SessionGate } from './session-gate.js';
import type { SessionResult, SessionSpec } from './session.js';
import { isSessionCached } from './session.js';
import type { TaskGraph, TaskGraphEntry } from './task-graph.js';

// ─── Internal constants ───────────────────────────────────────────────────

/** Grace period for plan-generator operations (gen.next / gen.return) before
 *  the scheduler gives up and treats the operation as hung. A leaked
 *  generator is preferred over blocking the scheduler indefinitely. */
const GENERATOR_TIMEOUT_MS = 5_000;

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

  /** Scoped clone of options.hookRegistry (created at start of run()). */
  private scopedHookRegistry?: HookRegistry;

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

    // Fail deadlocked tasks (missing deps) immediately.
    this.graph.failDeadlockedTasks();

    // Wire gate.onRelease → coalesced drain trigger.
    this.gate.onRelease = () => this.scheduleDrain();

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
      // Wake the main loop so it exits.
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

    // Count results.
    let completedTasks = 0;
    let failedTasks = 0;
    for (const entry of this.graph.getAllTasks()) {
      if (entry.status === 'complete') completedTasks++;
      else if (entry.status === 'failed' || entry.status === 'cancelled') failedTasks++;
    }
    return { completedTasks, failedTasks };
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
    // T1: Active tasks — continue their held batch specs.
    for (const entry of this.graph.getActiveTasks()) {
      this.tryStartBatchSpecs(entry);
    }

    // T2: Parked tasks — resume specs that now fit.
    for (const entry of this.graph.getParkedTasks()) {
      this.tryStartBatchSpecs(entry);
    }

    // T3: Ready tasks — initialize + start first specs (lazy activation).
    for (const entry of this.graph.getReadyTasks()) {
      if (!entry.heldBatch) {
        const ok = await this.initializeReadyTask(entry);
        if (!ok) continue; // task was skipped or finalized
      }
      // After init the task may no longer be ready (it became active, parked,
      // or terminal). Only start specs if still non-terminal with a held batch.
      if (!isTerminalTaskStatus(entry.status) && entry.heldBatch) {
        this.tryStartBatchSpecs(entry);
      }
    }
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
  private tryStartBatchSpecs(entry: TaskGraphEntry): void {
    // H1: skip tasks mid-advance — their heldBatch is the old settled batch.
    if (this.advancing.has(entry.task.id)) return;

    const batch = entry.heldBatch;
    if (!batch || batch.length === 0) return;

    let startedAny = false;

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

      if (!profile || !this.gate.canStart(profile)) {
        // Can't start this spec — try subsequent specs (mixed-profile batches
        // may have a different model that still has capacity).
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
    }

    // If the task is active and NONE of its un-started specs could start
    // (profiles missing / gate saturated / no capacity), park the task.
    // H1: never park a task whose heldBatch is already fully settled
    // (isBatchComplete) — it's about to advance.
    if (!startedAny && entry.status === 'active' && !this.isBatchComplete(entry)) {
      this.graph.setTaskStatus(entry.task.id, 'parked');
    }
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
   * S1: runner.execute() is wrapped in a timeout race so a hanging runner
   * can't leak a gate slot / deadlock the scheduler. The gate slot is ALWAYS
   * released (try/finally around execute).
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
    const cached = spec.resume !== true && isSessionCached(this.options.sessionBaseDir, spec.id);

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
      let result: SessionResult;
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
        const errorMsg = safeErrorMessage(err);
        const errs = this.taskErrors.get(taskId) ?? [];
        errs.push(errorMsg);
        this.taskErrors.set(taskId, errs);
        result = { mode: 'text', text: '' };
      }

      // Store the result at the spec's position (spec order preserved).
      // E2: track batchSettledCount for O(1) isBatchComplete.
      if (entry.batchResults[specIndex] === undefined) {
        const count = this.batchSettledCount.get(taskId) ?? 0;
        this.batchSettledCount.set(taskId, count + 1);
      }
      entry.batchResults[specIndex] = result;
      entry.completedSessions++;

      try {
        // If the entire batch has settled, advance the generator.
        if (this.isBatchComplete(entry)) {
          await this.advanceBatch(entry);
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

      // Schedule a drain — capacity freed and/or batch advanced.
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
   * yields (`[]`). Throws if the generator yields more than 1000 consecutive
   * empty batches (infinite-loop guard).
   */
  private async nextNonEmptyBatch(
    entry: TaskGraphEntry,
    seed: SessionResult[],
  ): Promise<IteratorResult<SessionSpec[], SessionResult[] | undefined>> {
    const maxEmpty = 1000;
    let emptyCount = 0;
    // S2: wrap gen.next in a timeout race so a hanging generator can't block
    // the scheduler. Accept a leaked generator over blocking.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    let next = await this.withTimeout(entry.planGen!.next(seed), GENERATOR_TIMEOUT_MS, 'plan generator next()');
    while (!next.done && next.value.length === 0) {
      emptyCount++;
      if (emptyCount > maxEmpty) {
        throw new Error(`Session plan generator yielded ${emptyCount}+ empty batches without completing`);
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      next = await this.withTimeout(entry.planGen!.next([]), GENERATOR_TIMEOUT_MS, 'plan generator next()');
    }
    return next;
  }

  // ─── Task finalization ──────────────────────────────────────────────────

  /**
   * Fail a task: push the error message, cull the worktree (best-effort),
   * set terminal status to 'failed', and promote blocked dependents.
   *
   * This is the single failure path used by finalizeTask, the session IIFE
   * (when advanceBatch/gen.next throws), and any future failure sites.
   */
  private async failTask(entry: TaskGraphEntry, errorMsg: string): Promise<void> {
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
    await this.cullWorktree(taskId);

    entry.task.result = { completed: false, error: errs.join('; ') };
    this.graph.setTaskStatus(taskId, 'failed');
    this.graph.recalculateReady(taskId);

    // Clean up the plan generator so any finally blocks run.
    await this.cleanupGenerator(taskId);
  }

  /**
   * Finalize a task: handle worktree merge/cull, then set terminal status
   * ('complete' or 'failed') based on accumulated session errors. Triggers
   * recalculateReady so blocked dependents can promote.
   */
  private async finalizeTask(entry: TaskGraphEntry): Promise<void> {
    const taskId = entry.task.id;

    // Defensive: if the task already reached a terminal state (e.g., cancelled
    // by abort), don't overwrite it.
    if (isTerminalTaskStatus(entry.status)) return;

    const errors = this.taskErrors.get(taskId);
    const hasErrors = errors !== undefined && errors.length > 0;

    // Worktree lifecycle. failTask is the single cull owner, so we only
    // handle the merge-on-success path here; failure culling is delegated to
    // failTask.
    if (!hasErrors && this.worktreeCreated.has(taskId) && this.options.worktreeManager) {
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

    if (hasErrors) {
      await this.failTask(entry, errors.join('; '));
      // failTask handles generator cleanup.
    } else {
      entry.task.result = { completed: true };
      this.graph.setTaskStatus(taskId, 'complete');
      // Promote blocked dependents whose deps are now all settled.
      this.graph.recalculateReady(taskId);
      // Clean up the plan generator so any finally blocks run.
      await this.cleanupGenerator(taskId);
    }
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
      await this.withTimeout(entry.planGen.return(undefined), GENERATOR_TIMEOUT_MS, 'plan generator return()');
    } catch {
      // Swallow — generator cleanup failures (including timeout) shouldn't propagate.
    }
  }

  /** Per-task state cleanup: delete all scheduler-side map entries for a task
   *  that has reached a terminal state. Bounds memory across long runs (fix 8). */
  private cleanupTaskState(taskId: string): void {
    this.batchStarted.delete(taskId);
    this.batchSettledCount.delete(taskId);
    this.resolveCache.delete(taskId);
    this.runners.delete(taskId);
    this.planCtxCache.delete(taskId);
    this.executeCtxCache.delete(taskId);
    this.advancing.delete(taskId);
    this.worktreeCreated.delete(taskId);
    this.worktreeCwds.delete(taskId);
    // taskErrors is left for result aggregation but can be cleared after terminal.
    this.taskErrors.delete(taskId);
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
        this.options.onStatus?.onTaskComplete?.({ taskId, title });
        break;
      case 'failed':
        this.options.onStatus?.onTaskRejected?.({
          taskId,
          title,
          reason: ((entry.task.result as { error?: string } | undefined)?.error as string | undefined) ?? 'task failed',
        });
        break;
      case 'cancelled':
        this.options.onStatus?.onTaskRejected?.({
          taskId,
          title,
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
   * cancelled).
   */
  private isDone(): boolean {
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
        await this.failTask(entry, `resource deadlock: task "${entry.task.id}" cannot start (status: ${entry.status})`);
      }
    }
  }

  // ─── Timeout helper ─────────────────────────────────────────────────────

  /**
   * Race a promise against a timeout. If the timeout fires first, the returned
   * promise rejects with an Error mentioning `label`. Used by S1 (runner.execute
   * timeout) and S2 (planGen.next/return timeout) to prevent a hanging runner
   * or generator from blocking the scheduler indefinitely.
   */
  private withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(label ? `${label} timed out after ${ms}ms` : `Timed out after ${ms}ms`));
      }, ms);
      // Don't let the timeout timer keep the process alive.
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as { unref?(): void }).unref?.();
      }
      p.then(
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // ─── Context builder ─────────────────────────────────────────────────────

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
      sessionBaseDir: this.options.sessionBaseDir,
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
