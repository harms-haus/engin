// ─── Tests for runners/coalescing-runner.ts (SessionPlan contract) ───────
//
// Tests verify:
//   1. plan: coordinator → children → coordinator done → completes
//   2. Coordinator IDs use coordinator#${round}
//   3. maxRounds exhaustion → throws
//   4. Default maxRounds = DEFAULT_MAX_ROUNDS (3) when omitted
//   5. execute() calls runScheduledSession and returns its result
//   6. Factory creates a fresh runner instance each call
//   7. Children can yield multiple batches per round
//
// Mock strategy:
//   - Shared mock via `test-fixtures.ts` → `mockRunScheduledSession`
//   - Mock child SessionPlanRunners are constructed inline to control yield
//     behavior.

import { describe, expect, it } from 'bun:test';
import { DEFAULT_MAX_ROUNDS } from '../constants.js';
import type { SessionResult, SessionSpec } from '../session.js';
import type { SessionPlanContext, SessionPlanRunner } from './session-plan-types.js';
import {
  CANNED_RESULT,
  makePlanContext,
  mockRunScheduledSession,
  setupRunScheduledSessionMock,
} from './test-fixtures.js';

// ─── Import module under test ────────────────────────────────────────────

import { coalescingRunner } from './coalescing-runner.js';

// ─── Mock wiring ─────────────────────────────────────────────────────────

setupRunScheduledSessionMock();

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a mock SessionPlanRunner whose plan yields the given batches in order.
 */
function makeMockChild(batches: SessionSpec[][], receivedResults?: SessionResult[][]): SessionPlanRunner {
  return {
    plan(_ctx: SessionPlanContext): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
      const gen = (async function* (): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        for (const batch of batches) {
          const results: SessionResult[] = yield batch;
          receivedResults?.push(results);
        }
        return undefined;
      })();

      return gen;
    },

    async execute(_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
      return mockRunScheduledSession(spec, _ctx);
    },
  };
}

/**
 * Create a simple SessionSpec for testing.
 */
function makeSpec(id: string, overrides?: Partial<SessionSpec>): SessionSpec {
  return {
    id,
    profile: 'executor',
    prompt: 'Do the work',
    outputMode: 'text',
    runnerRole: 'executor',
    attempt: 1,
    ...overrides,
  };
}

/** Build a coordinator SessionSpec for coalescingRunner. */
function makeCoordinatorSpec(overrides?: Partial<SessionSpec>): SessionSpec {
  return {
    id: 'task-coal/coordinator#1',
    profile: 'coordinator',
    prompt: 'Coordinate the work',
    outputMode: 'structured',
    runnerRole: 'coordinator',
    attempt: 1,
    ...overrides,
  };
}

/**
 * Build a child runner factory for coalescing tests that runs a fixed set
 * of worker specs per round.
 */
