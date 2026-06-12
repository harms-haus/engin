import { EventEmitter } from 'node:events';
import type { Task, TaskStatus } from '../core/types.js';
import { appendReviewFeedback } from '../core/utils.js';

export class TaskTracker extends EventEmitter {
  static readonly Events = {
    TaskReady: 'taskReady' as const,
    TaskSettled: 'taskSettled' as const,
  };

  private static readonly EMPTY_SET: ReadonlySet<string> = new Set();

  private tasks: Map<string, Task>;
  private reverseDeps: Map<string, Set<string>>;
  private warnedDeadlocked = new Set<string>();

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
  }

  private removeReverseDep(parentId: string, childId: string): void {
    const set = this.reverseDeps.get(parentId);
    if (set) {
      set.delete(childId);
      if (set.size === 0) this.reverseDeps.delete(parentId);
    }
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getReadyTasks(): Task[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.status === 'ready')
      .sort((a, b) => a.dependencies.length - b.dependencies.length || a.id.localeCompare(b.id));
  }

  /**
   * Returns up to `count` ready tasks whose status is set to `claimed`.
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
   * **must** go through the corresponding tracker methods (`startTask`,
   * `submitForReview`, `completeTask`, `failTask`, `rejectTask`) to ensure
   * correct state transitions, dependency recalculation, and event emission.
   */
  claimTasks(count: number): Task[] {
    const ready = this.getReadyTasks();
    const toClaim = ready.slice(0, count);

    for (const task of toClaim) {
      task.status = 'claimed';
    }

    return toClaim;
  }

  startTask(id: string, agentId: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'claimed') {
      throw new Error(`Task "${id}" must be "claimed" to start, got "${task.status}"`);
    }

    task.status = 'implementing';
    task.assignedAgent = agentId;
  }

  submitForReview(id: string, result: unknown): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'implementing') {
      throw new Error(`Task "${id}" must be "implementing" to submit for review, got "${task.status}"`);
    }

    task.status = 'reviewing';
    task.result = result;
  }

  completeTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'reviewing') {
      throw new Error(`Task "${id}" must be "reviewing" to complete, got "${task.status}"`);
    }

    task.status = 'done';
    this.recalculateStatuses(id);
    this.emit(TaskTracker.Events.TaskSettled);
  }

  failTask(id: string, result?: unknown): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'implementing' && task.status !== 'reviewing') {
      throw new Error(`Task "${id}" must be "implementing" or "reviewing" to fail, got "${task.status}"`);
    }

    task.status = 'failed';
    task.result = result;
    task.assignedAgent = undefined;
    this.recalculateStatuses(id);
    this.emit(TaskTracker.Events.TaskSettled);
  }

  rejectTask(id: string, reason: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'reviewing') {
      throw new Error(`Task "${id}" must be "reviewing" to reject, got "${task.status}"`);
    }

    task.status = 'ready';
    appendReviewFeedback(task, reason);
    this.recalculateStatuses(id);
    this.emit(TaskTracker.Events.TaskReady);
  }

  resetFailedTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'failed') {
        task.status = 'ready';
        task.assignedAgent = undefined;
        task.result = undefined;
        task.reviewFeedback = undefined;
      }
    }
  }

  resetStuckTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'claimed' || task.status === 'implementing' || task.status === 'reviewing') {
        task.status = 'ready';
        task.assignedAgent = undefined;
        task.result = undefined;
        task.reviewFeedback = undefined;
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
      this.emit(TaskTracker.Events.TaskReady);
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

  getBlockedWithMissingDeps(): { taskId: string; missingDepIds: string[] }[] {
    const results: { taskId: string; missingDepIds: string[] }[] = [];

    for (const task of this.tasks.values()) {
      if (task.status === 'blocked') {
        const missingDepIds = task.dependencies.filter((dep) => !this.tasks.has(dep));
        if (missingDepIds.length > 0) {
          results.push({ taskId: task.id, missingDepIds });
        }
      }
    }

    return results;
  }

  validateAllDependencies(): void {
    for (const task of this.tasks.values()) {
      const missing = task.dependencies.filter((dep) => !this.tasks.has(dep));
      if (missing.length > 0) {
        throw new Error(`Task "${task.id}" references missing dependencies: ${JSON.stringify(missing)}`);
      }
    }
  }

  /**
   * Single-pass check for the lane loop hot path.
   *
   * Returns `true` when every task is settled (`done` / `failed`) or
   * blocked with at least one missing dependency (deadlocked). An empty
   * tracker is considered done.
   */
  isPoolDone(): boolean {
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
          }
          continue;
        }
      }
      return false;
    }
    return true;
  }

  private static isSettled(status: TaskStatus): boolean {
    return status === 'done' || status === 'failed';
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
