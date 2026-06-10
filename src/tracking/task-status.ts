import { EventEmitter } from 'node:events';
import type { Task, TaskStatus } from '../core/types.js';

export class TaskTracker extends EventEmitter {
  private tasks: Map<string, Task>;
  private reverseDeps: Map<string, Set<string>>;

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
      const set = this.reverseDeps.get(dep);
      if (set) {
        set.add(fullTask.id);
      } else {
        this.reverseDeps.set(dep, new Set([fullTask.id]));
      }
    }

    try {
      this.detectCycle(fullTask.id);
    } catch (err) {
      this.tasks.delete(fullTask.id);
      // Roll back reverse dependency entries
      for (const dep of deps) {
        const set = this.reverseDeps.get(dep);
        if (set) {
          set.delete(fullTask.id);
          if (set.size === 0) this.reverseDeps.delete(dep);
        }
      }
      throw new Error(`Dependency cycle detected involving task "${fullTask.id}"`, { cause: err });
    }

    this.recalculateStatuses(fullTask.id);
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
  }

  rejectTask(id: string, reason: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    if (task.status !== 'reviewing') {
      throw new Error(`Task "${id}" must be "reviewing" to reject, got "${task.status}"`);
    }

    task.status = 'ready';
    task.reviewFeedback = reason;
    this.recalculateStatuses(id);
  }

  resetFailedTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'failed') {
        task.status = 'ready';
        task.assignedAgent = undefined;
        task.result = undefined;
      }
    }
  }

  resetStuckTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'claimed' || task.status === 'implementing') {
        task.status = 'ready';
        task.assignedAgent = undefined;
      }
    }
  }

  recalculateStatuses(hintTaskId?: string): void {
    let transitioned = false;
    const candidates = hintTaskId ? (this.reverseDeps.get(hintTaskId) ?? new Set()) : this.tasks.keys();

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
      this.emit('taskReady');
    }
  }

  toJSON(): { tasks: Task[] } {
    return { tasks: this.getAllTasks() };
  }

  resetForRetry(): void {
    this.resetFailedTasks();
    this.resetStuckTasks();
  }

  static fromJSON(data: { tasks: Task[] }): TaskTracker {
    const tracker = new TaskTracker();
    for (const task of data.tasks) {
      tracker.tasks.set(task.id, structuredClone(task));
    }
    // Build reverse dependency index
    for (const task of tracker.tasks.values()) {
      for (const dep of task.dependencies) {
        const set = tracker.reverseDeps.get(dep);
        if (set) {
          set.add(task.id);
        } else {
          tracker.reverseDeps.set(dep, new Set([task.id]));
        }
      }
    }
    // Validate no cycles in deserialized data
    for (const id of tracker.tasks.keys()) {
      tracker.detectCycle(id);
    }
    tracker.resetForRetry();
    tracker.recalculateStatuses();
    return tracker;
  }

  areAllSettled(): boolean {
    const all = this.getAllTasks();
    return all.length > 0 && all.every((t) => TaskTracker.isSettled(t.status));
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

  areAllDoneOrBlocked(): boolean {
    const all = this.getAllTasks();
    if (all.length === 0) return false;
    return all.every((t) => {
      if (TaskTracker.isSettled(t.status)) return true;
      if (t.status === 'blocked') {
        return t.dependencies.some((dep) => !this.tasks.has(dep));
      }
      return false;
    });
  }

  /**
   * Single-pass, zero-allocation check that combines the logic of
   * `areAllSettled()`, `areAllDoneOrBlocked()`, and
   * `getAllTasks().length === 0` for the lane loop hot path.
   */
  isPoolDone(): boolean {
    if (this.tasks.size === 0) return true;
    for (const task of this.tasks.values()) {
      const s = task.status;
      if (TaskTracker.isSettled(s)) continue;
      if (s === 'blocked' && task.dependencies.some((d) => !this.tasks.has(d))) continue;
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
