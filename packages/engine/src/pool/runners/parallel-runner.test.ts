// ─── Tests for runners/parallel-runner.ts (SessionPlan contract) ─────
//
// Tests verify:
//   1. plan() yields a combined batch containing all children's first batches
//   2. Results are split by child and forwarded back via childGen.next(results)
//   3. A child whose plan is exhausted (done) is skipped
//   4. Empty children list → plan generator returns immediately
//   5. execute() calls runScheduledSession and returns its result
//   6. Factory creates a fresh runner instance each call
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

import { parallelRunner } from './parallel-runner.js';

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

// ─── Tests ────────────────────────────────────────────────────────────────

describe('parallelRunner (SessionPlan)', () => {
  // ── 1. plan yields concatenated batch from children ─────────────────

  it('1a. plan yields combined batch from two children (one batch each)', async () => {
    const child0Batch = [makeSpec('child0/spec0#1'), makeSpec('child0/spec1#1')];
    const child1Batch = [makeSpec('child1/spec0#1')];
    const child0 = makeMockChild([child0Batch]);
    const child1 = makeMockChild([child1Batch]);

    const factory = parallelRunner([child0, child1]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect(first.done).toBe(false);
    const batch = first.value as SessionSpec[];
    expect(batch).toHaveLength(3);
    expect(batch[0].id).toBe('child0/spec0#1');
    expect(batch[1].id).toBe('child0/spec1#1');
    expect(batch[2].id).toBe('child1/spec0#1');
  });

  it('1b. plan yields specs from all children in order', async () => {
    const child0Batch = [makeSpec('a#1')];
    const child1Batch = [makeSpec('b#1')];
    const child2Batch = [makeSpec('c#1')];
    const child0 = makeMockChild([child0Batch]);
    const child1 = makeMockChild([child1Batch]);
    const child2 = makeMockChild([child2Batch]);

    const factory = parallelRunner([child0, child1, child2]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    const batch = first.value as SessionSpec[];
    expect(batch).toHaveLength(3);
    expect(batch[0].id).toBe('a#1');
    expect(batch[1].id).toBe('b#1');
    expect(batch[2].id).toBe('c#1');
  });

  it('1c. single child with multiple specs yields all in one batch', async () => {
    const childBatch = [makeSpec('s0#1'), makeSpec('s1#1'), makeSpec('s2#1')];
    const child = makeMockChild([childBatch]);

    const factory = parallelRunner([child]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect(first.done).toBe(false);
    const batch = first.value as SessionSpec[];
    expect(batch).toHaveLength(3);
  });

  // ── 2. Results split and forwarded back ─────────────────────────────

  it('2a. results are split by child batch size and forwarded back', async () => {
    const child0Results: SessionResult[][] = [];
    const child1Results: SessionResult[][] = [];

    const child0Batch = [makeSpec('c0/s0#1'), makeSpec('c0/s1#1')];
    const child1Batch = [makeSpec('c1/s0#1')];
    const child0 = makeMockChild([child0Batch], child0Results);
    const child1 = makeMockChild([child1Batch], child1Results);

    const factory = parallelRunner([child0, child1]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Get the combined batch
    await gen.next();

    // Feed results back (2 specs for child0, 1 for child1)
    const r0: SessionResult = { mode: 'text', text: 'r0' };
    const r1: SessionResult = { mode: 'text', text: 'r1' };
    const r2: SessionResult = { mode: 'text', text: 'r2' };
    const done = await gen.next([r0, r1, r2]);

    expect(done.done).toBe(true);

    // Child0 should have received its 2 results
    expect(child0Results).toHaveLength(1);
    expect(child0Results[0]).toEqual([r0, r1]);

    // Child1 should have received its 1 result
    expect(child1Results).toHaveLength(1);
    expect(child1Results[0]).toEqual([r2]);
  });

  it('2b. empty results array is forwarded correctly', async () => {
    const child0Results: SessionResult[][] = [];
    const child0Batch: SessionSpec[] = [];
    const child0 = makeMockChild([child0Batch], child0Results);

    const factory = parallelRunner([child0]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Get the combined batch (empty)
    const first = await gen.next();
    expect(first.value as SessionSpec[]).toHaveLength(0);

    // Feed empty results
    const done = await gen.next([]);
    expect(done.done).toBe(true);
    expect(child0Results).toHaveLength(1);
    expect(child0Results[0]).toEqual([]);
  });

  it('2c. child with 0-spec batch receives correct empty slice', async () => {
    const child0Results: SessionResult[][] = [];
    const child1Results: SessionResult[][] = [];

    const child0 = makeMockChild([[makeSpec('c0#1')]], child0Results);
    const child1 = makeMockChild([[]], child1Results); // empty batch

    const factory = parallelRunner([child0, child1]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next();
    const done = await gen.next([CANNED_RESULT]);

    expect(done.done).toBe(true);
    // Child0 got 1 result
    expect(child0Results).toHaveLength(1);
    expect(child0Results[0]).toEqual([CANNED_RESULT]);
    // Child1 got 0 results
    expect(child1Results).toHaveLength(1);
    expect(child1Results[0]).toEqual([]);
  });

  // ── 3. Child with exhausted plan is skipped ────────────────────────

  it('3a. child whose plan returns immediately (done) is skipped', async () => {
    const child0Results: SessionResult[][] = [];
    const child1Results: SessionResult[][] = [];

    // Child0 has a normal first batch
    const child0 = makeMockChild([[makeSpec('c0#1')]], child0Results);

    // Child1's plan is immediately exhausted (yields nothing)
    const child1WithTracker: SessionPlanRunner = {
      // eslint-disable-next-line require-yield
      plan: async function* (): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        return undefined;
      },
      execute: async () => CANNED_RESULT,
    };

    // Use the simpler approach - just verify child0 is the only contributor
    const factory = parallelRunner([child0, child1WithTracker]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    const batch = first.value as SessionSpec[];
    // Only child0 contributed specs
    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe('c0#1');

    // Feed results back
    const done = await gen.next([CANNED_RESULT]);
    expect(done.done).toBe(true);
    // Child0 got its result
    expect(child0Results).toHaveLength(1);
    expect(child0Results[0]).toEqual([CANNED_RESULT]);
  });

  it('3b. all children exhausted → empty combined batch', async () => {
    const exhaustedChild: SessionPlanRunner = {
      // eslint-disable-next-line require-yield
      plan: async function* (): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        return undefined;
      },
      execute: async () => CANNED_RESULT,
    };

    const factory = parallelRunner([exhaustedChild, exhaustedChild]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value as SessionSpec[]).toHaveLength(0);

    const done = await gen.next([]);
    expect(done.done).toBe(true);
  });

  // ── 4. Empty children list ─────────────────────────────────────────

  it('4. empty children list → plan yields empty batch then returns', async () => {
    const factory = parallelRunner([]);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // First yield: empty combined batch (no children to contribute)
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value as SessionSpec[]).toHaveLength(0);

    // Feed results back and finish
    const done = await gen.next([]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 5. execute delegates to runScheduledSession ────────────────────

  it('5a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const child0 = makeMockChild([[makeSpec('c0#1')]]);
    const factory = parallelRunner([child0]);
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-abc/executor#1');
    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('5b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const child0 = makeMockChild([[makeSpec('c0#1')]]);
    const factory = parallelRunner([child0]);
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-abc/executor#1');
    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 6. Factory creates fresh instances ─────────────────────────────

  it('6. factory returns a new runner instance each call', async () => {
    const child0 = makeMockChild([[makeSpec('c0#1')]]);
    const factory = parallelRunner([child0]);

    const runnerA = factory();
    const runnerB = factory();

    expect(runnerA).not.toBe(runnerB);
    expect(runnerA.plan).toBeInstanceOf(Function);
    expect(runnerA.execute).toBeInstanceOf(Function);
  });
});
