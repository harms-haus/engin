// ─── Tests for runners/linear-runner.ts (SessionPlan contract) ───────────
//
// Tests verify:
//   1. plan() yields child batches in strict order (child1 batch, then child2)
//   2. Results are forwarded back to children via gen.next(results)
//   3. execute() calls runScheduledSession and returns its result
//   4. The factory creates a fresh runner instance each call
//   5. Empty children list → plan generator returns immediately
//
// Mock strategy:
//   - Shared mock via `test-fixtures.ts` → `mockRunScheduledSession`
//   - Mock child SessionPlanRunners are constructed inline to control yield
//     behavior and track result forwarding.

import { describe, expect, it } from 'bun:test';
import type { SessionResult, SessionSpec } from '../session.js';
import type { SessionPlanContext, SessionPlanRunner } from './session-plan-types.js';
import {
  CANNED_RESULT,
  makePlanContext,
  mockRunScheduledSession,
  setupRunScheduledSessionMock,
} from './test-fixtures.js';

// ─── Import module under test ────────────────────────────────────────────

import { linearRunner } from './linear-runner.js';

// ─── Mock wiring ─────────────────────────────────────────────────────────

setupRunScheduledSessionMock();

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a mock SessionPlanRunner whose plan yields the given batches in order.
 *
 * Each batch is a `SessionSpec[]`. When the scheduler feeds results back via
 * `gen.next(results)`, the calls are recorded in `receivedResults`.
 *
 * @param batches - Batches to yield, one per yield.
 * @param receivedResults - Optional array to collect results fed back.
 * @param planReturns - Optional value for the generator's return (defaults to `undefined`).
 */
