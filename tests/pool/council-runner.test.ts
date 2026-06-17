/**
 * @fileoverview Tests for councilRunner – parallel worker execution with
 * synthesizer merge.
 *
 * Uses mock.module to replace runStep in step-execution so we can control
 * per-worker outcomes and track session disposal. Restores the real module
 * in afterAll so other test files are not affected.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

// ─── Capture real module before mocking ────────────────────────────────────

const realStepExecution = Object.assign({}, await import('../../packages/engine/src/pool/step-execution.js'));

// ─── Mock definitions + mock.module ────────────────────────────────────────

export const mockRunStep = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module('../../packages/engine/src/pool/step-execution.js', () => ({
  runStep: (...args: unknown[]) => mockRunStep(...args),
}));

// ─── Imports after mock.module ─────────────────────────────────────────────

import type { Task } from '../../packages/engine/src/core/types.js';
import { councilRunner } from '../../packages/engine/src/pool/council-runner.js';
import type { StepDefinition, TaskRunnerContext, TrackedSession } from '../../packages/engine/src/pool/types.js';
import { clearPoolMocks } from './helpers.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Create a mock TrackedSession with a tracked dispose mock. */
function makeTrackedSession(disposeFn?: ReturnType<typeof mock>): {
  trackedSession: TrackedSession;
  dispose: ReturnType<typeof mock>;
} {
  const dispose = disposeFn ?? mock(() => {});
  return {
    trackedSession: {
      session: {
        abort: mock(async () => {}),
        dispose: mock(() => {}),
        subscribe: mock(() => () => {}),
        prompt: mock(async () => {}),
        getLastAssistantText: mock(() => 'output'),
        sessionId: 'test-session',
      },
      dispose,
      sessionPath: '/tmp/sessions/test',
    },
    dispose,
  };
}

/** Create a minimal task for test context. */
function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    prompt: 'Do the thing',
    profile: 'coder',
    files: ['src/index.ts'],
    dependencies: [],
    status: 'ready',
    phaseId: 'phase-1',
    ...overrides,
  };
}

/** TestContext extends TaskRunnerContext so mock functions keep their `.mock` property. */
interface TestContext extends TaskRunnerContext {
  completeTask: ReturnType<typeof mock>;
  failTask: ReturnType<typeof mock>;
}

/** Create a runner context with mock complete/fail. */
function createCtx(overrides?: Partial<TestContext>): TestContext {
  return {
    task: makeTask(),
    agentId: 'lane-0',
    profiles: new Map(),
    onStatus: undefined,
    activeSessions: new Set<{ abort(): Promise<void> }>(),
    phaseId: 'implementing',
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    maxStepRetries: 5,
    completeTask: mock(() => true),
    failTask: mock(() => {}),
    ...overrides,
  } as TestContext;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRunStep.mockClear();
  clearPoolMocks();
});

