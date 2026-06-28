// ─── TaskGraph: DAG + Status + Dependency Pressure ─────────────────────────
//
// TaskGraph is the scheduler-facing task model that supersedes the status /
// dependency-tracking portions of the old TaskTracker (task-status.ts). It
// owns:
//
//   - The task DAG (forward + reverse dependency indices).
//   - Per-task status transitions (blocked / ready / parked / active /
//     complete / failed / cancelled).
//   - Blocking-pressure ranking via memoized transitive-dependent counts
//     (reverse-topology DFS).
//   - Kahn's-algorithm cycle detection at insert time.
//   - Deadlock detection: blocked tasks whose dependency ids don't exist in
//     the graph are marked failed via the onStatusTransition callback.
//
// Unlike TaskTracker, TaskGraph does NOT emit Node EventEmitter events.
// Status transitions are surfaced exclusively through the optional
// `onStatusTransition` callback, which the scheduler sets to emit events
// (or drive UI updates) in whatever way it sees fit.
//
// Each task is wrapped in a {@link TaskGraphEntry} that also carries the
// runner factory + scheduler-managed session-plan state (held batch, results,
// counters). TaskGraph is responsible ONLY for the status/DAG fields; the
// session-plan fields are mutated externally by the scheduler.

import { isTerminalTaskStatus } from '@engin/shared';
import type { TaskStatus } from '@engin/shared/types';
import type { Task } from '../core/types.js';
import type { SessionPlanRunner } from './runners/session-plan-types.js';
import type { SessionResult, SessionSpec } from './session.js';

// ─── Entry type ────────────────────────────────────────────────────────────

/**
 * A task plus its scheduler-managed session-plan state.
 *
 * The `task` and `status` fields are owned by {@link TaskGraph} (DAG + status
 * transitions). The runner / session-plan fields are mutated externally by the
 * scheduler:
 *
 *   - `runnerFactory` — constructs a fresh {@link SessionPlanRunner} when the
 *     task becomes active.
 *   - `planGen` — the live async generator (from `runner.plan(ctx)`) while the
 *     task is executing.
 *   - `heldBatch` — the current `SessionSpec[]` the scheduler is executing.
 *   - `batchResults` — results collected for the held batch so far.
 *   - `completedSessions` / `totalSessions` — scheduler-maintained counters.
 */
export interface TaskGraphEntry {
  /** The underlying task definition. */
  task: Task;
  /** Factory that constructs a fresh SessionPlanRunner instance. */
  runnerFactory: () => SessionPlanRunner;
  /** Current status (mirrors `task.status` — kept in sync by {@link TaskGraph}). */
  status: TaskStatus;
  /** Live async generator from `runner.plan(ctx)`, while the task is executing. */
  planGen?: AsyncGenerator<SessionSpec[], SessionResult[] | undefined>;
  /** The currently-held batch of SessionSpecs being executed by the scheduler. */
  heldBatch?: SessionSpec[];
  /** Results collected for the held batch so far (in spec order). */
  batchResults: SessionResult[];
  /** Count of settled (completed or failed) session `execute()` calls. */
  completedSessions: number;
  /** Total count of SessionSpecs yielded across all batches so far. */
  totalSessions: number;
}

// ─── TaskGraph ─────────────────────────────────────────────────────────────

/**
 * A task dependency graph (DAG) with status tracking and blocking-pressure
 * ranking.
 *
 * The graph maintains:
 *
 *   - A forward index (task id → entry).
 *   - A reverse-dependency index (dep id → set of tasks that depend on it).
 *   - A memoized transitive-dependents map (task id → set of all tasks that
 *     transitively depend on it), invalidated on any topology change.
 *
 * Status transitions are surfaced through the optional
 * {@link onStatusTransition} callback — TaskGraph does NOT emit Node events.
 */