function makeMockChild(
  batches: SessionSpec[][],
  receivedResults?: SessionResult[][],
  planReturns?: SessionResult[],
): SessionPlanRunner {
  return {
    plan(_ctx: SessionPlanContext): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
      const gen = (async function* (): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        for (const batch of batches) {
          const results: SessionResult[] = yield batch;
          receivedResults?.push(results);
        }
        return planReturns as SessionResult[] | undefined;
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

// ─── Tests ────────────────────────────────────────────────────────────────

describe('linearRunner (SessionPlan)', () => {
  // ── 1. plan yields child batches in order ─────────────────────────────

  it('1a. yields child0 batch, then child1 batch (two children, one batch each)', async () => {
    const child0Batch = [makeSpec('child0/spec#1')];
    const child1Batch = [makeSpec('child1/spec#1')];

    const child0 = makeMockChild([child0Batch]);
    const child1 = makeMockChild([child1Batch]);

    const factory = linearRunner([child0, child1]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // First yield should come from child0
    const first = await gen.next();
    expect(first.done).toBe(false);
    const batch0 = first.value as SessionSpec[];
    expect(batch0).toBe(child0Batch);
    expect(batch0[0].id).toBe('child0/spec#1');

    // Advance child0 by feeding results
    const second = await gen.next([CANNED_RESULT]);
    expect(second.done).toBe(false);
    const batch1 = second.value as SessionSpec[];
    expect(batch1).toBe(child1Batch);
    expect(batch1[0].id).toBe('child1/spec#1');

    // Advance child1 by feeding results — generator should be done
    const third = await gen.next([CANNED_RESULT]);
    expect(third.done).toBe(true);
    expect(third.value).toBeUndefined();
  });

  it('1b. yields batches from one child before moving to the next (multi-batch child)', async () => {
    const child0Batches = [[makeSpec('child0/batch0#1')], [makeSpec('child0/batch1#1')]];
    const child1Batch = [makeSpec('child1/batch0#1')];

    const child0 = makeMockChild(child0Batches);
    const child1 = makeMockChild([child1Batch]);

    const factory = linearRunner([child0, child1]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // child0 batch 0
    const b0 = await gen.next();
    expect(b0.done).toBe(false);
    const batch0 = b0.value as SessionSpec[];
    expect(batch0[0].id).toBe('child0/batch0#1');

    // child0 batch 1
    const b1 = await gen.next([CANNED_RESULT]);
    expect(b1.done).toBe(false);
    const batch1 = b1.value as SessionSpec[];
    expect(batch1[0].id).toBe('child0/batch1#1');

    // child1 batch 0
    const b2 = await gen.next([CANNED_RESULT]);
    expect(b2.done).toBe(false);
    const batch2 = b2.value as SessionSpec[];
    expect(batch2[0].id).toBe('child1/batch0#1');

    // done
    const done = await gen.next([CANNED_RESULT]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  it('1c. yields batches in order using a record of yields', async () => {
    const yieldOrder: string[] = [];

    const child0Batch = [makeSpec('child0/spec#1')];
    const child1Batch = [makeSpec('child1/spec#1')];

    const child0: SessionPlanRunner = {
      plan: async function* () {
        yieldOrder.push('plan child0');
        const results: SessionResult[] = yield child0Batch;
        yieldOrder.push(`child0 got ${results.length} result(s)`);
        return undefined;
      },
      execute: async () => CANNED_RESULT,
    };

    const child1: SessionPlanRunner = {
      plan: async function* () {
        yieldOrder.push('plan child1');
        const results: SessionResult[] = yield child1Batch;
        yieldOrder.push(`child1 got ${results.length} result(s)`);
        return undefined;
      },
      execute: async () => CANNED_RESULT,
    };

    const factory = linearRunner([child0, child1]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Start
    const b0 = await gen.next();
    expect((b0.value as SessionSpec[])[0].id).toBe('child0/spec#1');

    // Feed results for child0
    const b1 = await gen.next([CANNED_RESULT]);
    expect((b1.value as SessionSpec[])[0].id).toBe('child1/spec#1');

    // Feed results for child1
    const done = await gen.next([CANNED_RESULT]);
    expect(done.done).toBe(true);

    expect(yieldOrder).toEqual(['plan child0', 'child0 got 1 result(s)', 'plan child1', 'child1 got 1 result(s)']);
  });

  // ── 2. Results forward back to children ──────────────────────────────

  it('2. results are forwarded back to children via gen.next(results)', async () => {
    const child0Results: SessionResult[][] = [];
    const child1Results: SessionResult[][] = [];

    const child0Batch = [makeSpec('child0/spec#1')];
    const child1Batch = [makeSpec('child1/spec#1')];

    const child0 = makeMockChild([child0Batch], child0Results);
    const child1 = makeMockChild([child1Batch], child1Results);

    const factory = linearRunner([child0, child1]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const result0: SessionResult = { mode: 'text', text: 'result0' };
    const result1: SessionResult = { mode: 'text', text: 'result1' };

    // Get child0's batch
    await gen.next();
    // Feed results for child0
    await gen.next([result0]);
    expect(child0Results).toHaveLength(1);
    expect(child0Results[0]).toEqual([result0]);

    // Feed results for child1
    await gen.next([result1]);
    expect(child1Results).toHaveLength(1);
    expect(child1Results[0]).toEqual([result1]);
  });

  it('2b. empty results array feeds back correctly', async () => {
    const child0Results: SessionResult[][] = [];

    const child0Batch = [makeSpec('child0/spec#1')];
    const child0 = makeMockChild([child0Batch], child0Results);

    const factory = linearRunner([child0]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next();
    await gen.next([]);
    expect(child0Results).toHaveLength(1);
    expect(child0Results[0]).toEqual([]);
  });

  // ── 3. execute delegates to runScheduledSession ──────────────────────

  it('3a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const child0 = makeMockChild([[makeSpec('child0/spec#1')]]);
    const factory = linearRunner([child0]);
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-abc/executor#1');
    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('3b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const child0 = makeMockChild([[makeSpec('child0/spec#1')]]);
    const factory = linearRunner([child0]);
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-abc/executor#1');
    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 4. Factory creates fresh instances ───────────────────────────────

  it('4. factory returns a new runner instance each call', async () => {
    const child0 = makeMockChild([[makeSpec('child0/spec#1')]]);
    const factory = linearRunner([child0]);

    const runnerA = factory();
    const runnerB = factory();

    expect(runnerA).not.toBe(runnerB);
    expect(runnerA.plan).toBeInstanceOf(Function);
    expect(runnerA.execute).toBeInstanceOf(Function);
  });

  // ── 5. Empty children list ──────────────────────────────────────────

  it('5. empty children list → plan generator yields nothing and returns immediately', async () => {
    const factory = linearRunner([]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const result = await gen.next();
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  // ── 6. Single child ─────────────────────────────────────────────────

  it('6. single child yields its batches and completes', async () => {
    const childBatch = [makeSpec('only/spec#1')];
    const child = makeMockChild([childBatch]);

    const factory = linearRunner([child]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value as SessionSpec[]).toBe(childBatch);

    const second = await gen.next([CANNED_RESULT]);
    expect(second.done).toBe(true);
    expect(second.value).toBeUndefined();
  });

  // ── 7. Early termination: child finally blocks run on .return() ─────

  it('7a. early .return() on the parent plan triggers child finally block (resource leak fix)', async () => {
    // Build a fake child whose plan has a try/finally spy. When the parent
    // generator is .return()'d early, delegateToChild's finally calls
    // childGen.return(), which must run the child's finally block.
    let finallyRan = false;

    const childBatch = [makeSpec('child0/spec#1')];
    const child: SessionPlanRunner = {
      plan: async function* (
        _ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        try {
          const results: SessionResult[] = yield childBatch;
          return results;
        } finally {
          finallyRan = true;
        }
      },
      execute: async () => CANNED_RESULT,
    };

    const factory = linearRunner([child]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Start the parent plan — this starts the child and yields its first batch.
    const first = await gen.next();
    expect(first.done).toBe(false);

    // Simulate the scheduler early-terminating the plan (e.g. cancellation).
    expect(finallyRan).toBe(false);
    await gen.return(undefined);

    // The child's finally block must have run — no resource leak.
    expect(finallyRan).toBe(true);
  });

  it('7b. early .return() runs finally blocks for multiple children (only active child)', async () => {
    // Only the currently-active child (child0) should have its finally run.
    // child1 has not been started yet, so its finally should NOT run.
    let child0FinallyRan = false;
    let child1FinallyRan = false;

    const child0: SessionPlanRunner = {
      plan: async function* (
        _ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        try {
          yield [makeSpec('child0/spec#1')];
          return undefined;
        } finally {
          child0FinallyRan = true;
        }
      },
      execute: async () => CANNED_RESULT,
    };

    const child1: SessionPlanRunner = {
      plan: async function* (
        _ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        try {
          yield [makeSpec('child1/spec#1')];
          return undefined;
        } finally {
          child1FinallyRan = true;
        }
      },
      execute: async () => CANNED_RESULT,
    };

    const factory = linearRunner([child0, child1]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Start — child0's first batch is yielded.
    await gen.next();

    // Early-terminate before child0 finishes.
    await gen.return(undefined);

    // child0 was active — its finally ran.
    expect(child0FinallyRan).toBe(true);
    // child1 was never started — its finally did not run.
    expect(child1FinallyRan).toBe(false);
  });
});
