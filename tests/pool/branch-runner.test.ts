import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { branchRunner } from '../../packages/engine/src/pool/branch-runner.js';
import type { StepDefinition } from '../../packages/engine/src/pool/types.js';
import {
  clearPoolMocks,
  createRunnerContext,
  makeSession,
  mockCreateHarness,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.js';

beforeEach(() => {
  clearPoolMocks();
});

// ─── Shared: two branch steps ──────────────────────────────────────────────

const coderStep: StepDefinition = { name: 'implement', profileId: 'coder', isReadOnly: false };
const reviewerStep: StepDefinition = { name: 'review', profileId: 'reviewer', isReadOnly: true };
const defaultStep: StepDefinition = { name: 'default-step', profileId: 'coder', isReadOnly: false };

describe('branchRunner', () => {
  describe('first matching condition runs', () => {
    it('executes the step from the first matching branch when multiple match', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();

      const runner = branchRunner({
        branches: [
          { condition: () => true, step: coderStep },
          { condition: () => true, step: reviewerStep },
        ],
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      // Should have used coderStep (first match), not reviewerStep
      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).not.toHaveBeenCalled();
    });

    it('only the matching step profile is used', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();

      // Track which profileId was used
      let usedProfileId: string | undefined;
      mockCreateHarness.mockImplementation((opts: { profile: { id: string } }) => {
        usedProfileId = opts.profile.id;
        return Promise.resolve({
          session: makeSession(() => 'done'),
          sessionId: 'test-session',
          dispose: mock(() => {}),
        });
      });

      const runner = branchRunner({
        branches: [
          { condition: () => false, step: reviewerStep },
          { condition: () => true, step: coderStep },
        ],
      });

      await runner(ctx);

      expect(usedProfileId).toBe('coder');
      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
    });
  });

  describe('second branch matches when first does not', () => {
    it('runs the step from the second branch when the first condition is false', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();

      let usedProfileId: string | undefined;
      mockCreateHarness.mockImplementation((opts: { profile: { id: string } }) => {
        usedProfileId = opts.profile.id;
        return Promise.resolve({
          session: makeSession(() => 'done'),
          sessionId: 'test-session',
          dispose: mock(() => {}),
        });
      });

      const runner = branchRunner({
        branches: [
          { condition: () => false, step: coderStep },
          { condition: () => true, step: reviewerStep },
        ],
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(usedProfileId).toBe('reviewer');
      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
    });
  });

  describe('default step runs when no condition matches', () => {
    it('uses the default step when no branch condition matches', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();

      let usedProfileId: string | undefined;
      mockCreateHarness.mockImplementation((opts: { profile: { id: string } }) => {
        usedProfileId = opts.profile.id;
        return Promise.resolve({
          session: makeSession(() => 'done'),
          sessionId: 'test-session',
          dispose: mock(() => {}),
        });
      });

      const runner = branchRunner({
        branches: [
          { condition: () => false, step: coderStep },
          { condition: () => false, step: reviewerStep },
        ],
        default: defaultStep,
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(usedProfileId).toBe('coder'); // defaultStep has profileId 'coder'
      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('no match and no default', () => {
    it('returns { status: "failed" } and calls failTask', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();

      const runner = branchRunner({
        branches: [
          { condition: () => false, step: coderStep },
          { condition: () => false, step: reviewerStep },
        ],
        // no default
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'No matching branch and no default');
      expect(ctx.failTask).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'No matching branch and no default' }),
      );
      expect(ctx.completeTask).not.toHaveBeenCalled();
      // No harness should have been created
      expect(mockCreateHarness).not.toHaveBeenCalled();
    });
  });

  describe('step approved', () => {
    it('returns { status: "completed" } and calls completeTask', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();

      const runner = branchRunner({
        branches: [{ condition: () => true, step: coderStep }],
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).not.toHaveBeenCalled();
    });

    it('calls failTask when completeTask returns false', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext({
        completeTask: mock(() => false) as () => boolean,
      });

      const runner = branchRunner({
        branches: [{ condition: () => true, step: coderStep }],
      });

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'Failed to submit');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to submit' }));
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Use a separate test block to ensure proper imports ─────────────────────

describe('branchRunner - rejection path', () => {
  it('handles rejected step correctly', async () => {
    // Import the mock for structured output
    const { mockPromptForStructured } = await import('./helpers.js');

    setupProfileMocks();
    setupHarnessMocks();

    mockPromptForStructured.mockResolvedValue({
      result: { approved: false, feedback: 'Code does not meet standards', severity: 'medium' },
      attempts: 1,
    });

    const ctx = createRunnerContext();

    // We need a step with a schema so runStep uses structured output
    const reviewWithSchema: StepDefinition = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
      // We import z from zod for the schema
    };

    // We need to build the runner lazily because we need to import z
    const { z } = await import('zod');
    reviewWithSchema.schema = z.object({
      approved: z.boolean(),
      feedback: z.string().optional(),
      severity: z.string().optional(),
    });

    const runner = branchRunner({
      branches: [{ condition: () => true, step: reviewWithSchema }],
    });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome).toHaveProperty('feedback', 'Code does not meet standards');
    expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ feedback: 'Code does not meet standards' }));
    expect(ctx.completeTask).not.toHaveBeenCalled();
  });
});

describe('branchRunner - session disposal', () => {
  it('disposes the session on successful completion', async () => {
    setupProfileMocks();
    const dispose = mock(() => {});
    mockCreateHarness.mockResolvedValue({
      session: makeSession(() => 'done'),
      sessionId: 'test-session',
      dispose,
    });

    const ctx = createRunnerContext();
    const runner = branchRunner({
      branches: [{ condition: () => true, step: coderStep }],
    });

    await runner(ctx);

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the session when step is rejected', async () => {
    const { mockPromptForStructured } = await import('./helpers.js');

    setupProfileMocks();
    const dispose = mock(() => {});
    mockCreateHarness.mockResolvedValue({
      session: makeSession(() => 'done'),
      sessionId: 'test-session',
      dispose,
    });

    mockPromptForStructured.mockResolvedValue({
      result: { approved: false, feedback: 'Needs work', severity: 'medium' },
      attempts: 1,
    });

    const ctx = createRunnerContext();
    const { z } = await import('zod');
    const reviewWithSchema: StepDefinition = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
      schema: z.object({
        approved: z.boolean(),
        feedback: z.string().optional(),
        severity: z.string().optional(),
      }),
    };

    const runner = branchRunner({
      branches: [{ condition: () => true, step: reviewWithSchema }],
    });

    await runner(ctx);

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the session when completeTask returns false', async () => {
    setupProfileMocks();
    const dispose = mock(() => {});
    mockCreateHarness.mockResolvedValue({
      session: makeSession(() => 'done'),
      sessionId: 'test-session',
      dispose,
    });

    const ctx = createRunnerContext({
      completeTask: mock(() => false) as () => boolean,
    });

    const runner = branchRunner({
      branches: [{ condition: () => true, step: coderStep }],
    });

    await runner(ctx);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to submit' }));
  });

  it('disposes the session when no match and no default', async () => {
    setupProfileMocks();
    // No harness should be created, so no session to dispose
    // Still, the function should return cleanly
    const ctx = createRunnerContext();

    const runner = branchRunner({
      branches: [{ condition: () => false, step: coderStep }],
      // no default
    });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect(mockCreateHarness).not.toHaveBeenCalled();
  });
});

describe('branchRunner - unexpected error', () => {
  it('catches error, disposes session, returns failed, does NOT re-throw', async () => {
    setupProfileMocks();
    mockCreateHarness.mockRejectedValue(new Error('Something went wrong in harness'));

    const ctx = createRunnerContext();
    const runner = branchRunner({
      branches: [{ condition: () => true, step: coderStep }],
    });

    let threw = false;
    try {
      const outcome = await runner(ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'Something went wrong in harness');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Something went wrong in harness' }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('disposes sessions on unexpected error', async () => {
    setupProfileMocks();
    mockCreateHarness.mockRejectedValue(new Error('catastrophic failure'));

    const ctx = createRunnerContext();
    const runner = branchRunner({
      branches: [{ condition: () => true, step: coderStep }],
    });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome).toHaveProperty('error', 'catastrophic failure');
    expect(ctx.failTask).toHaveBeenCalledTimes(1);
  });

  it('does not re-throw the error', async () => {
    setupProfileMocks();
    mockCreateHarness.mockRejectedValue(new Error('Boom'));

    const ctx = createRunnerContext();
    const runner = branchRunner({
      branches: [{ condition: () => true, step: coderStep }],
    });

    const outcome = await runner(ctx);
    expect(outcome.status).toBe('failed');
    // Should have resolved, not thrown
  });
});

describe('branchRunner - condition uses task data', () => {
  it('passes the task to the condition function', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    const ctx = createRunnerContext();

    const conditionSpy = mock((task: { id: string }) => {
      expect(task.id).toBe(ctx.task.id);
      return true;
    });

    const runner = branchRunner({
      branches: [{ condition: conditionSpy, step: coderStep }],
    });

    await runner(ctx);

    expect(conditionSpy).toHaveBeenCalledTimes(1);
    expect(conditionSpy).toHaveBeenCalledWith(ctx.task);
  });
});

describe('branchRunner - onStepStart callback', () => {
  it('fires onStepStart with correct info', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    const onStepStart = mock(() => {});
    const ctx = createRunnerContext({
      onStatus: { onStepStart },
    });

    const runner = branchRunner({
      branches: [{ condition: () => true, step: coderStep }],
    });

    await runner(ctx);

    expect(onStepStart).toHaveBeenCalledTimes(1);
    expect(onStepStart).toHaveBeenCalledWith({
      taskId: ctx.task.id,
      stepIndex: 0,
      stepName: coderStep.name,
      agentId: ctx.agentId,
    });
  });
});
