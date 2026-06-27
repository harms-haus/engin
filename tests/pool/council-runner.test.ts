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
import type { StepDefinition, TaskRunnerContext } from '../../packages/engine/src/pool/types.js';
import { clearPoolMocks, createRunnerContext, makeTrackedSession } from './helpers.js';

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

      const ctx = createRunnerContext();
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

      const ctx = createRunnerContext();
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
      mockRunStep.mockImplementation(async (_params: { task: Task; step: StepDefinition }) => {
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

      const ctx = createRunnerContext();
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
      const synthTask = (synthCallArgs[0] as { task: Task }).task;
      expect(synthTask.prompt).toContain('## Worker Outputs');
      expect(synthTask.prompt).toContain('### Worker 0');
      expect(synthTask.prompt).toContain('Worker 0 result');
      expect(synthTask.prompt).toContain('### Worker 1');
      expect(synthTask.prompt).toContain('Worker 1 result');
    });
  });

  // ─── composeSynthesizerPrompt option (task: receive pre-composed prompts) ──
  //
  // councilRunner now accepts an optional `composeSynthesizerPrompt`
  // callback. When provided it is used to build the synthesizer task; when
  // omitted the default `composeWorkerOutputsPrompt` helper from
  // prompt-builder.ts is used (preserving the exact legacy prompt format).
  describe('composeSynthesizerPrompt option', () => {
    it('default composer produces the exact legacy prompt format when omitted', async () => {
      let callCount = 0;
      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            result: { type: 'approved', output: callCount === 1 ? 'out-0' : 'out-1' },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        return {
          result: { type: 'approved', output: 'merged' },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createRunnerContext();
      const originalPrompt = ctx.task.prompt;
      const runner = councilRunner({
        workers: [
          { name: 'w0', profileId: 'coder', isReadOnly: false },
          { name: 'w1', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
        // composeSynthesizerPrompt intentionally omitted → default composer
      });

      await runner(ctx);

      const synthTask = (mockRunStep.mock.calls[2][0] as { task: Task }).task;
      // Exact format previously inlined in council-runner.ts, now provided by
      // the default composeWorkerOutputsPrompt helper. The original prompt is
      // preserved (appended to, not replaced).
      expect(synthTask.prompt).toBe(
        originalPrompt + '\n\n## Worker Outputs\n' + '### Worker 0\nout-0\n\n### Worker 1\nout-1',
      );
      expect(synthTask.prompt.startsWith(originalPrompt)).toBe(true);
    });

    it('calls the provided composeSynthesizerPrompt with (ctx.task, workerOutputs)', async () => {
      let callCount = 0;
      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            result: { type: 'approved', output: callCount === 1 ? 'alpha' : 'beta' },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        return {
          result: { type: 'approved', output: 'merged' },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createRunnerContext();

      const composeSpy = mock((_task: Task, _outputs: unknown[]): Task => _task);

      const runner = councilRunner({
        workers: [
          { name: 'w0', profileId: 'coder', isReadOnly: false },
          { name: 'w1', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
        composeSynthesizerPrompt: composeSpy,
      });

      await runner(ctx);

      // Called exactly once, with the runner context's original task and the
      // collected worker outputs (in worker order).
      expect(composeSpy).toHaveBeenCalledTimes(1);
      expect(composeSpy).toHaveBeenCalledWith(ctx.task, ['alpha', 'beta']);
    });

    it('passes the task returned by composeSynthesizerPrompt verbatim to the synthesizer runStep', async () => {
      let callCount = 0;
      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return {
            result: { type: 'approved', output: 'worker-output' },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        return {
          result: { type: 'approved', output: 'merged' },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createRunnerContext();

      const customTask: Task = {
        ...ctx.task,
        title: 'custom-synth-title',
        prompt: 'COMPLETELY DIFFERENT PROMPT',
      };

      const runner = councilRunner({
        workers: [{ name: 'w0', profileId: 'coder', isReadOnly: false }],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
        composeSynthesizerPrompt: () => customTask,
      });

      await runner(ctx);

      // The synthesizer call (2nd runStep) must receive the composer's return
      // value by reference (no cloning / re-wrapping by the runner).
      const synthTask = (mockRunStep.mock.calls[1][0] as { task: Task }).task;
      expect(synthTask).toBe(customTask);
      expect(synthTask.prompt).toBe('COMPLETELY DIFFERENT PROMPT');
      expect(synthTask.title).toBe('custom-synth-title');
    });

    it('maps worker results to outputs: approved→output, rejected→feedback (in order)', async () => {
      let callCount = 0;
      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Worker 0 rejected (non-throwing) → feedback is used as its output
          return {
            result: { type: 'rejected', feedback: 'revise-me', output: undefined },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        if (callCount === 2) {
          // Worker 1 approved → output is used
          return {
            result: { type: 'approved', output: 'good-output' },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        return {
          result: { type: 'approved', output: 'merged' },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createRunnerContext();
      const captured: unknown[] = [];
      const runner = councilRunner({
        workers: [
          { name: 'w0', profileId: 'coder', isReadOnly: false },
          { name: 'w1', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
        composeSynthesizerPrompt: (task: Task, outputs: unknown[]) => {
          captured.push(...outputs);
          return task;
        },
      });

      await runner(ctx);

      // Order preserved: index 0 is the rejected worker's feedback, index 1 is
      // the approved worker's output.
      expect(captured).toEqual(['revise-me', 'good-output']);
    });

    it('does NOT call composeSynthesizerPrompt when all workers fail', async () => {
      mockRunStep.mockRejectedValue(new Error('Worker crashed'));

      const ctx = createRunnerContext();
      const composeSpy = mock((task: Task, _outputs: unknown[]): Task => task);

      const runner = councilRunner({
        workers: [
          { name: 'w0', profileId: 'coder', isReadOnly: false },
          { name: 'w1', profileId: 'coder', isReadOnly: false },
        ],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
        composeSynthesizerPrompt: composeSpy,
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      // The synthesizer (and therefore the composer) is skipped entirely when
      // every worker throws.
      expect(composeSpy).not.toHaveBeenCalled();
    });

    it('does not mutate the original ctx.task (default composer spreads into a new Task)', async () => {
      let callCount = 0;
      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return {
            result: { type: 'approved', output: 'worker-out' },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        return {
          result: { type: 'approved', output: 'merged' },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createRunnerContext();
      const originalPrompt = ctx.task.prompt;

      const runner = councilRunner({
        workers: [{ name: 'w0', profileId: 'coder', isReadOnly: false }],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
        // default composer
      });

      await runner(ctx);

      // ctx.task.prompt must be untouched — the composer returns a brand-new
      // Task object instead of mutating the original.
      expect(ctx.task.prompt).toBe(originalPrompt);
    });

    it('JSON-stringifies non-string worker outputs in the default composer', async () => {
      let callCount = 0;
      const objOutput = { score: 42, notes: 'looks good' };
      mockRunStep.mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return {
            result: { type: 'approved', output: objOutput },
            trackedSession: makeTrackedSession().trackedSession,
          };
        }
        return {
          result: { type: 'approved', output: 'merged' },
          trackedSession: makeTrackedSession().trackedSession,
        };
      });

      const ctx = createRunnerContext();
      const runner = councilRunner({
        workers: [{ name: 'w0', profileId: 'coder', isReadOnly: false }],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      await runner(ctx);

      const synthTask = (mockRunStep.mock.calls[1][0] as { task: Task }).task;
      // Non-string outputs are JSON.stringify-ed by the default composer
      // (matching the legacy inline behavior).
      expect(synthTask.prompt).toContain(JSON.stringify(objOutput));
    });
  });

  // ─── Shared runner-utils integration ───────────────────────────────────────
  //
  // The refactored runner builds its StepExecutionContext via buildExecCtx(ctx)
  // (runner-utils.ts). Unlike the old inline object, buildExecCtx forwards the
  // optional `rendererRegistry` field from the context.
  describe('shared runner utilities integration', () => {
    it('forwards ctx fields (incl. rendererRegistry) to runStep via buildExecCtx', async () => {
      mockRunStep.mockResolvedValue({
        result: { type: 'approved', output: 'out' },
        trackedSession: makeTrackedSession().trackedSession,
      });

      const rendererRegistry = { __marker: 'custom-renderer' } as unknown as TaskRunnerContext['rendererRegistry'];
      const ctx = createRunnerContext({ rendererRegistry });

      const runner = councilRunner({
        workers: [{ name: 'w0', profileId: 'coder', isReadOnly: false }],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      await runner(ctx);

      // execCtx is the 6th positional argument (index 5) to runStep.
      const execCtx = (mockRunStep.mock.calls[0][0] as Record<string, unknown>).execCtx as {
        rendererRegistry?: unknown;
        sessionBaseDir?: string;
        cwd?: string;
        phaseId?: string;
      };
      expect(execCtx.rendererRegistry).toBe(rendererRegistry);
      expect(execCtx.sessionBaseDir).toBe(ctx.sessionBaseDir);
      expect(execCtx.cwd).toBe(ctx.cwd);
      expect(execCtx.phaseId).toBe(ctx.phaseId);
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

      const ctx = createRunnerContext();
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

      const ctx = createRunnerContext();
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

      const ctx = createRunnerContext();
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
      const failCallArg = (ctx.failTask as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
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

      const ctx = createRunnerContext();
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
      const synthTask = (synthCallArgs[0] as { task: Task }).task;
      expect(synthTask.prompt).toContain('Worker 0 review feedback');
      expect(synthTask.prompt).toContain('Worker 1 output');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('no workers', () => {
    it('returns failed with error when workers array is empty', async () => {
      const ctx = createRunnerContext();
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

      const ctx = createRunnerContext();
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

      const ctx = createRunnerContext();
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

      const ctx = createRunnerContext();
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

      const ctx = createRunnerContext();
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

      const ctx = createRunnerContext();
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

      const ctx = createRunnerContext();
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
    // onStepStart removed in C2 — step lifecycle no longer fires onStepStart.
    // Council runner still runs workers and synthesizer correctly (tested above in success path).
  });

  describe('error handling', () => {
    it('does NOT re-throw errors from runStep', async () => {
      mockRunStep.mockRejectedValue(new Error('Internal error'));

      const ctx = createRunnerContext();
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

    it('settles as failed when completeTask returns false (delegated to settleResult)', async () => {
      // settleResult() branches on the boolean returned by completeTask:
      // when false (task cancelled/raced), it calls failTask and returns
      // { status: 'failed' }.
      mockRunStep.mockResolvedValue({
        result: { type: 'approved', output: 'merged-output' },
        trackedSession: makeTrackedSession().trackedSession,
      });

      const ctx = createRunnerContext({
        completeTask: mock(() => false),
      });
      const runner = councilRunner({
        workers: [{ name: 'w1', profileId: 'coder', isReadOnly: false }],
        synthesizer: { name: 'synth', profileId: 'coder', isReadOnly: false },
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'Failed to submit');
      // completeTask is invoked once with the synthesizer output; when it
      // returns false, settleResult calls failTask with the error.
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.completeTask).toHaveBeenCalledWith('merged-output');
      expect(ctx.failTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).toHaveBeenCalledWith({ completed: false, error: 'Failed to submit' });
    });
  });
});