function makeChildRunner(
  workerSpecs: SessionSpec[] = [makeSpec('task-coal/worker[0]#1')],
): (result: SessionResult, round: number) => SessionPlanRunner {
  return (_result: SessionResult, _round: number) => {
    return makeMockChild([workerSpecs]);
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('coalescingRunner (SessionPlan)', () => {
  // ── 1. Basic loop: coordinator → children → coordinator done → complete ─

  it('1a. round 1 coordinator says "more", round 2 says "done" → completes', async () => {
    const childBatch = [makeSpec('task-coal/worker[0]#1')];
    const childRunnerCalls: Array<{ result: SessionResult; round: number }> = [];

    const factory = coalescingRunner(makeCoordinatorSpec(), {
      childRunner: (result: SessionResult, round: number) => {
        childRunnerCalls.push({ result, round });
        return makeMockChild([childBatch]);
      },
      maxRounds: 3,
    });

    const runner = factory();
    const ctx = makePlanContext({ task: { ...makePlanContext().task, id: 'task-coal' } });
    const gen = runner.plan(ctx);

    // Round 1: coordinator says "more"
    const b0 = await gen.next();
    expect(b0.done).toBe(false);
    const round1Coord = (b0.value as SessionSpec[])[0];
    expect(round1Coord.id).toBe('task-coal/coordinator#1');

    // Feed round 1 coordinator result (done=false)
    const round1Result: SessionResult = { mode: 'structured', data: { done: false, children: [{ prompt: 'work' }] } };
    const b1 = await gen.next([round1Result]);
    // Child batch is yielded
    expect(b1.done).toBe(false);
    expect((b1.value as SessionSpec[])[0].id).toBe('task-coal/worker[0]#1');

    // Feed child results back
    const b2 = await gen.next([{ mode: 'text', text: 'worker round 1' }]);
    // Round 2: coordinator again
    expect(b2.done).toBe(false);
    const round2Coord = (b2.value as SessionSpec[])[0];
    expect(round2Coord.id).toBe('task-coal/coordinator#2');

    // Feed round 2 coordinator result (done=true)
    const round2Result: SessionResult = { mode: 'structured', data: { done: true } };
    const b3 = await gen.next([round2Result]);
    // Generator returns (completed)
    expect(b3.done).toBe(true);
    expect(b3.value).toBeUndefined();

    // childRunner was called once (round 1 only — round 2 was done)
    expect(childRunnerCalls).toHaveLength(1);
    expect(childRunnerCalls[0].round).toBe(1);
  });

  it('1b. coordinator IDs use coordinator#${round} per round', async () => {
    const coordIds: string[] = [];

    const factory = coalescingRunner(makeCoordinatorSpec(), {
      childRunner: (_result, _round) => makeMockChild([[makeSpec('w#1')]]),
      maxRounds: 3,
    });

    const runner = factory();
    const ctx = makePlanContext({ task: { ...makePlanContext().task, id: 'task-coal' } });
    const gen = runner.plan(ctx);

    // Start: get round 1 coordinator spec
    let next = await gen.next();
    expect(next.done).toBe(false);
    coordIds.push((next.value as SessionSpec[])[0].id);

    // Send coord result (done=false) → get child batch
    next = await gen.next([{ mode: 'structured', data: { done: false } }]);
    expect(next.done).toBe(false);

    // Send child result → get round 2 coordinator spec
    next = await gen.next([CANNED_RESULT]);
    expect(next.done).toBe(false);
    coordIds.push((next.value as SessionSpec[])[0].id);

    // Send done=true → generator returns
    const done = await gen.next([{ mode: 'structured', data: { done: true } }]);
    expect(done.done).toBe(true);

    expect(coordIds).toEqual(['task-coal/coordinator#1', 'task-coal/coordinator#2']);
  });

  // ── 2. maxRounds exhaustion → throws ───────────────────────────────────

  it('2a. maxRounds=2, always done=false → throws', async () => {
    const factory = coalescingRunner(makeCoordinatorSpec(), {
      childRunner: makeChildRunner(),
      maxRounds: 2,
    });

    const runner = factory();
    const ctx = makePlanContext({ task: { ...makePlanContext().task, id: 'task-coal' } });
    const gen = runner.plan(ctx);

    // Round 1: coordinator → child
    await gen.next();
    await gen.next([{ mode: 'structured', data: { done: false } }]);
    // Send child result → get round 2 coordinator spec
    await gen.next([CANNED_RESULT]);

    // Round 2: coordinator → child
    await gen.next([{ mode: 'structured', data: { done: false } }]);
    // Send child result → generator should throw (maxRounds exhausted)
    let threw = false;
    try {
      await gen.next([CANNED_RESULT]);
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/maxRounds|exhausted/i);
    }
    expect(threw).toBe(true);
  });

  it('2b. default maxRounds=DEFAULT_MAX_ROUNDS (3) when omitted — always done=false', async () => {
    const factory = coalescingRunner(makeCoordinatorSpec(), {
      childRunner: makeChildRunner(),
    });

    const runner = factory();
    const ctx = makePlanContext({ task: { ...makePlanContext().task, id: 'task-coal' } });
    const gen = runner.plan(ctx);

    // Run rounds where each gen.next() sends the prev result and gets the next batch.
    // Pattern per round:
    //   1. gen.next() / gen.next([coordResult]) → get coordinator yield
    //   2. gen.next([coordResult]) → send coord result, get child batch yield
    //   3. gen.next([childResult]) → send child result, get next coordinator (or throw)
    //
    // After 3 rounds, step 3 should throw.
    for (let r = 1; r < DEFAULT_MAX_ROUNDS; r++) {
      // Start or advance: get coordinator
      if (r === 1) {
        await gen.next(); // first call: start generator
      }
      // Send coord result → get child batch
      await gen.next([{ mode: 'structured', data: { done: false } }]);
      // Send child result → get next coordinator
      await gen.next([CANNED_RESULT]);
    }
    // Round 3 (last): start with coordinator
    // Already got coordinator at end of round 2
    // Send coord result → get child batch
    await gen.next([{ mode: 'structured', data: { done: false } }]);
    // Send child result → should throw (maxRounds exhausted)
    let threw = false;
    try {
      await gen.next([CANNED_RESULT]);
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/maxRounds|exhausted/i);
    }
    expect(threw).toBe(true);
  });

  // ── 3. Child batches per round ─────────────────────────────────────────

  it('3a. child yields multiple batches per round', async () => {
    const childBatches = [[makeSpec('round1/batch0#1')], [makeSpec('round1/batch1#1')]];

    let callCount = 0;
    const factory = coalescingRunner(makeCoordinatorSpec(), {
      childRunner: () => {
        callCount++;
        return makeMockChild(childBatches);
      },
      maxRounds: 2,
    });

    const runner = factory();
    const ctx = makePlanContext({ task: { ...makePlanContext().task, id: 'task-coal' } });
    const gen = runner.plan(ctx);

    // Round 1: coordinator → child batch 0 → child batch 1
    await gen.next(); // get coordinator
    let next = await gen.next([{ mode: 'structured', data: { done: false } }]); // send coord result → get child batch 0
    expect((next.value as SessionSpec[])[0].id).toBe('round1/batch0#1');
    next = await gen.next([CANNED_RESULT]); // send child batch 0 result → get child batch 1
    expect((next.value as SessionSpec[])[0].id).toBe('round1/batch1#1');
    // eslint-disable-next-line no-useless-assignment
    next = await gen.next([CANNED_RESULT]); // send child batch 1 result → get round 2 coordinator

    // Round 2: coordinator done
    await gen.next([{ mode: 'structured', data: { done: true } }]);

    expect(callCount).toBe(1);
  });

  // ── 4. execute delegates to runScheduledSession ────────────────────────

  it('4a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const factory = coalescingRunner(makeCoordinatorSpec(), {
      childRunner: makeChildRunner(),
    });
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-coal/coordinator#1');
    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('4b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const factory = coalescingRunner(makeCoordinatorSpec(), {
      childRunner: makeChildRunner(),
    });
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-coal/coordinator#1');
    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 5. Factory creates fresh instances ─────────────────────────────────

  it('5. factory returns a new runner instance each call', async () => {
    const factory = coalescingRunner(makeCoordinatorSpec(), {
      childRunner: makeChildRunner(),
    });

    const runnerA = factory();
    const runnerB = factory();

    expect(runnerA).not.toBe(runnerB);
    expect(runnerA.plan).toBeInstanceOf(Function);
    expect(runnerA.execute).toBeInstanceOf(Function);
    expect(runnerB.plan).toBeInstanceOf(Function);
    expect(runnerB.execute).toBeInstanceOf(Function);
  });
});
