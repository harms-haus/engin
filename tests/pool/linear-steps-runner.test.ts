import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

import { linearStepsRunner } from '../../packages/engine/src/pool/linear-steps-runner.js';
import {
  clearPoolMocks,
  createRunnerContext,
  makeSession,
  mockCreateHarness,
  mockPromptForStructured,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.ts';

beforeEach(() => {
  clearPoolMocks();
});

describe('linearStepsRunner', () => {
  describe('single-step success', () => {
    it('completes a single non-structured step', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();
      const runner = linearStepsRunner([{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).not.toHaveBeenCalled();
    });
  });

  describe('multi-step success', () => {
    it('executes two steps in sequence', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        { name: 'review', profileId: 'reviewer', isReadOnly: true },
      ]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(mockCreateHarness).toHaveBeenCalledTimes(2);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('step rejection then retry then success', () => {
    it('backs up on rejection and retries, eventually completing', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      // First call to promptForStructured rejects, second approves
      let structuredCall = 0;
      mockPromptForStructured.mockImplementation(() => {
        structuredCall++;
        if (structuredCall === 1) {
          return Promise.resolve({
            result: { approved: false, feedback: 'Needs more tests', severity: 'medium' },
            attempts: 1,
          });
        }
        return Promise.resolve({
          result: { approved: true, feedback: undefined },
          attempts: 1,
        });
      });

      const onStepStart = mock(() => {});
      const ctx = createRunnerContext({
        maxStepRetries: 5,
        onStatus: { onStepStart },
      });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
        },
      ]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      // 4 onStepStart calls: step0, step1(rejected), step0(retry), step1(approved)
      expect(onStepStart).toHaveBeenCalledTimes(4);
      expect(onStepStart).toHaveBeenNthCalledWith(1, expect.objectContaining({ stepIndex: 0, stepName: 'implement' }));
      expect(onStepStart).toHaveBeenNthCalledWith(2, expect.objectContaining({ stepIndex: 1, stepName: 'review' }));
      expect(onStepStart).toHaveBeenNthCalledWith(3, expect.objectContaining({ stepIndex: 0, stepName: 'implement' }));
      expect(onStepStart).toHaveBeenNthCalledWith(4, expect.objectContaining({ stepIndex: 1, stepName: 'review' }));
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('max retries with critical severity', () => {
    it('returns failed with feedback when severity is critical', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Security vulnerability', severity: 'critical' },
        attempts: 1,
      });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({
            approved: z.boolean(),
            feedback: z.string().optional(),
            severity: z.string().optional(),
          }),
        },
      ]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('feedback', 'Security vulnerability');
      expect(ctx.failTask).toHaveBeenCalledWith(
        expect.objectContaining({ feedback: 'Security vulnerability', severity: 'critical' }),
      );
      expect(ctx.completeTask).not.toHaveBeenCalled();
    });
  });

  describe('max retries with medium severity', () => {
    it('returns completed when severity is medium', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Minor style issues', severity: 'medium' },
        attempts: 1,
      });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({
            approved: z.boolean(),
            feedback: z.string().optional(),
            severity: z.string().optional(),
          }),
        },
      ]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).not.toHaveBeenCalled();
    });
  });

  describe('no steps', () => {
    it('returns failed when steps array is empty', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();
      const runner = linearStepsRunner([]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'No steps defined for task');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'No steps defined for task' }));
      expect(ctx.completeTask).not.toHaveBeenCalled();
    });
  });

  describe('unexpected error handling', () => {
    it('catches error from createHarness, returns failed, does NOT re-throw', async () => {
      setupProfileMocks();
      mockCreateHarness.mockRejectedValue(new Error('Harness exploded'));

      const ctx = createRunnerContext();
      const runner = linearStepsRunner([{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

      let threw = false;
      try {
        const outcome = await runner(ctx);
        expect(outcome.status).toBe('failed');
        expect(outcome).toHaveProperty('error', 'Harness exploded');
        expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Harness exploded' }));
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });
  });

  describe('session disposal', () => {
    it('disposes all sessions on successful completion', async () => {
      setupProfileMocks();
      const disposes: ReturnType<typeof mock>[] = [];
      let harnessCall = 0;
      mockCreateHarness.mockImplementation(() => {
        harnessCall++;
        const dispose = mock(() => {});
        disposes.push(dispose);
        return {
          session: makeSession(() => 'done'),
          sessionId: `s-${harnessCall}`,
          dispose,
        };
      });

      const ctx = createRunnerContext();
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        { name: 'review', profileId: 'reviewer', isReadOnly: true },
      ]);

      await runner(ctx);

      expect(disposes).toHaveLength(2);
      for (const d of disposes) {
        expect(d).toHaveBeenCalledTimes(1);
      }
    });

    it('disposes all sessions on failure', async () => {
      setupProfileMocks();
      const disposes: ReturnType<typeof mock>[] = [];
      let harnessCall = 0;
      mockCreateHarness.mockImplementation(() => {
        harnessCall++;
        const dispose = mock(() => {});
        disposes.push(dispose);
        return {
          session: makeSession(() => 'done'),
          sessionId: `s-${harnessCall}`,
          dispose,
        };
      });

      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Fatal error', severity: 'critical' },
        attempts: 1,
      });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({
            approved: z.boolean(),
            feedback: z.string().optional(),
            severity: z.string().optional(),
          }),
        },
      ]);

      await runner(ctx);

      // At least the harnesses that were created should be disposed
      expect(disposes.length).toBeGreaterThan(0);
      for (const d of disposes) {
        expect(d).toHaveBeenCalledTimes(1);
      }
    });
  });
});
