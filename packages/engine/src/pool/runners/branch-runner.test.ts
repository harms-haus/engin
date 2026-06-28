// ─── Tests for runners/branch-runner.ts (SessionPlan contract) ──────────
//
// Tests verify:
//   1. First matching condition → its runner's plan is delegated to
//   2. Remaining branches NOT evaluated after a match
//   3. Selected branch's plan yields batches, results are forwarded
//   4. No branch matches + default provided → default runner's plan used
//   5. No branch matches + no default → plan throws
//   6. Conditions evaluated in strict order
//   7. Async conditions (return Promise<boolean>) work correctly
//   8. execute() calls runScheduledSession and returns its result
//   9. Factory creates a fresh runner instance each call
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

import { branchRunner } from './branch-runner.js';

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('branchRunner (SessionPlan)', () => {
  // ── 1. First matching condition runs ────────────────────────────────────

  it('1a. first condition matches → its runner plan is delegated to', async () => {
    const branchABatch = [makeSpec('branch-a/spec#1')];
    const branchBBatch = [makeSpec('branch-b/spec#1')];

    const childA = makeMockChild([branchABatch]);
    const childB = makeMockChild([branchBBatch]);

    const factory = branchRunner({
      branches: [
        { condition: () => true, runner: childA },
        { condition: () => true, runner: childB },
      ],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Should yield branch A's batch
    const first = await gen.next();
    expect(first.done).toBe(false);
    const batch = first.value as SessionSpec[];
    expect(batch[0].id).toBe('branch-a/spec#1');

    // Feed results back
    const done = await gen.next([CANNED_RESULT]);
    expect(done.done).toBe(true);
  });

  it('1b. second runner NOT invoked when first matches', async () => {
    const childA = makeMockChild([[makeSpec('a#1')]]);
    let childBPlanStarted = false;

    const childB = makeMockChild([]);
    // Track whether childB's plan generator was ever entered
    const childBGen = childB.plan(makePlanContext());
    const originalNext = childBGen.next.bind(childBGen);
    childBGen.next = async (...args: Parameters<typeof originalNext>) => {
      childBPlanStarted = true;
      return originalNext(...args);
    };
    childB.plan = () => childBGen;

    const factory = branchRunner({
      branches: [
        { condition: () => true, runner: childA },
        { condition: () => true, runner: childB },
      ],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next();
    await gen.next([CANNED_RESULT]);

    expect(childBPlanStarted).toBe(false);
  });

  it('1c. selected branch receives the correct SessionPlanContext', async () => {
    let capturedCtx: SessionPlanContext | undefined;

    const childA: SessionPlanRunner = {
      // eslint-disable-next-line require-yield
      plan: async function* plan(ctx: SessionPlanContext) {
        capturedCtx = ctx;
        return undefined;
      },
      execute: async () => CANNED_RESULT,
    };

    const factory = branchRunner({
      branches: [{ condition: () => true, runner: childA }],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next();

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.task.id).toBe('task-abc');
  });

  // ── 2. Selected branch yields batches ─────────────────────────────────

  it('2a. selected branch yields batches that are re-yielded', async () => {
    const childBatch = [makeSpec('selected/spec#1'), makeSpec('selected/spec#2')];
    const child = makeMockChild([childBatch]);

    const factory = branchRunner({
      branches: [{ condition: () => true, runner: child }],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect(first.done).toBe(false);
    const batch = first.value as SessionSpec[];
    expect(batch).toHaveLength(2);
    expect(batch[0].id).toBe('selected/spec#1');
    expect(batch[1].id).toBe('selected/spec#2');
  });

  it('2b. results are forwarded to the selected branch', async () => {
    const childResults: SessionResult[][] = [];
    const child = makeMockChild([[makeSpec('selected/spec#1')]], childResults);

    const factory = branchRunner({
      branches: [{ condition: () => true, runner: child }],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next();

    const result: SessionResult = { mode: 'text', text: 'forwarded result' };
    await gen.next([result]);

    expect(childResults).toHaveLength(1);
    expect(childResults[0]).toEqual([result]);
  });

  it('2c. selected branch with multiple batches works', async () => {
    const childBatches = [[makeSpec('batch0#1')], [makeSpec('batch1#1')]];
    const child = makeMockChild(childBatches);

    const factory = branchRunner({
      branches: [{ condition: () => true, runner: child }],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Batch 0
    const b0 = await gen.next();
    expect((b0.value as SessionSpec[])[0].id).toBe('batch0#1');

    // Batch 1
    const b1 = await gen.next([CANNED_RESULT]);
    expect((b1.value as SessionSpec[])[0].id).toBe('batch1#1');

    // Done
    const done = await gen.next([CANNED_RESULT]);
    expect(done.done).toBe(true);
  });

  // ── 3. No match + default → default runs ───────────────────────────────

  it('3. no matching branch + default provided → default plan is delegated to', async () => {
    const defaultBatch = [makeSpec('default/spec#1')];
    const defaultChild = makeMockChild([defaultBatch]);

    const factory = branchRunner({
      branches: [
        { condition: () => false, runner: makeMockChild([]) },
        { condition: () => false, runner: makeMockChild([]) },
      ],
      default: defaultChild,
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect(first.done).toBe(false);
    const batch = first.value as SessionSpec[];
    expect(batch[0].id).toBe('default/spec#1');

    const done = await gen.next([CANNED_RESULT]);
    expect(done.done).toBe(true);
  });

  it('3b. default runner with multiple batches works', async () => {
    const defaultBatches = [[makeSpec('default/batch0#1')], [makeSpec('default/batch1#1')]];
    const defaultChild = makeMockChild(defaultBatches);

    const factory = branchRunner({
      branches: [{ condition: () => false, runner: makeMockChild([]) }],
      default: defaultChild,
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const b0 = await gen.next();
    expect((b0.value as SessionSpec[])[0].id).toBe('default/batch0#1');
    const b1 = await gen.next([CANNED_RESULT]);
    expect((b1.value as SessionSpec[])[0].id).toBe('default/batch1#1');
    const done = await gen.next([CANNED_RESULT]);
    expect(done.done).toBe(true);
  });

  // ── 4. No match + no default → throws ─────────────────────────────────

  it('4. no matching branch + no default → plan throws "No branch matched"', async () => {
    const factory = branchRunner({
      branches: [{ condition: () => false, runner: makeMockChild([]) }],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    let threw = false;
    try {
      // The generator should throw when started and no branch matches
      await gen.next();
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/no branch matched/i);
    }
    expect(threw).toBe(true);
  });

  // ── 5. Conditions evaluated in order ───────────────────────────────────

  it('5a. conditions evaluated in order; first match stops evaluation', async () => {
    const evalOrder: number[] = [];

    const childA = makeMockChild([[makeSpec('a#1')]]);
    const childB = makeMockChild([[makeSpec('b#1')]]);

    const factory = branchRunner({
      branches: [
        {
          condition: () => {
            evalOrder.push(0);
            return true;
          },
          runner: childA,
        },
        {
          condition: () => {
            evalOrder.push(1);
            return true;
          },
          runner: childB,
        },
      ],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next();
    await gen.next([CANNED_RESULT]);

    expect(evalOrder).toEqual([0]);
  });

  it('5b. when first condition is false, second is evaluated and its runner runs', async () => {
    const evalOrder: number[] = [];

    const childA = makeMockChild([[makeSpec('a#1')]]);
    const childB = makeMockChild([[makeSpec('b#1')]]);

    const factory = branchRunner({
      branches: [
        {
          condition: () => {
            evalOrder.push(0);
            return false;
          },
          runner: childA,
        },
        {
          condition: () => {
            evalOrder.push(1);
            return true;
          },
          runner: childB,
        },
      ],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect((first.value as SessionSpec[])[0].id).toBe('b#1');
    await gen.next([CANNED_RESULT]);

    expect(evalOrder).toEqual([0, 1]);
  });

  // ── 6. Async conditions ────────────────────────────────────────────────

  it('6a. async condition (returns Promise<true>) → matching runner executes', async () => {
    const child = makeMockChild([[makeSpec('async-match/spec#1')]]);

    const factory = branchRunner({
      branches: [
        {
          condition: async () => {
            await delay(5);
            return true;
          },
          runner: child,
        },
      ],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect((first.value as SessionSpec[])[0].id).toBe('async-match/spec#1');
  });

  it('6b. async conditions evaluated in order; first match stops further evaluation', async () => {
    const evalOrder: number[] = [];

    const childA = makeMockChild([[makeSpec('a#1')]]);
    const childB = makeMockChild([[makeSpec('b#1')]]);

    const factory = branchRunner({
      branches: [
        {
          condition: async () => {
            evalOrder.push(0);
            await delay(5);
            return true;
          },
          runner: childA,
        },
        {
          condition: async () => {
            evalOrder.push(1);
            return true;
          },
          runner: childB,
        },
      ],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next();
    await gen.next([CANNED_RESULT]);

    expect(evalOrder).toEqual([0]);
  });

  it('6c. async condition returning false → continues to next branch', async () => {
    const childB = makeMockChild([[makeSpec('b#1')]]);

    const factory = branchRunner({
      branches: [
        {
          condition: async () => {
            await delay(5);
            return false;
          },
          runner: makeMockChild([]),
        },
        {
          condition: () => true,
          runner: childB,
        },
      ],
    });

    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect((first.value as SessionSpec[])[0].id).toBe('b#1');
  });

  // ── 7. execute delegates to runScheduledSession ────────────────────────

  it('7a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const factory = branchRunner({
      branches: [{ condition: () => true, runner: makeMockChild([]) }],
    });
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-abc/branch#1');
    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('7b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const factory = branchRunner({
      branches: [{ condition: () => true, runner: makeMockChild([]) }],
    });
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeSpec('task-abc/branch#1');
    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 8. Factory creates fresh instances ─────────────────────────────────

  it('8. factory returns a new runner instance each call', async () => {
    const factory = branchRunner({
      branches: [{ condition: () => true, runner: makeMockChild([]) }],
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
