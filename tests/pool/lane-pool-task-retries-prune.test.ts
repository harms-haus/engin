/**
 * @fileoverview Tests for pruning of the `LanePool.taskRetries` map.
 *
 * `taskRetries` is a `Map<string, number>` tracking how many same-run retries
 * each task has consumed. Without pruning it grows unbounded over a long run
 * (one entry per task that ever failed, never deleted). After the fix, an
 * entry is deleted once the task settles permanently — either by completing
 * or by exhausting its retry budget — so the map stays bounded.
 *
 * These tests verify:
 *
 * 1. A completed task's entry is pruned.
 * 2. A permanently-failed task's entry is pruned.
 * 3. The map is empty after a run with many tasks of mixed outcomes.
 * 4. Pruning does not break retry correctness (counts/attempts unchanged).
 *
 * Note: a `TaskRunner` is responsible for settling the task via
 * `ctx.completeTask()` / `ctx.failTask()` (mirroring `linearStepsRunner`).
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { LanePool } from '../../packages/engine/src/pool/lane-pool.js';
import {
  clearPoolMocks,
  createPoolAndTracker,
  makeSession,
  makeTask,
  mockCreateHarness,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.js';

beforeEach(() => {
  clearPoolMocks();
});

/** White-box access to the private taskRetries map. */
function taskRetriesOf(pool: LanePool): Map<string, number> {
  return (pool as unknown as { taskRetries: Map<string, number> }).taskRetries;
}

