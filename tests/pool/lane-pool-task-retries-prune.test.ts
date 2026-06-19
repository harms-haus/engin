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
import type { Task } from '../../packages/engine/src/core/types.js';
import type { WorktreeManager } from '../../packages/engine/src/core/worktree-manager.js';
import { LanePool } from '../../packages/engine/src/pool/lane-pool.js';
import type { TaskRunner } from '../../packages/engine/src/pool/types.js';
import {
  clearPoolMocks,
  createPoolAndTracker,
  makeSession,
  makeTask,
  mockCreateHarness,
  setupHarnessMocks,
  setupProfileMocks,
  TaskTracker,
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

// ═══════════════════════════════════════════════════════════════════════════
// Per-task worktree lifecycle
// ═══════════════════════════════════════════════════════════════════════════
//
// When a `worktreeManager` is supplied via `LanePoolOptions`, each claimed
// task executes inside a fresh git worktree:
//   • `createTaskWorktree(taskId, prompt)` runs BEFORE the runner and its
//     returned path overrides `ctx.cwd` (and `ctx.worktreeManager` is forwarded).
//   • `mergeTaskBranch(taskId)` runs on a completed outcome; a failed merge
//     fails the task instead of completing it.
//   • `cullTaskWorktree(taskId)` runs on failure — before a retry, and again
//     when the retry budget is exhausted (permanent failure).
// When no `worktreeManager` is configured the lifecycle is untouched.

/** Options for {@link createMockWorktreeManager}. */
interface MockWorktreeManagerOptions {
  createPath?: string;
  createThrows?: boolean;
  mergeResult?: { success: boolean; conflictsResolved: boolean };
}

/**
 * A mock `WorktreeManager` whose lifecycle methods record their invocation
 * order into `log` (e.g. `'create:task-1'`, `'cull:task-1'`). The mock does NOT
 * internally cull on a successful merge (the real manager does), so every
 * `cullTaskWorktree` call observed here originates from the pool layer itself.
 */
function createMockWorktreeManager(options?: MockWorktreeManagerOptions) {
  const log: string[] = [];
  const mergeResult = options?.mergeResult ?? { success: true, conflictsResolved: false };
  return {
    log,
    createTaskWorktree: mock(async (taskId: string, _prompt?: string): Promise<string> => {
      if (options?.createThrows) throw new Error('worktree-create-failed');
      log.push(`create:${taskId}`);
      return options?.createPath ?? `/tmp/worktrees/${taskId}`;
    }),
    mergeTaskBranch: mock(async (taskId: string): Promise<{ success: boolean; conflictsResolved: boolean }> => {
      log.push(`merge:${taskId}`);
      return mergeResult;
    }),
    cullTaskWorktree: mock(async (taskId: string): Promise<void> => {
      log.push(`cull:${taskId}`);
    }),
  };
}

/** Options for {@link createPoolWithWorktree}. */
interface PoolWithWorktreeOptions {
  tasks?: Task[];
  worktreeManager?: WorktreeManager;
  maxConcurrentLanes?: number;
  maxTaskRetries?: number;
  cwd?: string;
  getRunnerForTask?: (task: Task) => TaskRunner;
}

/** Build a `LanePool` + `TaskTracker`, forwarding an optional worktreeManager. */
function createPoolWithWorktree(options: PoolWithWorktreeOptions) {
  const tracker = new TaskTracker();
  const tasks = options.tasks ?? [makeTask()];
  for (const task of tasks) tracker.addTask(task);

  const pool = new LanePool({
    maxConcurrentLanes: options.maxConcurrentLanes ?? 1,
    profilesDirs: ['/mock/profiles'],
    sessionBaseDir: '/tmp/sessions',
    cwd: options.cwd ?? '/tmp/project',
    phaseId: 'implementing',
    taskTracker: tracker,
    getStepsForTask: (_task: Task) => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
    getRunnerForTask: options.getRunnerForTask,
    maxTaskRetries: options.maxTaskRetries,
    worktreeManager: options.worktreeManager,
    laneWaitTimeoutMs: 50,
  });

  return { pool, tracker };
}

describe('LanePool per-task worktree lifecycle', () => {
  it('creates the worktree before the runner runs, forwards cwd + worktreeManager, and merges on success', async () => {
    setupProfileMocks();
    const wm = createMockWorktreeManager({ createPath: '/tmp/wt/task-1' });
    let runnerCwd: string | undefined;
    let runnerWorktreeManager: unknown;
    const { pool, tracker } = createPoolWithWorktree({
      tasks: [makeTask({ id: 'task-1', prompt: 'do the thing' })],
      worktreeManager: wm as unknown as WorktreeManager,
      getRunnerForTask: () => async (ctx) => {
        wm.log.push('runner');
        runnerCwd = ctx.cwd;
        runnerWorktreeManager = ctx.worktreeManager;
        ctx.completeTask();
        return { status: 'completed' };
      },
    });

    await pool.run();

    // createTaskWorktree receives the task id and prompt, and runs BEFORE the runner.
    expect(wm.createTaskWorktree).toHaveBeenCalledTimes(1);
    expect(wm.createTaskWorktree).toHaveBeenCalledWith('task-1', 'do the thing', expect.anything());
    // The runner observed the worktree path as cwd and the manager was forwarded.
    expect(runnerCwd).toBe('/tmp/wt/task-1');
    expect(runnerWorktreeManager).toBe(wm);
    // The task completed (the merge succeeded).
    expect(tracker.getTask('task-1')!.status).toBe('complete');
    // Full lifecycle order: create → runner → merge.
    expect(wm.log).toEqual(['create:task-1', 'runner', 'merge:task-1']);
  });

  it('marks the task failed when mergeTaskBranch fails after a successful run', async () => {
    setupProfileMocks();
    const wm = createMockWorktreeManager({
      mergeResult: { success: false, conflictsResolved: false },
    });
    const { pool, tracker } = createPoolWithWorktree({
      tasks: [makeTask({ id: 'task-1' })],
      worktreeManager: wm as unknown as WorktreeManager,
      maxTaskRetries: 0, // merge failure is permanent — not retried
      getRunnerForTask: () => async (ctx) => {
        ctx.completeTask();
        return { status: 'completed' };
      },
    });

    const result = await pool.run();

    expect(wm.mergeTaskBranch).toHaveBeenCalledTimes(1);
    expect(wm.mergeTaskBranch).toHaveBeenCalledWith('task-1');
    // A failed merge must NOT leave the task reported as complete.
    expect(tracker.getTask('task-1')!.status).toBe('failed');
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
  });

  it('culls the failed worktree before retrying the task', async () => {
    setupProfileMocks();
    const wm = createMockWorktreeManager();
    const attempts: Record<string, number> = {};
    const { pool, tracker } = createPoolWithWorktree({
      tasks: [makeTask({ id: 'task-1' })],
      worktreeManager: wm as unknown as WorktreeManager,
      maxConcurrentLanes: 1, // sequential → deterministic retry ordering
      maxTaskRetries: 1,
      getRunnerForTask: (task) => async (ctx) => {
        attempts[task.id] = (attempts[task.id] ?? 0) + 1;
        if (attempts[task.id] === 1) {
          ctx.failTask({ completed: false, error: 'fail' });
          return { status: 'failed', error: 'fail' };
        }
        ctx.completeTask();
        return { status: 'completed' };
      },
    });

    await pool.run();

    // Two attempts (initial + retry) → two worktrees created.
    expect(wm.createTaskWorktree).toHaveBeenCalledTimes(2);
    // The task eventually succeeded on the retry.
    expect(tracker.getTask('task-1')!.status).toBe('complete');
    // Lifecycle order: create → cull(retry) → create(retry) → merge(success).
    // The cull of the failed attempt MUST precede the retry's fresh worktree.
    expect(wm.log).toEqual(['create:task-1', 'cull:task-1', 'create:task-1', 'merge:task-1']);
  });

  it('culls the worktree when a task permanently fails (retry budget exhausted)', async () => {
    setupProfileMocks();
    const wm = createMockWorktreeManager();
    const { pool, tracker } = createPoolWithWorktree({
      tasks: [makeTask({ id: 'task-1' })],
      worktreeManager: wm as unknown as WorktreeManager,
      maxConcurrentLanes: 1,
      maxTaskRetries: 1,
      getRunnerForTask: () => async (ctx) => {
        ctx.failTask({ completed: false, error: 'always fails' });
        return { status: 'failed', error: 'always fails' };
      },
    });

    await pool.run();

    // 1 initial + 1 retry = 2 attempts; every worktree is culled (retry + permanent fail).
    expect(tracker.getTask('task-1')!.status).toBe('failed');
    expect(wm.createTaskWorktree).toHaveBeenCalledTimes(2);
    expect(wm.cullTaskWorktree).toHaveBeenCalledTimes(2);
    expect(wm.log).toEqual(['create:task-1', 'cull:task-1', 'create:task-1', 'cull:task-1']);
  });

  it('does not touch the worktree lifecycle when no worktreeManager is configured', async () => {
    setupProfileMocks();
    let runnerCwd: string | undefined;
    const { pool, tracker } = createPoolWithWorktree({
      tasks: [makeTask({ id: 'task-1' })],
      worktreeManager: undefined,
      cwd: '/original/project',
      getRunnerForTask: () => async (ctx) => {
        runnerCwd = ctx.cwd;
        // No manager is forwarded in the backward-compatible (no-worktree) path.
        expect(ctx.worktreeManager).toBeUndefined();
        ctx.completeTask();
        return { status: 'completed' };
      },
    });

    await pool.run();

    // cwd is unchanged and the task completes normally.
    expect(runnerCwd).toBe('/original/project');
    expect(tracker.getTask('task-1')!.status).toBe('complete');
  });

  it('falls back to the original cwd when createTaskWorktree throws', async () => {
    setupProfileMocks();
    const wm = createMockWorktreeManager({ createThrows: true });
    let runnerCwd: string | undefined;
    const { pool, tracker } = createPoolWithWorktree({
      tasks: [makeTask({ id: 'task-1' })],
      worktreeManager: wm as unknown as WorktreeManager,
      cwd: '/original/project',
      getRunnerForTask: () => async (ctx) => {
        runnerCwd = ctx.cwd;
        ctx.completeTask();
        return { status: 'completed' };
      },
    });

    await pool.run();

    // Worktree creation failed → cwd stays at the configured cwd; the task still completes.
    expect(runnerCwd).toBe('/original/project');
    expect(tracker.getTask('task-1')!.status).toBe('complete');
  });

  // ── Task threading for worktree-lifecycle hooks ──────────────────────────
  //
  // The worktree-lifecycle hooks (beforeTaskWorktreeCreate, onTaskMerge,
  // onMergeConflict, …) need the FULL Task — not just id + prompt — so they can
  // read task.profile (e.g. the default scout-skip), task.title, task.files,
  // etc. LanePool has the full Task in its runner context and must forward it
  // to createTaskWorktree so the WorktreeManager can pass it through to the
  // hook args.

  it('threads the full Task to createTaskWorktree so worktree hooks receive task.profile', async () => {
    setupProfileMocks();
    const wm = createMockWorktreeManager({ createPath: '/tmp/wt/scout-1' });
    const task = makeTask({ id: 'scout-1', prompt: 'scout the codebase', profile: 'scout' });
    const { pool } = createPoolWithWorktree({
      tasks: [task],
      worktreeManager: wm as unknown as WorktreeManager,
      getRunnerForTask: () => async (ctx) => {
        ctx.completeTask();
        return { status: 'completed' };
      },
    });

    await pool.run();

    // createTaskWorktree received the Task as the 3rd arg (backward-compatible
    // optional param). The mock records all call args, including extras beyond
    // its declared params, so we cast to access the 3rd positional arg.
    expect(wm.createTaskWorktree).toHaveBeenCalledTimes(1);
    const callArgs = wm.createTaskWorktree.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('scout-1'); // taskId (1st arg)
    expect(callArgs[1]).toBe('scout the codebase'); // taskPrompt (2nd arg)
    // The 3rd arg is the full Task — carrying profile so hooks can read it.
    // (Compared by identity-fields, not reference: the tracker may normalize
    // the task object, so toBe would fail on a different-but-equal reference.)
    expect(callArgs[2]).toEqual(expect.objectContaining({ id: task.id, profile: task.profile }));
    expect((callArgs[2] as Task).profile).toBe('scout');
  });
});
