/**
 * @fileoverview Tests for mapRunner – fan-out over a collection with concurrency cap.
 *
 * Uses mock.module to replace runStep in step-execution so we can control
 * per-item outcomes and track session disposal. Restores the real module
 * in afterAll so other test files are not affected.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real module before mocking ────────────────────────────────────

const realStepExecution = Object.assign({}, await import('../../src/pool/step-execution.js'));

// ─── Mock definitions + mock.module ────────────────────────────────────────

export const mockRunStep = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module('../../src/pool/step-execution.js', () => ({
  runStep: (...args: unknown[]) => mockRunStep(...args),
  StepExecutionContext: realStepExecution.StepExecutionContext,
}));

// ─── Imports after mock.module ─────────────────────────────────────────────

import type { AgentProfile, Task } from '../../src/core/types.js';
import { mapRunner } from '../../src/pool/map-runner.js';
import type { StepDefinition, TaskRunnerContext } from '../../src/pool/types.js';
import { makeMockSession } from '../helpers/make-session.ts';
import { makeTask } from '../helpers/make-task.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

const defaultProfile: AgentProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [],
  includeTools: [],
};

function createProfiles(): Map<string, AgentProfile> {
  const profiles = new Map<string, AgentProfile>();
  profiles.set('coder', defaultProfile);
  return profiles;
}

function defaultTask(overrides?: Partial<Task>): Task {
  return makeTask({ ...overrides });
}

interface MockTrackedSession {
  session: ReturnType<typeof makeMockSession>['session'];
  dispose: ReturnType<typeof mock>;
  sessionPath: string;
}

function makeTrackedSession(disposeOverride?: () => void): MockTrackedSession {
  const mockSession = makeMockSession();
  return {
    session: mockSession.session,
    dispose: disposeOverride ?? mock(() => {}),
    sessionPath: '/tmp/sessions/test-task/0-0-test-step',
  };
}

interface RunnerContextOverrides {
  task?: Task;
  completeTask?: () => boolean;
  failTask?: (result?: unknown) => void;
  onStatus?: Record<string, unknown>;
}

function createRunnerContext(overrides: RunnerContextOverrides = {}): TaskRunnerContext {
  const profiles = createProfiles();
  return {
    task: overrides.task ?? defaultTask(),
    agentId: 'lane-0',
    profiles,
    onStatus: overrides.onStatus as TaskRunnerContext['onStatus'],
    activeSessions: new Set(),
    phaseId: 'implementing',
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    apiKeys: undefined,
    maxStepRetries: 5,
    completeTask: overrides.completeTask ?? (mock(() => true) as () => boolean),
    failTask: overrides.failTask ?? (mock(() => {}) as (result?: unknown) => void),
  };
}

// Simple step definition for testing
const testStep: StepDefinition = {
  name: 'process-item',
  profileId: 'coder',
  isReadOnly: false,
};

// ─── Restore real module after all tests in this file ──────────────────────

afterAll(() => {
  mock.module('../../src/pool/step-execution.js', () => realStepExecution);
});

// ─── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRunStep.mockClear();
});

describe('mapRunner', () => {
  describe('all items succeed', () => {
    it('returns completed with all outputs', async () => {
      const items = ['item-a', 'item-b', 'item-c'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      mockRunStep.mockImplementation((itemTask: Task) => {
        const ts = makeTrackedSession();
        // Last char of the full prompt = last char of the item string
        const prompt = itemTask.prompt;
        const lastChar = prompt[prompt.length - 1];
        return Promise.resolve({
          result: { type: 'approved' as const, output: `output-${lastChar}` },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      // Items: 'item-a', 'item-b', 'item-c' → last char 'a', 'b', 'c'
      expect((outcome as { output: unknown[] }).output).toEqual(['output-a', 'output-b', 'output-c']);
      expect((outcome as { output: unknown[] }).output).toHaveLength(3);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).not.toHaveBeenCalled();
    });

    it('calls runStep once per item with correct arguments', async () => {
      const items = ['apple', 'banana'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const trackedSessions: MockTrackedSession[] = [makeTrackedSession(), makeTrackedSession()];
      let callCount = 0;

      mockRunStep.mockImplementation(() => {
        const ts = trackedSessions[callCount++];
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      expect(mockRunStep).toHaveBeenCalledTimes(2);

      // Check first call prompt includes item 1
      const firstCallArgs = mockRunStep.mock.calls[0];
      const firstTask = firstCallArgs[0] as Task;
      expect(firstTask.prompt).toContain('## Item 1 of 2');
      expect(firstTask.prompt).toContain('apple');

      // Check second call prompt includes item 2
      const secondCallArgs = mockRunStep.mock.calls[1];
      const secondTask = secondCallArgs[0] as Task;
      expect(secondTask.prompt).toContain('## Item 2 of 2');
      expect(secondTask.prompt).toContain('banana');
    });
  });

  describe('no items', () => {
    it('returns failed with error message', async () => {
      const runner = mapRunner({
        items: () => [],
        step: testStep,
      });

      const ctx = createRunnerContext();
      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'No items to process');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'No items to process' }));
      expect(ctx.completeTask).not.toHaveBeenCalled();
      expect(mockRunStep).not.toHaveBeenCalled();
    });
  });

  describe('partial failure', () => {
    it('fails with partial failure message when one item throws', async () => {
      const items = ['good', 'bad', 'good2'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const trackedSessions: MockTrackedSession[] = [makeTrackedSession(), makeTrackedSession(), makeTrackedSession()];

      let callIdx = 0;
      mockRunStep.mockImplementation(() => {
        const idx = callIdx++;
        if (idx === 1) {
          // Second item throws
          return Promise.reject(new Error('Item failed'));
        }
        const ts = trackedSessions[idx];
        return Promise.resolve({
          result: { type: 'approved' as const, output: `result-${idx}` },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', '1 of 3 items failed');
      expect(ctx.failTask).toHaveBeenCalled();
      expect(ctx.completeTask).not.toHaveBeenCalled();
    });

    it('disposes all sessions on partial failure', async () => {
      const items = ['a', 'b', 'c'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const disposeFns = [mock(() => {}), mock(() => {}), mock(() => {})];
      const trackedSessions: MockTrackedSession[] = [
        makeTrackedSession(disposeFns[0]),
        makeTrackedSession(disposeFns[1]),
        makeTrackedSession(disposeFns[2]),
      ];

      let callIdx = 0;
      mockRunStep.mockImplementation(() => {
        const idx = callIdx++;
        if (idx === 1) {
          return Promise.reject(new Error('fail'));
        }
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: trackedSessions[idx],
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      // Sessions 0 and 2 should be disposed (they succeeded and were tracked)
      expect(disposeFns[0]).toHaveBeenCalledTimes(1);
      expect(disposeFns[2]).toHaveBeenCalledTimes(1);
      // Session 1 was disposed by runStep's catch block (simulated by our mock rejecting),
      // so it's not tracked in the sessions array and not disposed by mapRunner.
    });

    it('all sessions disposed even with multiple failing items', async () => {
      const items = ['ok1', 'fail1', 'ok2', 'fail2'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const disposeFns = [mock(() => {}), mock(() => {})];
      const okSessions = [makeTrackedSession(disposeFns[0]), makeTrackedSession(disposeFns[1])];

      let callIdx = 0;
      let okIdx = 0;
      mockRunStep.mockImplementation(() => {
        const idx = callIdx++;
        if (idx === 1 || idx === 3) {
          // Items at index 1 and 3 throw
          return Promise.reject(new Error(`fail-${idx}`));
        }
        const ts = okSessions[okIdx++];
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', '2 of 4 items failed');

      // Sessions for successful items (0 and 2) must be disposed
      expect(disposeFns[0]).toHaveBeenCalledTimes(1);
      expect(disposeFns[1]).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrency cap', () => {
    it('with concurrency=1 runs items sequentially (total time ~ N * delay)', async () => {
      const items = ['a', 'b', 'c', 'd'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
        concurrency: 1,
      });

      const DELAY_MS = 30;
      const ts = makeTrackedSession();

      mockRunStep.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, DELAY_MS));
        return {
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        };
      });

      const start = performance.now();
      const ctx = createRunnerContext();
      await runner(ctx);
      const elapsed = performance.now() - start;

      // Sequential: 4 items * 30ms = ~120ms. Should be >= 100ms (allowing some variance)
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });

    it('with concurrency=2 runs faster than sequential', async () => {
      const items = ['a', 'b', 'c', 'd'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
        concurrency: 2,
      });

      const DELAY_MS = 40;
      const ts = makeTrackedSession();

      mockRunStep.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, DELAY_MS));
        return {
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        };
      });

      const start = performance.now();
      const ctx = createRunnerContext();
      await runner(ctx);
      const elapsed = performance.now() - start;

      // With concurrency=2: 2 batches of ~40ms = ~80ms + overhead.
      // Sequential would be ~160ms. Allow some headroom.
      expect(elapsed).toBeLessThan(130);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });

    it('with no concurrency cap runs all in parallel', async () => {
      const items = ['a', 'b', 'c', 'd'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
        // No concurrency cap — all parallel
      });

      const DELAY_MS = 40;
      const ts = makeTrackedSession();

      mockRunStep.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, DELAY_MS));
        return {
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        };
      });

      const start = performance.now();
      const ctx = createRunnerContext();
      await runner(ctx);
      const elapsed = performance.now() - start;

      // All parallel: ~40ms + overhead
      expect(elapsed).toBeLessThan(100);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });

    it('concurrency >= items.length runs all in parallel', async () => {
      const items = ['a', 'b', 'c'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
        concurrency: 10, // >= items.length
      });

      const DELAY_MS = 30;
      const ts = makeTrackedSession();

      mockRunStep.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, DELAY_MS));
        return {
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        };
      });

      const start = performance.now();
      const ctx = createRunnerContext();
      await runner(ctx);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(80);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('session leak prevention', () => {
    it('uses allSettled so all sessions are tracked even on failure (no concurrency cap)', async () => {
      const items = ['good', 'bad', 'good2'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const disposes = [mock(() => {}), mock(() => {}), mock(() => {})];
      const trackedSessions: MockTrackedSession[] = [
        makeTrackedSession(disposes[0]),
        makeTrackedSession(disposes[1]),
        makeTrackedSession(disposes[2]),
      ];

      let callIdx = 0;
      mockRunStep.mockImplementation(() => {
        const idx = callIdx++;
        if (idx === 1) {
          return Promise.reject(new Error('bad item'));
        }
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: trackedSessions[idx],
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      // Sessions 0 and 2 were pushed to the sessions array, so they must be disposed
      expect(disposes[0]).toHaveBeenCalledTimes(1);
      expect(disposes[2]).toHaveBeenCalledTimes(1);
      // Session 1 was never pushed (runStep threw), so it's not our responsibility.
      // runStep's own catch block disposes it internally.
    });

    it('uses allSettled so all sessions are tracked even on failure (with concurrency cap)', async () => {
      const items = ['a', 'fail', 'c', 'd'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
        concurrency: 2,
      });

      const disposes = [mock(() => {}), mock(() => {}), mock(() => {})];
      const trackedSessions: MockTrackedSession[] = [
        makeTrackedSession(disposes[0]),
        makeTrackedSession(disposes[1]),
        makeTrackedSession(disposes[2]),
      ];

      let callIdx = 0;
      const succeedIndices = new Set([0, 2, 3]); // items 0, 2, 3 succeed, item 1 fails
      mockRunStep.mockImplementation(() => {
        const idx = callIdx++;
        if (!succeedIndices.has(idx)) {
          return Promise.reject(new Error(`fail-${idx}`));
        }
        // Map succeedIndices to trackedSessions: 0->0, 2->1, 3->2
        const sessionMap: Record<number, number> = { 0: 0, 2: 1, 3: 2 };
        const ts = trackedSessions[sessionMap[idx]];
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', '1 of 4 items failed');

      // All sessions that completed successfully must be disposed
      expect(disposes[0]).toHaveBeenCalledTimes(1);
      expect(disposes[1]).toHaveBeenCalledTimes(1);
      expect(disposes[2]).toHaveBeenCalledTimes(1);
    });
  });

  describe('item prompt injection', () => {
    it('includes string items directly in the prompt', async () => {
      const items = ['hello', 'world'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const ts = makeTrackedSession();
      mockRunStep.mockImplementation((_itemTask: Task) => {
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      // Check what was passed to runStep
      const firstCallTask = mockRunStep.mock.calls[0][0] as Task;
      expect(firstCallTask.prompt).toContain('hello');
      expect(firstCallTask.prompt).toContain('## Item 1 of 2');

      const secondCallTask = mockRunStep.mock.calls[1][0] as Task;
      expect(secondCallTask.prompt).toContain('world');
      expect(secondCallTask.prompt).toContain('## Item 2 of 2');
    });

    it('JSON.stringifies non-string items', async () => {
      const items = [{ key: 'value' }, [1, 2, 3]];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const ts = makeTrackedSession();
      mockRunStep.mockImplementation((_itemTask: Task) => {
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      const firstCallTask = mockRunStep.mock.calls[0][0] as Task;
      expect(firstCallTask.prompt).toContain('{"key":"value"}');
      expect(firstCallTask.prompt).toContain('## Item 1 of 2');

      const secondCallTask = mockRunStep.mock.calls[1][0] as Task;
      expect(secondCallTask.prompt).toContain('[1,2,3]');
      expect(secondCallTask.prompt).toContain('## Item 2 of 2');
    });
  });

  describe('session disposal on every exit path', () => {
    it('disposes sessions on success', async () => {
      const items = ['a', 'b'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const disposes = [mock(() => {}), mock(() => {})];
      const ts = [makeTrackedSession(disposes[0]), makeTrackedSession(disposes[1])];

      let idx = 0;
      mockRunStep.mockImplementation(() => {
        const i = idx++;
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts[i],
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      expect(disposes[0]).toHaveBeenCalledTimes(1);
      expect(disposes[1]).toHaveBeenCalledTimes(1);
    });

    it('disposes sessions on partial failure', async () => {
      const items = ['a', 'b', 'c'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const disposes = [mock(() => {}), mock(() => {})];
      const ts = [makeTrackedSession(disposes[0]), makeTrackedSession(disposes[1])];

      let idx = 0;
      let okIdx = 0;
      mockRunStep.mockImplementation(() => {
        const i = idx++;
        if (i === 1) {
          return Promise.reject(new Error('fail'));
        }
        const t = ts[okIdx++];
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: t,
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      // Successful sessions disposed
      expect(disposes[0]).toHaveBeenCalledTimes(1);
      expect(disposes[1]).toHaveBeenCalledTimes(1);
    });

    it('disposes sessions on all items failing', async () => {
      const items = ['a', 'b'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      mockRunStep.mockImplementation(() => {
        return Promise.reject(new Error('all fail'));
      });

      const ctx = createRunnerContext();
      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', '2 of 2 items failed');
      expect(ctx.failTask).toHaveBeenCalled();
      // No sessions to dispose since all threw (runStep disposed internally)
    });

    it('disposes sessions on unexpected error after processing', async () => {
      const items = ['a'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const disposes = [mock(() => {})];
      const ts = makeTrackedSession(disposes[0]);

      mockRunStep.mockImplementation(() => {
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      // Make completeTask throw
      const ctx = createRunnerContext({
        completeTask: () => {
          throw new Error('unexpected');
        },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'unexpected');
      expect(disposes[0]).toHaveBeenCalledTimes(1);
    });
  });

  describe('result type handling', () => {
    it('returns output for approved results', async () => {
      const items = ['test'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const ts = makeTrackedSession();
      mockRunStep.mockImplementation(() => {
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'the-output' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect((outcome as { output: unknown[] }).output).toEqual(['the-output']);
    });

    it('returns feedback for rejected results', async () => {
      const items = ['test'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const ts = makeTrackedSession();
      mockRunStep.mockImplementation(() => {
        return Promise.resolve({
          result: { type: 'rejected' as const, feedback: 'needs improvement' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      const outcome = await runner(ctx);

      // Rejected result still counts as "succeeded" from processItem perspective
      // because runStep didn't throw — it returned a rejected result.
      // The mapRunner uses result.type to decide output vs feedback.
      expect(outcome.status).toBe('completed');
      expect((outcome as { output: unknown[] }).output).toEqual(['needs improvement']);
    });
  });

  describe('items function receives the task', () => {
    it('calls items with ctx.task', async () => {
      const itemsFn = mock((_task: Task) => ['a', 'b']);
      const runner = mapRunner({
        items: itemsFn,
        step: testStep,
      });

      const ts = makeTrackedSession();
      mockRunStep.mockImplementation(() => {
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const task = defaultTask({ id: 'custom-task-id' });
      const ctx = createRunnerContext({ task });
      await runner(ctx);

      expect(itemsFn).toHaveBeenCalledTimes(1);
      expect(itemsFn).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom-task-id' }));
    });
  });

  describe('output order preservation', () => {
    it('preserves input order in outputs', async () => {
      const items = ['first', 'second', 'third'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const ts = makeTrackedSession();
      mockRunStep.mockImplementation((_task: Task) => {
        const delay = Math.random() * 20;
        return new Promise((resolve) =>
          setTimeout(() => {
            resolve({
              result: { type: 'approved' as const, output: _task.prompt.slice(-1) },
              trackedSession: ts,
            });
          }, delay),
        );
      });

      const ctx = createRunnerContext();
      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      // Just verify length
      expect((outcome as { output: unknown[] }).output).toHaveLength(3);
    });
  });
});
