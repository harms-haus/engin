// ─── Tests for runners/retrospective-council-runner.ts (SessionPlan contract)
//
// Tests verify:
//   1. Convener-only / pressure-valve: buildMembers returns [] → done
//   2. One full round then terminate → done
//   3. Multi-round loop with nextMembers
//   4. Empty nextMembers ends (OR condition with terminate)
//   5. maxRounds ends WITHOUT throwing
//   6. onMaxRoundsExhausted invoked exactly once on cap-exit
//   7. onMaxRoundsExhausted NOT called on normal terminate
//   8. onMaxRoundsExhausted error swallowed
//   9. buildRetrospectivePrompt called each round with (ctx, round)
//  10. buildRetrospectivePrompt omitted → retrospective.prompt reused
//  11. Batch contents/order correct
//  12. execute delegates to runScheduledSession (+ error propagation)
//  13. Factory creates fresh runner instances each call
//  14. async buildRetrospectivePrompt is awaited (Promise resolves to string)
//  15. buildRetrospectivePrompt provided → unique per-round retrospective ids
//  16. buildRetrospectivePrompt omitted → template id unchanged
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

import type { RetrospectiveCouncilRunnerOptions } from './retrospective-council-runner.js';
import { retrospectiveCouncilRunner } from './retrospective-council-runner.js';

// ─── Mock wiring ─────────────────────────────────────────────────────────

setupRunScheduledSessionMock();

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeSpec(id: string): SessionSpec {
  return {
    id,
    profile: 'p',
    prompt: 'prompt',
    outputMode: 'text' as const,
    runnerRole: 'role',
    attempt: 1,
  };
}

function structured(data: Record<string, unknown>): SessionResult {
  return { mode: 'structured', data };
}

function convenerResult(): SessionResult {
  return structured({ dimension: 'd', applicable: true, notApplicableReason: '', summary: '', findings: [] });
}

