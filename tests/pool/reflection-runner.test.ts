import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

import { reflectionRunner } from '../../src/pool/reflection-runner.js';
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
    expect(outcome.output).toEqual(criticOutput);
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
  it('returns failed when completeTask returns false on approval', async () => {
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
    expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to submit' }));
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
