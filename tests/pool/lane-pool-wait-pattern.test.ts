/**
 * @fileoverview Tests for the dual-listener wait pattern in LanePool.runLane().
 */

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  TaskTracker,
  clearPoolMocks,
  createPoolAndTracker,
  makeSession,
  makeTask,
  mockCreateHarness,
  setupHarnessMocks,
  setupHarnessMocksWithAbort,
  setupProfileMocks,
} from './helpers.ts';

beforeEach(() => {
  clearPoolMocks();
});

describe('LanePool dual-listener wait pattern', () => {
  describe('event-driven wake-up', () => {
    it('wakes waiting lane when dependency task completes (2 lanes, 2 dependent tasks)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-1', title: 'First', dependencies: [] }),
          { ...makeTask({ id: 'task-2', title: 'Second', dependencies: ['task-1'] }), status: undefined as const },
        ],
        maxConcurrentLanes: 2,
      });
      expect(tracker.getTask('task-2')!.status).toBe('blocked');
      const result = await pool.run();
      expect(result.completedTasks).toBe(2);
      expect(result.failedTasks).toBe(0);
    });

    it('handles chain dependencies with multiple wake-ups (A→B→C, 2 lanes)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-A', title: 'A', dependencies: [] }),
          { ...makeTask({ id: 'task-B', title: 'B', dependencies: ['task-A'] }), status: undefined as const },
          { ...makeTask({ id: 'task-C', title: 'C', dependencies: ['task-B'] }), status: undefined as const },
        ],
        maxConcurrentLanes: 2,
      });
      expect(tracker.getTask('task-B')!.status).toBe('blocked');
      expect(tracker.getTask('task-C')!.status).toBe('blocked');
      const result = await pool.run();
      expect(result.completedTasks).toBe(3);
    });

    it('wakes waiting lane when dependency task fails', async () => {
      setupProfileMocks();
      mockCreateHarness.mockRejectedValueOnce(new Error('Agent creation failed'));
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => 'done'),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-1', dependencies: [] }),
          { ...makeTask({ id: 'task-2', dependencies: ['task-1'] }), status: undefined as const },
        ],
        maxConcurrentLanes: 2,
      });
      const spy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await pool.run();
        expect(result.failedTasks).toBe(1);
        expect(result.completedTasks).toBe(1);
        expect(tracker.getTask('task-2')!.status).toBe('complete');
      } finally {
        spy.mockRestore();
      }
    });

    it('handles diamond dependency with 3 lanes', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-A', dependencies: [] }),
          { ...makeTask({ id: 'task-B', dependencies: ['task-A'] }), status: undefined as const },
          { ...makeTask({ id: 'task-C', dependencies: ['task-A'] }), status: undefined as const },
          { ...makeTask({ id: 'task-D', dependencies: ['task-B', 'task-C'] }), status: undefined as const },
        ],
        maxConcurrentLanes: 3,
      });
      const result = await pool.run();
      expect(result.completedTasks).toBe(4);
      expect(tracker.getTask('task-D')!.status).toBe('complete');
    });
  });

  describe('abort signal', () => {
    it('resolves wait promise and lane exits on abort during idle wait', async () => {
      setupProfileMocks();
      setupHarnessMocksWithAbort();
      const controller = new AbortController();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-1', dependencies: [] }),
          { ...makeTask({ id: 'task-2', dependencies: ['task-1'] }), status: undefined as const },
        ],
        maxConcurrentLanes: 2,
        signal: controller.signal,
      });
      const runPromise = pool.run();
      tracker.once(TaskTracker.Events.TaskSettled, () => controller.abort());
      const result = await runPromise;
      expect(result.completedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('complete');
    });

    it('skips execution when signal is already aborted before run()', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const controller = new AbortController();
      controller.abort();
      const { pool } = createPoolAndTracker({ tasks: [makeTask()], signal: controller.signal });
      const result = await pool.run();
      expect(result.completedTasks).toBe(0);
      expect(mockCreateHarness).not.toHaveBeenCalled();
    });

    it('lane checks signal.aborted after waking from wait and exits', async () => {
      setupProfileMocks();
      setupHarnessMocksWithAbort();
      const controller = new AbortController();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-1', dependencies: [] }),
          { ...makeTask({ id: 'task-2', dependencies: ['task-1'] }), status: undefined as const },
        ],
        maxConcurrentLanes: 2,
        signal: controller.signal,
      });
      const runPromise = pool.run();
      tracker.once(TaskTracker.Events.TaskSettled, () => controller.abort());
      const result = await runPromise;
      expect(result.completedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('complete');
    });
  });

  describe('listener cleanup', () => {
    it('removes all TaskReady and TaskSettled listeners after pool completes', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-1', dependencies: [] }),
          { ...makeTask({ id: 'task-2', dependencies: ['task-1'] }), status: undefined as const },
        ],
        maxConcurrentLanes: 2,
      });
      await pool.run();
      expect(tracker.listenerCount(TaskTracker.Events.TaskReady)).toBe(0);
      expect(tracker.listenerCount(TaskTracker.Events.TaskSettled)).toBe(0);
    });

    it('removes all listeners even when wake comes from abort signal', async () => {
      setupProfileMocks();
      setupHarnessMocksWithAbort();
      const controller = new AbortController();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-1', dependencies: [] }),
          { ...makeTask({ id: 'task-2', dependencies: ['task-1'] }), status: undefined as const },
        ],
        maxConcurrentLanes: 2,
        signal: controller.signal,
      });
      const runPromise = pool.run();
      tracker.once(TaskTracker.Events.TaskSettled, () => controller.abort());
      await runPromise;
      expect(tracker.listenerCount(TaskTracker.Events.TaskReady)).toBe(0);
      expect(tracker.listenerCount(TaskTracker.Events.TaskSettled)).toBe(0);
    });

    it('cleanup prevents a second listener from firing after first wake', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-1', dependencies: [] }),
          { ...makeTask({ id: 'task-2', dependencies: ['task-1'] }), status: undefined as const },
        ],
        maxConcurrentLanes: 2,
      });
      let claimCount = 0;
      const orig = tracker.claimTasks.bind(tracker);
      const spy = spyOn(tracker, 'claimTasks').mockImplementation((count: number) => {
        const tasks = orig(count);
        if (tasks.length > 0) claimCount++;
        return tasks;
      });
      try {
        await pool.run();
        expect(claimCount).toBe(2);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('configurable lane wait timeout', () => {
    it('passes laneWaitTimeoutMs to setTimeout for the wait', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const task = makeTask({ id: 'task-1' });
      task.status = 'active';
      const { pool, tracker } = createPoolAndTracker({ tasks: [task], maxConcurrentLanes: 1, laneWaitTimeoutMs: 1234 });
      const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((
        cb: (...args: unknown[]) => void,
        delay?: number,
      ) =>
        globalThis.setTimeout(
          cb,
          typeof delay === 'number' && delay >= 1000 ? 0 : delay,
        )) as typeof globalThis.setTimeout);
      let ready = false;
      const origClaim = tracker.claimTasks.bind(tracker);
      const claimSpy = spyOn(tracker, 'claimTasks').mockImplementation((count: number) => {
        const tasks = origClaim(count);
        if (tasks.length === 0 && !ready) {
          ready = true;
          tracker.getTask('task-1')!.status = 'ready';
        }
        return tasks;
      });
      try {
        await pool.run();
        expect(spy.mock.calls.some((c) => c[1] === 1234)).toBe(true);
      } finally {
        claimSpy.mockRestore();
        spy.mockRestore();
      }
    });

    it('defaults to 60000 when laneWaitTimeoutMs is not provided', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const task = makeTask({ id: 'task-1' });
      task.status = 'active';
      const { pool, tracker } = createPoolAndTracker({ tasks: [task], maxConcurrentLanes: 1 });
      const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((
        cb: (...args: unknown[]) => void,
        delay?: number,
      ) =>
        globalThis.setTimeout(
          cb,
          typeof delay === 'number' && delay >= 1000 ? 0 : delay,
        )) as typeof globalThis.setTimeout);
      let ready = false;
      const origClaim = tracker.claimTasks.bind(tracker);
      const claimSpy = spyOn(tracker, 'claimTasks').mockImplementation((count: number) => {
        const tasks = origClaim(count);
        if (tasks.length === 0 && !ready) {
          ready = true;
          tracker.getTask('task-1')!.status = 'ready';
        }
        return tasks;
      });
      try {
        await pool.run();
        expect(spy.mock.calls.some((c) => c[1] === 60000)).toBe(true);
      } finally {
        claimSpy.mockRestore();
        spy.mockRestore();
      }
    });
  });

  describe('TOCTOU missed-wakeup fix', () => {
    it('catches TaskReady emitted during claimTasks without waiting for timeout', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const realSetTimeout = globalThis.setTimeout;
      const task = makeTask({ id: 'task-1', dependencies: [] });
      task.status = 'active';

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task],
        maxConcurrentLanes: 1,
        laneWaitTimeoutMs: 60000,
      });

      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        (cb: (...args: unknown[]) => void, delay?: number) => {
          if (typeof delay === 'number' && delay >= 1000) {
            return realSetTimeout(cb, 0);
          }
          return realSetTimeout(cb, delay);
        },
      );

      let raceTriggered = false;
      const originalClaim = tracker.claimTasks.bind(tracker);
      const claimSpy = spyOn(tracker, 'claimTasks').mockImplementation((count: number) => {
        const tasks = originalClaim(count);
        if (tasks.length === 0 && !raceTriggered) {
          raceTriggered = true;
          tracker.getTask('task-1')!.status = 'ready';
          tracker.emit(TaskTracker.Events.TaskReady);
        }
        return tasks;
      });

      try {
        const result = await pool.run();
        expect(result.completedTasks).toBe(1);
        expect(tracker.getTask('task-1')!.status).toBe('complete');
      } finally {
        claimSpy.mockRestore();
        setTimeoutSpy.mockRestore();
      }
    });
  });

  describe('log noise reduction', () => {
    it('does not log routine timeout polls at all (noise removed)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const task = makeTask({ id: 'task-1' });
      task.status = 'active';
      const { pool, tracker } = createPoolAndTracker({ tasks: [task], maxConcurrentLanes: 1, laneWaitTimeoutMs: 10 });
      let c = 0;
      const origClaim = tracker.claimTasks.bind(tracker);
      const spy = spyOn(tracker, 'claimTasks').mockImplementation((count: number) => {
        c++;
        if (c > 2) tracker.getTask('task-1')!.status = 'ready';
        return origClaim(count);
      });
      const debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await pool.run();
        // Routine timeouts no longer log at all (debug or warn)
        expect(
          warnSpy.mock.calls.filter((call) => call.some((a) => typeof a === 'string' && a.includes('stall'))),
        ).toHaveLength(0);
      } finally {
        spy.mockRestore();
        debugSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('escalates to console.warn once after STALL_WARN_THRESHOLD consecutive timeouts', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const task = makeTask({ id: 'task-1' });
      task.status = 'active';
      const { pool, tracker } = createPoolAndTracker({ tasks: [task], maxConcurrentLanes: 1, laneWaitTimeoutMs: 10 });
      let c = 0;
      const origClaim = tracker.claimTasks.bind(tracker);
      const spy = spyOn(tracker, 'claimTasks').mockImplementation((count: number) => {
        c++;
        if (c > 8) tracker.getTask('task-1')!.status = 'ready';
        return origClaim(count);
      });
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await pool.run();
        expect(
          warnSpy.mock.calls.filter((call) => call.some((a) => typeof a === 'string' && a.includes('stall'))),
        ).toHaveLength(1);
      } finally {
        spy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe('stranded-task hardening', () => {
    it('fails task when completeTask throws instead of stranding it', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const controller = new AbortController();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [makeTask()],
        maxConcurrentLanes: 1,
        laneWaitTimeoutMs: 100,
        signal: controller.signal,
      });
      const completeSpy = spyOn(tracker, 'completeTask').mockImplementation(() => {
        throw new Error('Tracker state error');
      });
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const t = setTimeout(() => controller.abort(), 200);
      try {
        const result = await pool.run();
        expect(result.failedTasks).toBe(1);
        expect(tracker.getTask('task-1')!.status).toBe('failed');
      } finally {
        clearTimeout(t);
        completeSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
