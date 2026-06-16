/**
 * @fileoverview Tests for AbortSignal handling paths in LanePool.run().
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  clearPoolMocks,
  createPoolAndTracker,
  makeSession,
  makeTask,
  mockCreateHarness,
  mockLoadProfilesFromDirs,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.js';

beforeEach(() => {
  clearPoolMocks();
});

describe('LanePool AbortSignal handling', () => {
  describe('already-aborted signal returns early', () => {
    it('returns {completedTasks: 0, failedTasks: 0} when signal is already aborted', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const controller = new AbortController();
      controller.abort();
      expect(
        await createPoolAndTracker({
          tasks: [makeTask({ id: 'task-1' })],
          maxConcurrentLanes: 1,
          signal: controller.signal,
        }).pool.run(),
      ).toEqual({ completedTasks: 0, failedTasks: 0 });
    });

    it('does not call loadProfilesFromDirs when signal is already aborted', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const controller = new AbortController();
      controller.abort();
      await createPoolAndTracker({ tasks: [makeTask({ id: 'task-1' })], signal: controller.signal }).pool.run();
      expect(mockLoadProfilesFromDirs).not.toHaveBeenCalled();
    });

    it('does not call createHarness when signal is already aborted', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const controller = new AbortController();
      controller.abort();
      await createPoolAndTracker({ tasks: [makeTask({ id: 'task-1' })], signal: controller.signal }).pool.run();
      expect(mockCreateHarness).not.toHaveBeenCalled();
    });

    it('returns early even with multiple tasks', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const controller = new AbortController();
      controller.abort();
      const result = await createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' }), makeTask({ id: 'task-3' })],
        maxConcurrentLanes: 3,
        signal: controller.signal,
      }).pool.run();
      expect(result).toEqual({ completedTasks: 0, failedTasks: 0 });
      expect(mockCreateHarness).not.toHaveBeenCalled();
    });
  });

  describe('signal fires mid-run causes lanes to exit', () => {
    it('resolves run() without hanging when abort fires during processing', async () => {
      setupProfileMocks();
      const promptResolvers: (() => void)[] = [];
      const abortFn = mock(async () => {
        promptResolvers.forEach((r) => r());
      });
      let promptsCalled: () => void;
      const called = new Promise<void>((r) => {
        promptsCalled = r;
      });
      let count = 0;
      const mkSession = () => ({
        ...makeSession(() => 'done'),
        abort: abortFn,
        prompt: mock(async () => {
          count++;
          if (count === 2) promptsCalled!();
          await new Promise<void>((r) => promptResolvers.push(r));
        }),
      });
      let hc = 0;
      mockCreateHarness.mockImplementation(() => {
        hc++;
        return { session: mkSession(), sessionId: `s-${hc}`, dispose: mock(() => {}) };
      });
      const controller = new AbortController();
      const runPromise = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })],
        maxConcurrentLanes: 2,
        signal: controller.signal,
      }).pool.run();
      await called;
      controller.abort();
      const result = await runPromise;
      expect(result.completedTasks + result.failedTasks).toBeLessThanOrEqual(2);
    });

    it('stops processing additional tasks after abort signal fires', async () => {
      setupProfileMocks();

      const controller = new AbortController();

      const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' }), makeTask({ id: 'task-3' })];

      const { pool } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 1,
        signal: controller.signal,
      });

      let harnessCallCount = 0;
      let firstPromptResolve: (() => void) | undefined;
      let promptCalledResolve: (() => void) | undefined;
      const promptCalled = new Promise<void>((resolve) => {
        promptCalledResolve = resolve;
      });
      mockCreateHarness.mockImplementation(() => {
        harnessCallCount++;
        if (harnessCallCount === 1) {
          // First task: block on prompt so abort can fire mid-processing
          const session = {
            ...makeSession(() => 'done'),
            abort: mock(async () => {
              // When abort fires, unblock the first prompt
              if (firstPromptResolve) firstPromptResolve();
            }),
            prompt: mock(async () => {
              // Signal that prompt was called (lane is mid-prompt)
              if (promptCalledResolve) promptCalledResolve();
              await new Promise<void>((resolve) => {
                firstPromptResolve = resolve;
              });
            }),
          };
          return {
            session,
            sessionId: `session-${harnessCallCount}`,
            dispose: mock(() => {}),
          };
        }
        return {
          session: makeSession(() => 'done'),
          sessionId: `session-${harnessCallCount}`,
          dispose: mock(() => {}),
        };
      });

      const runPromise = pool.run();

      // Wait for the first task to start its prompt (lane is mid-processing)
      await promptCalled;

      // Abort while the first task is still being processed
      controller.abort();

      const result = await runPromise;

      // The lane should stop processing after abort — at most the first task
      // may have completed or failed, but not all 3
      expect(result.completedTasks + result.failedTasks).toBeLessThanOrEqual(1);
    });

    it('removes abort listener from signal after run completes', async () => {
      setupProfileMocks();
      const session = { ...makeSession(() => 'done'), abort: mock(async () => {}) };
      mockCreateHarness.mockResolvedValue({ session, sessionId: 'test-session', dispose: mock(() => {}) });
      const controller = new AbortController();
      const removeSpy = mock(() => {});
      const orig = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.removeEventListener = ((...args: Parameters<typeof orig>) => {
        removeSpy();
        return orig(...args);
      }) as typeof controller.signal.removeEventListener;
      await createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' })],
        maxConcurrentLanes: 1,
        signal: controller.signal,
      }).pool.run();
      expect(removeSpy).toHaveBeenCalled();
    });
  });

  describe('active sessions are aborted when signal fires', () => {
    it('calls abort on in-progress sessions when signal fires', async () => {
      setupProfileMocks();
      const a1 = mock(async () => {}),
        a2 = mock(async () => {});
      const s1 = { ...makeSession(() => 'done'), abort: a1 },
        s2 = { ...makeSession(() => 'done'), abort: a2 };
      let idx = 0;
      mockCreateHarness.mockImplementation(() => ({
        session: [s1, s2][idx++],
        sessionId: `s-${idx}`,
        dispose: mock(() => {}),
      }));
      const controller = new AbortController();
      let called: () => void;
      const promptsCalled = new Promise<void>((r) => {
        called = r;
      });
      let pc = 0;
      const pp: (() => void)[] = [];
      s1.prompt = mock(async () => {
        pc++;
        if (pc === 2) called!();
        await new Promise<void>((r) => pp.push(r));
      });
      s2.prompt = mock(async () => {
        pc++;
        if (pc === 2) called!();
        await new Promise<void>((r) => pp.push(r));
      });
      const runPromise = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })],
        maxConcurrentLanes: 2,
        signal: controller.signal,
      }).pool.run();
      await promptsCalled;
      controller.abort();
      pp.forEach((r) => r());
      await runPromise;
      expect(a1.mock.calls.length + a2.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('pool completes without hanging when abort fires during session prompt', async () => {
      setupProfileMocks();
      let pr: () => void;
      const af = mock(async () => {
        pr?.();
      });
      let called: () => void;
      const promptCalled = new Promise<void>((r) => {
        called = r;
      });
      const session = {
        ...makeSession(() => 'done'),
        abort: af,
        prompt: mock(async () => {
          called!();
          await new Promise<void>((r) => {
            pr = r;
          });
        }),
      };
      mockCreateHarness.mockResolvedValue({ session, sessionId: 'test-session', dispose: mock(() => {}) });
      const controller = new AbortController();
      const runPromise = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' })],
        maxConcurrentLanes: 1,
        signal: controller.signal,
      }).pool.run();
      await promptCalled;
      controller.abort();
      const result = await runPromise;
      expect(result).toBeDefined();
      expect(af).toHaveBeenCalled();
    });
  });

  describe('snapshot prevents skipped entries during abort iteration', () => {
    it('all three concurrent sessions are aborted when signal fires', async () => {
      setupProfileMocks();
      const [a1, a2, a3] = [mock(async () => {}), mock(async () => {}), mock(async () => {})];
      const [s1, s2, s3] = [
        { ...makeSession(() => 'done'), abort: a1 },
        { ...makeSession(() => 'done'), abort: a2 },
        { ...makeSession(() => 'done'), abort: a3 },
      ];
      let idx = 0;
      mockCreateHarness.mockImplementation(() => ({
        session: [s1, s2, s3][idx++],
        sessionId: `s-${idx}`,
        dispose: mock(() => {}),
      }));
      const controller = new AbortController();
      let allCalled: () => void;
      const allPromptsCalled = new Promise<void>((r) => {
        allCalled = r;
      });
      let pc = 0;
      const resolvers: (() => void)[] = [];
      for (const s of [s1, s2, s3]) {
        s.prompt = mock(async () => {
          pc++;
          if (pc === 3) allCalled!();
          await new Promise<void>((r) => resolvers.push(r));
        });
      }
      const runPromise = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' }), makeTask({ id: 'task-3' })],
        maxConcurrentLanes: 3,
        signal: controller.signal,
      }).pool.run();
      await allPromptsCalled;
      controller.abort();
      resolvers.forEach((r) => r());
      await runPromise;
      expect(a1).toHaveBeenCalledTimes(1);
      expect(a2).toHaveBeenCalledTimes(1);
      expect(a3).toHaveBeenCalledTimes(1);
    });

    it('aborts all sessions even when one removes itself during another abort() call', async () => {
      setupProfileMocks();
      const [a1, a2, a3] = [mock(async () => {}), mock(async () => {}), mock(async () => {})];
      const [s1, s2, s3] = [
        { ...makeSession(() => 'done'), abort: a1 },
        { ...makeSession(() => 'done'), abort: a2 },
        { ...makeSession(() => 'done'), abort: a3 },
      ];
      let idx = 0;
      mockCreateHarness.mockImplementation(() => ({
        session: [s1, s2, s3][idx++],
        sessionId: `s-${idx}`,
        dispose: mock(() => {}),
      }));
      const controller = new AbortController();
      let allCalled: () => void;
      const allPromptsCalled = new Promise<void>((r) => {
        allCalled = r;
      });
      let pc = 0;
      const resolvers: (() => void)[] = [];
      a1.mockImplementation(async () => {
        if (resolvers.length >= 2) resolvers[1]();
      });
      for (const s of [s1, s2, s3]) {
        s.prompt = mock(async () => {
          pc++;
          if (pc === 3) allCalled!();
          await new Promise<void>((r) => resolvers.push(r));
        });
      }
      const runPromise = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' }), makeTask({ id: 'task-3' })],
        maxConcurrentLanes: 3,
        signal: controller.signal,
      }).pool.run();
      await allPromptsCalled;
      controller.abort();
      resolvers.forEach((r) => r());
      await runPromise;
      expect(a1).toHaveBeenCalled();
      expect(a2).toHaveBeenCalled();
      expect(a3).toHaveBeenCalled();
    });

    it('still aborts remaining sessions when some sessions finish concurrently', async () => {
      setupProfileMocks();
      const [a1, a2, a3] = [mock(async () => {}), mock(async () => {}), mock(async () => {})];
      const [s1, s2, s3] = [
        { ...makeSession(() => 'done'), abort: a1 },
        { ...makeSession(() => 'done'), abort: a2 },
        { ...makeSession(() => 'done'), abort: a3 },
      ];
      let idx = 0;
      mockCreateHarness.mockImplementation(() => ({
        session: [s1, s2, s3][idx++],
        sessionId: `s-${idx}`,
        dispose: mock(() => {}),
      }));
      const controller = new AbortController();
      s3.prompt = mock(async (_text: string) => {});
      let midCalled: () => void;
      const midPromptsCalled = new Promise<void>((r) => {
        midCalled = r;
      });
      let mc = 0;
      const resolvers: (() => void)[] = [];
      s1.prompt = mock(async () => {
        mc++;
        if (mc === 2) midCalled!();
        await new Promise<void>((r) => resolvers.push(r));
      });
      s2.prompt = mock(async () => {
        mc++;
        if (mc === 2) midCalled!();
        await new Promise<void>((r) => resolvers.push(r));
      });
      const runPromise = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' }), makeTask({ id: 'task-3' })],
        maxConcurrentLanes: 3,
        signal: controller.signal,
      }).pool.run();
      await midPromptsCalled;
      controller.abort();
      resolvers.forEach((r) => r());
      await runPromise;
      expect(a1).toHaveBeenCalled();
      expect(a2).toHaveBeenCalled();
    });
  });
});
