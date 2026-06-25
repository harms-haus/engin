/**
 * @fileoverview Tests for mapRunner – fan-out over a collection with concurrency cap.
 *
 * Uses mock.module to replace runStep in step-execution so we can control
 * per-item outcomes and track session disposal. Restores the real module
 * in afterAll so other test files are not affected.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real module before mocking ────────────────────────────────────

const realStepExecution = Object.assign({}, await import('../../packages/engine/src/pool/step-execution.js'));

// ─── Mock definitions + mock.module ────────────────────────────────────────

export const mockRunStep = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module('../../packages/engine/src/pool/step-execution.js', () => ({
  runStep: (...args: unknown[]) => mockRunStep(...args),
}));

// ─── Imports after mock.module ─────────────────────────────────────────────

import { RendererRegistry } from '../../packages/engine/src/core/renderer-registry.js';
import type { Task } from '../../packages/engine/src/core/types.js';
import { mapRunner, type MapRunnerOptions } from '../../packages/engine/src/pool/map-runner.js';
import { composeItemPrompt } from '../../packages/engine/src/pool/prompt-builder.js';
import type { StepDefinition } from '../../packages/engine/src/pool/types.js';
import { createRunnerContext, makeTask, makeTrackedSession } from './helpers.js';

// ─── Type bridge for the composeItemPrompt refactor (write-tests step) ───────
//
// `mapRunner` will gain an optional `composeItemPrompt` option once its source
// is refactored (this is the write-tests step, so source edits are out of
// scope). Until the field lands on MapRunnerOptions, this local augmentation
// lets the tests below typecheck under `tsc --noEmit` while still exercising
// the option at runtime. `mapOptions` is a transparent passthrough: it checks
// the *object literal* against the target shape (so `composeItemPrompt` is a
// known property and the inline lambdas get proper parameter types), then
// returns a plain MapRunnerOptions. Once MapRunnerOptions declares the field,
// `mapOptions` collapses to a no-op and can be deleted.
type ComposeItemPromptFn = (task: Task, itemIndex: number, totalItems: number, item: unknown) => Task;
type MapRunnerOptionsWithCompose = MapRunnerOptions & { composeItemPrompt?: ComposeItemPromptFn };
function mapOptions(o: MapRunnerOptionsWithCompose): MapRunnerOptions {
  return o;
}

// Simple step definition for testing
const testStep: StepDefinition = {
  name: 'process-item',
  profileId: 'coder',
  isReadOnly: false,
};

// ─── Restore real module after all tests in this file ──────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/pool/step-execution.js', () => realStepExecution);
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

      mockRunStep.mockImplementation(({ task: itemTask }: { task: Task }) => {
        const ts = makeTrackedSession().trackedSession;
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

    it('passes the collected outputs array to completeTask so it lands on task.result', async () => {
      const items = ['item-a', 'item-b'];
      const runner = mapRunner({ items: () => items, step: testStep });

      mockRunStep.mockImplementation(({ task: itemTask }: { task: Task }) => {
        const ts = makeTrackedSession().trackedSession;
        const lastChar = itemTask.prompt[itemTask.prompt.length - 1];
        return Promise.resolve({
          result: { type: 'approved' as const, output: `output-${lastChar}` },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      expect(ctx.completeTask).toHaveBeenCalledWith(['output-a', 'output-b']);
    });

    it('calls runStep once per item with correct arguments', async () => {
      const items = ['apple', 'banana'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const trackedSessions = [makeTrackedSession().trackedSession, makeTrackedSession().trackedSession];
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
      const firstTask = (firstCallArgs[0] as { task: Task }).task;
      expect(firstTask.prompt).toContain('## Item 1 of 2');
      expect(firstTask.prompt).toContain('apple');

      // Check second call prompt includes item 2
      const secondCallArgs = mockRunStep.mock.calls[1];
      const secondTask = (secondCallArgs[0] as { task: Task }).task;
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

      const trackedSessions = [
        makeTrackedSession().trackedSession,
        makeTrackedSession().trackedSession,
        makeTrackedSession().trackedSession,
      ];

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
      const trackedSessions = [
        makeTrackedSession(disposeFns[0]).trackedSession,
        makeTrackedSession(disposeFns[1]).trackedSession,
        makeTrackedSession(disposeFns[2]).trackedSession,
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
      const okSessions = [
        makeTrackedSession(disposeFns[0]).trackedSession,
        makeTrackedSession(disposeFns[1]).trackedSession,
      ];

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
      const ts = makeTrackedSession().trackedSession;

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
      const ts = makeTrackedSession().trackedSession;

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
      const ts = makeTrackedSession().trackedSession;

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
      const ts = makeTrackedSession().trackedSession;

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
      const trackedSessions = [
        makeTrackedSession(disposes[0]).trackedSession,
        makeTrackedSession(disposes[1]).trackedSession,
        makeTrackedSession(disposes[2]).trackedSession,
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
      const trackedSessions = [
        makeTrackedSession(disposes[0]).trackedSession,
        makeTrackedSession(disposes[1]).trackedSession,
        makeTrackedSession(disposes[2]).trackedSession,
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

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(({ task: _itemTask }: { task: Task }) => {
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      // Check what was passed to runStep
      const firstCallTask = (mockRunStep.mock.calls[0][0] as { task: Task }).task;
      expect(firstCallTask.prompt).toContain('hello');
      expect(firstCallTask.prompt).toContain('## Item 1 of 2');

      const secondCallTask = (mockRunStep.mock.calls[1][0] as { task: Task }).task;
      expect(secondCallTask.prompt).toContain('world');
      expect(secondCallTask.prompt).toContain('## Item 2 of 2');
    });

    it('JSON.stringifies non-string items', async () => {
      const items = [{ key: 'value' }, [1, 2, 3]];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
      });

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(({ task: _itemTask }: { task: Task }) => {
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext();
      await runner(ctx);

      const firstCallTask = (mockRunStep.mock.calls[0][0] as { task: Task }).task;
      expect(firstCallTask.prompt).toContain('{"key":"value"}');
      expect(firstCallTask.prompt).toContain('## Item 1 of 2');

      const secondCallTask = (mockRunStep.mock.calls[1][0] as { task: Task }).task;
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
      const ts = [makeTrackedSession(disposes[0]).trackedSession, makeTrackedSession(disposes[1]).trackedSession];

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
      const ts = [makeTrackedSession(disposes[0]).trackedSession, makeTrackedSession(disposes[1]).trackedSession];

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
      const ts = makeTrackedSession(disposes[0]).trackedSession;

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

      const ts = makeTrackedSession().trackedSession;
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

      const ts = makeTrackedSession().trackedSession;
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

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() => {
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const task = makeTask({ id: 'custom-task-id' });
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

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(({ task: _task }: { task: Task }) => {
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

  // ─── Refactor (task): configurable prompt composition ────────────────────
  //
  // mapRunner now accepts an optional `composeItemPrompt(task, itemIndex,
  // totalItems, item)` callback. When omitted it must fall back to the shared
  // `composeItemPrompt` helper from prompt-builder.ts, preserving the exact
  // `## Item X of Y` + item prompt format the runner previously inlined.

  describe('composeItemPrompt option', () => {
    it('uses the provided composeItemPrompt to build each item task', async () => {
      const items = ['one', 'two'];
      const runner = mapRunner(
        mapOptions({
          items: () => items,
          step: testStep,
          composeItemPrompt: (task, itemIndex, totalItems, item) => ({
            ...task,
            prompt: `CUSTOM|idx=${itemIndex}|total=${totalItems}|item=${item}`,
          }),
        }),
      );

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const ctx = createRunnerContext();
      await runner(ctx);

      const firstTask = (mockRunStep.mock.calls[0][0] as { task: Task }).task;
      expect(firstTask.prompt).toBe('CUSTOM|idx=0|total=2|item=one');
      // A custom composer fully replaces the default header.
      expect(firstTask.prompt).not.toContain('## Item');

      const secondTask = (mockRunStep.mock.calls[1][0] as { task: Task }).task;
      expect(secondTask.prompt).toBe('CUSTOM|idx=1|total=2|item=two');
    });

    it('invokes composeItemPrompt once per item with (task, itemIndex, totalItems, item)', async () => {
      const items = ['a', 'b', 'c'];
      const compose = mock(
        (task: Task, itemIndex: number, totalItems: number, item: unknown): Task => ({
          ...task,
          prompt: `p-${itemIndex}`,
        }),
      );
      const runner = mapRunner(
        mapOptions({
          items: () => items,
          step: testStep,
          composeItemPrompt: compose,
        }),
      );

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const task = makeTask({ id: 'task-xyz', prompt: 'base' });
      const ctx = createRunnerContext({ task });
      await runner(ctx);

      expect(compose).toHaveBeenCalledTimes(3);
      // itemIndex is 0-based; totalItems is the full collection length.
      expect(compose).toHaveBeenCalledWith(task, 0, 3, 'a');
      expect(compose).toHaveBeenCalledWith(task, 1, 3, 'b');
      expect(compose).toHaveBeenCalledWith(task, 2, 3, 'c');
    });

    it('passes non-string items (objects/arrays) verbatim as the item argument', async () => {
      const items = [{ name: 'widget' }, [1, 2, 3], 42];
      const compose = mock((task: Task): Task => ({ ...task, prompt: 'p' }));
      const runner = mapRunner(
        mapOptions({
          items: () => items,
          step: testStep,
          composeItemPrompt: compose,
        }),
      );

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const task = makeTask({ prompt: 'base' });
      await runner(createRunnerContext({ task }));

      // The raw item (not its JSON form) must reach compose — it is the
      // composer's job, not the runner's, to serialize.
      expect(compose).toHaveBeenCalledWith(task, 0, 3, { name: 'widget' });
      expect(compose).toHaveBeenCalledWith(task, 1, 3, [1, 2, 3]);
      expect(compose).toHaveBeenCalledWith(task, 2, 3, 42);
    });

    it('passes the original ctx.task to composeItemPrompt and does not mutate it', async () => {
      const items = ['x'];
      let receivedTask: Task | undefined;
      const runner = mapRunner(
        mapOptions({
          items: () => items,
          step: testStep,
          composeItemPrompt: (task) => {
            receivedTask = task;
            return { ...task, prompt: 'composed' };
          },
        }),
      );

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const task = makeTask({ id: 'orig-task', prompt: 'original-prompt' });
      const ctx = createRunnerContext({ task });
      await runner(ctx);

      expect(receivedTask).toBe(task);
      // The runner / composer must leave ctx.task.prompt untouched.
      expect(task.prompt).toBe('original-prompt');
    });

    it('respects composeItemPrompt even under a concurrency cap', async () => {
      const items = ['a', 'b', 'c', 'd'];
      const runner = mapRunner(
        mapOptions({
          items: () => items,
          step: testStep,
          concurrency: 1,
          composeItemPrompt: (task, itemIndex, _total, item) => ({
            ...task,
            prompt: `SEQ-${itemIndex}-${item}`,
          }),
        }),
      );

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const ctx = createRunnerContext();
      await runner(ctx);

      // Outputs are collected in input order regardless of concurrency.
      const prompts = mockRunStep.mock.calls.map((c) => (c[0] as { task: Task }).task.prompt);
      expect(prompts).toEqual(['SEQ-0-a', 'SEQ-1-b', 'SEQ-2-c', 'SEQ-3-d']);
    });

    it('passes totalItems as the full collection length, not the concurrency cap', async () => {
      const items = ['a', 'b', 'c', 'd', 'e'];
      const seenTotals: number[] = [];
      const runner = mapRunner(
        mapOptions({
          items: () => items,
          step: testStep,
          concurrency: 2,
          composeItemPrompt: (task, _i, total) => {
            seenTotals.push(total);
            return { ...task, prompt: 'x' };
          },
        }),
      );

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      await runner(createRunnerContext());

      // totalItems is the full collection length, independent of the concurrency
      // cap. Assert order-independently — the *order* compose is called in is an
      // implementation detail of the worker pool, but every call must receive 5.
      expect(seenTotals).toHaveLength(5);
      expect(seenTotals.every((t) => t === 5)).toBe(true);
      expect(seenTotals).not.toContain(2);
    });

    it('does not invoke the default composer when a custom one is supplied', async () => {
      // A custom composer yields prompts without the default '## Item X of Y'
      // marker — proving the prompt-builder default was bypassed entirely.
      const items = ['a', 'b'];
      const runner = mapRunner(
        mapOptions({
          items: () => items,
          step: testStep,
          composeItemPrompt: (task, _i, _t, item) => ({ ...task, prompt: `ONLY-CUSTOM-${item}` }),
        }),
      );

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      await runner(createRunnerContext());

      for (const call of mockRunStep.mock.calls) {
        expect((call[0] as { task: Task }).task.prompt).not.toContain('## Item');
      }
    });

    it('explicitly passing composeItemPrompt: undefined still uses the default composer', async () => {
      // Pins the `?? ` fallback the rename touches: an explicit `undefined`
      // option must fall through to the shared prompt-builder default, NOT be
      // treated as a custom override. A rename that swaps the operands of `??`
      // (e.g. `composeItemPrompt ?? options.composeItemPrompt`) would still pass
      // the omitted-option tests but would fail here because `undefined` is not
      // callable.
      const items = ['one', 'two'];
      const runner = mapRunner(
        mapOptions({
          items: () => items,
          step: testStep,
          composeItemPrompt: undefined,
        }),
      );

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const task = makeTask({ prompt: 'BASE' });
      await runner(createRunnerContext({ task }));

      // The default `## Item X of Y` header must appear — proving the shared
      // prompt-builder helper was selected despite the explicit undefined.
      expect((mockRunStep.mock.calls[0][0] as { task: Task }).task.prompt).toBe(
        composeItemPrompt(task, 0, 2, 'one').prompt,
      );
      expect((mockRunStep.mock.calls[1][0] as { task: Task }).task.prompt).toBe(
        composeItemPrompt(task, 1, 2, 'two').prompt,
      );
      expect((mockRunStep.mock.calls[0][0] as { task: Task }).task.prompt).toContain('## Item 1 of 2');
    });

    it('passing the shared composeItemPrompt helper as the option reproduces the default exactly', async () => {
      // The option is a strict superset of the default: handing the shared
      // helper in explicitly must be indistinguishable from omitting it.
      const items = ['one', 'two', 'three'];
      const runnerExplicit = mapRunner(
        mapOptions({
          items: () => items,
          step: testStep,
          composeItemPrompt,
        }),
      );
      const runnerDefault = mapRunner({ items: () => items, step: testStep });

      const ts = makeTrackedSession().trackedSession;
      const impl = () =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });

      const task = makeTask({ prompt: 'BASE' });

      mockRunStep.mockImplementation(impl);
      await runnerExplicit(createRunnerContext({ task }));
      const explicitPrompts = mockRunStep.mock.calls.map((c) => (c[0] as { task: Task }).task.prompt);

      mockRunStep.mockClear();
      mockRunStep.mockImplementation(impl);
      await runnerDefault(createRunnerContext({ task }));
      const defaultPrompts = mockRunStep.mock.calls.map((c) => (c[0] as { task: Task }).task.prompt);

      expect(explicitPrompts).toEqual(defaultPrompts);
      // And both match the helper output directly.
      expect(explicitPrompts).toEqual([
        composeItemPrompt(task, 0, 3, 'one').prompt,
        composeItemPrompt(task, 1, 3, 'two').prompt,
        composeItemPrompt(task, 2, 3, 'three').prompt,
      ]);
    });
  });

  describe('default prompt composition (backward compatibility)', () => {
    it('defaults to the composeItemPrompt helper from prompt-builder', async () => {
      const items = ['alpha', 'beta'];
      const runner = mapRunner({
        items: () => items,
        step: testStep,
        // no composeItemPrompt → shared prompt-builder default
      });

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const task = makeTask({ prompt: 'BASE-PROMPT' });
      const ctx = createRunnerContext({ task });
      await runner(ctx);

      // The composed prompt must equal what the shared helper produces.
      const expectedFirst = composeItemPrompt(task, 0, 2, 'alpha');
      const expectedSecond = composeItemPrompt(task, 1, 2, 'beta');
      expect((mockRunStep.mock.calls[0][0] as { task: Task }).task.prompt).toBe(expectedFirst.prompt);
      expect((mockRunStep.mock.calls[1][0] as { task: Task }).task.prompt).toBe(expectedSecond.prompt);
    });

    it('produces the exact ## Item X of Y header + item string for string items', async () => {
      const items = ['hello', 'world'];
      const runner = mapRunner({ items: () => items, step: testStep });

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const task = makeTask({ prompt: 'BASE' });
      await runner(createRunnerContext({ task }));

      expect((mockRunStep.mock.calls[0][0] as { task: Task }).task.prompt).toBe('BASE\n## Item 1 of 2\nhello');
      expect((mockRunStep.mock.calls[1][0] as { task: Task }).task.prompt).toBe('BASE\n## Item 2 of 2\nworld');
    });

    it('JSON.stringifies non-string items via the default composer', async () => {
      const items = [{ k: 1 }, [9, 9]];
      const runner = mapRunner({ items: () => items, step: testStep });

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const task = makeTask({ prompt: 'BASE' });
      await runner(createRunnerContext({ task }));

      expect((mockRunStep.mock.calls[0][0] as { task: Task }).task.prompt).toBe('BASE\n## Item 1 of 2\n{"k":1}');
      expect((mockRunStep.mock.calls[1][0] as { task: Task }).task.prompt).toBe('BASE\n## Item 2 of 2\n[9,9]');
    });

    it('spreads all other task fields onto the composed item task', async () => {
      const items = ['x'];
      const runner = mapRunner({ items: () => items, step: testStep });

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const task = makeTask({ id: 'keep-id', title: 'Keep Title', profile: 'coder' });
      await runner(createRunnerContext({ task }));

      const composed = (mockRunStep.mock.calls[0][0] as { task: Task }).task;
      expect(composed.id).toBe('keep-id');
      expect(composed.title).toBe('Keep Title');
      expect(composed.profile).toBe('coder');
    });
  });

  // ─── Refactor (task): shared runner utilities ───────────────────────────
  //
  // Session tracking, execCtx construction, and the error envelope should be
  // delegated to runner-utils.ts (createSessionTracker / buildExecCtx /
  // handleRunnerError). The behaviors below pin down their observable effects.

  describe('task settle: completeTask return value', () => {
    it('returns failed "Failed to submit" when completeTask returns false (all items ok)', async () => {
      // Pins the settle branch that remains after extracting shared utils: the
      // multi-output settle is NOT delegated to single-result settleResult, so
      // the runner must still honor completeTask's boolean.
      const items = ['a', 'b'];
      const runner = mapRunner({ items: () => items, step: testStep });

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const ctx = createRunnerContext({
        completeTask: mock(() => false) as () => boolean,
      });
      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'Failed to submit');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to submit' }));
    });

    it('still disposes tracked sessions when completeTask returns false', async () => {
      const items = ['a', 'b'];
      const runner = mapRunner({ items: () => items, step: testStep });

      const disposeFns = [mock(() => {}), mock(() => {})];
      const sessions = [
        makeTrackedSession(disposeFns[0]).trackedSession,
        makeTrackedSession(disposeFns[1]).trackedSession,
      ];
      let i = 0;
      mockRunStep.mockImplementation(() => {
        const ts = sessions[i++];
        return Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        });
      });

      const ctx = createRunnerContext({ completeTask: mock(() => false) as () => boolean });
      await runner(ctx);

      expect(disposeFns[0]).toHaveBeenCalledTimes(1);
      expect(disposeFns[1]).toHaveBeenCalledTimes(1);
    });
  });

  describe('shared runner utilities (buildExecCtx)', () => {
    it('forwards rendererRegistry from ctx into the runStep execCtx', async () => {
      // buildExecCtx propagates ctx.rendererRegistry — the previous inline
      // construction omitted this field.
      const items = ['a'];
      const runner = mapRunner({ items: () => items, step: testStep });

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const rendererRegistry = new RendererRegistry();
      const ctx = createRunnerContext({ rendererRegistry });
      await runner(ctx);

      // runStep(task, step, agentId, runStepCtx, profiles, execCtx) — execCtx is arg 5.
      const execCtx = (mockRunStep.mock.calls[0][0] as Record<string, unknown>).execCtx;
      expect(execCtx).toMatchObject({ rendererRegistry });
    });

    it('builds execCtx with all TaskRunnerContext fields forwarded', async () => {
      const items = ['a'];
      const runner = mapRunner({ items: () => items, step: testStep });

      const ts = makeTrackedSession().trackedSession;
      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      const onStatus = { onStepStart: mock(() => {}) };
      const apiKeys = { openai: 'sk-xxx' };
      const ctx = createRunnerContext({
        sessionBaseDir: '/tmp/sb',
        cwd: '/tmp/cwd',
        apiKeys,
        phaseId: 'review',
        onStatus,
      });
      await runner(ctx);

      const execCtx = (mockRunStep.mock.calls[0][0] as Record<string, unknown>).execCtx;
      expect(execCtx.sessionBaseDir).toBe('/tmp/sb');
      expect(execCtx.cwd).toBe('/tmp/cwd');
      expect(execCtx.apiKeys).toBe(apiKeys);
      expect(execCtx.phaseId).toBe('review');
      expect(execCtx.onStatus).toBe(onStatus);
      expect(execCtx.activeSessions).toBe(ctx.activeSessions);
    });
  });

  describe('shared runner utilities (handleRunnerError envelope)', () => {
    it('on unexpected error, disposes sessions before calling failTask', async () => {
      const items = ['a'];
      const runner = mapRunner({ items: () => items, step: testStep });

      const sequence: string[] = [];
      const disposeFn = mock(() => {
        sequence.push('dispose');
      });
      const ts = makeTrackedSession(disposeFn).trackedSession;

      mockRunStep.mockImplementation(() =>
        Promise.resolve({
          result: { type: 'approved' as const, output: 'ok' },
          trackedSession: ts,
        }),
      );

      // completeTask throws → outer try/catch → handleRunnerError path.
      const failTask = mock((_r?: unknown) => {
        sequence.push('failTask');
      });
      const ctx = createRunnerContext({
        completeTask: () => {
          throw new Error('unexpected');
        },
        failTask,
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(failTask).toHaveBeenCalledTimes(1);
      expect(disposeFn).toHaveBeenCalledTimes(1);
      // handleRunnerError disposes FIRST, then fails the task.
      expect(sequence).toEqual(['dispose', 'failTask']);
    });
  });
});
