/**
 * @fileoverview Tests for the dual-listener wait pattern in LanePool.runLane().
 *
 * The `await new Promise<void>` block in runLane() uses a dual-listener pattern
 * that registers listeners for both TaskReady and TaskSettled events (plus an
 * abort signal). These tests verify the correctness and edge cases of this
 * concurrency pattern:
 *
 * 1. WHY both listeners: TaskReady fires when blocked tasks become ready via
 *    recalculateStatuses; TaskSettled fires when a task completes or fails.
 *    Each covers scenarios the other does not.
 *
 * 2. Race condition safety: the race window is now ELIMINATED — listeners
 *    are registered BEFORE claimTasks/isPoolDone checks so no event emitted
 *    during that gap can be missed.
 *
 * 3. Cleanup prevents double-wake by removing both listeners synchronously.
 *
 * 4. Abort signal listener enables cooperative cancellation while waiting.
 */

import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Task } from '../../src/core/types.js';
import { TaskTracker } from '../../src/tracking/task-status.js';
import { makeMockSession } from '../helpers/make-session.js';
import { makeTask } from '../helpers/make-task.js';

// Capture real modules before mocking so we can restore them in afterAll.
const realHarnessFactory = Object.assign({}, await import('../../src/core/harness-factory.ts'));
const realProfile = Object.assign({}, await import('../../src/core/profile.ts'));
const realStructuredOutput = Object.assign({}, await import('../../src/core/structured-output.ts'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/harness-factory.ts', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/profile.ts', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/structured-output.ts', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { LanePool } from '../../src/pool/lane-pool.ts';
import type { StepDefinition } from '../../src/pool/types.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

const defaultProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [] as string[],
  includeTools: [] as string[],
};

function makeSession(textFn: (promptText: string) => string | undefined = () => 'done') {
  return makeMockSession(textFn).session;
}

/** Mock session that includes an abort method for cooperative cancellation tests. */
function makeSessionWithAbort(textFn?: (promptText: string) => string | undefined) {
  const session = makeSession(textFn);
  return { ...session, abort: mock(async () => {}) };
}

function setupProfileMocks() {
  const profilesMap = new Map<string, typeof defaultProfile>();
  profilesMap.set('coder', defaultProfile);
  mockLoadProfilesFromDirs.mockResolvedValue(profilesMap);
}

function setupHarnessMocks(session?: ReturnType<typeof makeSession>) {
  const sess = session ?? makeSession();
  mockCreateHarness.mockResolvedValue({
    session: sess,
    sessionId: 'test-session',
    dispose: mock(() => {}),
  });
  return sess;
}

/** Set up harness mock with a session that has an abort method. */
function setupHarnessMocksWithAbort(session?: ReturnType<typeof makeSessionWithAbort>) {
  const sess = session ?? makeSessionWithAbort();
  mockCreateHarness.mockResolvedValue({
    session: sess,
    sessionId: 'test-session',
    dispose: mock(() => {}),
  });
  return sess;
}

interface WaitPatternPoolOptions {
  maxConcurrentLanes?: number;
  getStepsForTask?: (task: Task) => StepDefinition[];
  tasks?: Task[];
  signal?: AbortSignal;
  laneWaitTimeoutMs?: number;
}

function createPoolAndTracker(overrides?: WaitPatternPoolOptions) {
  const tracker = new TaskTracker();
  const tasks = overrides?.tasks ?? [makeTask()];
  for (const task of tasks) {
    tracker.addTask(task);
  }

  const getStepsForTask =
    overrides?.getStepsForTask ??
    ((_task: Task): StepDefinition[] => [{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

  const pool = new LanePool({
    maxConcurrentLanes: overrides?.maxConcurrentLanes ?? 1,
    profilesDirs: ['/mock/profiles'],
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    phase: 'implementing',
    taskTracker: tracker,
    getStepsForTask,
    signal: overrides?.signal,
    laneWaitTimeoutMs: overrides?.laneWaitTimeoutMs,
  });

  return { pool, tracker };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreateHarness.mockClear();
  mockLoadProfilesFromDirs.mockClear();
  mockPromptForStructured.mockClear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('LanePool dual-listener wait pattern', () => {
  // ── Event-Driven Wake-Up ────────────────────────────────────────────────

  describe('event-driven wake-up', () => {
    it('wakes waiting lane when dependency task completes (2 lanes, 2 dependent tasks)', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const task1 = makeTask({ id: 'task-1', title: 'First', dependencies: [] });
      const task2 = {
        ...makeTask({ id: 'task-2', title: 'Second', dependencies: ['task-1'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task1, task2],
        maxConcurrentLanes: 2,
      });

      // task-2 should start as blocked since task-1 is not done
      expect(tracker.getTask('task-2')!.status).toBe('blocked');

      const result = await pool.run();

      // One lane processes task-1; the other lane enters the wait block
      // (claimTasks returns empty, isPoolDone is false). When task-1 completes,
      // recalculateStatuses emits TaskReady and completeTask emits TaskSettled,
      // either of which wakes the waiting lane to process task-2.
      expect(result.completedTasks).toBe(2);
      expect(result.failedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('done');
      expect(tracker.getTask('task-2')!.status).toBe('done');
    });

    it('handles chain dependencies with multiple wake-ups (A→B→C, 2 lanes)', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const taskA = makeTask({ id: 'task-A', title: 'A', dependencies: [] });
      const taskB = {
        ...makeTask({ id: 'task-B', title: 'B', dependencies: ['task-A'] }),
        status: undefined as const,
      };
      const taskC = {
        ...makeTask({ id: 'task-C', title: 'C', dependencies: ['task-B'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [taskA, taskB, taskC],
        maxConcurrentLanes: 2,
      });

      // task-B blocked on task-A, task-C blocked on task-B
      expect(tracker.getTask('task-B')!.status).toBe('blocked');
      expect(tracker.getTask('task-C')!.status).toBe('blocked');

      const result = await pool.run();

      // Each completion in the chain triggers a wake-up for the next:
      // task-A completes → task-B becomes ready (wake) → task-B completes →
      // task-C becomes ready (wake) → task-C completes
      expect(result.completedTasks).toBe(3);
      expect(result.failedTasks).toBe(0);
      expect(tracker.getTask('task-A')!.status).toBe('done');
      expect(tracker.getTask('task-B')!.status).toBe('done');
      expect(tracker.getTask('task-C')!.status).toBe('done');
    });

    it('wakes waiting lane when dependency task fails', async () => {
      setupProfileMocks();

      // First createHarness call rejects (task-1 fails), subsequent calls succeed
      mockCreateHarness.mockRejectedValueOnce(new Error('Agent creation failed'));
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => 'done'),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const task1 = makeTask({ id: 'task-1', title: 'First', dependencies: [] });
      const task2 = {
        ...makeTask({ id: 'task-2', title: 'Second', dependencies: ['task-1'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task1, task2],
        maxConcurrentLanes: 2,
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await pool.run();

        // task-1 fails. failTask calls recalculateStatuses, which sees task-1
        // is settled ('failed' counts as settled), so task-2 becomes ready.
        // TaskSettled fires, waking the waiting lane which then processes task-2.
        expect(result.failedTasks).toBe(1);
        expect(result.completedTasks).toBe(1);
        expect(tracker.getTask('task-1')!.status).toBe('failed');
        expect(tracker.getTask('task-2')!.status).toBe('done');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('handles diamond dependency with 3 lanes', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      //       A
      //      / \
      //     B   C
      //      \ /
      //       D
      const taskA = makeTask({ id: 'task-A', title: 'A', dependencies: [] });
      const taskB = {
        ...makeTask({ id: 'task-B', title: 'B', dependencies: ['task-A'] }),
        status: undefined as const,
      };
      const taskC = {
        ...makeTask({ id: 'task-C', title: 'C', dependencies: ['task-A'] }),
        status: undefined as const,
      };
      const taskD = {
        ...makeTask({ id: 'task-D', title: 'D', dependencies: ['task-B', 'task-C'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [taskA, taskB, taskC, taskD],
        maxConcurrentLanes: 3,
      });

      const result = await pool.run();

      // A completes first, unblocking B and C. B and C can run concurrently.
      // D waits until both B and C are settled. The dual-listener pattern
      // ensures D's lane wakes up when the second of B/C completes.
      expect(result.completedTasks).toBe(4);
      expect(result.failedTasks).toBe(0);
      expect(tracker.getTask('task-D')!.status).toBe('done');
    });
  });

  // ── Abort Signal ────────────────────────────────────────────────────────

  describe('abort signal', () => {
    it('resolves wait promise and lane exits on abort during idle wait', async () => {
      setupProfileMocks();
      setupHarnessMocksWithAbort();

      const controller = new AbortController();

      const task1 = makeTask({ id: 'task-1', dependencies: [] });
      const task2 = {
        ...makeTask({ id: 'task-2', dependencies: ['task-1'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task1, task2],
        maxConcurrentLanes: 2,
        signal: controller.signal,
      });

      const runPromise = pool.run();

      // Register a one-shot listener on TaskSettled that fires abort
      // synchronously when the first task completes. At that moment one lane
      // was waiting in the idle-wait block (task-2 was blocked on task-1).
      // Either TaskReady (from recalculateStatuses) or TaskSettled resolves
      // the waiting lane's promise. By calling abort() synchronously inside
      // this listener we ensure signal.aborted is set before the waiting
      // lane's microtask continues, so the lane checks signal.aborted and
      // exits without claiming the now-ready task-2.
      tracker.once(TaskTracker.Events.TaskSettled, () => {
        controller.abort();
      });

      const result = await runPromise;

      // task-1 completed (lane 1). Lane 2 woke up from the event, checked
      // signal.aborted (true), and returned without processing task-2.
      expect(result).toBeDefined();
      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('done');
    });

    it('skips execution when signal is already aborted before run()', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const controller = new AbortController();
      controller.abort();

      const { pool } = createPoolAndTracker({
        tasks: [makeTask()],
        signal: controller.signal,
      });

      const result = await pool.run();

      // Pool returns immediately from the early check at the top of run()
      expect(result.completedTasks).toBe(0);
      expect(result.failedTasks).toBe(0);
      expect(mockCreateHarness).not.toHaveBeenCalled();
    });

    it('lane checks signal.aborted after waking from wait and exits', async () => {
      setupProfileMocks();
      setupHarnessMocksWithAbort();

      const controller = new AbortController();

      const task1 = makeTask({ id: 'task-1', dependencies: [] });
      const task2 = {
        ...makeTask({ id: 'task-2', dependencies: ['task-1'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task1, task2],
        maxConcurrentLanes: 2,
        signal: controller.signal,
      });

      const runPromise = pool.run();

      // Same dual-listener pattern: fire abort synchronously when the first
      // task completes. The waiting lane (blocked on task-2's dependency)
      // wakes from TaskReady/TaskSettled, loops back, checks signal.aborted,
      // and exits without claiming the now-ready task-2.
      tracker.once(TaskTracker.Events.TaskSettled, () => {
        controller.abort();
      });

      const result = await runPromise;

      // The lane that was waiting checked signal.aborted after waking and
      // returned. Only task-1 was processed before abort.
      expect(result).toBeDefined();
      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('done');
    });
  });

  // ── Listener Cleanup ───────────────────────────────────────────────────

  describe('listener cleanup', () => {
    it('removes all TaskReady and TaskSettled listeners after pool completes', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const task1 = makeTask({ id: 'task-1', dependencies: [] });
      const task2 = {
        ...makeTask({ id: 'task-2', dependencies: ['task-1'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task1, task2],
        maxConcurrentLanes: 2,
      });

      await pool.run();

      // After pool completion, the cleanup function in the wait block should
      // have removed all TaskReady and TaskSettled listeners. Both the once()
      // auto-cleanup and the explicit removeListener in cleanup() contribute.
      expect(tracker.listenerCount(TaskTracker.Events.TaskReady)).toBe(0);
      expect(tracker.listenerCount(TaskTracker.Events.TaskSettled)).toBe(0);
    });

    it('removes all listeners even when wake comes from abort signal', async () => {
      setupProfileMocks();
      setupHarnessMocksWithAbort();

      const controller = new AbortController();

      const task1 = makeTask({ id: 'task-1', dependencies: [] });
      const task2 = {
        ...makeTask({ id: 'task-2', dependencies: ['task-1'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task1, task2],
        maxConcurrentLanes: 2,
        signal: controller.signal,
      });

      const runPromise = pool.run();

      // Fire abort synchronously when the first task completes. The
      // cleanup function inside the wait block removes listeners even
      // when the wake is triggered by an abort that fires after the
      // wait promise was already resolved by TaskReady/TaskSettled.
      tracker.once(TaskTracker.Events.TaskSettled, () => {
        controller.abort();
      });

      await runPromise;

      // After pool exit, all listeners must be removed regardless of
      // what triggered the wake (event vs abort).
      expect(tracker.listenerCount(TaskTracker.Events.TaskReady)).toBe(0);
      expect(tracker.listenerCount(TaskTracker.Events.TaskSettled)).toBe(0);
    });

    it('cleanup prevents a second listener from firing after first wake', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      // Use 2 lanes with dependent tasks. When task-1 completes, both
      // TaskReady (from recalculateStatuses) and TaskSettled (from
      // completeTask) fire in quick succession. The cleanup function removes
      // the second listener synchronously before it can fire, so only one
      // wake occurs per lane.
      const task1 = makeTask({ id: 'task-1', dependencies: [] });
      const task2 = {
        ...makeTask({ id: 'task-2', dependencies: ['task-1'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task1, task2],
        maxConcurrentLanes: 2,
      });

      // Track how many times claimTasks is called to ensure no double-processing.
      // With 2 lanes and 2 tasks (one dependent), there should be exactly 2
      // successful claims (task-1 by one lane, task-2 by the other after wake).
      let claimCount = 0;
      const originalClaim = tracker.claimTasks.bind(tracker);
      const spy = spyOn(tracker, 'claimTasks').mockImplementation((count: number) => {
        const tasks = originalClaim(count);
        if (tasks.length > 0) claimCount++;
        return tasks;
      });

      try {
        await pool.run();

        // Exactly 2 successful claims — one per task. No double-wake caused
        // a lane to claim the same task or attempt an extra claim.
        expect(claimCount).toBe(2);
        expect(tracker.getTask('task-1')!.status).toBe('done');
        expect(tracker.getTask('task-2')!.status).toBe('done');
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── Configurable Lane Wait Timeout ──────────────────────────────────

  describe('configurable lane wait timeout', () => {
    it('passes laneWaitTimeoutMs to setTimeout for the wait', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const realSetTimeout = globalThis.setTimeout;
      const task = makeTask({ id: 'task-1', dependencies: [] });
      // Manually set status to 'implementing' so it's not claimable and not settled
      // → lane enters the wait block
      task.status = 'implementing';

      const controller = new AbortController();
      const { pool } = createPoolAndTracker({
        tasks: [task],
        maxConcurrentLanes: 1,
        laneWaitTimeoutMs: 1234,
        signal: controller.signal,
      });

      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((cb: any, delay?: number) =>
        realSetTimeout(cb, delay)) as any);

      const t = setTimeout(() => controller.abort(), 200);

      try {
        await pool.run();

        const hasCorrectDelay = setTimeoutSpy.mock.calls.some((call) => call[1] === 1234);
        expect(hasCorrectDelay).toBe(true);
      } finally {
        clearTimeout(t);
        setTimeoutSpy.mockRestore();
      }
    });

    it('defaults to 60000 when laneWaitTimeoutMs is not provided', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const realSetTimeout = globalThis.setTimeout;
      const task = makeTask({ id: 'task-1', dependencies: [] });
      task.status = 'implementing';

      const controller = new AbortController();
      const { pool } = createPoolAndTracker({
        tasks: [task],
        maxConcurrentLanes: 1,
        signal: controller.signal,
      });

      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((cb: any, delay?: number) =>
        realSetTimeout(cb, delay)) as any);

      const t = setTimeout(() => controller.abort(), 200);

      try {
        await pool.run();

        // POST-FIX default is 60000; current source uses 30000 → fails RED
        const hasCorrectDelay = setTimeoutSpy.mock.calls.some((call) => call[1] === 60000);
        expect(hasCorrectDelay).toBe(true);
      } finally {
        clearTimeout(t);
        setTimeoutSpy.mockRestore();
      }
    });
  });

  // ── TOCTOU Missed-Wakeup Fix ────────────────────────────────────────

  describe('TOCTOU missed-wakeup fix', () => {
    it('catches TaskReady emitted during claimTasks without waiting for timeout', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const realSetTimeout = globalThis.setTimeout;
      const task = makeTask({ id: 'task-1', dependencies: [] });
      task.status = 'implementing';

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task],
        maxConcurrentLanes: 1,
        laneWaitTimeoutMs: 60000,
      });

      // Block long timeouts (pool's 60000 ms) so the test doesn't hang
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((cb: any, delay?: number) => {
        if (typeof delay === 'number' && delay >= 1000) return 0 as any;
        return realSetTimeout(cb, delay);
      }) as any);

      // Simulate TOCTOU race: emit TaskReady synchronously *during* claimTasks
      // before the return. In the current code, listeners are registered
      // AFTER claimTasks, so this event is missed → lane hangs → RED.
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

        // If the TOCTOU fix works, the pool catches the TaskReady during
        // claimTasks and the lane finds the task on the next iteration.
        expect(result.completedTasks).toBe(1);
        expect(tracker.getTask('task-1')!.status).toBe('done');
      } finally {
        claimSpy.mockRestore();
        setTimeoutSpy.mockRestore();
      }
    });
  });

  // ── Log Noise Reduction ─────────────────────────────────────────────

  describe('log noise reduction', () => {
    it('logs routine timeout poll at debug level, not warn', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const task = makeTask({ id: 'task-1', dependencies: [] });
      task.status = 'implementing';

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task],
        maxConcurrentLanes: 1,
        laneWaitTimeoutMs: 10,
      });

      let counter = 0;
      const originalClaim = tracker.claimTasks.bind(tracker);
      const claimSpy = spyOn(tracker, 'claimTasks').mockImplementation((count: number) => {
        counter++;
        if (counter > 2) {
          tracker.getTask('task-1')!.status = 'ready';
        }
        return originalClaim(count);
      });

      const debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await pool.run();

        // POST-FIX: routine timeouts logged at debug level
        expect(debugSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

        // Below stall threshold (5), no stall warning expected
        const stallWarnings = warnSpy.mock.calls.filter((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('stall')),
        );
        expect(stallWarnings.length).toBe(0);
      } finally {
        claimSpy.mockRestore();
        debugSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('escalates to console.warn once after STALL_WARN_THRESHOLD consecutive timeouts', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const task = makeTask({ id: 'task-1', dependencies: [] });
      task.status = 'implementing';

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task],
        maxConcurrentLanes: 1,
        laneWaitTimeoutMs: 10,
      });

      let counter = 0;
      const originalClaim = tracker.claimTasks.bind(tracker);
      const claimSpy = spyOn(tracker, 'claimTasks').mockImplementation((count: number) => {
        counter++;
        if (counter > 8) {
          tracker.getTask('task-1')!.status = 'ready';
        }
        return originalClaim(count);
      });

      const debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await pool.run();

        // POST-FIX: EXACTLY ONE stall warning after crossing threshold
        const stallWarnings = warnSpy.mock.calls.filter((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('stall')),
        );
        expect(stallWarnings.length).toBe(1);

        // Multiple debug-level timeout polls
        expect(debugSpy.mock.calls.length).toBeGreaterThan(1);
      } finally {
        claimSpy.mockRestore();
        debugSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  // ── Stranded-Task Hardening ─────────────────────────────────────────

  describe('stranded-task hardening', () => {
    it('fails task when submitForReview throws instead of stranding it', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const controller = new AbortController();
      const { pool, tracker } = createPoolAndTracker({
        tasks: [makeTask()],
        maxConcurrentLanes: 1,
        laneWaitTimeoutMs: 100,
        signal: controller.signal,
      });

      const submitSpy = spyOn(tracker, 'submitForReview').mockImplementation(() => {
        throw new Error('Tracker state error');
      });
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      const t = setTimeout(() => controller.abort(), 500);

      try {
        const result = await pool.run();

        // POST-FIX: when submitForReview throws, pool marks task as failed
        // instead of leaving it stranded in 'implementing' status
        expect(result.failedTasks).toBe(1);
        expect(tracker.getTask('task-1')!.status).toBe('failed');
      } finally {
        clearTimeout(t);
        submitSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../src/core/profile.ts', () => realProfile);
  mock.module('../../src/core/structured-output.ts', () => realStructuredOutput);
});
