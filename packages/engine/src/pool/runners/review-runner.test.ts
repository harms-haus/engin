// ─── Tests for runners/review-runner.ts (SessionPlan contract) ────────────
//
// Tests verify:
//   1. plan: execute→review→approved→generator returns (done)
//   2. plan: reject round 1, approve round 2 → done; stable IDs, resume,
//      feedback appended
//   3. plan: maxRounds exhausted → throws (task failure)
//   4. plan: stable IDs across rounds (round 2+ resumes)
//   5. plan: review prompt includes execute output (all modes: text,
//      structured, filesystem)
//   6. plan: execute prompt includes accumulated feedback on round 2+
//   7. plan: DEFAULT_MAX_ROUNDS (3) used when maxRounds omitted
//   8. plan: onReviewReject callback fires on rejection
//   9. plan: onReviewReject errors are non-fatal (swallowed)
//  10. execute: delegates to runScheduledSession
//  11. execute: propagates errors from runScheduledSession
//  12. Factory creates fresh runner instances each call
//
// Mock strategy:
//   - Shared mock via `test-fixtures.ts` → `mockRunScheduledSession`
//   - plan() is tested by driving the generator manually (simulating the
//     scheduler's feed/results loop).
//   - execute() is tested via the shared mock.

import { describe, expect, it } from 'bun:test';
import type { SessionResult, SessionSpec } from '../session.js';
import {
  CANNED_RESULT,
  makePlanContext,
  mockRunScheduledSession,
  setupRunScheduledSessionMock,
} from './test-fixtures.js';

// ─── Import module under test ────────────────────────────────────────────

import { reviewRunner } from './review-runner.js';

// ─── Mock wiring ─────────────────────────────────────────────────────────

setupRunScheduledSessionMock();

// ─── Helper factories (matching reviewRunner's parameter type) ──────────

function makeExecSpec() {
  return {
    profile: 'executor',
    prompt: 'Build the feature',
    outputMode: 'text' as const,
    role: 'executor',
  };
}

function makeReviewSpec() {
  return {
    profile: 'reviewer',
    prompt: 'Review the work',
    outputMode: 'structured' as const,
    role: 'reviewer',
  };
}

// ─── Canned session results ─────────────────────────────────────────────

function execResult(text = 'implementation'): SessionResult {
  return { mode: 'text', text };
}

function approvedReview(): SessionResult {
  return { mode: 'structured', data: { approved: true } };
}

