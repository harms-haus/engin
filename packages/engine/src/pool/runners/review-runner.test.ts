// ─── Tests for runners/review-runner.ts ─────────────────────────────────────
//
// Tests 7–13 from the kb-4 contract spec.
//
// Tests verify:
//   7. approve on round 1 → completed
//   8. reject round 1, approve round 2 → completed; IDs, feedback appended
//   9. maxRounds exhausted → {status:'failed', error matches /rejected after .* rounds/i}
//  10. DEFAULT maxRounds (3) used when omitted
//  11. transient SessionError in execute → retry-in-place, then succeed
//  12. permanent SessionError in execute → rethrow, no retry
//  13. REPLAY: round-1 execute+review cached, round-2 runs fresh
//
// The module under test is imported from './review-runner.js'.

import { describe, expect, it, mock } from 'bun:test';

import type { AgentProfile, Task } from '../../core/types.js';
import { DEFAULT_MAX_ROUNDS } from '../constants.js';
import type { RunSessionContext, SessionResult } from '../session.js';
import { SessionError } from '../session.js';
import { reviewRunner } from './review-runner.js';
import type { RunnerContext, TaskOutcome } from './types.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-xyz',
    title: 'Build feature',
    prompt: 'Implement X',
    profile: 'executor',
    files: [],
    dependencies: [],
    status: 'active',
    phaseId: 'code',
    worktree: 'none',
    ...overrides,
  };
}

function makeProfile(id: string, overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id,
    name: id,
    provider: 'openai',
    model: 'gpt-4o',
    thinkingLevel: 'low',
    systemPrompt: `You are ${id}.`,
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<RunnerContext>): RunnerContext {
  const task = makeTask();
  const profiles = new Map<string, AgentProfile>();
  profiles.set('executor', makeProfile('executor'));
  profiles.set('reviewer', makeProfile('reviewer'));
  return {
    task,
    gate: {
      run: mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
        fn({ signal: new AbortController().signal }),
      ),
    } as unknown as RunnerContext['gate'],
    runSession: mock(async () => ({ mode: 'text', text: 'ok' }) satisfies SessionResult),
    profiles,
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    activeSessions: new Set(),
    phaseId: 'code',
    agentId: 'agent-1',
    ...overrides,
  };
}

/** Build an execute spec — uses `role` (the public API name). */
function makeExecSpec() {
  return {
    profile: 'executor',
    prompt: 'Build the feature',
    outputMode: 'text' as const,
    role: 'executor',
    runnerRole: 'executor',
    attempt: 1,
  };
}

/** Build a review spec — uses `role` (the public API name). */
function makeReviewSpec() {
  return {
    profile: 'reviewer',
    prompt: 'Review the work',
    outputMode: 'structured' as const,
    role: 'reviewer',
    runnerRole: 'reviewer',
    attempt: 1,
  };
}

