// ─── SessionPlan Runner Contract Types ─────────────────────────────────────
//
// This module defines the SessionPlan runner contract that supersedes the
// old runner types (now removed).
//
// The SessionPlan contract decouples *planning* (what sessions to run) from
// *scheduling* (when to start them, subject to gate capacity). A runner is an
// async generator that yields batches of SessionSpecs. The scheduler consumes
// those batches, starts as many sessions as the gate allows, and feeds the
// settled SessionResults back into the generator to advance it.
//
// Key design points:
//
//   - The runner does NOT own a gate or call runSession directly. The
//     scheduler owns the gate and calls `runner.execute()` for each spec.
//   - A batch is ATOMIC: the generator cannot advance to the next yield until
//     every spec in the current batch has settled.
//   - Sessions that cannot start immediately (gate at capacity) PARK the task
//     (status 'parked'); already-started siblings in the same batch continue
//     running. The parked task is resumed when a slot frees up.
//
// Re-exports SessionSpec and SessionResult from ../session.js for convenience
// so consumers can import everything they need from this single module.

import type { RendererRegistry } from '../../core/renderer-registry.js';
import type { AgentProfile, StatusCallbacks, Task } from '../../core/types.js';
import type { HookRegistry } from '../../hooks/types.js';
import type { AuditLog } from '../../tracking/audit-log.js';
import type { SessionResult, SessionSpec } from '../session.js';

export type { SessionResult, SessionSpec };

// ─── Context ──────────────────────────────────────────────────────────────

/** Context passed to a SessionPlanRunner's `plan()` and `execute()` methods.
 *
 *  Unlike the old runner contract, this does NOT include a `gate`, a
 *  `runSession` function, or `maxTaskRetries`. The scheduler owns the gate and
 *  invokes `execute()` for each spec — the runner never acquires or releases
 *  gate slots itself. */
export interface SessionPlanContext {
  /** The task being executed. */
  task: Task;
  /** Resolved agent profiles keyed by profile id. */
  profiles: Map<string, AgentProfile>;
  /** Base directory for persisted session storage. */
  sessionBaseDir: string;
  /** Working directory for agent operations. */
  cwd: string;
  /** Optional per-task worktree path. When set, agent sessions run inside the
   *  isolated worktree. `undefined` when no worktree is in use. */
  worktreeCwd?: string;
  /** Optional API key overrides by provider. */
  apiKeys?: Record<string, string>;
  /** Mutable set of active sessions (for cooperative abort). */
  activeSessions: Set<{ abort(): Promise<void> }>;
  /** Status callback handlers (onSessionStart / onSessionComplete / agent-status
   *  forwarding). */
  onStatus?: StatusCallbacks;
  /** Hook registry (for lifecycle hooks). */
  hookRegistry?: HookRegistry;
  /** Renderer registry (for output rendering). */
  rendererRegistry?: RendererRegistry;
  /** Audit log (for tracking session events). */
  auditLog?: AuditLog;
  /** Cooperative cancellation signal. */
  signal?: AbortSignal;
  /** Step timeout in milliseconds (passed through to session execution). */
  stepTimeoutMs?: number;
  /** Phase identifier (propagated to lifecycle callbacks). */
  phaseId: string;
  /** Agent identifier (propagated to lifecycle callbacks). */
  agentId: string;
}

// ─── Runner interface ─────────────────────────────────────────────────────

