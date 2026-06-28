// ─── Tests for runners/coordinator-runner.ts (SessionPlan contract) ──────
//
// Tests verify:
//   1. plan() yields coordinator spec first, then child batches
//   2. childRunner receives the coordinator SessionResult from yield return
//   3. Coordinator + child specs → totalSessions grows dynamically
//   4. execute() calls runScheduledSession and returns its result
//   5. Factory creates a fresh runner instance each call
//   6. Empty child plan (no specs yielded) still completes cleanly
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

import { coordinatorRunner } from './coordinator-runner.js';

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

/** Build a coordinator SessionSpec. */
function makeCoordinatorSpec(overrides?: Partial<SessionSpec>): SessionSpec {
  return {
    id: 'task-abc/coordinator#1',
    profile: 'coordinator',
    prompt: 'Plan the work',
    outputMode: 'structured',
    runnerRole: 'coordinator',
    attempt: 1,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('coordinatorRunner (SessionPlan)', () => {
  // ── 1. plan yields coordinator first, then child batches ────────────────

  it('1a. yields coordinator spec first, then child batches', async () => {
    const childBatch = [makeSpec('child/spec#1')];
    const childRunnerFactoryResults: SessionResult[] = [];

    const factory = coordinatorRunner(makeCoordinatorSpec(), {
      childRunner: (coordResult: SessionResult) => {
        childRunnerFactoryResults.push(coordResult);
        return makeMockChild([childBatch]);
      },
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // First yield: coordinator spec
    const first = await gen.next();
    expect(first.done).toBe(false);
    const batch0 = first.value as SessionSpec[];
    expect(batch0).toHaveLength(1);
    expect(batch0[0].id).toBe('task-abc/coordinator#1');

    // Feed coordinator result back → child runner should be called
    const coordResult: SessionResult = { mode: 'structured', data: { children: ['task A'] } };
    const second = await gen.next([coordResult]);
    expect(second.done).toBe(false);
    const batch1 = second.value as SessionSpec[];
    expect(batch1).toBe(childBatch);
    expect(batch1[0].id).toBe('child/spec#1');

    // Feed child result back → done
    const third = await gen.next([CANNED_RESULT]);
    expect(third.done).toBe(true);
    expect(third.value).toBeUndefined();
  });

  it('1b. childRunner receives the coordinator SessionResult', async () => {
    const childRunnerFactoryResults: SessionResult[] = [];

    const factory = coordinatorRunner(makeCoordinatorSpec(), {
      childRunner: (coordResult: SessionResult) => {
        childRunnerFactoryResults.push(coordResult);
        return makeMockChild([]);
      },
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Get coordinator batch
    await gen.next();

    // Feed coordinator result
    const coordResult: SessionResult = { mode: 'structured', data: { children: ['task A', 'task B'] } };
    await gen.next([coordResult]);

    expect(childRunnerFactoryResults).toHaveLength(1);
    expect(childRunnerFactoryResults[0]).toBe(coordResult);
  });

  it('1c. coordinator + child specs are yielded in order (totalSessions grows)', async () => {
    const childBatch = [makeSpec('child/spec0#1'), makeSpec('child/spec1#1')];

    const factory = coordinatorRunner(makeCoordinatorSpec(), {
      childRunner: () => makeMockChild([childBatch]),
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Coordinator spec
    const b0 = await gen.next();
    expect(b0.value as SessionSpec[]).toHaveLength(1);

    // Child specs (2)
    const b1 = await gen.next([CANNED_RESULT]);
    expect(b1.value as SessionSpec[]).toHaveLength(2);

    // Done
    const done = await gen.next([CANNED_RESULT, CANNED_RESULT]);
    expect(done.done).toBe(true);

    // Total yielded: 1 coordinator + 2 children = 3 specs
    let totalSpecs = 0;
    const gen2 = runner.plan(ctx);
    const firstAgain = await gen2.next();
    totalSpecs += (firstAgain.value as SessionSpec[]).length;
    const secondAgain = await gen2.next([CANNED_RESULT]);
    totalSpecs += (secondAgain.value as SessionSpec[]).length;
    expect(totalSpecs).toBe(3);
  });

  // ── 2. Child with multiple batches ────────────────────────────────────

  it('2a. child yields multiple batches → all are forwarded', async () => {
    const childBatches = [[makeSpec('child/batch0#1')], [makeSpec('child/batch1#1')]];

    const factory = coordinatorRunner(makeCoordinatorSpec(), {
      childRunner: () => makeMockChild(childBatches),
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Coordinator
    await gen.next();

    // Child batch 0
    const b0 = await gen.next([CANNED_RESULT]);
    expect((b0.value as SessionSpec[])[0].id).toBe('child/batch0#1');

    // Child batch 1
    const b1 = await gen.next([CANNED_RESULT]);
    expect((b1.value as SessionSpec[])[0].id).toBe('child/batch1#1');

    // Done
    const done = await gen.next([CANNED_RESULT]);
    expect(done.done).toBe(true);
  });

  it('2b. child with empty plan (no batches) → completes after coordinator', async () => {
    const factory = coordinatorRunner(makeCoordinatorSpec(), {
      childRunner: () => makeMockChild([]),
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Coordinator
    await gen.next();

    // Feed coordinator result → child yields nothing → done
    const done = await gen.next([CANNED_RESULT]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 3. Results forwarded to child ──────────────────────────────────────

  it('3. child receives results forwarded via gen.next', async () => {
    const childResults: SessionResult[][] = [];
    const childBatch = [makeSpec('child/spec#1')];
    const child = makeMockChild([childBatch], childResults);

    const factory = coordinatorRunner(makeCoordinatorSpec(), {
      childRunner: () => child,
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Coordinator
    await gen.next();

    // Feed coordinator result + child results
    const coordResult: SessionResult = { mode: 'structured', data: { done: false } };
    const childResult: SessionResult = { mode: 'text', text: 'child output' };
    await gen.next([coordResult]); // this triggers child to yield its batch
    await gen.next([childResult]); // feed child result back

    expect(childResults).toHaveLength(1);
    expect(childResults[0]).toEqual([childResult]);
  });

  // ── 4. execute delegates to runScheduledSession ────────────────────────

  it('4a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const factory = coordinatorRunner(makeCoordinatorSpec(), {
      childRunner: () => makeMockChild([]),
    });
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-abc/coordinator#1');
    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('4b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const factory = coordinatorRunner(makeCoordinatorSpec(), {
      childRunner: () => makeMockChild([]),
    });
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-abc/coordinator#1');
    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 5. Factory creates fresh instances ─────────────────────────────────

  it('5. factory returns a new runner instance each call', async () => {
    const factory = coordinatorRunner(makeCoordinatorSpec(), {
      childRunner: () => makeMockChild([]),
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