describe('LanePool taskRetries map pruning', () => {
  describe('baseline (no retries => empty map)', () => {
    it('taskRetries stays empty when every task succeeds on the first try', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const tasks = [makeTask({ id: 'task-a' }), makeTask({ id: 'task-b' })];
      const { pool } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 2,
        maxTaskRetries: 2,
        getRunnerForTask: () => async (ctx) => {
          ctx.completeTask();
          return { status: 'completed' };
        },
      });
      const result = await pool.run();
      expect(result.completedTasks).toBe(2);
      // Tasks that never fail must never enter the retry map.
      expect(taskRetriesOf(pool).size).toBe(0);
    });
  });

  describe('entries are pruned on permanent settlement', () => {
    it('deletes a task from taskRetries once it completes after a retry', async () => {
      setupProfileMocks();
      // Fail the first attempt (via a thrown error → safeFailTask), then
      // succeed. With maxTaskRetries=2 the retry budget is touched (entry
      // created) but the task ultimately completes.
      let calls = 0;
      mockCreateHarness.mockImplementation(() => {
        calls++;
        if (calls <= 1) {
          return {
            session: makeSession(() => {
              throw new Error('fail');
            }),
            sessionId: `s-${calls}`,
            dispose: mock(() => {}),
          };
        }
        return { session: makeSession(() => 'done'), sessionId: `s-${calls}`, dispose: mock(() => {}) };
      });
      const { pool, tracker } = createPoolAndTracker({ maxTaskRetries: 2 });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('complete');
      // Entry was created during the failed attempt but must be pruned on completion.
      expect(taskRetriesOf(pool).has('task-1')).toBe(false);
    });

    it('deletes a task from taskRetries once it permanently fails (budget exhausted)', async () => {
      setupProfileMocks();
      mockCreateHarness.mockImplementation(() => ({
        session: makeSession(() => {
          throw new Error('always fails');
        }),
        sessionId: 's',
        dispose: mock(() => {}),
      }));
      const { pool, tracker } = createPoolAndTracker({ maxTaskRetries: 2 });

      const result = await pool.run();

      // 1 initial + 2 retries = 3 attempts, all fail.
      expect(mockCreateHarness).toHaveBeenCalledTimes(3);
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
      // Budget exhausted → permanently failed → entry pruned.
      expect(taskRetriesOf(pool).has('task-1')).toBe(false);
    });

    it('deletes a task from taskRetries when maxTaskRetries is 1 and the single retry fails', async () => {
      setupProfileMocks();
      mockCreateHarness.mockImplementation(() => ({
        session: makeSession(() => {
          throw new Error('fail');
        }),
        sessionId: 's',
        dispose: mock(() => {}),
      }));
      const { pool, tracker } = createPoolAndTracker({ maxTaskRetries: 1 });

      const result = await pool.run();

      expect(mockCreateHarness).toHaveBeenCalledTimes(2); // initial + 1 retry
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
      expect(taskRetriesOf(pool).has('task-1')).toBe(false);
    });
  });

  describe('map stays bounded across many tasks', () => {
    it('taskRetries map is empty after a run with mixed task outcomes', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const attempts: Record<string, number> = {};
      const tasks = [makeTask({ id: 'task-a' }), makeTask({ id: 'task-b' }), makeTask({ id: 'task-c' })];
      const { pool, tracker } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 1,
        maxTaskRetries: 2,
        getRunnerForTask: (task) => async (ctx) => {
          attempts[task.id] = (attempts[task.id] ?? 0) + 1;
          // task-a: always fails (exhausts budget, pruned).
          if (task.id === 'task-a') {
            ctx.failTask({ completed: false, error: 'always fails' });
            return { status: 'failed', error: 'always fails' };
          }
          // task-b: succeeds on first try (never enters the map).
          if (task.id === 'task-b') {
            ctx.completeTask();
            return { status: 'completed' };
          }
          // task-c: fail once then succeed.
          if (attempts[task.id] <= 1) {
            ctx.failTask({ completed: false, error: 'fail' });
            return { status: 'failed', error: 'fail' };
          }
          ctx.completeTask();
          return { status: 'completed' };
        },
      });

      const result = await pool.run();

      expect(tracker.getTask('task-a')!.status).toBe('failed');
      expect(tracker.getTask('task-b')!.status).toBe('complete');
      expect(tracker.getTask('task-c')!.status).toBe('complete');
      expect(result.failedTasks).toBe(1);
      expect(result.completedTasks).toBe(2);
      // Every settled task's entry has been pruned → bounded map.
      expect(taskRetriesOf(pool).size).toBe(0);
    });

    it('taskRetries map is empty after all tasks permanently fail', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const tasks = Array.from({ length: 5 }, (_, i) => makeTask({ id: `task-${i + 1}` }));
      const { pool } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 2,
        maxTaskRetries: 1,
        getRunnerForTask: () => async (ctx) => {
          ctx.failTask({ completed: false, error: 'boom' });
          return { status: 'failed', error: 'boom' };
        },
      });

      const result = await pool.run();

      expect(result.failedTasks).toBe(5);
      expect(taskRetriesOf(pool).size).toBe(0);
    });
  });

  describe('pruning does not break retry correctness', () => {
    it('still retries the correct number of times when a task fails twice then succeeds', async () => {
      setupProfileMocks();
      let calls = 0;
      mockCreateHarness.mockImplementation(() => {
        calls++;
        if (calls <= 2) {
          return {
            session: makeSession(() => {
              throw new Error('fail');
            }),
            sessionId: `s-${calls}`,
            dispose: mock(() => {}),
          };
        }
        return { session: makeSession(() => 'done'), sessionId: `s-${calls}`, dispose: mock(() => {}) };
      });
      const { pool, tracker } = createPoolAndTracker({ maxTaskRetries: 2 });

      const result = await pool.run();

      // 1 initial + 2 retries = 3 attempts; succeeds on the 3rd.
      expect(calls).toBe(3);
      expect(result.completedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('complete');
      // And the entry is pruned after completion.
      expect(taskRetriesOf(pool).has('task-1')).toBe(false);
    });

    it('pruning across multiple tasks keeps each task independently retried', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const attemptsPerTask: Record<string, number> = {};
      const tasks = [makeTask({ id: 'task-a' }), makeTask({ id: 'task-b' })];
      const { pool, tracker } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 1, // sequential → deterministic per-task retry counts
        maxTaskRetries: 2,
        getRunnerForTask: (task) => async (ctx) => {
          attemptsPerTask[task.id] = (attemptsPerTask[task.id] ?? 0) + 1;
          // Each task fails once, then succeeds.
          if (attemptsPerTask[task.id] <= 1) {
            ctx.failTask({ completed: false, error: 'fail' });
            return { status: 'failed', error: 'fail' };
          }
          ctx.completeTask();
          return { status: 'completed' };
        },
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(2);
      expect(tracker.getTask('task-a')!.status).toBe('complete');
      expect(tracker.getTask('task-b')!.status).toBe('complete');
      // Each task consumed exactly one retry (2 attempts each).
      expect(attemptsPerTask['task-a']).toBe(2);
      expect(attemptsPerTask['task-b']).toBe(2);
      // Pruning the first task must not have reset the second task's counter
      // (which would cause extra retries). Both entries are gone at the end.
      expect(taskRetriesOf(pool).size).toBe(0);
    });

    it('a task that exhausts retries is not retried again after pruning', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const attemptsPerTask: Record<string, number> = {};
      const tasks = [makeTask({ id: 'task-x' }), makeTask({ id: 'task-y' })];
      const { pool, tracker } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 1,
        maxTaskRetries: 1,
        getRunnerForTask: (task) => async (ctx) => {
          attemptsPerTask[task.id] = (attemptsPerTask[task.id] ?? 0) + 1;
          ctx.failTask({ completed: false, error: 'always' });
          return { status: 'failed', error: 'always' };
        },
      });

      const result = await pool.run();

      // 1 initial + 1 retry = 2 attempts each; pruning must not reset either.
      expect(attemptsPerTask['task-x']).toBe(2);
      expect(attemptsPerTask['task-y']).toBe(2);
      expect(result.failedTasks).toBe(2);
      expect(tracker.getTask('task-x')!.status).toBe('failed');
      expect(tracker.getTask('task-y')!.status).toBe('failed');
      expect(taskRetriesOf(pool).size).toBe(0);
    });
  });
});