/**
 * The SessionPlan runner contract.
 *
 * A runner is a stateful object with two methods: `plan()` and `execute()`.
 * Runners are constructed via factories (see {@link SessionPlanFactory}) so
 * each task gets a fresh runner instance.
 *
 * ## Contract
 *
 * ### `plan(ctx)` — async generator yielding batches
 *
 * Returns an async generator that yields **batches** of `SessionSpec[]`. The
 * generator is driven by the scheduler according to the following protocol:
 *
 * 1. The scheduler calls `gen.next()` (with no argument) to start the
 *    generator and receive the **first batch** (`SessionSpec[]`). It HOLDS
 *    that batch — it does not immediately call `gen.next()` again.
 *
 * 2. The scheduler starts as many sessions in the held batch as gate capacity
 *    allows (via `gate.canStart()` — a {@link SessionGate} method — plus
 *    `gate.acquire()`). Sessions that cannot start immediately (gate at
 *    capacity) cause the task to be **PARKED** (status `'parked'`).
 *    Already-started siblings in the batch **continue running** — they are
 *    not paused or cancelled.
 *
 * 3. The scheduler calls `gen.next(results)` to **ADVANCE** the generator and
 *    receive the next batch ONLY once the **ENTIRE current batch has settled**
 *    (every spec has either completed or failed). The `results` argument is
 *    `SessionResult[]` — one result per spec, **in spec order**. The
 *    generator uses these results to decide what (if anything) to yield next.
 *
 * 4. When the generator returns (its `return` value), it MAY provide a final
 *    `SessionResult[]` — the terminal results for all sessions in the plan.
 *    A `return` value of `undefined` means the runner does not aggregate
 *    terminal results (the scheduler tracks them itself).
 *
 * ### `sessionPeek` (scheduler-side concept)
 *
 * "The currently-held batch" — i.e. the `SessionSpec[]` most recently yielded
 * by `gen.next()` that the scheduler is actively executing. The scheduler does
 * NOT call `gen.next()` just to peek; it inspects the held batch directly.
 *
 * **Note:** This is NOT a runner method or property. The runner has no
 * `sessionPeek` member. The scheduler holds the batch reference as part of
 * its own state.
 *
 * ### Batch atomicity
 *
 * A batch is ATOMIC: the generator cannot advance (the scheduler will not call
 * `gen.next(results)`) until ALL specs in the batch have settled. A session
 * that is blocked on gate capacity PARKS THE TASK (status `'parked'`); the
 * already-started siblings in the batch continue running and must settle
 * before the generator advances.
 *
 * ### `totalSessions` / `completedSessions` (scheduler-tracked counts)
 *
 * These are counters maintained by the **scheduler**, not the runner:
 *
 *   - `totalSessions` = the count of SessionSpecs yielded so far across all
 *     batches (may grow for coordinators that yield additional batches based
 *     on intermediate results).
 *   - `completedSessions` = the count of settled (completed or failed)
 *     `execute()` calls.
 *
 * The runner does NOT expose or track these counters itself. The scheduler
 * infers them from the batches it receives and the results it collects.
 *
 * ### `execute(ctx, spec)` — run a single session
 *
 * Runs one `SessionSpec` and returns its `SessionResult`.
 *
 * **IMPORTANT:** `execute()` must NOT acquire the gate itself. The scheduler
 * acquires the gate slot BEFORE calling `execute()` and releases it AFTER the
 * session settles. This ensures capacity is enforced centrally by the
 * scheduler, not duplicated in every runner.
 */
export interface SessionPlanRunner {
  /**
   * Plan the sessions for a task as an async generator yielding batches.
   *
   * Each `yield` produces a `SessionSpec[]` batch. The scheduler feeds back
   * `SessionResult[]` (one per spec, in order) via `gen.next(results)` once
   * the entire batch has settled. The generator's `return` value may be a
   * final `SessionResult[]` or `undefined`.
   *
   * @param ctx - The session plan context (no gate — the scheduler owns it).
   * @yields `SessionSpec[]` batches.
   * @returns A final `SessionResult[]` or `undefined`.
   */
  plan(ctx: SessionPlanContext): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]>;

  /**
   * Execute a single session spec.
   *
   * The scheduler acquires the gate slot BEFORE calling this method and
   * releases it AFTER the returned promise settles. This method must NOT
   * acquire or release the gate itself.
   *
   * @param ctx - The session plan context.
   * @param spec - The session specification to execute.
   * @returns The session result.
   */
  execute(ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult>;
}

// ─── Factory ──────────────────────────────────────────────────────────────

/**
 * Factory that constructs a fresh {@link SessionPlanRunner} instance.
 *
 * Runners are stateful (they track plan progress across batches), so each task
 * gets its own runner instance via the factory. This prevents cross-task
 * state leakage and allows the scheduler to construct a runner lazily when a
 * task becomes active.
 */
export type SessionPlanFactory = () => SessionPlanRunner;