function rejectedReview(feedback = 'Needs error handling'): SessionResult {
  return { mode: 'structured', data: { approved: false, feedback } };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('reviewRunner (SessionPlan)', () => {
  // ── 1. Execute→review→approved→done ────────────────────────────────────

  it('1. plan: execute→review→approved→generator returns (done)', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1: execute batch
    const batch1 = await gen.next();
    expect(batch1.done).toBeFalse();
    expect(batch1.value).toHaveLength(1);
    const execSpec = (batch1.value as SessionSpec[])[0];
    expect(execSpec.id).toBe('task-abc/executor');
    expect(execSpec.attempt).toBe(1);
    expect(execSpec.resume).toBeUndefined();

    // Feed back execute result → expect review batch
    const batch2 = await gen.next([execResult()]);
    expect(batch2.done).toBeFalse();
    expect(batch2.value).toHaveLength(1);
    const reviewSpec = (batch2.value as SessionSpec[])[0];
    expect(reviewSpec.id).toBe('task-abc/reviewer');
    expect(reviewSpec.attempt).toBe(1);
    expect(reviewSpec.resume).toBeUndefined();

    // Feed back approved review → expect generator done
    const done = await gen.next([approvedReview()]);
    expect(done.done).toBeTrue();
    expect(done.value).toBeUndefined();
  });

  // ── 2. Reject round 1, approve round 2 → done ─────────────────────────

  it('2a. plan: reject round 1, approve round 2 → done', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1: execute → review (rejected)
    await gen.next(); // execute batch
    await gen.next([execResult()]); // review batch
    await gen.next([rejectedReview('Needs error handling')]); // → round 2 execute (resume)

    // Round 2: execute → review (approved)
    await gen.next([execResult()]); // review batch (resume)
    const done = await gen.next([approvedReview()]);
    expect(done.done).toBeTrue();
    expect(done.value).toBeUndefined();
  });

  it('2b. plan: stable IDs with resume:true on round 2+', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1
    const r1e = await gen.next(); // execute
    const r1eSpec = (r1e.value as SessionSpec[])[0];
    expect(r1eSpec.id).toBe('task-abc/executor');
    expect(r1eSpec.resume).toBeUndefined();

    const r1r = await gen.next([execResult()]); // review
    const r1rSpec = (r1r.value as SessionSpec[])[0];
    expect(r1rSpec.id).toBe('task-abc/reviewer');
    expect(r1rSpec.resume).toBeUndefined();

    // Round 2: rejected → resume:true
    const r2e = await gen.next([rejectedReview('fix')]); // execute (resume)
    const r2eSpec = (r2e.value as SessionSpec[])[0];
    expect(r2eSpec.id).toBe('task-abc/executor');
    expect(r2eSpec.resume).toBeTrue();

    const r2r = await gen.next([execResult()]); // review (resume)
    const r2rSpec = (r2r.value as SessionSpec[])[0];
    expect(r2rSpec.id).toBe('task-abc/reviewer');
    expect(r2rSpec.resume).toBeTrue();

    // Approve
    await gen.next([approvedReview()]);
  });

  it('2c. plan: feedback appended to execute prompt on round 2', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1: execute → review (rejected with feedback)
    await gen.next(); // execute batch (round 1)
    await gen.next([execResult()]); // review batch (round 1)
    // The rejected review causes the generator to yield the round-2 execute batch.
    // We capture THAT batch to check the prompt.
    const r2ExecBatch = await gen.next([rejectedReview('Add error handling')]); // execute batch (round 2)
    const r2Spec = (r2ExecBatch.value as SessionSpec[])[0];
    expect(r2Spec.prompt).toContain('Add error handling');
    expect(r2Spec.prompt).toContain('Review feedback:\n');
    // Original prompt still present
    expect(r2Spec.prompt).toContain('Build the feature');
  });

  // ── 3. Max rounds exhausted → throws ──────────────────────────────────

  it('3. plan: maxRounds=2, always reject → throws with rejection message', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec(), { maxRounds: 2 });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1
    await gen.next(); // execute
    await gen.next([execResult()]); // review
    await gen.next([rejectedReview('nope')]); // → round 2 execute

    // Round 2
    await gen.next([execResult()]); // review
    // Last rejection → generator throws
    await expect(gen.next([rejectedReview('nope')])).rejects.toThrow(/rejected after .* rounds/i);
  });

  // ── 4. Stable IDs across rounds ────────────────────────────────────────

  it('4. plan: stable execute/review ids across rounds (no #round suffix)', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Collect all spec ids as the loop progresses
    const specs: Array<{ id: string; resume: boolean | undefined; round: number }> = [];

    // Round 1 execute
    const r1e = await gen.next();
    specs.push({ id: (r1e.value as SessionSpec[])[0].id, resume: (r1e.value as SessionSpec[])[0].resume, round: 1 });

    // Round 1 review
    const r1r = await gen.next([execResult()]);
    specs.push({ id: (r1r.value as SessionSpec[])[0].id, resume: (r1r.value as SessionSpec[])[0].resume, round: 1 });

    // Round 2 execute (rejected → resume)
    const r2e = await gen.next([rejectedReview('fix')]);
    specs.push({ id: (r2e.value as SessionSpec[])[0].id, resume: (r2e.value as SessionSpec[])[0].resume, round: 2 });

    // Round 2 review (resume)
    const r2r = await gen.next([execResult()]);
    specs.push({ id: (r2r.value as SessionSpec[])[0].id, resume: (r2r.value as SessionSpec[])[0].resume, round: 2 });

    // Approve
    await gen.next([approvedReview()]);

    // Verify stable ids: every execute spec has the same id, every review too
    const executeIds = specs.filter((s) => s.id.includes('execut')).map((s) => s.id);
    const reviewIds = specs.filter((s) => s.id.includes('review')).map((s) => s.id);
    expect(new Set(executeIds).size).toBe(1);
    expect(executeIds[0]).toBe('task-abc/executor');
    expect(new Set(reviewIds).size).toBe(1);
    expect(reviewIds[0]).toBe('task-abc/reviewer');

    // Round 1: no resume; Round 2: resume
    expect(specs[0].resume).toBeUndefined(); // execute round 1
    expect(specs[1].resume).toBeUndefined(); // review round 1
    expect(specs[2].resume).toBeTrue(); // execute round 2
    expect(specs[3].resume).toBeTrue(); // review round 2
  });

  // ── 5. Review prompt includes execute output ──────────────────────────

  it('5a. plan: review prompt contains text-mode execute output', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next(); // execute batch
    const reviewBatch = await gen.next([execResult('EXECUTION RESULT TEXT')]);
    expect((reviewBatch.value as SessionSpec[])[0].prompt).toContain('EXECUTION RESULT TEXT');
    expect((reviewBatch.value as SessionSpec[])[0].prompt).toContain('---\nExecute output:\n');
  });

  it('5b. plan: review prompt contains structured-mode execute output', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next(); // execute batch
    const structuredResult: SessionResult = {
      mode: 'structured',
      data: { status: 'done', summary: 'Implemented X' },
    };
    const reviewBatch = await gen.next([structuredResult]);
    expect((reviewBatch.value as SessionSpec[])[0].prompt).toContain('{"status":"done","summary":"Implemented X"}');
    expect((reviewBatch.value as SessionSpec[])[0].prompt).toContain('---\nExecute output:\n');
  });

  it('5c. plan: review prompt handles filesystem-mode execute output', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next(); // execute batch
    const fsResult: SessionResult = { mode: 'filesystem', files: ['output.txt'] };
    const reviewBatch = await gen.next([fsResult]);
    expect((reviewBatch.value as SessionSpec[])[0].prompt).toContain('(filesystem session — see files)');
  });

  // ── 6. Execute prompt includes accumulated feedback on round 2+ ──────

  it('6. plan: execute prompt includes accumulated feedback on round 2+', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1: execute → review (rejected with feedback)
    await gen.next(); // execute (round 1)
    await gen.next([execResult()]); // review (round 1)
    // The rejected review causes the generator to yield the round-2 execute
    // batch. That batch's prompt should contain the accumulated feedback.
    const r2Exec = await gen.next([rejectedReview('Fix the tests')]); // → round 2 execute
    expect((r2Exec.value as SessionSpec[])[0].prompt).toContain('Fix the tests');
  });

  // ── 7. DEFAULT_MAX_ROUNDS ─────────────────────────────────────────────

  it('7. plan: default maxRounds=DEFAULT_MAX_ROUNDS: always reject → throws after 3 rounds', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec()); // no maxRounds option
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1
    await gen.next(); // execute
    await gen.next([execResult()]); // review
    await gen.next([rejectedReview('nope')]); // → round 2 execute

    // Round 2
    await gen.next([execResult()]); // review
    await gen.next([rejectedReview('nope')]); // → round 3 execute

    // Round 3
    await gen.next([execResult()]); // review
    // Last rejection → throws
    await expect(gen.next([rejectedReview('nope')])).rejects.toThrow(/rejected after .* rounds/i);
  });

  // ── 8. onReviewReject callback ────────────────────────────────────────

  it('8a. plan: onReviewReject fires when review rejects', async () => {
    const rejectedRounds: number[] = [];
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec(), {
      maxRounds: 2,
      onReviewReject: (round: number) => {
        rejectedRounds.push(round);
      },
    });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1: rejected
    await gen.next(); // execute
    await gen.next([execResult()]); // review
    await gen.next([rejectedReview('fix')]); // → round 2 execute
    expect(rejectedRounds).toEqual([1]);

    // Round 2: rejected
    await gen.next([execResult()]); // review
    await expect(gen.next([rejectedReview('fix')])).rejects.toThrow();
    expect(rejectedRounds).toEqual([1, 2]);
  });

  it('8b. plan: onReviewReject errors are non-fatal (swallowed)', async () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec(), {
      maxRounds: 2,
      onReviewReject: () => {
        throw new Error('callback error');
      },
    });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1: rejected (callback throws but is swallowed)
    await gen.next(); // execute
    await gen.next([execResult()]); // review
    // This would fail if the callback error propagated
    await gen.next([rejectedReview('fix')]); // → round 2 execute

    // Round 2: rejected (callback throws again)
    await gen.next([execResult()]); // review
    await expect(gen.next([rejectedReview('fix')])).rejects.toThrow();
  });

  // ── 9. onReviewReject NOT called on approval ──────────────────────────

  it('9. plan: onReviewReject is NOT called when review approves', async () => {
    let callbackCalls = 0;
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec(), {
      onReviewReject: () => {
        callbackCalls++;
      },
    });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next(); // execute
    await gen.next([execResult()]); // review
    await gen.next([approvedReview()]); // approve → done

    expect(callbackCalls).toBe(0);
  });

  // ── 10. execute delegates to runScheduledSession ───────────────────────

  it('10a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = {
      id: 'task-abc/executor',
      profile: 'executor',
      prompt: 'Do the work',
      outputMode: 'text',
      runnerRole: 'executor',
      attempt: 1,
    };

    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('10b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = {
      id: 'task-abc/executor',
      profile: 'executor',
      prompt: 'Do the work',
      outputMode: 'text',
      runnerRole: 'executor',
      attempt: 1,
    };

    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 11. Factory creates fresh instances ────────────────────────────────

  it('11. factory returns a new runner instance each call', () => {
    const factory = reviewRunner(makeExecSpec(), makeReviewSpec());

    const runnerA = factory();
    const runnerB = factory();

    expect(runnerA).not.toBe(runnerB);
    expect(runnerA.plan).toBeInstanceOf(Function);
    expect(runnerA.execute).toBeInstanceOf(Function);
    expect(runnerB.plan).toBeInstanceOf(Function);
    expect(runnerB.execute).toBeInstanceOf(Function);
  });
});
