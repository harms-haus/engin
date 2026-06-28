import { TaskTracker } from '../../packages/engine/src/tracking/task-status.js';

/**
 * Simulate a task lifecycle transition on a TaskTracker via direct status
 * mutation. TaskTracker's EventEmitter surface was removed in C1, so these
 * helpers only mutate task fields (no event emission).
 */

/** Claim a ready task: set active + assignedAgent. */
export function simulateClaim(tracker: TaskTracker, taskId: string, agentId: string): void {
  const task = tracker.getTask(taskId);
  if (!task) throw new Error(`Task "${taskId}" not found`);
  task.status = 'active';
  task.assignedAgent = agentId;
}

/** Complete an active task: set complete + result. */
export function simulateComplete(tracker: TaskTracker, taskId: string, result?: unknown): void {
  const task = tracker.getTask(taskId);
  if (!task) throw new Error(`Task "${taskId}" not found`);
  task.status = 'complete';
  task.result = result;
}

/** Fail an active task: set failed + result. */
export function simulateFail(tracker: TaskTracker, taskId: string, result?: unknown): void {
  const task = tracker.getTask(taskId);
  if (!task) throw new Error(`Task "${taskId}" not found`);
  task.status = 'failed';
  task.result = result;
}
