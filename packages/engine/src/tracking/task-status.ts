// ─── TaskTracker — thin read-only task store ───────────────────────────────
//
// All scheduling logic has been migrated to TaskGraph (pool/task-graph.ts).
// This class is a minimal store that WorkflowStatusTracker
// (tracking/workflow-status.ts) depends on for basic task storage and
// serialization. Once WorkflowStatusTracker is removed (D2), this file can
// be deleted entirely.

import type { Task, TaskStatus } from '../core/types.js';

export class TaskTracker {
  private tasks: Map<string, Task>;

  constructor() {
    this.tasks = new Map();
  }

  addTask(task: Omit<Task, 'status'> & { status?: TaskStatus }): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task with id "${task.id}" already exists`);
    }
    const deps = task.dependencies ?? [];
    const status: TaskStatus =
      task.status ??
      (deps.every((dep) => {
        const depTask = this.tasks.get(dep);
        return depTask !== undefined && isSettled(depTask.status);
      })
        ? 'ready'
        : 'blocked');

    const fullTask: Task = { ...task, dependencies: deps, status };
    this.tasks.set(fullTask.id, fullTask);
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  toJSON(): { tasks: Task[] } {
    return { tasks: this.getAllTasks() };
  }

  static fromJSON(data: { tasks: Task[] }, _options?: { preserveState?: boolean }): TaskTracker {
    const tracker = new TaskTracker();
    for (const task of data.tasks) {
      tracker.tasks.set(task.id, structuredClone(task));
    }
    return tracker;
  }
}

function isSettled(status: TaskStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}