afterAll(() => {
  mock.module('../../packages/engine/src/pool/step-execution.js', () => realStepExecution);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('councilRunner', () => {
  describe('basic parallel execution', () => {
    it('runs all workers and synthesizer, returns completed on approval', async () => {
      mockRunStep.mockResolvedValue({
        result: { type: 'approved', output: 'worker output' },
        trackedSession: makeTrackedSession().trackedSession,
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'writer', profileId: 'coder', isReadOnly: false },
          { name: 'tester', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'merge', profileId: 'coder', isReadOnly: false },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).not.toHaveBeenCalled();
      // 2 workers + 1 synthesizer
      expect(mockRunStep).toHaveBeenCalledTimes(3);
    });

    it('passes the synthesizer output to completeTask so it lands on task.result', async () => {
      let call = 0;
      mockRunStep.mockImplementation(async () => {
        call++;
        // calls 1..2 are workers, call 3 is the synthesizer
        const output = call <= 2 ? `worker-${call}` : 'merged-synthesis';
        return { result: { type: 'approved', output }, trackedSession: makeTrackedSession().trackedSession };
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'writer', profileId: 'coder', isReadOnly: false },
          { name: 'tester', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'merge', profileId: 'coder', isReadOnly: false },
      });

      await runner(ctx);

      expect(ctx.completeTask).toHaveBeenCalledWith('merged-synthesis');
    });

    it('includes worker outputs in synthesizer prompt', async () => {
      let callCount = 0;
      mockRunStep.mockImplementation(async (_task: Task, _step: StepDefinition) => {
        callCount++;
        // Return different outputs per worker
        if (callCount <= 2) {
          return {
            result: { type: 'approved', output: `Worker ${callCount - 1} result` },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        // Synthesizer - check the prompt
        return {
          result: { type: 'approved', output: 'merged' },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'impl', profileId: 'coder', isReadOnly: false },
          { name: 'test', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      await runner(ctx);

      // Third call: synthesizer should receive the combined prompt
      const synthCallArgs = mockRunStep.mock.calls[2];
      const synthTask = synthCallArgs[0] as Task;
      expect(synthTask.prompt).toContain('## Worker Outputs');
      expect(synthTask.prompt).toContain('### Worker 0');
      expect(synthTask.prompt).toContain('Worker 0 result');
      expect(synthTask.prompt).toContain('### Worker 1');
      expect(synthTask.prompt).toContain('Worker 1 result');
    });
  });

  describe('synthesizer rejection', () => {
    it('returns failed with feedback when synthesizer rejects', async () => {
      let callCount = 0;
      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return {
            result: { type: 'approved', output: 'worker output' },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        // Synthesizer rejects
        return {
          result: { type: 'rejected', feedback: 'Outputs are inconsistent', output: undefined },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [{ name: 'writer', profileId: 'coder', isReadOnly: false }],
        synthesizer: {
          name: 'validator',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
        },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('feedback', 'Outputs are inconsistent');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ feedback: 'Outputs are inconsistent' }));
      expect(ctx.completeTask).not.toHaveBeenCalled();
    });
  });

  describe('worker failures', () => {
    it('handles one worker throwing: other workers complete and synthesizer runs', async () => {
      let callCount = 0;
      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Worker 0 failed');
        }
        return {
          result: { type: 'approved', output: `Worker ${callCount - 1} output` },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'worker-a', profileId: 'coder', isReadOnly: false },
          { name: 'worker-b', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      // Calls: worker-a (throws), worker-b (ok), synthesizer (ok)
      expect(mockRunStep).toHaveBeenCalledTimes(3);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });

    it('fails the task when all workers throw', async () => {
      mockRunStep.mockRejectedValue(new Error('Worker crashed'));

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'worker-a', profileId: 'coder', isReadOnly: false },
          { name: 'worker-b', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'All workers failed');
      expect(ctx.failTask).toHaveBeenCalled();
      const failCallArg = ctx.failTask.mock.calls[0][0] as Record<string, unknown>;
      expect(failCallArg.error).toContain('Worker crashed');
      expect(ctx.completeTask).not.toHaveBeenCalled();
    });

    it('captures rejected (not throwing) worker outputs for synthesizer', async () => {
      let callCount = 0;
      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Worker 0 returns rejected (non-throwing)
          return {
            result: { type: 'rejected', feedback: 'Worker 0 review feedback', output: undefined },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        if (callCount === 2) {
          // Worker 1 returns approved
          return {
            result: { type: 'approved', output: 'Worker 1 output' },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        // Synthesizer
        return {
          result: { type: 'approved', output: 'merged' },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          {
            name: 'reviewer-a',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
          },
          { name: 'writer-b', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      await runner(ctx);

      // Verify synthesizer received the rejected worker's feedback
      const synthCallArgs = mockRunStep.mock.calls[2];
      const synthTask = synthCallArgs[0] as Task;
      expect(synthTask.prompt).toContain('Worker 0 review feedback');
      expect(synthTask.prompt).toContain('Worker 1 output');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('no workers', () => {
    it('returns failed with error when workers array is empty', async () => {
      const ctx = createCtx();
      const runner = councilRunner({
        workers: [],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'No workers defined');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'No workers defined' }));
      expect(ctx.completeTask).not.toHaveBeenCalled();
      expect(mockRunStep).not.toHaveBeenCalled();
    });
  });

  describe('session disposal (leak fix verification)', () => {
    it('disposes each session exactly once on success path', async () => {
      const disposes: ReturnType<typeof mock>[] = [];

      mockRunStep.mockImplementation(async () => {
        const { trackedSession, dispose } = makeTrackedSession();
        disposes.push(dispose);
        return {
          result: { type: 'approved', output: 'output' },
          trackedSession,
        };
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'w1', profileId: 'coder', isReadOnly: false },
          { name: 'w2', profileId: 'coder', isReadOnly: false },
          { name: 'w3', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      await runner(ctx);

      // 3 workers + 1 synthesizer = 4 sessions
      expect(disposes).toHaveLength(4);
      for (const d of disposes) {
        expect(d).toHaveBeenCalledTimes(1);
      }
    });

    it('disposes each session exactly once when synthesizer rejects', async () => {
      const disposes: ReturnType<typeof mock>[] = [];
      let callCount = 0;

      mockRunStep.mockImplementation(async () => {
        callCount++;
        const { trackedSession, dispose } = makeTrackedSession();
        disposes.push(dispose);
        if (callCount <= 2) {
          return {
            result: { type: 'approved', output: 'output' },
            trackedSession,
          };
        }
        // Synthesizer rejects
        return {
          result: { type: 'rejected', feedback: 'Rejected by synth' },
          trackedSession,
        };
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'w1', profileId: 'coder', isReadOnly: false },
          { name: 'w2', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: {
          name: 'synth',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
        },
      });

      await runner(ctx);

      // 2 workers + 1 synthesizer = 3 sessions
      expect(disposes).toHaveLength(3);
      for (const d of disposes) {
        expect(d).toHaveBeenCalledTimes(1);
      }
    });

    it('disposes only successful worker sessions when one worker throws', async () => {
      const disposes: ReturnType<typeof mock>[] = [];
      let callCount = 0;

      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Worker 0 throws — runStep already disposed its own session
          throw new Error('Worker 0 crashed');
        }
        const { trackedSession, dispose } = makeTrackedSession();
        disposes.push(dispose);
        return {
          result: { type: 'approved', output: 'output' },
          trackedSession,
        };
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'w1', profileId: 'coder', isReadOnly: false },
          { name: 'w2', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      await runner(ctx);

      // Worker 1 + synthesizer = 2 disposes (worker 0 didn't create tracked session)
      expect(disposes).toHaveLength(2);
      for (const d of disposes) {
        expect(d).toHaveBeenCalledTimes(1);
      }
    });

    it('disposes nothing when all workers throw (no sessions tracked)', async () => {
      mockRunStep.mockRejectedValue(new Error('Worker crashed'));

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'w1', profileId: 'coder', isReadOnly: false },
          { name: 'w2', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      // No sessions tracked — disposeAllSessions is a no-op
      expect(ctx.failTask).toHaveBeenCalled();
    });

    it('disposes sessions on unexpected error (catch block)', async () => {
      const disposes: ReturnType<typeof mock>[] = [];
      let callCount = 0;

      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Worker succeeds
          const { trackedSession, dispose } = makeTrackedSession();
          disposes.push(dispose);
          return {
            result: { type: 'approved', output: 'output' },
            trackedSession,
          };
        }
        // Synthesizer throws
        throw new Error('Synth runtime failure');
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [{ name: 'w1', profileId: 'coder', isReadOnly: false }],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      if (outcome.status !== 'failed') throw new Error('expected failed');
      expect(outcome.error).toContain('Synth runtime failure');
      // Worker session should have been disposed
      expect(disposes).toHaveLength(1);
      expect(disposes[0]).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrency', () => {
    it('runs workers in parallel (total time < sum of individual times)', async () => {
      const WORKER_DELAY = 80;

      let concurrentCount = 0;
      let maxConcurrent = 0;

      mockRunStep.mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((resolve) => setTimeout(resolve, WORKER_DELAY));
        concurrentCount--;
        return {
          result: { type: 'approved', output: 'output' },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [
          { name: 'slow-a', profileId: 'coder', isReadOnly: false },
          { name: 'slow-b', profileId: 'coder', isReadOnly: false },
          { name: 'slow-c', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      const start = Date.now();
      await runner(ctx);
      const elapsed = Date.now() - start;

      // If workers ran in parallel, max concurrent should be > 1
      expect(maxConcurrent).toBeGreaterThan(1);
      // Sequential would take at least 4 * WORKER_DELAY = 320ms
      // Parallel workers (~WORKER_DELAY) + sequential synth (~WORKER_DELAY) ≈ 2 * WORKER_DELAY ≈ 160ms
      expect(elapsed).toBeLessThan(3 * WORKER_DELAY);
    });
  });

  describe('status callbacks', () => {
    it('fires onStepStart for each worker and the synthesizer', async () => {
      mockRunStep.mockResolvedValue({
        result: { type: 'approved', output: 'output' },
        trackedSession: makeTrackedSession().trackedSession,
      });

      const onStepStart = mock(() => {});
      const ctx = createCtx({ onStatus: { onStepStart } });
      const runner = councilRunner({
        workers: [
          { name: 'alpha', profileId: 'coder', isReadOnly: false },
          { name: 'beta', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'gamma', profileId: 'coder', isReadOnly: false },
      });

      await runner(ctx);

      expect(onStepStart).toHaveBeenCalledTimes(3);
      expect(onStepStart).toHaveBeenNthCalledWith(1, expect.objectContaining({ stepIndex: 0, stepName: 'alpha' }));
      expect(onStepStart).toHaveBeenNthCalledWith(2, expect.objectContaining({ stepIndex: 1, stepName: 'beta' }));
      expect(onStepStart).toHaveBeenNthCalledWith(3, expect.objectContaining({ stepIndex: 2, stepName: 'gamma' }));
    });
  });

  describe('error handling', () => {
    it('does NOT re-throw errors from runStep', async () => {
      mockRunStep.mockRejectedValue(new Error('Internal error'));

      const ctx = createCtx();
      const runner = councilRunner({
        workers: [{ name: 'w1', profileId: 'coder', isReadOnly: false }],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      let threw = false;
      try {
        const outcome = await runner(ctx);
        expect(outcome.status).toBe('failed');
        expect(outcome).toHaveProperty('error', 'All workers failed');
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });

    it('handles completeTask returning false', async () => {
      mockRunStep.mockResolvedValue({
        result: { type: 'approved', output: 'output' },
        trackedSession: makeTrackedSession().trackedSession,
      });

      const ctx = createCtx({
        completeTask: mock(() => false),
      });
      const runner = councilRunner({
        workers: [{ name: 'w1', profileId: 'coder', isReadOnly: false }],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'Failed to submit');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to submit' }));
    });
  });
});
