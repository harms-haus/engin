/**
 * @fileoverview Tests for AbortSignal handling paths in LanePool.run().
 *
 * Covers three critical concurrency scenarios:
 *
 * 1. **Already-aborted signal returns early** (line 69 check):
 *    When signal is already aborted before run(), the pool returns
 *    {completedTasks:0, failedTasks:0} immediately without spawning
 *    lanes or loading profiles.
 *
 * 2. **Signal fires mid-run causes lanes to exit**:
 *    When abort fires while lanes are processing tasks, the lanes
 *    detect cancellation on their next loop iteration and the run()
 *    promise resolves without hanging.
 *
 * 3. **Active sessions are aborted when signal fires** (lines 94–100):
 *    The abortActiveSessions listener iterates activeSessions and calls
 *    abort() on each in-progress session so LLM calls are cancelled
 *    immediately instead of running to completion.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
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

interface AbortPoolOptions {
  maxConcurrentLanes?: number;
  getStepsForTask?: (task: Task) => StepDefinition[];
  tasks?: Task[];
  signal?: AbortSignal;
}

function createPoolAndTracker(overrides?: AbortPoolOptions) {
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
    taskTracker: tracker,
    getStepsForTask,
    signal: overrides?.signal,
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

describe('LanePool AbortSignal handling', () => {
  // ── Scenario 1: Already-aborted signal returns early ────────────────────

  describe('already-aborted signal returns early', () => {
    it('returns {completedTasks: 0, failedTasks: 0} when signal is already aborted', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const controller = new AbortController();
      controller.abort();

      const { pool } = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' })],
        maxConcurrentLanes: 1,
        signal: controller.signal,
      });

      const result = await pool.run();

      expect(result).toEqual({ completedTasks: 0, failedTasks: 0 });
    });

    it('does not call loadProfilesFromDirs when signal is already aborted', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const controller = new AbortController();
      controller.abort();

      const { pool } = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' })],
        signal: controller.signal,
      });

      await pool.run();

      expect(mockLoadProfilesFromDirs).not.toHaveBeenCalled();
    });

    it('does not call createHarness when signal is already aborted', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const controller = new AbortController();
      controller.abort();

      const { pool } = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' })],
        signal: controller.signal,
      });

      await pool.run();

      expect(mockCreateHarness).not.toHaveBeenCalled();
    });

    it('returns early even with multiple tasks in the tracker', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const controller = new AbortController();
      controller.abort();

      const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' }), makeTask({ id: 'task-3' })];

      const { pool } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 3,
        signal: controller.signal,
      });

      const result = await pool.run();

      expect(result).toEqual({ completedTasks: 0, failedTasks: 0 });
      expect(mockCreateHarness).not.toHaveBeenCalled();
      expect(mockLoadProfilesFromDirs).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 2: Signal fires mid-run causes lanes to exit ───────────────

  describe('signal fires mid-run causes lanes to exit', () => {
    it('resolves run() without hanging when abort fires during processing', async () => {
      setupProfileMocks();

      // Track pending prompt resolvers so abort can unblock them
      const promptResolvers: (() => void)[] = [];

      const abortFn = mock(async () => {
        // When abort is called, resolve all pending prompts so lanes can exit
        for (const resolve of promptResolvers) {
          resolve();
        }
      });

      const makeDelayedSession = () => ({
        ...makeSession(() => 'done'),
        abort: abortFn,
        prompt: mock(async () => {
          await new Promise<void>((resolve) => {
            promptResolvers.push(resolve);
          });
        }),
      });

      let harnessCount = 0;
      mockCreateHarness.mockImplementation(() => {
        harnessCount++;
        return {
          session: makeDelayedSession(),
          sessionId: `session-${harnessCount}`,
          dispose: mock(() => {}),
        };
      });

      const controller = new AbortController();

      const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })];

      const { pool } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 2,
        signal: controller.signal,
      });

      const runPromise = pool.run();

      // Wait for lanes to start processing (harness created, prompt called)
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Abort while lanes are mid-prompt — abortActiveSessions calls session.abort()
      // which resolves the pending prompt promises
      controller.abort();

      // run() should resolve without hanging
      const result = await runPromise;

      expect(result).toBeDefined();
      expect(typeof result.completedTasks).toBe('number');
      expect(typeof result.failedTasks).toBe('number');
      // At least some tasks may not have completed due to abort
      expect(result.completedTasks + result.failedTasks).toBeLessThanOrEqual(2);
    });

    it('stops processing additional tasks after abort signal fires', async () => {
      setupProfileMocks();

      const controller = new AbortController();

      const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' }), makeTask({ id: 'task-3' })];

      // Use a single lane so tasks are processed sequentially
      const { pool } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 1,
        signal: controller.signal,
      });

      // First harness blocks on prompt; subsequent ones would succeed
      let harnessCallCount = 0;
      let firstPromptResolve: (() => void) | undefined;
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

      // Wait for the first task to be in progress (mid-prompt)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Abort while the first task is still being processed
      controller.abort();

      const result = await runPromise;

      // The lane should stop processing after abort — at most the first task
      // may have completed or failed, but not all 3
      expect(result.completedTasks + result.failedTasks).toBeLessThanOrEqual(1);
    });

    it('removes abort listener from signal after run completes', async () => {
      setupProfileMocks();

      const session = {
        ...makeSession(() => 'done'),
        abort: mock(async () => {}),
      };

      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const controller = new AbortController();

      // Spy on removeEventListener to verify it's called in the finally block
      const removeSpy = mock(() => {});
      const origRemove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.removeEventListener = ((...args: unknown[]) => {
        removeSpy(...args);
        return origRemove(...args);
      }) as typeof controller.signal.removeEventListener;

      const { pool } = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' })],
        maxConcurrentLanes: 1,
        signal: controller.signal,
      });

      // Pool completes normally without abort
      await pool.run();

      // The finally block in run() removes the abortActiveSessions listener
      // so it doesn't leak
      expect(removeSpy).toHaveBeenCalled();
    });
  });

  // ── Scenario 3: Active sessions are aborted when signal fires ───────────

  describe('active sessions are aborted when signal fires', () => {
    it('calls abort on in-progress sessions when signal fires', async () => {
      setupProfileMocks();

      // Create sessions with spyable abort methods
      const abortFn1 = mock(async () => {});
      const abortFn2 = mock(async () => {});

      const session1 = {
        ...makeSession(() => 'done'),
        abort: abortFn1,
      };
      const session2 = {
        ...makeSession(() => 'done'),
        abort: abortFn2,
      };

      let harnessIndex = 0;
      const sessions = [session1, session2];

      // Create harness returns sessions that block on prompt until abort resolves them
      mockCreateHarness.mockImplementation(() => {
        const session = sessions[harnessIndex++];
        return {
          session,
          sessionId: `session-${harnessIndex}`,
          dispose: mock(() => {}),
        };
      });

      const controller = new AbortController();

      const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })];

      const { pool } = createPoolAndTracker({
        tasks,
        maxConcurrentLanes: 2,
        signal: controller.signal,
      });

      // Override session.prompt to block until abort fires
      const promptPromises: { resolve: () => void }[] = [];

      session1.prompt = mock(async () => {
        await new Promise<void>((resolve) => {
          promptPromises.push({ resolve });
        });
      });
      session2.prompt = mock(async () => {
        await new Promise<void>((resolve) => {
          promptPromises.push({ resolve });
        });
      });

      const runPromise = pool.run();

      // Wait for lanes to start and sessions to be added to activeSessions
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Both sessions should be in activeSessions now, fire abort
      controller.abort();

      // Resolve the prompts so lanes can continue after abort
      for (const p of promptPromises) {
        p.resolve();
      }

      const result = await runPromise;

      // The abortActiveSessions listener should have called abort() on the
      // active sessions (the ones that were mid-prompt)
      expect(result).toBeDefined();
      // At least one abort should have been called (the session(s) in activeSessions)
      const totalAborts = abortFn1.mock.calls.length + abortFn2.mock.calls.length;
      expect(totalAborts).toBeGreaterThanOrEqual(1);
    });

    it('pool completes without hanging when abort fires during session prompt', async () => {
      setupProfileMocks();

      // Session that blocks on prompt and has abort to cancel it
      let promptResolve: (() => void) | undefined;
      const abortFn = mock(async () => {
        // When abort is called, resolve the pending prompt so the lane can exit
        if (promptResolve) promptResolve();
      });

      const session = {
        ...makeSession(() => 'done'),
        abort: abortFn,
        prompt: mock(async () => {
          await new Promise<void>((resolve) => {
            promptResolve = resolve;
          });
        }),
      };

      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const controller = new AbortController();

      const { pool } = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' })],
        maxConcurrentLanes: 1,
        signal: controller.signal,
      });

      const runPromise = pool.run();

      // Wait for the session to be in activeSessions (mid-prompt)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Abort should trigger abortActiveSessions which calls session.abort(),
      // which resolves the pending prompt, allowing the lane to continue
      controller.abort();

      // Should resolve without hanging — this is the key assertion
      const result = await runPromise;

      expect(result).toBeDefined();
      expect(typeof result.completedTasks).toBe('number');
      expect(typeof result.failedTasks).toBe('number');
      // The abort was called on the active session
      expect(abortFn).toHaveBeenCalled();
    });

    it('active sessions Set is cleaned up as sessions finish after abort', async () => {
      setupProfileMocks();

      // Track when sessions enter/leave the active set by watching
      // the onAgentSpawn/onAgentComplete callbacks which fire in the
      // same finally block that removes from activeSessions
      const spawnCount = { value: 0 };
      const completeCount = { value: 0 };

      const session = {
        ...makeSession(() => 'done'),
        abort: mock(async () => {}),
      };

      let promptResolve: (() => void) | undefined;
      session.prompt = mock(async () => {
        await new Promise<void>((resolve) => {
          promptResolve = resolve;
        });
      });

      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const controller = new AbortController();

      const onAgentSpawn = mock(() => {
        spawnCount.value++;
      });
      const onAgentComplete = mock(() => {
        completeCount.value++;
      });

      createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' })],
        maxConcurrentLanes: 1,
        signal: controller.signal,
      });

      // Re-create pool with status callbacks
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'task-1' }));

      const poolWithStatus = new LanePool({
        maxConcurrentLanes: 1,
        profilesDirs: ['/mock/profiles'],
        sessionBaseDir: '/tmp/sessions',
        cwd: '/tmp/project',
        taskTracker: tracker,
        getStepsForTask: () => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
        signal: controller.signal,
        onStatus: { onAgentSpawn, onAgentComplete },
      });

      const runPromise = poolWithStatus.run();

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Abort while the session is active
      controller.abort();

      // Resolve the prompt so the lane can finish
      if (promptResolve) promptResolve();

      await runPromise;

      // onAgentSpawn fires when session enters activeSessions
      // onAgentComplete fires in the finally block when session is removed
      expect(spawnCount.value).toBe(1);
      expect(completeCount.value).toBe(1);
    });
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../src/core/profile.ts', () => realProfile);
  mock.module('../../src/core/structured-output.ts', () => realStructuredOutput);
});
