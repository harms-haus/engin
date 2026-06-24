import { EventEmitter } from 'node:events';
import { appendReviewFeedback } from '../core/task-feedback.js';
import type { Task, TaskStatus } from '../core/types.js';

export class TaskTracker extends EventEmitter {
  static readonly Events = {
    TaskReady: 'taskReady' as const,
    TaskSettled: 'taskSettled' as const,
    TaskClaimed: 'taskClaimed' as const,
  };

  private static readonly EMPTY_SET: ReadonlySet<string> = new Set();

  private tasks: Map<string, Task>;
  private reverseDeps: Map<string, Set<string>>;
  private warnedDeadlocked = new Set<string>();
  /**
   * Memoized transitive-dependents map (taskId → set of tasks that transitively
   * depend on it). A pure function of the dependency topology, so it is rebuilt
   * lazily and only invalidated when the topology changes. See
   * {@link getTransitiveDependents}.
   */
  private transitiveDependents: Map<string, Set<string>> | null = null;

  constructor() {
    super();
    this.tasks = new Map();
    this.reverseDeps = new Map();
  }

  addTask(task: Omit<Task, 'status'> & { status?: TaskStatus }): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task with id "${task.id}" already exists`);
    }

    const deps = task.dependencies ?? [];

    // Insert temporarily, then check for cycles. Roll back on failure.
    const status: TaskStatus =
      task.status ??
      (deps.every((dep) => {
        const depTask = this.tasks.get(dep);
        return depTask !== undefined && TaskTracker.isSettled(depTask.status);
      })
        ? 'ready'
        : 'blocked');

    const fullTask: Task = { ...task, dependencies: deps, status };

    // Temporarily insert to check for cycles
    this.tasks.set(fullTask.id, fullTask);

    // Build reverse dependency entries
    for (const dep of deps) {
      this.addReverseDep(dep, fullTask.id);
    }

    try {
      this.detectCycle(fullTask.id);
    } catch (err) {
      this.tasks.delete(fullTask.id);
      // Roll back reverse dependency entries
      for (const dep of deps) {
        this.removeReverseDep(dep, fullTask.id);
      }
      throw new Error(`Dependency cycle detected involving task "${fullTask.id}"`, { cause: err });
    }

    this.recalculateStatuses(fullTask.id);
  }

  private addReverseDep(parentId: string, childId: string): void {
    const set = this.reverseDeps.get(parentId);
    if (set) {
      set.add(childId);
    } else {
      this.reverseDeps.set(parentId, new Set([childId]));
    }
    // Topology changed: the memoized transitive-dependents map is now stale.
    this.transitiveDependents = null;
  }

  private removeReverseDep(parentId: string, childId: string): void {
    const set = this.reverseDeps.get(parentId);
    if (set) {
      set.delete(childId);
      if (set.size === 0) this.reverseDeps.delete(parentId);
    }
    // Topology changed: the memoized transitive-dependents map is now stale.
    this.transitiveDependents = null;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getReadyTasks(): Task[] {
    // Collect ready tasks in insertion order (Map iteration order).
    const ready: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'ready') {
        ready.push(task);
      }
    }
    // The comparator ranks ONLY by blocking pressure; equal-pressure tasks
    // compare as 0. Array.prototype.sort is stable (ES2019+), so those ties
    // keep their insertion order above — i.e. first-added first-served. This
    // is the documented secondary ordering for tasks that don't block (or
    // block the same amount of) downstream work. Do NOT re-collect out of
    // insertion order without revisiting this invariant.
    return ready.sort((a, b) => this.compareByBlockingPressure(a, b));
  }

  /**
   * Ordering comparator for ready tasks, used to decide which task a lane
   * claims next when several are available.
   *
   * Prefers tasks that relieve the most "blocking pressure": a task with many
   * downstream dependents is claimed before one with few (or none), so that
   * completing it unblocks — or at least advances — the largest amount of
   * pending work. Leaf tasks (nothing depends on them) sink to the bottom and
   * are only chosen once no task with dependents remains ready.
   *
   * The pressure metric counts *transitive* dependents, so it correctly
   * prefers a task even when finishing it won't immediately unblock anything
   * (e.g. a dependent still has other unsatisfied dependencies): every
   * completed predecessor still reduces the dependent's remaining blockers.
   *
   * This is the ONLY ranking key. Tasks with equal pressure compare as 0, and
   * {@link getReadyTasks} relies on the stability of `Array.prototype.sort`
   * to keep them in insertion order (first-to-last). Do NOT add secondary keys
   * such as dependency count or alphabetical id here — that would override the
   * intended first-added-first-served tiebreak (and previously caused tasks
   * with fewer dependencies to be starved in favor of lighter ones, which is
   * not the desired behavior).
   */
  private compareByBlockingPressure(a: Task, b: Task): number {
    const pressureA = this.getTransitiveDependentCount(a.id);
    const pressureB = this.getTransitiveDependentCount(b.id);
    // Descending: a task that unblocks more downstream work is claimed first.
    // Equal pressure → 0 → stable sort preserves insertion order (first-to-last).
    return pressureB - pressureA;
  }

  /**
   * Count of tasks that transitively depend on `id` — every task reachable from
   * `id` through the reverse-dependency graph. Used to gauge blocking pressure.
   */
  private getTransitiveDependentCount(id: string): number {
    return this.getTransitiveDependents().get(id)?.size ?? 0;
  }

  /**
   * Build (once, then memoize) a map of each task → the set of all tasks that
   * transitively depend on it. Derived purely from the dependency topology, so
   * it is safe to cache across status changes; it is invalidated whenever the
   * topology changes (see {@link addReverseDep} / {@link removeReverseDep}).
   */
  private getTransitiveDependents(): Map<string, Set<string>> {
    if (this.transitiveDependents) return this.transitiveDependents;

    const result = new Map<string, Set<string>>();
    for (const start of this.tasks.keys()) {
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

  /**
   * Returns up to `count` ready tasks whose status is set to `active` and
   * whose `assignedAgent` is set to `agentId`.
   *
   * **Mutable reference aliasing:** The returned array contains direct
   * references to the internal `Task` objects stored in this tracker — not
   * copies. Callers may safely mutate the following fields on the returned
   * objects without going through a tracker method:
   *
   * - `reviewFeedback` — accumulated by the lane pool after each rejected
   *   review to persist all feedback entries across retries.
   *
   * All other task mutations (status transitions, `result`, `assignedAgent`)
   * **must** go through the corresponding tracker methods (`claimTasks`,
   * `completeTask`, `failTask`, `rejectTask`, `cancelTask`) to ensure
   * correct state transitions, dependency recalculation, and event emission.
   */
  claimTasks(count: number, agentId: string): Task[] {
    const ready = this.getReadyTasks();
    const toClaim = ready.slice(0, count);

    for (const task of toClaim) {
      task.status = 'active';
      task.assignedAgent = agentId;
      this.warnedDeadlocked.delete(task.id);
    }

    if (toClaim.length > 0) {
      // Persist the 'active' status so an interrupted run can be resumed —
      // without this, in-flight tasks show as 'ready' on disk and the resume
      // path can't tell them apart from never-started tasks.
      queueMicrotask(() => this.emit(TaskTracker.Events.TaskClaimed));
    }

    return toClaim;
  }

  /**
   * Mark a task as complete. The optional `result` (e.g. the agent's final
   * output) is stored on `task.result` so downstream phases can read it back —
   * mirroring how `failTask` stores its result. Without this, consumers that
   * collect outputs via `task.result` (e.g. scouting reports) read `undefined`
   * and the data is silently lost.
   */
  completeTask(id: string, result?: unknown): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'active') {
      throw new Error(`Task "${id}" must be "active" to complete, got "${task.status}"`);
    }

    task.status = 'complete';
    task.result = result;
    this.warnedDeadlocked.delete(id);
    this.recalculateStatuses(id);
    queueMicrotask(() => this.emit(TaskTracker.Events.TaskSettled));
  }

  failTask(id: string, result?: unknown): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'active') {
      throw new Error(`Task "${id}" must be "active" to fail, got "${task.status}"`);
    }

    task.status = 'failed';
    task.result = result;
    task.assignedAgent = undefined;
    this.warnedDeadlocked.delete(id);
    this.recalculateStatuses(id);
    queueMicrotask(() => this.emit(TaskTracker.Events.TaskSettled));
  }

  /**
   * Reset a single `failed` task back to `ready` so a lane can re-claim and
   * re-run it from step 1. Throws unless the task is currently `failed`.
   *
   * Emits `TaskReady` so waiting lanes wake up to re-claim the task.
   *
   * Unlike {@link resetFailedTasks} (which resets every failed task and is
   * used on resume), this targets one task and is used by the LanePool for
   * same-run retries. The tracker is session-agnostic, so clearing of any
   * persisted session data is the caller's responsibility.
   */
  resetTaskForRetry(id: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'failed') {
      throw new Error(`Task "${id}" must be "failed" to reset for retry, got "${task.status}"`);
    }

    task.status = 'ready';
    task.assignedAgent = undefined;
    task.result = undefined;
    task.reviewFeedback = undefined;
    queueMicrotask(() => this.emit(TaskTracker.Events.TaskReady));
  }

  rejectTask(id: string, reason: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'active') {
      throw new Error(`Task "${id}" must be "active" to reject, got "${task.status}"`);
    }

    appendReviewFeedback(task, reason);
    queueMicrotask(() => this.emit(TaskTracker.Events.TaskReady));
  }

  cancelTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (TaskTracker.isSettled(task.status)) {
      throw new Error(`Task "${id}" is already settled (${task.status}) and cannot be cancelled`);
    }

    task.status = 'cancelled';
    this.warnedDeadlocked.delete(id);
    queueMicrotask(() => this.emit(TaskTracker.Events.TaskSettled));
  }

  resetFailedTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'failed') {
        task.status = 'ready';
        task.assignedAgent = undefined;
        task.result = undefined;
        task.reviewFeedback = undefined;
        this.warnedDeadlocked.delete(task.id);
      }
    }
  }

  resetStuckTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'active') {
        task.status = 'ready';
        task.assignedAgent = undefined;
        task.result = undefined;
        task.reviewFeedback = undefined;
        this.warnedDeadlocked.delete(task.id);
      }
    }
  }

  recalculateStatuses(hintTaskId?: string): void {
    let transitioned = false;
    const candidates = hintTaskId ? (this.reverseDeps.get(hintTaskId) ?? TaskTracker.EMPTY_SET) : this.tasks.keys();

    for (const id of candidates) {
      const task = this.tasks.get(id);
      if (!task || task.status !== 'blocked') continue;
      const allDepsSettled = task.dependencies.every((dep) => {
        const depTask = this.tasks.get(dep);
        return depTask !== undefined && TaskTracker.isSettled(depTask.status);
      });
      if (allDepsSettled) {
        task.status = 'ready';
        transitioned = true;
      }
    }

    if (transitioned) {
      queueMicrotask(() => this.emit(TaskTracker.Events.TaskReady));
    }
  }

  toJSON(): { tasks: Task[] } {
    return { tasks: this.getAllTasks() };
  }

  resetForRetry(): void {
    this.resetFailedTasks();
    this.resetStuckTasks();
  }

  static fromJSON(data: { tasks: Task[] }, options?: { preserveState?: boolean }): TaskTracker {
    const tracker = new TaskTracker();
    for (const task of data.tasks) {
      tracker.tasks.set(task.id, structuredClone(task));
    }
    // Build reverse dependency index
    for (const task of tracker.tasks.values()) {
      for (const dep of task.dependencies) {
        tracker.addReverseDep(dep, task.id);
      }
    }
    // Validate no cycles in deserialized data
    for (const id of tracker.tasks.keys()) {
      tracker.detectCycle(id);
    }
    if (!options?.preserveState) {
      tracker.resetForRetry();
    }
    tracker.recalculateStatuses();
    return tracker;
  }

  /**
   * Returns all tasks whose `phaseId` matches the given value.
   */
  getTasksByPhase(phaseId: string): Task[] {
    const result: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.phaseId === phaseId) {
        result.push(task);
      }
    }
    return result;
  }

  /**
   * Returns the unique phase IDs in insertion order.
   */
  getPhases(): string[] {
    const seen = new Set<string>();
    const phases: string[] = [];
    for (const task of this.tasks.values()) {
      if (!seen.has(task.phaseId)) {
        seen.add(task.phaseId);
        phases.push(task.phaseId);
      }
    }
    return phases;
  }

  /**
   * Validates referential integrity of all dependency references.
   *
   * Every id listed in each task's `dependencies` array must correspond to a
   * task that exists in this tracker. Throws with a descriptive message if
   * any violations are found.
   *
   * This is distinct from cycle detection (handled by `addTask` at insert
   * time) — this method only checks that dependency IDs exist.
   */
  validateAllDependencies(): void {
    const violations: { taskId: string; missingDeps: string[] }[] = [];

    for (const task of this.tasks.values()) {
      const missingDeps = task.dependencies.filter((dep) => !this.tasks.has(dep));
      if (missingDeps.length > 0) {
        violations.push({ taskId: task.id, missingDeps });
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map(({ taskId, missingDeps }) => `"${taskId}" → missing: [${missingDeps.map((d) => `"${d}"`).join(', ')}]`)
        .join('; ');
      throw new Error(`Dependency integrity check failed: ${details}`);
    }
  }

  /**
   * Single-pass check for the lane loop hot path.
   *
   * Returns `true` when every task is settled (`complete` / `failed` / `cancelled`) or
   * blocked with at least one missing dependency (deadlocked). An empty
   * tracker is considered done.
   *
   * **SIDE EFFECT:** This is NOT a pure read — when it encounters a `blocked`
   * task whose dependencies reference non-existent tasks (a deadlock), it
   * mutates that task to `failed` with a descriptive `result.error` string
   * starting with `'deadlocked:'`, and emits `TaskSettled`. The mutation is
   * idempotent (guarded by `warnedDeadlocked`), so repeat calls do not
   * re-fail or re-emit. Callers that expect a read-only predicate should be
   * aware of this side effect.
   */
  isPoolDone(): boolean {
    let settledDeadlock = false;
    if (this.tasks.size === 0) return true;
    for (const task of this.tasks.values()) {
      const s = task.status;
      if (TaskTracker.isSettled(s)) continue;
      if (s === 'blocked') {
        const missing = task.dependencies.filter((d) => !this.tasks.has(d));
        if (missing.length > 0) {
          if (!this.warnedDeadlocked.has(task.id)) {
            this.warnedDeadlocked.add(task.id);
            console.warn(
              `[TaskTracker] Task "${task.id}" is blocked with missing dependencies: ${missing.join(', ')} — treating as deadlocked`,
            );
            // Mark deadlocked task as failed so it counts in run results
            // instead of silently staying blocked forever.
            task.status = 'failed';
            task.result = { completed: false, error: `deadlocked: missing dependency ${missing.join(', ')}` };
            settledDeadlock = true;
          }
          continue;
        }
      }
      return false;
    }
    if (settledDeadlock) {
      queueMicrotask(() => this.emit(TaskTracker.Events.TaskSettled));
    }
    return true;
  }

  private static isSettled(status: TaskStatus): boolean {
    return status === 'complete' || status === 'failed' || status === 'cancelled';
  }

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

      const task = this.tasks.get(id);
      if (task) {
        for (const dep of task.dependencies) {
          if (this.tasks.has(dep)) {
            dfs(dep);
          }
        }
      }

      stack.delete(id);
    };

    dfs(startId);
  }
}