function retroResult(overrides: {
  terminate: boolean;
  findings?: unknown[];
  resolvedFindings?: unknown[];
  regressions?: unknown[];
}): SessionResult {
  return structured({
    terminate: overrides.terminate,
    applicable: true,
    summary: '',
    findings: overrides.findings ?? [],
    resolvedFindings: overrides.resolvedFindings ?? [],
    regressions: overrides.regressions ?? [],
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('retrospectiveCouncilRunner (SessionPlan)', () => {
  // ── 1. Convener-only / pressure-valve ─────────────────────────────────

  it('1. plan: buildMembers returns [] → exactly one batch (convener) then done', async () => {
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: true, nextMembers: [] }),
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // First yield should be the convener batch
    const batch1 = await gen.next();
    expect(batch1.done).toBe(false);
    const convenerBatch = batch1.value as SessionSpec[];
    expect(convenerBatch).toHaveLength(1);
    expect(convenerBatch[0].id).toBe('convener');

    // Feed convener result back → generator should return immediately
    const done = await gen.next([convenerResult()]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 2. One full round then terminate ──────────────────────────────────

  it('2. plan: one full round then terminate → done after 3 batches', async () => {
    const memberSpec = makeSpec('member1');
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [memberSpec],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: true, nextMembers: [] }),
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Batch 1: convener
    const b1 = await gen.next();
    expect(b1.done).toBe(false);
    expect((b1.value as SessionSpec[])[0].id).toBe('convener');

    // Batch 2: members
    const b2 = await gen.next([convenerResult()]);
    expect(b2.done).toBe(false);
    expect(b2.value as SessionSpec[]).toHaveLength(1);
    expect((b2.value as SessionSpec[])[0].id).toBe('member1');

    // Batch 3: retrospective
    const b3 = await gen.next([{ mode: 'text', text: 'member output' }]);
    expect(b3.done).toBe(false);
    expect(b3.value as SessionSpec[]).toHaveLength(1);
    expect((b3.value as SessionSpec[])[0].id).toBe('retro');

    // Feed retrospective result back → terminate, done
    const done = await gen.next([retroResult({ terminate: true })]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 3. Multi-round loop ───────────────────────────────────────────────

  it('3. plan: multi-round loop — round1 continue, round2 terminate → 5 batches', async () => {
    const memberSpec1 = makeSpec('member1');
    const memberSpec2 = makeSpec('member2');
    let callCount = 0;
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [memberSpec1],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => {
        callCount++;
        if (callCount === 1) {
          return { terminate: false, nextMembers: [memberSpec2] };
        }
        return { terminate: true, nextMembers: [] };
      },
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Batch 1: convener
    await gen.next();
    // Batch 2: members (round 1, memberSpec1)
    const b2 = await gen.next([convenerResult()]);
    expect((b2.value as SessionSpec[])[0].id).toBe('member1');
    // Batch 3: retrospect (round 1)
    await gen.next([{ mode: 'text', text: 'member1 out' }]);

    // Batch 4: members (round 2, memberSpec2)
    const b4 = await gen.next([retroResult({ terminate: false })]);
    expect((b4.value as SessionSpec[])[0].id).toBe('member2');

    // Batch 5: retrospect (round 2)
    await gen.next([{ mode: 'text', text: 'member2 out' }]);

    // Feed retrospective → terminate, done
    const done = await gen.next([retroResult({ terminate: true })]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 4. Empty nextMembers ends ─────────────────────────────────────────

  it('4. plan: empty nextMembers ends the loop (OR condition)', async () => {
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [makeSpec('member')],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: false, nextMembers: [] }),
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Convener
    await gen.next();
    // Members
    await gen.next([convenerResult()]);
    // Retrospective
    await gen.next([{ mode: 'text', text: 'out' }]);
    // Empty nextMembers → done
    const done = await gen.next([retroResult({ terminate: false })]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 5. maxRounds ends WITHOUT throwing ────────────────────────────────

  it('5. plan: maxRounds=1 ends without throwing', async () => {
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [makeSpec('member')],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: false, nextMembers: [makeSpec('member2')] }),
      maxRounds: 1,
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Convener
    await gen.next();
    // Members (round 1)
    await gen.next([convenerResult()]);
    // Retrospective (round 1) — interpretRetrospective says continue, but maxRounds=1
    // After this, the loop falls through and returns (no throw)
    const retroBatch = await gen.next([{ mode: 'text', text: 'out' }]);
    expect(retroBatch.done).toBe(false);
    expect((retroBatch.value as SessionSpec[])[0].id).toBe('retro');

    // Feed retrospective result back — the loop is done, so generator returns
    const done = await gen.next([retroResult({ terminate: false })]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 6. onMaxRoundsExhausted invoked exactly once on cap-exit ──────────

  it('6. plan: onMaxRoundsExhausted invoked exactly once on cap-exit', async () => {
    const exhaustedRounds: number[] = [];
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [makeSpec('member')],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: false, nextMembers: [makeSpec('member2')] }),
      maxRounds: 1,
      onMaxRoundsExhausted: () => {
        exhaustedRounds.push(1);
      },
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Run through all batches
    await gen.next(); // convener
    await gen.next([convenerResult()]); // members (round 1)
    await gen.next([{ mode: 'text', text: 'out' }]); // retro (round 1)
    // Feed retro result → loop exhausted → callback fires
    const done = await gen.next([retroResult({ terminate: false })]);
    expect(done.done).toBe(true);
    expect(exhaustedRounds).toHaveLength(1);
  });

  // ── 7. onMaxRoundsExhausted NOT called on normal terminate ────────────

  it('7. plan: onMaxRoundsExhausted NOT called on normal terminate', async () => {
    let callbackCalls = 0;
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [makeSpec('member')],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: true, nextMembers: [] }),
      maxRounds: 3,
      onMaxRoundsExhausted: () => {
        callbackCalls++;
      },
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next(); // convener
    await gen.next([convenerResult()]); // members
    await gen.next([{ mode: 'text', text: 'out' }]); // retro
    await gen.next([retroResult({ terminate: true })]); // terminate

    expect(callbackCalls).toBe(0);
  });

  // ── 8. onMaxRoundsExhausted error swallowed ──────────────────────────

  it('8. plan: onMaxRoundsExhausted error swallowed', async () => {
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [makeSpec('member')],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: false, nextMembers: [makeSpec('member2')] }),
      maxRounds: 1,
      onMaxRoundsExhausted: () => {
        throw new Error('exhausted error');
      },
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next(); // convener
    await gen.next([convenerResult()]); // members (round 1)
    await gen.next([{ mode: 'text', text: 'out' }]); // retro (round 1)
    // Even though callback throws, generator returns normally
    const done = await gen.next([retroResult({ terminate: false })]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 9. buildRetrospectivePrompt called each round ─────────────────────

  it('9. plan: buildRetrospectivePrompt called each round with (ctx, round)', async () => {
    const roundCalls: number[] = [];
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [makeSpec('member')],
      retrospective: { ...makeSpec('retro'), prompt: 'default prompt' },
      buildRetrospectivePrompt: (ctx, round) => {
        roundCalls.push(round);
        return `prompt-r${round}`;
      },
      interpretRetrospective: () => ({ terminate: false, nextMembers: [makeSpec('member2')] }),
      maxRounds: 2,
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1
    await gen.next(); // convener
    await gen.next([convenerResult()]); // members
    const retro1 = await gen.next([{ mode: 'text', text: 'out' }]);
    expect((retro1.value as SessionSpec[])[0].prompt).toBe('prompt-r1');

    // Round 2
    const members2 = await gen.next([retroResult({ terminate: false })]);
    expect((members2.value as SessionSpec[])[0].id).toBe('member2');
    const retro2 = await gen.next([{ mode: 'text', text: 'out2' }]);
    expect((retro2.value as SessionSpec[])[0].prompt).toBe('prompt-r2');

    // Terminate
    await gen.next([retroResult({ terminate: true })]);

    expect(roundCalls).toEqual([1, 2]);
  });

  // ── 10. buildRetrospectivePrompt omitted → retro.prompt reused ────────

  it('10. plan: buildRetrospectivePrompt omitted → retrospective.prompt reused each round', async () => {
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [makeSpec('member')],
      retrospective: { ...makeSpec('retro'), prompt: 'static prompt' },
      // buildRetrospectivePrompt omitted
      interpretRetrospective: () => ({ terminate: false, nextMembers: [makeSpec('member2')] }),
      maxRounds: 2,
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Round 1
    await gen.next(); // convener
    await gen.next([convenerResult()]); // members
    const retro1 = await gen.next([{ mode: 'text', text: 'out' }]);
    expect((retro1.value as SessionSpec[])[0].prompt).toBe('static prompt');

    // Round 2
    await gen.next([retroResult({ terminate: false })]); // members
    const retro2 = await gen.next([{ mode: 'text', text: 'out2' }]);
    expect((retro2.value as SessionSpec[])[0].prompt).toBe('static prompt');

    // Terminate
    await gen.next([retroResult({ terminate: true })]);
  });

  // ── 11. Batch contents/order correct ──────────────────────────────────

  it('11. plan: batch contents and order correct', async () => {
    const memberA = makeSpec('memberA');
    const memberB = makeSpec('memberB');
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: { ...makeSpec('convener'), prompt: 'convener prompt' },
      buildMembers: () => [memberA, memberB],
      retrospective: { ...makeSpec('retro'), prompt: 'retro prompt' },
      interpretRetrospective: () => ({ terminate: true, nextMembers: [] }),
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Convener batch
    const b1 = await gen.next();
    expect(b1.done).toBe(false);
    const convBatch = b1.value as SessionSpec[];
    expect(convBatch).toHaveLength(1);
    expect(convBatch[0].id).toBe('convener');
    expect(convBatch[0].prompt).toBe('convener prompt');
    expect(convBatch[0].outputMode).toBe('text');

    // Members batch
    const b2 = await gen.next([convenerResult()]);
    expect(b2.done).toBe(false);
    const membBatch = b2.value as SessionSpec[];
    expect(membBatch).toHaveLength(2);
    expect(membBatch[0].id).toBe('memberA');
    expect(membBatch[1].id).toBe('memberB');

    // Retrospective batch
    const b3 = await gen.next([
      { mode: 'text', text: 'A out' },
      { mode: 'text', text: 'B out' },
    ]);
    expect(b3.done).toBe(false);
    const retBatch = b3.value as SessionSpec[];
    expect(retBatch).toHaveLength(1);
    expect(retBatch[0].id).toBe('retro');
    expect(retBatch[0].prompt).toBe('retro prompt');

    // Terminate → done
    const done = await gen.next([retroResult({ terminate: true })]);
    expect(done.done).toBe(true);
  });

  // ── 12. execute delegates to runScheduledSession ──────────────────────

  it('12a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: true, nextMembers: [] }),
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('test-spec');
    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('12b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: true, nextMembers: [] }),
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('test-spec');
    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 13. Factory creates fresh instances ────────────────────────────────

  it('13. factory returns a new runner instance each call', () => {
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [],
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: true, nextMembers: [] }),
    };
    const factory = retrospectiveCouncilRunner(options);

    const runnerA = factory();
    const runnerB = factory();

    expect(runnerA).not.toBe(runnerB);
    expect(runnerA.plan).toBeInstanceOf(Function);
    expect(runnerA.execute).toBeInstanceOf(Function);
    expect(runnerB.plan).toBeInstanceOf(Function);
    expect(runnerB.execute).toBeInstanceOf(Function);
  });

  // ── 14. async buildRetrospectivePrompt is awaited ───────────────────

  it('14. plan: async buildRetrospectivePrompt is awaited (Promise resolves to the prompt string)', async () => {
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [makeSpec('m1')],
      retrospective: makeSpec('retro'),
      buildRetrospectivePrompt: async (_ctx, round) => Promise.resolve(`prompt-r${round}`),
      interpretRetrospective: () => ({ terminate: true, nextMembers: [] }),
      maxRounds: 1,
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Convener
    await gen.next();
    // Members (round 1)
    await gen.next([convenerResult()]);
    // Retrospective batch — the runner must have AWAITED the async
    // buildRetrospectivePrompt, so the prompt is the resolved string,
    // not '[object Promise]'.
    const retroBatch = await gen.next([{ mode: 'text', text: 'member out' }]);
    expect(retroBatch.done).toBe(false);
    const retroSpec = (retroBatch.value as SessionSpec[])[0];
    expect(retroSpec.prompt).toBe('prompt-r1');
    expect(retroSpec.prompt).not.toBe('[object Promise]');

    // Terminate → done
    const done = await gen.next([retroResult({ terminate: true })]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 15. buildRetrospectivePrompt provided → unique per-round retrospective ids

  it('15. plan: buildRetrospectivePrompt provided → retrospective spec ids are unique per round', async () => {
    const memberSpec1 = makeSpec('member1');
    const memberSpec2 = makeSpec('member2');
    let callCount = 0;
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [memberSpec1],
      retrospective: makeSpec('retro'),
      buildRetrospectivePrompt: (_ctx, round) => `prompt-r${round}`,
      interpretRetrospective: () => {
        callCount++;
        if (callCount === 1) {
          return { terminate: false, nextMembers: [memberSpec2] };
        }
        return { terminate: true, nextMembers: [] };
      },
      maxRounds: 2,
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Convener
    await gen.next();
    // Members (round 1)
    await gen.next([convenerResult()]);
    // Retrospective (round 1) — id should have -r1 suffix
    const retro1 = await gen.next([{ mode: 'text', text: 'out' }]);
    expect((retro1.value as SessionSpec[])[0].id).toBe('retro-r1');

    // Members (round 2)
    await gen.next([retroResult({ terminate: false })]);
    // Retrospective (round 2) — id should have -r2 suffix
    const retro2 = await gen.next([{ mode: 'text', text: 'out2' }]);
    expect((retro2.value as SessionSpec[])[0].id).toBe('retro-r2');

    // Terminate → done
    const done = await gen.next([retroResult({ terminate: true })]);
    expect(done.done).toBe(true);
  });

  // ── 16. buildRetrospectivePrompt omitted → template id unchanged

  it('16. plan: buildRetrospectivePrompt omitted → retrospective spec id equals template id exactly', async () => {
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: () => [makeSpec('member')],
      retrospective: makeSpec('retro'),
      // buildRetrospectivePrompt omitted
      interpretRetrospective: () => ({ terminate: false, nextMembers: [makeSpec('member2')] }),
      maxRounds: 2,
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Convener
    await gen.next();
    // Members (round 1)
    await gen.next([convenerResult()]);
    // Retrospective (round 1) — id unchanged (no suffix)
    const retro1 = await gen.next([{ mode: 'text', text: 'out' }]);
    expect((retro1.value as SessionSpec[])[0].id).toBe('retro');

    // Members (round 2)
    await gen.next([retroResult({ terminate: false })]);
    // Retrospective (round 2) — id STILL unchanged
    const retro2 = await gen.next([{ mode: 'text', text: 'out2' }]);
    expect((retro2.value as SessionSpec[])[0].id).toBe('retro');

    // Terminate
    await gen.next([retroResult({ terminate: true })]);
  });

  // ── 17. buildMembers receives the correct convener result ────────────

  it('17. plan: buildMembers receives the correct convener result', async () => {
    const received: SessionResult[] = [];
    const options: RetrospectiveCouncilRunnerOptions = {
      convener: makeSpec('convener'),
      buildMembers: (result) => {
        received.push(result);
        return [makeSpec('member1')];
      },
      retrospective: makeSpec('retro'),
      interpretRetrospective: () => ({ terminate: true, nextMembers: [] }),
    };
    const factory = retrospectiveCouncilRunner(options);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Yield convener batch
    await gen.next();

    // Feed a specific structured convener result
    const convenerInput = convenerResult();
    await gen.next([convenerInput]);

    // buildMembers must have been called with that exact result
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(convenerInput);
  });
});
