import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

import { RendererRegistry } from '../../packages/engine/src/core/renderer-registry.js';
import { reflectionRunner } from '../../packages/engine/src/pool/reflection-runner.js';
import type { TaskRunnerContext } from '../../packages/engine/src/pool/types.js';
import {
  clearPoolMocks,
  createRunnerContext,
  makeSession,
  mockCreateHarness,
  mockPromptForStructured,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.js';

beforeEach(() => {
  clearPoolMocks();
});

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Default draft step (no schema – produces output). */
const draftStep = { name: 'implement', profileId: 'coder', isReadOnly: false };

/** Default critic step (with schema – reviews the draft). */
const criticStep = {
  name: 'review',
  profileId: 'reviewer',
  isReadOnly: true,
  schema: z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
    severity: z.string().optional(),
  }),
};

/**
 * Sets up mocks for a single critic evaluation.
 * When `approved` is true, the critic returns approved; otherwise rejected.
 */
function setupCriticMock(approved: boolean, feedback = 'Needs work', severity = 'medium') {
  mockPromptForStructured.mockResolvedValue({
    result: { approved, feedback, severity },
    attempts: 1,
  });
}

/**
 * Sets up sequential critic responses (e.g. first rejects, second approves).
 */
function setupCriticSequence(responses: { approved: boolean; feedback?: string; severity?: string }[]) {
  let callIndex = 0;
  mockPromptForStructured.mockImplementation(() => {
    const r = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve({
      result: { approved: r.approved, feedback: r.feedback ?? 'No feedback', severity: r.severity ?? 'medium' },
      attempts: 1,
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// approve-on-round-1
// ═══════════════════════════════════════════════════════════════════════════

describe('approve on round 1', () => {
  it('returns completed when critic approves on first round', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(true, 'Looks good');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('completed');
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    expect(ctx.failTask).not.toHaveBeenCalled();
  });

  it('runs draftStep and criticStep each exactly once on first-round approval', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(true, 'Looks good');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // Each round: one createHarness for draft, one for critic = 2 calls
    expect(mockCreateHarness).toHaveBeenCalledTimes(2);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
  });

  it('returns output from critic when approved', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    const criticOutput = { approved: true, feedback: 'All good', severity: 'low' };
    mockPromptForStructured.mockResolvedValue({
      result: criticOutput,
      attempts: 1,
    });

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('completed');
    expect(outcome).toHaveProperty('output', criticOutput);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// reject-then-approve
// ═══════════════════════════════════════════════════════════════════════════

describe('reject then approve', () => {
  it('runs draft and critic twice when first review is rejected', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Add more tests', severity: 'medium' },
      { approved: true, feedback: 'Much better', severity: 'low' },
    ]);

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('completed');
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    expect(ctx.failTask).not.toHaveBeenCalled();

    // 2 rounds: 2 draft harnesses + 2 critic harnesses = 4 createHarness calls
    expect(mockCreateHarness).toHaveBeenCalledTimes(4);
    // critic runs twice
    expect(mockPromptForStructured).toHaveBeenCalledTimes(2);
  });

  it('returns completed when critic approves on round 2', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Add more tests', severity: 'medium' },
      { approved: true, feedback: 'Much better', severity: 'low' },
    ]);

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('completed');
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// max-rounds-exhausted-critical
// ═══════════════════════════════════════════════════════════════════════════

describe('max rounds exhausted with critical severity', () => {
  it('returns failed with feedback when severity is critical', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    // Always reject with critical severity
    setupCriticMock(false, 'Security vulnerability', 'critical');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome).toHaveProperty('feedback', 'Security vulnerability');
    expect(ctx.failTask).toHaveBeenCalledWith(
      expect.objectContaining({ feedback: 'Security vulnerability', severity: 'critical' }),
    );
    expect(ctx.completeTask).not.toHaveBeenCalled();
  });

  it('runs draftStep three times when maxRounds is 3 and all rejected', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(false, 'Still needs work', 'critical');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // 3 rounds × 2 harnesses (draft + critic) = 6
    expect(mockCreateHarness).toHaveBeenCalledTimes(6);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// max-rounds-exhausted-medium
// ═══════════════════════════════════════════════════════════════════════════

describe('max rounds exhausted with medium severity', () => {
  it('returns completed when severity is medium', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(false, 'Minor style issues', 'medium');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('completed');
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    expect(ctx.failTask).not.toHaveBeenCalled();
  });

  it('returns completed when severity is low', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(false, 'Minor nitpick', 'low');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('completed');
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
  });

  it('returns failed when severity is high', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(false, 'Major issue', 'high');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome).toHaveProperty('feedback', 'Major issue');
    expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ feedback: 'Major issue', severity: 'high' }));
    expect(ctx.completeTask).not.toHaveBeenCalled();
  });

  it('returns completed when no severity field is present (defaults to medium)', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    // Critic output omits severity → extractSeverity returns 'medium' →
    // isFailingSeverity is false → accept with caveats.
    mockPromptForStructured.mockResolvedValue({
      result: { approved: false, feedback: 'no severity here' },
      attempts: 1,
    });

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 1 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('completed');
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// review-feedback
// ═══════════════════════════════════════════════════════════════════════════

describe('review feedback appended to task', () => {
  it('has reviewFeedback entries after each rejection', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Round 1 feedback', severity: 'medium' },
      { approved: false, feedback: 'Round 2 feedback', severity: 'medium' },
      { approved: true, feedback: 'Approved', severity: 'low' },
    ]);

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(ctx.task.reviewFeedback).toBeDefined();
    expect(ctx.task.reviewFeedback).toHaveLength(2);
    expect(ctx.task.reviewFeedback![0]).toBe('Round 1 feedback');
    expect(ctx.task.reviewFeedback![1]).toBe('Round 2 feedback');
  });

  it('does not add reviewFeedback when critic approves on first round', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(true, 'Looks good');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(ctx.task.reviewFeedback).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// onStepStart
// ═══════════════════════════════════════════════════════════════════════════

describe('onStepStart fires correctly', () => {
  it('fires onStepStart for draftStep at stepIndex 0 and criticStep at stepIndex 1', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(true, 'Good');

    const onStepStart = mock(() => {});
    const ctx = createRunnerContext({
      onStatus: { onStepStart },
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(onStepStart).toHaveBeenCalledTimes(2);
    expect(onStepStart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ stepIndex: 0, stepName: 'implement', taskId: ctx.task.id, agentId: ctx.agentId }),
    );
    expect(onStepStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ stepIndex: 1, stepName: 'review', taskId: ctx.task.id, agentId: ctx.agentId }),
    );
  });

  it('fires onStepStart for each round when retrying', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Needs work', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const onStepStart = mock(() => {});
    const ctx = createRunnerContext({
      onStatus: { onStepStart },
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // Round 1: stepIndex 0 (draft), stepIndex 1 (critic)
    // Round 2: stepIndex 0 (draft), stepIndex 1 (critic)
    expect(onStepStart).toHaveBeenCalledTimes(4);
    expect(onStepStart).toHaveBeenNthCalledWith(1, expect.objectContaining({ stepIndex: 0, stepName: 'implement' }));
    expect(onStepStart).toHaveBeenNthCalledWith(2, expect.objectContaining({ stepIndex: 1, stepName: 'review' }));
    expect(onStepStart).toHaveBeenNthCalledWith(3, expect.objectContaining({ stepIndex: 0, stepName: 'implement' }));
    expect(onStepStart).toHaveBeenNthCalledWith(4, expect.objectContaining({ stepIndex: 1, stepName: 'review' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// onDecision
// ═══════════════════════════════════════════════════════════════════════════

describe('onDecision fires on each critic rejection', () => {
  it('fires onDecision for each rejection', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Fix this', severity: 'medium' },
      { approved: false, feedback: 'Still needs work', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const onDecision = mock(() => {});
    const ctx = createRunnerContext({
      onStatus: { onDecision },
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(onDecision).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        decision: expect.stringContaining('Critic rejected'),
        reasoning: 'Fix this',
        taskId: ctx.task.id,
        agentId: ctx.agentId,
      }),
    );
    expect(onDecision).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        decision: expect.stringContaining('Critic rejected'),
        reasoning: 'Still needs work',
        taskId: ctx.task.id,
        agentId: ctx.agentId,
      }),
    );
  });

  it('does not fire onDecision when critic approves', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(true, 'Good');

    const onDecision = mock(() => {});
    const ctx = createRunnerContext({
      onStatus: { onDecision },
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(onDecision).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// session-resume
// ═══════════════════════════════════════════════════════════════════════════

describe('session resume', () => {
  it('passes existingSessionPath to runStep on subsequent rounds', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    // Track createHarness calls to inspect harness options
    const harnessArgs: unknown[] = [];
    mockCreateHarness.mockImplementation((...args: unknown[]) => {
      harnessArgs.push(args);
      const dispose = mock(() => {});
      return {
        session: makeSession(() => 'done'),
        sessionId: `s-${harnessArgs.length}`,
        dispose,
      };
    });

    setupCriticSequence([
      { approved: false, feedback: 'Needs work', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // 4 harness calls: round1-draft, round1-critic, round2-draft, round2-critic
    expect(harnessArgs).toHaveLength(4);

    // Round 1, draft (call 1): first time, should NOT have resumeSessionPath
    const call1 = harnessArgs[0] as Record<string, unknown>[];
    expect(call1[0]).toEqual(
      expect.objectContaining({
        sessionDir: expect.any(String),
      }),
    );
    expect((call1[0] as Record<string, unknown>).resumeSessionPath).toBeUndefined();

    // Round 1, critic (call 2): first time, should NOT have resumeSessionPath
    const call2 = harnessArgs[1] as Record<string, unknown>[];
    expect(call2[0]).toEqual(
      expect.objectContaining({
        sessionDir: expect.any(String),
      }),
    );
    expect((call2[0] as Record<string, unknown>).resumeSessionPath).toBeUndefined();

    // Round 2, draft (call 3): second time, SHOULD have resumeSessionPath
    const call3 = harnessArgs[2] as Record<string, unknown>[];
    expect(call3[0]).toEqual(
      expect.objectContaining({
        resumeSessionPath: expect.any(String),
      }),
    );

    // Round 2, critic (call 4): second time, SHOULD have resumeSessionPath
    const call4 = harnessArgs[3] as Record<string, unknown>[];
    expect(call4[0]).toEqual(
      expect.objectContaining({
        resumeSessionPath: expect.any(String),
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// session-disposal
// ═══════════════════════════════════════════════════════════════════════════

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
    setupCriticMock(true, 'Good');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // 2 harnesses: draft + critic
    expect(disposes).toHaveLength(2);
    for (const d of disposes) {
      expect(d).toHaveBeenCalledTimes(1);
    }
  });

  it('disposes all sessions on failure after max rounds with critical severity', async () => {
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
    setupCriticMock(false, 'Fatal error', 'critical');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 2 });

    await runner(ctx);

    // 2 rounds × 2 = 4 harnesses
    expect(disposes).toHaveLength(4);
    for (const d of disposes) {
      expect(d).toHaveBeenCalledTimes(1);
    }
  });

  it('disposes old session when replacing with new one on retry', async () => {
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
    setupCriticSequence([
      { approved: false, feedback: 'Needs work', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // 4 harnesses: round1-draft, round1-critic, round2-draft, round2-critic
    expect(disposes).toHaveLength(4);

    // Round 1 draft dispose should have been called when round 2 draft replaces it
    // Round 1 critic dispose should have been called when round 2 critic replaces it
    // All should be disposed exactly once
    for (const d of disposes) {
      expect(d).toHaveBeenCalledTimes(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// unexpected-error
// ═══════════════════════════════════════════════════════════════════════════

describe('unexpected error handling', () => {
  it('catches error, disposes sessions, calls failTask, does not re-throw', async () => {
    setupProfileMocks();
    mockCreateHarness.mockRejectedValue(new Error('Harness exploded'));

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

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

  it('disposes tracked sessions when error occurs mid-execution', async () => {
    setupProfileMocks();
    const disposes: ReturnType<typeof mock>[] = [];

    // First call succeeds (draft run), second call throws (critic run)
    let callCount = 0;
    mockCreateHarness.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const dispose = mock(() => {});
        disposes.push(dispose);
        return {
          session: makeSession(() => 'done'),
          sessionId: 's-1',
          dispose,
        };
      }
      throw new Error('Critic harness failed');
    });

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // The draft session should have been disposed
    expect(disposes).toHaveLength(1);
    expect(disposes[0]).toHaveBeenCalledTimes(1);
    expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Critic harness failed' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// default-maxRounds
// ═══════════════════════════════════════════════════════════════════════════

describe('default maxRounds', () => {
  it('defaults maxRounds to 3 when not provided', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    // Always reject with critical so we can count rounds
    setupCriticMock(false, 'Always wrong', 'critical');

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep }); // no maxRounds

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    // 3 rounds × 2 harnesses = 6
    expect(mockCreateHarness).toHaveBeenCalledTimes(6);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// completeTask-fails
// ═══════════════════════════════════════════════════════════════════════════

describe('completeTask failure handling', () => {
  it('settles as failed when completeTask returns false on critic approval (delegated to settleResult)', async () => {
    // settleResult() branches on the boolean returned by completeTask:
    // when false (task cancelled/raced), it calls failTask and returns
    // { status: 'failed' }.
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(true, 'Approved');

    const ctx = createRunnerContext({
      completeTask: mock(() => false) as () => boolean,
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome).toHaveProperty('error', 'Failed to submit');
    // completeTask is invoked once with the critic output; when it returns
    // false, settleResult calls failTask with the error.
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    expect(ctx.completeTask).toHaveBeenCalledWith({ approved: true, feedback: 'Approved', severity: 'medium' });
    expect(ctx.failTask).toHaveBeenCalledTimes(1);
    expect(ctx.failTask).toHaveBeenCalledWith({ completed: false, error: 'Failed to submit' });
  });

  it('returns failed when completeTask returns false after max rounds with medium severity', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(false, 'Minor issues', 'medium');

    const ctx = createRunnerContext({
      completeTask: mock(() => false) as () => boolean,
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 1 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome).toHaveProperty('error', 'Failed to submit');
    expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to submit' }));
  });
});

describe('completeTask receives output', () => {
  it('passes the critic output to completeTask on first-round approval', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    const criticOutput = { approved: true, feedback: 'Looks great', severity: 'low' };
    mockPromptForStructured.mockResolvedValue({ result: criticOutput, attempts: 1 });

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(ctx.completeTask).toHaveBeenCalledWith(criticOutput);
  });

  it('passes the final critic output to completeTask when max rounds exhausted with medium severity', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    const criticOutput = { approved: false, feedback: 'Minor issues', severity: 'medium' };
    mockPromptForStructured.mockResolvedValue({ result: criticOutput, attempts: 1 });

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 1 });

    await runner(ctx);

    expect(ctx.completeTask).toHaveBeenCalledWith(criticOutput);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// shared-runner-utils-integration
// ═══════════════════════════════════════════════════════════════════════════
//
// The refactored runner delegates session tracking to createSessionMap(),
// builds its StepExecutionContext via buildExecCtx(ctx), and wraps its
// settle/error blocks with settleResult()/handleRunnerError() (runner-utils.ts).
// These tests pin down the observable effects of that delegation. The most
// significant behavioral change vs. the old inline code is that buildExecCtx
// forwards the optional `rendererRegistry` field (previously omitted), so
// per-profile renderers registered on the context now run during step
// execution.

describe('shared runner utilities integration', () => {
  it('forwards ctx.rendererRegistry to runStep via buildExecCtx (fires onAgentRender)', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(true, 'Good');

    const rendererRegistry = new RendererRegistry();
    const renderFn = mock(() => 'RENDERED');
    rendererRegistry.register('coder', renderFn);

    const onAgentRender = mock(() => {});
    const ctx = createRunnerContext({
      rendererRegistry,
      onStatus: { onAgentRender },
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // The draft step (profileId 'coder') produced the assistant text 'done'.
    // buildExecCtx forwards rendererRegistry into the runStep execCtx, so the
    // 'coder' renderer runs over 'done' and fires onAgentRender. With the old
    // inline execCtx (which omitted rendererRegistry) this callback never fires.
    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(renderFn).toHaveBeenCalledWith('done');
    expect(onAgentRender).toHaveBeenCalledTimes(1);
    expect(onAgentRender).toHaveBeenCalledWith(
      expect.objectContaining({
        rendered: 'RENDERED',
        profile: 'coder',
        agentId: ctx.agentId,
        taskId: ctx.task.id,
      }),
    );
  });

  it('does not fire onAgentRender when no rendererRegistry is provided', async () => {
    // buildExecCtx leaves rendererRegistry undefined when ctx omits it, so
    // invokeRenderer() short-circuits and onAgentRender is never called.
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(true, 'Good');

    const onAgentRender = mock(() => {});
    const ctx = createRunnerContext({
      onStatus: { onAgentRender },
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(onAgentRender).not.toHaveBeenCalled();
  });

  it('forwards ctx.cwd and ctx.apiKeys into the harness via the buildExecCtx execCtx', async () => {
    setupProfileMocks();
    const harnessArgs: unknown[] = [];
    mockCreateHarness.mockImplementation((...args: unknown[]) => {
      harnessArgs.push(args);
      return Promise.resolve({
        session: makeSession(() => 'done'),
        sessionId: 's-x',
        dispose: mock(() => {}),
      });
    });
    setupCriticMock(true, 'Good');

    const apiKeys = { openai: 'sk-forwarded' };
    const ctx = createRunnerContext({
      sessionBaseDir: '/tmp/sb-fwd',
      cwd: '/tmp/cwd-fwd',
      apiKeys,
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // runStep builds harness options from execCtx.cwd / execCtx.apiKeys;
    // buildExecCtx forwards these straight from ctx, so createHarness sees them.
    expect(harnessArgs.length).toBeGreaterThanOrEqual(1);
    // createHarness is invoked as createHarness(harnessOpts), so the options
    // object is the first element of the captured args array.
    const firstOpts = (harnessArgs[0] as unknown[])[0] as Record<string, unknown>;
    expect(firstOpts.cwd).toBe('/tmp/cwd-fwd');
    expect(firstOpts.apiKeys).toBe(apiKeys);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// onDecision observe-hook (hookRegistry) firing
//
// The reflection runner fires the `onDecision` OBSERVE hook (audit-log sink)
// ALONGSIDE the `onStatus.onDecision` callback (event-store sink) on each
// critic rejection. These tests pin down the hook-firing behavior so the
// extraction of fireOnDecisionHook() is provably behavior-preserving.
// ═══════════════════════════════════════════════════════════════════════════

describe('onDecision observe hook (hookRegistry) fires alongside onStatus', () => {
  /** Minimal fake HookRegistry. `hasSubscribers` returns true ONLY for
   *  'onDecision' so other seams (onStructuredOutput, beforeStepPrompt) stay
   *  dormant. */
  function makeFakeRegistry(hasSubs: boolean) {
    return {
      register: mock(() => {}),
      invokeObserve: mock(async () => {}),
      invokePipeline: mock(async () => undefined),
      invokeFirstWins: mock(async () => undefined),
      invokeAllRun: mock(async () => undefined),
      hasSubscribers: mock((name: string) => hasSubs && name === 'onDecision'),
    };
  }

  it('invokes the onDecision observe hook on each critic rejection', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Fix this', severity: 'medium' },
      { approved: false, feedback: 'Still needs work', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const registry = makeFakeRegistry(true);
    const ctx = createRunnerContext({
      hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // Two rejections → two observe-hook invocations.
    expect(registry.invokeObserve).toHaveBeenCalledTimes(2);
  });

  it('passes agentId, taskId, phaseId, decision and reasoning into the args', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Fix this', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const registry = makeFakeRegistry(true);
    const ctx = createRunnerContext({
      hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(registry.invokeObserve).toHaveBeenCalledWith(
      'onDecision',
      expect.objectContaining({
        agentId: ctx.agentId,
        taskId: ctx.task.id,
        phaseId: ctx.phaseId,
        decision: 'Critic rejected (round 1/3), retrying',
        reasoning: 'Fix this',
      }),
      expect.anything(),
    );
  });

  it('defaults reasoning to "No feedback provided" when critic feedback is absent', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    // Critic rejects with no feedback field.
    mockPromptForStructured.mockResolvedValue({
      result: { approved: false, severity: 'critical' },
      attempts: 1,
    });

    const registry = makeFakeRegistry(true);
    const ctx = createRunnerContext({
      hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 1 });

    await runner(ctx);

    const passedArgs = (registry.invokeObserve.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(passedArgs.reasoning).toBe('No feedback provided');
  });

  it('fires both onStatus.onDecision AND the observe hook (two separate sinks)', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Fix this', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const registry = makeFakeRegistry(true);
    const onStatusDecision = mock((_info: unknown) => {});
    const ctx = createRunnerContext({
      hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
      onStatus: { onDecision: onStatusDecision } as Record<string, unknown>,
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(onStatusDecision).toHaveBeenCalledTimes(1);
    expect(registry.invokeObserve).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke the observe hook when hookRegistry has no subscribers', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Fix this', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const registry = makeFakeRegistry(false);
    const ctx = createRunnerContext({
      hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(registry.invokeObserve).not.toHaveBeenCalled();
  });

  it('does NOT invoke the observe hook when no hookRegistry is provided', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Fix this', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const ctx = createRunnerContext();
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    // Smoke test — completes without error, no hook to assert on.
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke the observe hook when critic approves on first round', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticMock(true, 'Good');

    const registry = makeFakeRegistry(true);
    const ctx = createRunnerContext({
      hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    expect(registry.invokeObserve).not.toHaveBeenCalled();
  });

  it('passes the correct hook context: cwd = worktreeCwd ?? ctx.cwd, workDir = ctx.cwd', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    setupCriticSequence([
      { approved: false, feedback: 'Fix this', severity: 'medium' },
      { approved: true, feedback: 'Good', severity: 'low' },
    ]);

    const registry = makeFakeRegistry(true);
    const ctx = createRunnerContext({
      hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
      cwd: '/tmp/project',
      worktreeCwd: '/wt/task-1',
    });
    const runner = reflectionRunner({ draftStep, criticStep, maxRounds: 3 });

    await runner(ctx);

    const hookCtx = (registry.invokeObserve.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(hookCtx.registry).toBe(registry);
    expect(hookCtx.cwd).toBe('/wt/task-1');
    expect(hookCtx.workDir).toBe('/tmp/project');
  });
});