export class TaskGraph {
  private entries = new Map<string, TaskGraphEntry>();
  private reverseDeps = new Map<string, Set<string>>();
  /**
   * Memoized transitive-dependents map (taskId → set of tasks that transitively
   * depend on it). A pure function of the dependency topology, so it is rebuilt
   * lazily and only invalidated when the topology changes (addTask). See
   * {@link buildTransitiveDependents}.
   */
  private transitiveDependents: Map<string, Set<string>> | null = null;

  /**
   * Optional callback invoked on every status transition. Set by the scheduler
   * to emit status events or drive UI updates.
   */
  onStatusTransition?: (taskId: string, status: TaskStatus) => void;

  // ─── Insertion ──────────────────────────────────────────────────────────

  /**
   * Add a task to the graph. Assigns initial status:
   *
   *   - `'ready'`   — when all dependencies are settled (complete / failed /
   *                   cancelled) or the task has no dependencies.
   *   - `'blocked'` — when any dependency is unsettled or doesn't exist yet.
   *
   * Runs Kahn's-algorithm cycle detection and THROWS on a cycle. The reverse-
   * dependency index and transitive-dependents cache are updated.
   */
  addTask(task: Task, runnerFactory: () => SessionPlanRunner): void {
    if (this.entries.has(task.id)) {
      throw new Error(`Task with id "${task.id}" already exists`);
    }

    const deps = task.dependencies ?? [];
    // Preserve a pre-existing SETTLED status (complete / failed / cancelled)
    // — used when resuming a run where tasks already reached a terminal
    // state. Otherwise assign 'ready' (all deps settled) or 'blocked' (any
    // dep unsettled / missing).
    const status: TaskStatus =
      task.status !== undefined && TaskGraph.isSettled(task.status)
        ? task.status
        : this.allDepsSettled(deps)
          ? 'ready'
          : 'blocked';

    const entry: TaskGraphEntry = {
      task: { ...task, dependencies: deps, status },
      runnerFactory,
      status,
      batchResults: [],
      completedSessions: 0,
      totalSessions: 0,
    };

    // Insert temporarily, then check for cycles. Roll back on failure.
    this.entries.set(task.id, entry);

    for (const dep of deps) {
      this.addReverseDep(dep, task.id);
    }

    try {
      this.detectCycle(task.id);
    } catch (err) {
      this.entries.delete(task.id);
      for (const dep of deps) {
        this.removeReverseDep(dep, task.id);
      }
      throw new Error(`Dependency cycle detected involving task "${task.id}"`, { cause: err });
    }

    // Recalculate blocked dependents: a newly-added task with a pre-settled
    // status (e.g. 'complete' on resume) should auto-promote its blocked
    // dependents — matching the semantics of TaskTracker.addTask.
    this.recalculateReady(task.id);
  }

  /**
   * Add multiple tasks in a single batch. Each task is inserted in order;
   * cycle detection runs after each insertion (so a cycle among the batch is
   * caught at the point it forms).
   *
   * Each task may optionally carry a `runnerFactory`; when omitted, a no-op
   * factory is used (suitable for tests / status-only graphs).
   */
  addTasks(...tasks: (Task & { runnerFactory?: () => SessionPlanRunner })[]): void {
    for (const t of tasks) {
      const { runnerFactory, ...task } = t;
      this.addTask(task, runnerFactory ?? this.makeNoopRunnerFactory());
    }
  }

  // ─── Lookup ─────────────────────────────────────────────────────────────

  /**
   * Returns the {@link TaskGraphEntry} for `id`, or `undefined`. The returned
   * entry is a live reference to the internal object (same aliasing contract as
   * {@link getAllTasks}).
   */
  getTask(id: string): TaskGraphEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Returns all entries in insertion order. The returned array contains live
   * references to the internal entry objects.
   */
  getAllTasks(): TaskGraphEntry[] {
    return Array.from(this.entries.values());
  }

  // ─── Status queries ────────────────────────────────────────────────────

