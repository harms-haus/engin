/**
 * @fileoverview Tests for listener-leak hardening in LanePool.runLane().
 *
 * The redesigned wake mechanism uses a single persistent listener per lane
 * (registered once at the start of `runLane`, removed when the lane exits)
 * instead of per-iteration `once()` listeners that are added/removed every
 * loop iteration.
 *
 * What is observable about the redesign (old vs new):
 *
 * - **During processing** (inside the runner/prompt), the old design has
 *   already torn down its per-iteration `once()` listeners via `cleanup()`
 *   (count == 0), while the new design keeps its persistent listener
 *   registered (count == maxConcurrentLanes).
 * - **Registration churn**: the old design calls `once()`/`addEventListener`
 *   on every iteration, so the *number* of registration calls scales with the
 *   task count. The new design registers once per lane, so it scales with the
 *   lane count.
 * - **Post-run**: both designs must leave zero listeners behind (invariant).
 *
 * Sampling `listenerCount` at `claimTasks` time is NOT discriminating — the
 * old design's per-iteration listeners are still registered there (count == N),
 * so a "count <= N" assertion passes for both designs. These tests therefore
 * sample at the points above.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  TaskTracker,
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

describe('LanePool listener-leak hardening', () => {
  describe('persistent listeners remain registered mid-processing', () => {
    it('keeps a persistent TaskReady/TaskSettled listener while a task is being processed (single lane)', async () => {
      setupProfileMocks();
      const { pool, tracker } = createPoolAndTracker({ tasks: [makeTask()], maxConcurrentLanes: 1 });

      let resolvePrompt!: () => void;
      let signalEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      let readyDuringPrompt = -1;
      let settledDuringPrompt = -1;

      const session = makeSession(() => 'done');
      session.prompt = mock(async () => {
        readyDuringPrompt = tracker.listenerCount(TaskTracker.Events.TaskReady);
        settledDuringPrompt = tracker.listenerCount(TaskTracker.Events.TaskSettled);
        signalEntered();
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      });
      mockCreateHarness.mockResolvedValue({ session, sessionId: 's-1', dispose: mock(() => {}) });

      const runPromise = pool.run();
      await entered; // lane is now mid-prompt
      // Old design: cleanup() already removed the per-iteration once() listeners
      // before the runner ran → count 0. New design: the persistent listener is
      // still attached → exactly maxConcurrentLanes (1 here).
      expect(readyDuringPrompt).toBe(1);
      expect(settledDuringPrompt).toBe(1);

      resolvePrompt();
      await runPromise;
    });

    it('TaskReady/TaskSettled listener count == maxConcurrentLanes while multiple lanes process tasks concurrently', async () => {
      setupProfileMocks();
      const maxConcurrentLanes = 2;
      const { pool, tracker } = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })],
        maxConcurrentLanes,
      });

      const resolvers: Array<() => void> = [];
      let entered = 0;
      let signalBothEntered!: () => void;
      const bothEntered = new Promise<void>((resolve) => {
        signalBothEntered = resolve;
      });
      const readySamples: number[] = [];

      let hc = 0;
      mockCreateHarness.mockImplementation(() => {
        hc++;
        const session = makeSession(() => 'done');
        session.prompt = mock(async () => {
          readySamples.push(tracker.listenerCount(TaskTracker.Events.TaskReady));
          entered++;
          if (entered === maxConcurrentLanes) signalBothEntered();
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
        });
        return { session, sessionId: `s-${hc}`, dispose: mock(() => {}) };
      });

      const runPromise = pool.run();
      await bothEntered; // both lanes are now mid-prompt concurrently

      // Both persistent listeners are present while both lanes are busy. The old
      // design would show 0 here (listeners torn down before processing).
      expect(Math.max(...readySamples)).toBe(maxConcurrentLanes);
      expect(tracker.listenerCount(TaskTracker.Events.TaskSettled)).toBe(maxConcurrentLanes);

      resolvers.forEach((r) => r());
      await runPromise;
    });
  });

  describe('no per-iteration registration churn', () => {
    it('TaskTracker listener registrations stay bounded by lane count (not task count)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      // Many tasks processed by few lanes → many loop iterations under the old
      // design. The new design registers one persistent listener per lane.
      const tasks = Array.from({ length: 24 }, (_, i) => makeTask({ id: `task-${i + 1}` }));
      const maxConcurrentLanes = 2;
      const { pool, tracker } = createPoolAndTracker({ tasks, maxConcurrentLanes });

      const TRACKED = new Set<string>([TaskTracker.Events.TaskReady, TaskTracker.Events.TaskSettled]);
      let registrations = 0;
      let onceRegistrations = 0;
      // Wrap every public registration entry point so the count is independent
      // of which method (on/once/addListener) the implementation chooses.
      const realOn = EventEmitter.prototype.on;
      const realOnce = EventEmitter.prototype.once;
      const realAdd = EventEmitter.prototype.addListener;
      const wrap =
        (orig: typeof realOn, bucket: () => void) =>
        (ev: string | symbol, listener: (...args: unknown[]) => void): TaskTracker => {
          if (TRACKED.has(ev as string)) {
            registrations++;
            bucket();
          }
          return orig.call(tracker, ev, listener) as TaskTracker;
        };
      tracker.on = wrap(realOn, () => {}) as typeof tracker.on;
      tracker.once = wrap(realOnce, () => {
        onceRegistrations++;
      }) as typeof tracker.once;
      tracker.addListener = wrap(realAdd, () => {}) as typeof tracker.addListener;

      await pool.run();

      // The invariant under test: registration count is O(lanes), NOT O(tasks).
      // The old per-iteration design calls once() on every loop iteration, so
      // the count scales with the number of tasks (well above tasks.length here).
      //
      // Bounds are intentionally generous so the test does NOT couple to whether
      // the implementation uses on() vs once(): a single once() call internally
      // delegates to on(), so wrapping all three entry points can double-count a
      // once() as 2. With 2 events (TaskReady + TaskSettled) the new design is at
      // most ~4 registrations per lane even with that double-counting, so 6×lanes
      // gives comfortable headroom while still being far below the old-design
      // count (which scales past tasks.length).
      expect(registrations).toBeLessThan(tasks.length); // must be sub-linear in tasks
      expect(onceRegistrations).toBeLessThan(tasks.length);
      expect(registrations).toBeLessThanOrEqual(6 * maxConcurrentLanes); // grows with lanes, not tasks
    });

    it('AbortSignal abort listeners stay bounded by lane count + 1 (not task count)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const controller = new AbortController();

      let abortAdds = 0;
      const origAdd = controller.signal.addEventListener.bind(controller.signal);
      controller.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
        if (args[0] === 'abort') abortAdds++;
        return origAdd(...args);
      }) as typeof controller.signal.addEventListener;

      // Many tasks across multiple lanes ⇒ many iterations under the old design.
      const tasks = Array.from({ length: 24 }, (_, i) => makeTask({ id: `task-${i + 1}` }));
      const maxConcurrentLanes = 2;
      const { pool } = createPoolAndTracker({ tasks, maxConcurrentLanes, signal: controller.signal });
      await pool.run();

      // The invariant: abort-listener adds are O(lanes), NOT O(tasks). The new
      // design installs 1 (run()'s abortActiveSessions) + 1 persistent listener
      // per lane. The old design calls addEventListener on every loop iteration,
      // so adds scale with the task count.
      //
      // `2×lanes` gives headroom for any run()-level bookkeeping without coupling
      // to an exact constant; it is still far below the old per-iteration count.
      expect(abortAdds).toBeLessThanOrEqual(2 * maxConcurrentLanes); // grows with lanes
      expect(abortAdds).toBeLessThan(tasks.length); // must be sub-linear in tasks
    });
  });

  describe('all listeners removed after run completes', () => {
    it('removes every TaskReady and TaskSettled listener after processing many tasks', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const tasks = Array.from({ length: 8 }, (_, i) => makeTask({ id: `task-${i + 1}` }));
      const { pool, tracker } = createPoolAndTracker({ tasks, maxConcurrentLanes: 3 });
      await pool.run();
      expect(tracker.listenerCount(TaskTracker.Events.TaskReady)).toBe(0);
      expect(tracker.listenerCount(TaskTracker.Events.TaskSettled)).toBe(0);
    });

    it('removes every listener after a run that exercised the idle wait path', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-1', dependencies: [] }),
          { ...makeTask({ id: 'task-2', dependencies: ['task-1'] }), status: 'blocked' as const },
        ],
        maxConcurrentLanes: 2,
      });
      await pool.run();
      expect(tracker.listenerCount(TaskTracker.Events.TaskReady)).toBe(0);
      expect(tracker.listenerCount(TaskTracker.Events.TaskSettled)).toBe(0);
    });
  });

  describe('AbortSignal listener cleanup', () => {
    it('balances every abort addEventListener with a removeEventListener', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const controller = new AbortController();

      let abortAdds = 0;
      let abortRemoves = 0;
      const origAdd = controller.signal.addEventListener.bind(controller.signal);
      const origRemove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
        if (args[0] === 'abort') abortAdds++;
        return origAdd(...args);
      }) as typeof controller.signal.addEventListener;
      controller.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
        if (args[0] === 'abort') abortRemoves++;
        return origRemove(...args);
      }) as typeof controller.signal.removeEventListener;

      const tasks = Array.from({ length: 6 }, (_, i) => makeTask({ id: `task-${i + 1}` }));
      const { pool } = createPoolAndTracker({ tasks, maxConcurrentLanes: 2, signal: controller.signal });
      await pool.run();

      expect(abortAdds).toBeGreaterThan(0);
      expect(abortRemoves).toBe(abortAdds);
    });

    it('removes all abort listeners so a post-run abort triggers no lane callbacks', async () => {
      setupProfileMocks();
      const session = { ...makeSession(() => 'done'), abort: mock(async () => {}) };
      mockCreateHarness.mockResolvedValue({ session, sessionId: 's', dispose: mock(() => {}) });

      const controller = new AbortController();
      const { pool } = createPoolAndTracker({ tasks: [makeTask()], maxConcurrentLanes: 2, signal: controller.signal });
      await pool.run();

      // After run completes, aborting must not invoke any lingering session abort.
      controller.abort();
      // session.abort is only called by run()'s abortActiveSessions listener,
      // which is removed in run()'s finally — so a post-run abort is a no-op.
      expect(session.abort).not.toHaveBeenCalled();
    });
  });
});