function makeSessionError(msg: string, retryable = false): SessionError {
  return new SessionError(msg, { kind: retryable ? 'transient' : 'permanent', retryable });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('reviewRunner', () => {
  // ── 7. approve on round 1 → completed ────────────────────────────────────

  it('7. review approves on round 1 → returns completed', async () => {
    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        return { mode: 'text', text: 'implementation' } satisfies SessionResult;
      }
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = reviewRunner(makeExecSpec(), makeReviewSpec());

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
  });

  // ── 8. reject round 1, approve round 2 → completed; IDs and feedback ────

  it('8a. reject round 1, approve round 2 → completed', async () => {
    let reviewCallCount = 0;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        return { mode: 'text', text: 'implementation' } satisfies SessionResult;
      }
      // review
      reviewCallCount++;
      if (reviewCallCount === 1) {
        return {
          mode: 'structured',
          data: { approved: false, feedback: 'Needs error handling' },
        } satisfies SessionResult;
      }
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = reviewRunner(makeExecSpec(), makeReviewSpec());

    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
  });

  it('8b. execute id is STABLE across rounds and round 2+ resumes the prior session', async () => {
    const executeIds: string[] = [];
    const executeResumes: boolean[] = [];
    const reviewResumes: boolean[] = [];
    let reviewCallCount = 0;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        executeIds.push(rsctx.spec.id);
        executeResumes.push(rsctx.spec.resume === true);
        return { mode: 'text', text: 'implementation' } satisfies SessionResult;
      }
      reviewCallCount++;
      reviewResumes.push(rsctx.spec.resume === true);
      if (reviewCallCount === 1) {
        return {
          mode: 'structured',
          data: { approved: false, feedback: 'revise' },
        } satisfies SessionResult;
      }
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    await reviewRunner(makeExecSpec(), makeReviewSpec())(ctx);

    // Stable execute id (no #round suffix) so round 2 resumes session 1.
    expect(executeIds).toEqual(['task-xyz/execute', 'task-xyz/execute']);
    // Round 1 creates; round 2 resumes.
    expect(executeResumes).toEqual([false, true]);
    // The review session resumes on round 2 too.
    expect(reviewResumes).toEqual([false, true]);
  });

  it('8c. review ran twice (once per round)', async () => {
    let reviewCallCount = 0;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        return { mode: 'text', text: 'impl' } satisfies SessionResult;
      }
      reviewCallCount++;
      if (reviewCallCount === 1) {
        return {
          mode: 'structured',
          data: { approved: false, feedback: 'revise' },
        } satisfies SessionResult;
      }
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    await reviewRunner(makeExecSpec(), makeReviewSpec())(ctx);

    expect(reviewCallCount).toBe(2);
  });

  it('8d. feedback is appended to the execute prompt on round 2', async () => {
    const executePrompts: string[] = [];
    let reviewCallCount = 0;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        executePrompts.push(rsctx.spec.prompt);
        return { mode: 'text', text: 'impl' } satisfies SessionResult;
      }
      reviewCallCount++;
      if (reviewCallCount === 1) {
        return {
          mode: 'structured',
          data: { approved: false, feedback: 'Needs error handling' },
        } satisfies SessionResult;
      }
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    await reviewRunner(makeExecSpec(), makeReviewSpec())(ctx);

    expect(executePrompts).toHaveLength(2);
    // Round 1: original prompt
    expect(executePrompts[0]).toBe('Build the feature');
    // Round 2: prompt contains the feedback from round 1
    expect(executePrompts[1]).toContain('Needs error handling');
  });

  // ── 9. maxRounds exhausted → failed ─────────────────────────────────────

  it('9. maxRounds=2, always reject → {status:"failed", error matches /rejected after .* rounds/i}', async () => {
    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        return { mode: 'text', text: 'impl' } satisfies SessionResult;
      }
      return { mode: 'structured', data: { approved: false, feedback: 'nope' } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = reviewRunner(makeExecSpec(), makeReviewSpec(), { maxRounds: 2 });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect((outcome as { error?: string }).error).toMatch(/rejected after .* rounds/i);
  });

  // ── 10. DEFAULT maxRounds (3) when omitted ──────────────────────────────

  it('10. default maxRounds=DEFAULT_MAX_ROUNDS: always reject → stops at round 3', async () => {
    const executeIds: string[] = [];

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        executeIds.push(rsctx.spec.id);
        return { mode: 'text', text: 'impl' } satisfies SessionResult;
      }
      return { mode: 'structured', data: { approved: false, feedback: 'nope' } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    // maxRounds omitted → uses DEFAULT_MAX_ROUNDS
    const runner = reviewRunner(makeExecSpec(), makeReviewSpec());

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    // Should have run exactly DEFAULT_MAX_ROUNDS execute calls
    expect(executeIds).toHaveLength(DEFAULT_MAX_ROUNDS);
    // Stable id across all rounds (resume on round 2+).
    expect(executeIds[executeIds.length - 1]).toBe(`task-xyz/execute`);
    expect(executeIds.every((id) => id === 'task-xyz/execute')).toBe(true);
  });

  // ── 11. transient retry-in-place ────────────────────────────────────────

  it('11. transient SessionError in execute → retry-in-place, then succeed', async () => {
    let executeCallCount = 0;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        executeCallCount++;
        if (executeCallCount === 1) {
          throw makeSessionError('transient crash', true);
        }
        return { mode: 'text', text: 'recovered impl' } satisfies SessionResult;
      }
      // review → approve
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = reviewRunner(makeExecSpec(), makeReviewSpec());

    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // Execute was called twice: first (crashed), then retry (succeeded)
    expect(executeCallCount).toBe(2);
  });

  // ── 12. permanent error → rethrow/no-retry ──────────────────────────────

  it('12. permanent SessionError in execute → returns failed, no retry', async () => {
    let executeCallCount = 0;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        executeCallCount++;
        throw makeSessionError('permanent failure', false);
      }
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = reviewRunner(makeExecSpec(), makeReviewSpec());

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect((outcome as { error?: string }).error).toBe('permanent failure');
    // Execute called only once — no retry
    expect(executeCallCount).toBe(1);
  });

  // ── 13. REPLAY: round-1 cached, round-2 fresh ──────────────────────────

  it('13. stable execute/review ids: round 2 resumes round-1 sessions', async () => {
    // With the resume design, the execute + review ids are STABLE across
    // rounds (no #round suffix). Round 1 creates both sessions; round 2
    // re-prompts them with resume:true (the agent/ reviewer see prior work).
    const runSessionCalls: { id: string; resume: boolean }[] = [];
    let reviewCallCount = 0;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      runSessionCalls.push({ id: rsctx.spec.id, resume: rsctx.spec.resume === true });
      if (rsctx.spec.id.includes('execute')) {
        return { mode: 'text', text: 'impl' } satisfies SessionResult;
      }
      reviewCallCount++;
      if (reviewCallCount === 1) {
        return { mode: 'structured', data: { approved: false, feedback: 'revise' } } satisfies SessionResult;
      }
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = reviewRunner(makeExecSpec(), makeReviewSpec());

    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // Stable ids across both rounds.
    expect(runSessionCalls.map((c) => c.id)).toEqual([
      'task-xyz/execute',
      'task-xyz/review',
      'task-xyz/execute',
      'task-xyz/review',
    ]);
    // Round 1 creates both; round 2 resumes both.
    expect(runSessionCalls.map((c) => c.resume)).toEqual([false, false, true, true]);
  });

  // ── REGRESSION: review prompt must contain execute result ──────────────────
  //
  // Bug: reviewRunner passes reviewSpec.prompt verbatim — the execute session
  // result is never interpolated into the review prompt, so the reviewer
  // cannot see what it's reviewing.
  //
  // Expected fix: after the execute session completes, modify the review prompt
  // to include the execute result. The format the implement worker should match:
  //
  //   Text-mode execute result:
  //     reviewPrompt = reviewSpec.prompt + "\n\n---\nExecute output:\n" + executeResult.text
  //
  //   Structured-mode execute result:
  //     reviewPrompt = reviewSpec.prompt + "\n\n---\nExecute output:\n" + JSON.stringify(executeResult.data)
  //
  // These tests will FAIL until the implement worker implements step 2 of the
  // review loop algorithm: "Feed the execute result into the review prompt."

  it('REGRESSION: text-mode execute result appears in review prompt', async () => {
    let reviewPrompt: string | undefined;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        return { mode: 'text', text: 'THE EXECUTE OUTPUT' } satisfies SessionResult;
      }
      // review — capture the prompt to assert on
      reviewPrompt = rsctx.spec.prompt;
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = reviewRunner(makeExecSpec(), makeReviewSpec());

    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // FAILS because reviewPrompt is just reviewSpec.prompt ("Review the work") verbatim.
    expect(reviewPrompt).toContain('THE EXECUTE OUTPUT');
    // Should include the standard separator prefix
    expect(reviewPrompt).toContain('---\nExecute output:\n');
  });

  it('REGRESSION: structured-mode execute result appears in review prompt', async () => {
    let reviewPrompt: string | undefined;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('execute')) {
        return { mode: 'structured', data: { status: 'done', summary: 'Implemented X' } } satisfies SessionResult;
      }
      reviewPrompt = rsctx.spec.prompt;
      return { mode: 'structured', data: { approved: true } } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = reviewRunner(makeExecSpec(), makeReviewSpec());

    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // FAILS because reviewPrompt is just reviewSpec.prompt ("Review the work") verbatim.
    // The review prompt should contain the JSON of the structured execute data.
    expect(reviewPrompt).toContain('{"status":"done","summary":"Implemented X"}');
    expect(reviewPrompt).toContain('---\nExecute output:\n');
  });
});