  /**
   * Returns tasks currently in `'ready'` status, sorted DESC by
   * {@link transitiveDependentCount} (blocking pressure). Equal-pressure tasks
   * keep their insertion order (stable FIFO tiebreak) — this relies on the
   * stability of `Array.prototype.sort` (ES2019+).
   *
   * Only NEVER-started ready tasks are returned (status exactly `'ready'`).
   */
  getReadyTasks(): TaskGraphEntry[] {
    const ready: TaskGraphEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === 'ready') {
        ready.push(entry);
      }
    }
    // The comparator ranks ONLY by blocking pressure; equal-pressure tasks
    // compare as 0. Array.prototype.sort is stable (ES2019+), so ties keep
    // their insertion order (first-added first-served). Do NOT add secondary
    // keys — that would override the intended FIFO tiebreak.
    return ready.sort((a, b) => this.transitiveDependentCount(b.task.id) - this.transitiveDependentCount(a.task.id));
  }

  /**
   * Returns tasks currently in `'parked'` status, sorted DESC by
   * {@link transitiveDependentCount}. Equal-pressure tasks keep insertion order.
   */
  getParkedTasks(): TaskGraphEntry[] {
    const parked: TaskGraphEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === 'parked') {
        parked.push(entry);
      }
    }
    return parked.sort((a, b) => this.transitiveDependentCount(b.task.id) - this.transitiveDependentCount(a.task.id));
  }

  /**
   * Returns tasks currently in `'active'` status, in insertion order.
   */
  getActiveTasks(): TaskGraphEntry[] {
    const active: TaskGraphEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === 'active') {
        active.push(entry);
      }
    }
    return active;
  }

  // ─── Status transitions ─────────────────────────────────────────────────

  /**
   * Transition a task's status. Updates both the entry's `status` field and
   * `task.status` (kept in sync). Invokes {@link onStatusTransition} when the
   * status actually changes (no callback for no-op transitions).
   *
   * Does NOT emit events — the scheduler owns event emission via the callback.
   */
  setTaskStatus(id: string, status: TaskStatus): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Task "${id}" not found`);
    if (entry.status === status) return;

    entry.status = status;
    entry.task.status = status;
    this.onStatusTransition?.(id, status);
  }

  // ─── Dependency recalculation ───────────────────────────────────────────

  /**
   * Recalculate the status of blocked dependents. When a dependency settles
   * (complete / failed / cancelled), this transitions blocked tasks whose
   * dependencies are now ALL settled from `'blocked'` → `'ready'`.
   *
   * @param depsHint — when provided, only dependents of this task id are
   *                   checked. When omitted, ALL blocked tasks are scanned.
   */
  recalculateReady(depsHint?: string): void {
    const candidates: Iterable<string> = depsHint ? (this.reverseDeps.get(depsHint) ?? EMPTY_SET) : this.entries.keys();

    for (const id of candidates) {
      const entry = this.entries.get(id);
      if (!entry || entry.status !== 'blocked') continue;
      if (this.allDepsSettled(entry.task.dependencies)) {
        this.setTaskStatus(id, 'ready');
      }
    }
  }

  // ─── Blocking pressure ──────────────────────────────────────────────────

  /**
   * Count of tasks that transitively depend on `id` — every task reachable from
   * `id` through the reverse-dependency graph. Used to gauge blocking pressure.
   *
   * Backed by a memoized map that is invalidated on any topology change
   * ({@link addTask}). Safe to call repeatedly; the first call after a topology
   * change rebuilds the full map.
   */
  transitiveDependentCount(id: string): number {
    return this.buildTransitiveDependents().get(id)?.size ?? 0;
  }

  // ─── Deadlock detection ─────────────────────────────────────────────────

  /**
   * Fail blocked tasks whose dependency ids don't exist in the graph (a
   * deadlock — the dependency will never settle because it was never added).
   * Marks each such task `'failed'` via {@link setTaskStatus} (which invokes
   * {@link onStatusTransition}).
   *
   * Idempotent: tasks already marked failed are skipped.
   */
  failDeadlockedTasks(): void {
    for (const entry of this.entries.values()) {
      if (entry.status !== 'blocked') continue;
      const missing = entry.task.dependencies.filter((dep) => !this.entries.has(dep));
      if (missing.length > 0) {
        entry.task.result = {
          completed: false,
          error: `deadlocked: missing dependency ${missing.join(', ')}`,
        };
        this.setTaskStatus(entry.task.id, 'failed');
      }
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private static readonly isSettled = isTerminalTaskStatus;

  /**
   * Returns `true` when every dep in `deps` is present in the graph AND settled.
   * A missing dep → `false` (the task stays blocked until the dep is added).
   */
  private allDepsSettled(deps: string[]): boolean {
    return deps.every((dep) => {
      const depEntry = this.entries.get(dep);
      return depEntry !== undefined && TaskGraph.isSettled(depEntry.status);
    });
  }

  // DUPLICATE of TaskTracker.addReverseDep — keep in sync until task D1 removes TaskTracker.
  private addReverseDep(parentId: string, childId: string): void {
    const set = this.reverseDeps.get(parentId);
    if (set) {
      set.add(childId);
    } else {
      this.reverseDeps.set(parentId, new Set([childId]));
    }
    // Topology changed: memoized transitive-dependents map is now stale.
    this.transitiveDependents = null;
  }

  // DUPLICATE of TaskTracker.removeReverseDep — keep in sync until task D1 removes TaskTracker.
  private removeReverseDep(parentId: string, childId: string): void {
    const set = this.reverseDeps.get(parentId);
    if (set) {
      set.delete(childId);
      if (set.size === 0) this.reverseDeps.delete(parentId);
    }
    this.transitiveDependents = null;
  }

  // DUPLICATE of TaskTracker.getTransitiveDependents — keep in sync until task D1 removes TaskTracker.
  /**
   * Build (once, then memoize) a map of each task → the set of all tasks that
   * transitively depend on it. Derived purely from the dependency topology, so
   * it is safe to cache across status changes; invalidated whenever the topology
   * changes (see {@link addReverseDep} / {@link removeReverseDep}).
   */
  private buildTransitiveDependents(): Map<string, Set<string>> {
    if (this.transitiveDependents) return this.transitiveDependents;

    const result = new Map<string, Set<string>>();
    for (const start of this.entries.keys()) {
      const reached = new Set<string>();
      // DFS over the reverse-dependency graph: every task that transitively
      // depends on `start` accumulates into `reached`.
      const stack: string[] = [...(this.reverseDeps.get(start) ?? [])];
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) continue; // guarded by stack.length > 0
        if (reached.has(current)) continue;
        reached.add(current);
        const dependents = this.reverseDeps.get(current);
        if (dependents) for (const dep of dependents) stack.push(dep);
      }
      result.set(start, reached);
    }

    this.transitiveDependents = result;
    return result;
  }

  // DUPLICATE of TaskTracker.detectCycle — keep in sync until task D1 removes TaskTracker.
  /**
   * Single-source cycle detection using Kahn's-algorithm-style DFS coloring.
   * Throws when a back-edge (cycle) is detected starting from `startId`.
   */
  private detectCycle(startId: string): void {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (id: string): void => {
      if (stack.has(id)) {
        throw new Error(`Cycle detected at "${id}"`);
      }
      if (visited.has(id)) return;

      visited.add(id);
      stack.add(id);

      const entry = this.entries.get(id);
      if (entry) {
        for (const dep of entry.task.dependencies) {
          if (this.entries.has(dep)) {
            dfs(dep);
          }
        }
      }

      stack.delete(id);
    };

    dfs(startId);
  }

  /** Default no-op runner factory used by {@link addTasks} when the caller
   *  passes bare Task objects without a `runnerFactory`. */
  private makeNoopRunnerFactory(): () => SessionPlanRunner {
    return () => ({
      plan: async function* () {
        yield [];
        return [];
      },
      execute: async () => ({ mode: 'text', text: '' }),
    });
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();
