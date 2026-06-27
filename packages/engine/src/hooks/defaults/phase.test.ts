// ─── Tests for hooks/defaults/phase.ts — phase-level default hooks ──────────
//
// These tests pin the FOUR default implementations for the phase-level hooks
// declared in hooks/types.ts (the "Phase level (influence) hooks" block):
//
//   1. defaultShouldRetryPhase       — FirstWinsHook<boolean | undefined, ShouldRetryPhaseArgs>
//        → true when the result signals retry-needed AND round < 3; otherwise
//          undefined (abstain). Recognizes BOTH the new `{ retry: true }`
//          shape AND the legacy `'scouting'` string jump-back signal for
//          backward compat with spir.ts.
//   2. defaultBeforePhaseTransition  — FirstWinsHook<PhaseTransition | undefined, BeforePhaseTransitionArgs>
//        → { type: 'advance' } (linear progression — the fallback when no
//          workflow hook overrides it).
//   3. defaultOnPhaseSettled         — AllRunHook<unknown, OnPhaseSettledArgs>
//        → contribution { [task.id]: task.result } for tasks with status
//          'complete'; the folded result is stored on
//          args.state[`${phaseId}Results`].
//   4. createDefaultAfterPhase(onSidebarUpdate?) — ObserveHook<AfterPhaseArgs>
//        → fires the captured `onSidebarUpdate` status callback (the sidebar
//          indicator update previously inlined in spir.ts's `completePhase`).
//          Implemented as a FACTORY because an ObserveHook<AfterPhaseArgs> has
//          no other channel to receive the StatusCallbacks.onSidebarUpdate
//          dependency (it is not on HookContext nor on AfterPhaseArgs).
//
// Plus the companion reducer added to hooks/reducers.ts:
//
//   5. PHASE_RESULTS_REDUCER — (acc, next) => ({ ...(acc ?? {}), ...next })
//        merges per-subscriber onPhaseSettled contribution objects.
//
// Module under test: ./phase.js (companion reducer: ../reducers.js)
//
// The test file is co-located with the source, so imports are relative to
// packages/engine/src/hooks/defaults/.
//
// NOTE: `./phase.js` does not exist yet — this is the write-tests step. The
// tests are RED until the implementation lands; they serve as the executable
// spec for phase.ts.

import { describe, expect, it } from 'bun:test';

import type { Task } from '../../core/types.js';
import { PHASE_RESULTS_REDUCER } from '../reducers.js';
import { createHookRegistry } from '../registry.js';
import type {
  AfterPhaseArgs,
  BeforePhaseTransitionArgs,
  HookContext,
  OnPhaseSettledArgs,
  PhaseTransition,
  ShouldRetryPhaseArgs,
  WorkflowHooks,
} from '../types.js';
import * as defaultsBarrel from './index.js';
import {
  createDefaultAfterPhase,
  defaultBeforePhaseTransition,
  defaultOnPhaseSettled,
  defaultShouldRetryPhase,
} from './phase.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/**
 * Minimal HookContext. `registry` defaults to a fresh, independent registry
 * (forwarded as a real value here even though direct-invocation tests don't
 * route through it). Mirrors makeCtx in registry.test.ts / workflow.test.ts /
 * worktree-defaults.test.ts.
 */
function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: createHookRegistry(),
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

/** A minimal Task fixture. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Do thing',
    prompt: 'implement feature X',
    profile: 'coder',
    files: [],
    dependencies: [],
    worktree: 'none',
    status: 'active',
    phaseId: 'code',
    ...overrides,
  };
}

/** A minimal ShouldRetryPhaseArgs fixture. */
function makeRetryArgs(overrides: Partial<ShouldRetryPhaseArgs> = {}): ShouldRetryPhaseArgs {
  return {
    phaseId: 'scouting',
    result: undefined,
    round: 1,
    state: {},
    ...overrides,
  };
}

/** A minimal OnPhaseSettledArgs fixture with a fresh state bag. */
function makeSettledArgs(
  overrides: Partial<Omit<OnPhaseSettledArgs, 'state'>> & {
    state?: Record<string, unknown>;
    tasks?: Task[];
    phaseId?: string;
  } = {},
): OnPhaseSettledArgs {
  return {
    phaseId: overrides.phaseId ?? 'scouting',
    tasks: overrides.tasks ?? [],
    state: overrides.state ?? {},
  };
}

/** A minimal BeforePhaseTransitionArgs fixture. */
function makeTransitionArgs(overrides: Partial<BeforePhaseTransitionArgs> = {}): BeforePhaseTransitionArgs {
  return {
    from: 'scouting',
    to: 'planning',
    state: {},
    ...overrides,
  };
}

/** A minimal AfterPhaseArgs fixture. */
function makeAfterArgs(overrides: Partial<AfterPhaseArgs> = {}): AfterPhaseArgs {
  return {
    phaseId: 'scouting',
    result: undefined,
    durationMs: 1234,
    ...overrides,
  };
}

// ── defaultShouldRetryPhase ─────────────────────────────────────────────────

describe('defaultShouldRetryPhase', () => {
  it('is a function (a FirstWinsHook)', () => {
    expect(typeof defaultShouldRetryPhase).toBe('function');
  });

  it('is assignable to WorkflowHooks.shouldRetryPhase (type-level + identity)', () => {
    const hooks: WorkflowHooks = { shouldRetryPhase: defaultShouldRetryPhase };
    expect(hooks.shouldRetryPhase).toBe(defaultShouldRetryPhase);
  });

  // ── { retry: true } shape (the generalized signal) ───────────────────────
  describe('result with { retry: true }', () => {
    it('returns true when round < 3 and result.retry === true', async () => {
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: { retry: true }, round: 1 }), makeCtx());
      expect(result).toBe(true);
    });

    it('returns true for round 2 (still below the 3-round ceiling)', async () => {
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: { retry: true }, round: 2 }), makeCtx());
      expect(result).toBe(true);
    });

    it('returns true for round 0 (round < 3 holds at the low boundary)', async () => {
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: { retry: true }, round: 0 }), makeCtx());
      expect(result).toBe(true);
    });

    it('returns undefined when round === 3 (ceiling reached — no more retries)', async () => {
      // round < 3 is false at round 3, so the default abstains even though the
      // result still signals retry. This is the historical ≤3-rounds bound.
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: { retry: true }, round: 3 }), makeCtx());
      expect(result).toBeUndefined();
    });

    it('returns undefined when round > 3 (above the ceiling)', async () => {
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: { retry: true }, round: 5 }), makeCtx());
      expect(result).toBeUndefined();
    });
  });

  // ── 'scouting' string (the legacy jump-back signal — backward compat) ─────
  describe("result === 'scouting' (legacy jump-back signal)", () => {
    it("returns true when round < 3 and result === 'scouting'", async () => {
      // For backward compat with spir.ts, the default also recognizes the old
      // 'scouting' string jump-back signal as a retry request.
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: 'scouting', round: 1 }), makeCtx());
      expect(result).toBe(true);
    });

    it("returns undefined when round === 3 even for the 'scouting' signal", async () => {
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: 'scouting', round: 3 }), makeCtx());
      expect(result).toBeUndefined();
    });
  });

  // ── non-retry results abstain ────────────────────────────────────────────
  describe('non-retry results', () => {
    it('returns undefined when result.retry === false', async () => {
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: { retry: false }, round: 1 }), makeCtx());
      expect(result).toBeUndefined();
    });

    it('returns undefined when result.retry is a truthy non-true value', async () => {
      // The contract is retry === true (strict). A truthy-but-not-true value
      // (e.g. 1, 'yes') must NOT trigger a retry.
      const a = await defaultShouldRetryPhase(makeRetryArgs({ result: { retry: 1 }, round: 1 }), makeCtx());
      const b = await defaultShouldRetryPhase(makeRetryArgs({ result: { retry: 'yes' }, round: 1 }), makeCtx());
      expect(a).toBeUndefined();
      expect(b).toBeUndefined();
    });

    it('returns undefined when result is an object without a retry field', async () => {
      const result = await defaultShouldRetryPhase(
        makeRetryArgs({ result: { summary: 'done', tasks: 3 }, round: 1 }),
        makeCtx(),
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined when result is a non-scouting string', async () => {
      // Only the 'scouting' jump-back signal is recognized; other strings are
      // ordinary results and must NOT trigger a retry.
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: 'planning', round: 1 }), makeCtx());
      expect(result).toBeUndefined();
    });

    it('returns undefined when result is undefined', async () => {
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: undefined, round: 1 }), makeCtx());
      expect(result).toBeUndefined();
    });

    it('returns undefined when result is null', async () => {
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: null, round: 1 }), makeCtx());
      expect(result).toBeUndefined();
    });

    it('returns undefined when result is a number', async () => {
      const result = await defaultShouldRetryPhase(makeRetryArgs({ result: 42, round: 1 }), makeCtx());
      expect(result).toBeUndefined();
    });
  });

  it('ignores the phaseId / state args (decision driven by result + round only)', async () => {
    const a = await defaultShouldRetryPhase(
      makeRetryArgs({ phaseId: 'scouting', state: {}, result: { retry: true }, round: 1 }),
      makeCtx(),
    );
    const b = await defaultShouldRetryPhase(
      makeRetryArgs({ phaseId: 'coding', state: { any: 'thing' }, result: { retry: true }, round: 1 }),
      makeCtx(),
    );
    expect(a).toBe(b);
    expect(a).toBe(true);
  });
});

// ── defaultBeforePhaseTransition ────────────────────────────────────────────

describe('defaultBeforePhaseTransition', () => {
  it('is a function (a FirstWinsHook)', () => {
    expect(typeof defaultBeforePhaseTransition).toBe('function');
  });

  it('is assignable to WorkflowHooks.beforePhaseTransition (type-level + identity)', () => {
    const hooks: WorkflowHooks = { beforePhaseTransition: defaultBeforePhaseTransition };
    expect(hooks.beforePhaseTransition).toBe(defaultBeforePhaseTransition);
  });

  it("returns { type: 'advance' } (linear progression — the default transition)", async () => {
    const result = await defaultBeforePhaseTransition(makeTransitionArgs(), makeCtx());
    expect(result).toEqual({ type: 'advance' });
  });

  it('returns a non-undefined value (wins in a first-wins composition)', async () => {
    const result = await defaultBeforePhaseTransition(makeTransitionArgs(), makeCtx());
    expect(result).toBeDefined();
  });

  it('does not set a target (advance has no jump target)', async () => {
    const result = await defaultBeforePhaseTransition(makeTransitionArgs(), makeCtx());
    expect(result).toEqual({ type: 'advance' });
    expect(result?.target).toBeUndefined();
  });

  it('satisfies the PhaseTransition type for the advance case', async () => {
    const result: PhaseTransition | undefined = await defaultBeforePhaseTransition(makeTransitionArgs(), makeCtx());
    // Type-level check compiles only when result is assignable; assert runtime too.
    expect(result?.type).toBe('advance');
  });

  it('returns the same transition regardless of from / to / state args', async () => {
    const a = await defaultBeforePhaseTransition(
      makeTransitionArgs({ from: 'scouting', to: 'planning', state: {} }),
      makeCtx(),
    );
    const b = await defaultBeforePhaseTransition(
      makeTransitionArgs({ from: 'coding', to: 'review', state: { x: 1 } }),
      makeCtx(),
    );
    expect(a).toEqual(b);
    expect(a).toEqual({ type: 'advance' });
  });
});

// ── defaultOnPhaseSettled ───────────────────────────────────────────────────

describe('defaultOnPhaseSettled', () => {
  it('is a function (an AllRunHook)', () => {
    expect(typeof defaultOnPhaseSettled).toBe('function');
  });

  it('is assignable to WorkflowHooks.onPhaseSettled (type-level + identity)', () => {
    const hooks: WorkflowHooks = { onPhaseSettled: defaultOnPhaseSettled };
    expect(hooks.onPhaseSettled).toBe(defaultOnPhaseSettled);
  });

  // ── contribution: { [task.id]: task.result } for complete tasks ──────────
  describe('contribution (return value)', () => {
    it('returns { [task.id]: task.result } for a single complete task', async () => {
      const tasks = [makeTask({ id: 't1', status: 'complete', result: { summary: 'scouted 3 files' } })];
      const result = await defaultOnPhaseSettled(makeSettledArgs({ tasks }), makeCtx());
      expect(result).toEqual({ t1: { summary: 'scouted 3 files' } });
    });

    it('maps every complete task id to its result', async () => {
      const tasks = [
        makeTask({ id: 't1', status: 'complete', result: 'r1' }),
        makeTask({ id: 't2', status: 'complete', result: { n: 2 } }),
        makeTask({ id: 't3', status: 'complete', result: ['a', 'b'] }),
      ];
      const result = await defaultOnPhaseSettled(makeSettledArgs({ tasks }), makeCtx());
      expect(result).toEqual({ t1: 'r1', t2: { n: 2 }, t3: ['a', 'b'] });
    });

    it('EXCLUDES tasks whose status is not complete', async () => {
      // Only 'complete' tasks contribute; ready / active / failed / cancelled
      // tasks are filtered out.
      const tasks = [
        makeTask({ id: 't-ready', status: 'ready', result: 'should-not-appear' }),
        makeTask({ id: 't-active', status: 'active', result: 'should-not-appear' }),
        makeTask({ id: 't-failed', status: 'failed', result: 'should-not-appear' }),
        makeTask({ id: 't-cancelled', status: 'cancelled', result: 'should-not-appear' }),
        makeTask({ id: 't-blocked', status: 'blocked', result: 'should-not-appear' }),
        makeTask({ id: 't-done', status: 'complete', result: 'appears' }),
      ];
      const result = await defaultOnPhaseSettled(makeSettledArgs({ tasks }), makeCtx());
      expect(result).toEqual({ 't-done': 'appears' });
    });

    it('captures a complete task whose result is undefined (key still present)', async () => {
      // A complete task may have no result payload; the id still maps to
      // undefined. toStrictEqual (NOT toEqual) is used because Jest/bun's
      // toEqual ignores undefined properties — so toEqual would pass even for
      // {} and fail to pin the key's presence.
      const tasks = [makeTask({ id: 't1', status: 'complete', result: undefined })];
      const result = await defaultOnPhaseSettled(makeSettledArgs({ tasks }), makeCtx());
      expect(result).toStrictEqual({ t1: undefined });
      expect(Object.keys(result as Record<string, unknown>)).toEqual(['t1']);
    });

    it('returns an empty object when there are no complete tasks', async () => {
      const tasks = [makeTask({ id: 't1', status: 'active' })];
      const result = await defaultOnPhaseSettled(makeSettledArgs({ tasks }), makeCtx());
      expect(result).toEqual({});
    });

    it('returns an empty object when args.tasks is empty', async () => {
      const result = await defaultOnPhaseSettled(makeSettledArgs({ tasks: [] }), makeCtx());
      expect(result).toEqual({});
    });
  });

  // ── side effect: folded result stored on args.state ─────────────────────
  describe('state storage (args.state[`${phaseId}Results`])', () => {
    it('stores the contribution on args.state[`${phaseId}Results`]', async () => {
      const state: Record<string, unknown> = { preexisting: true };
      const tasks = [
        makeTask({ id: 't1', status: 'complete', result: 'r1' }),
        makeTask({ id: 't2', status: 'complete', result: 'r2' }),
      ];
      await defaultOnPhaseSettled(makeSettledArgs({ phaseId: 'scouting', tasks, state }), makeCtx());
      expect(state['scoutingResults']).toEqual({ t1: 'r1', t2: 'r2' });
    });

    it('uses a different state key per phaseId', async () => {
      const state: Record<string, unknown> = {};
      await defaultOnPhaseSettled(
        makeSettledArgs({
          phaseId: 'scouting',
          tasks: [makeTask({ id: 's1', status: 'complete', result: 'sr' })],
          state,
        }),
        makeCtx(),
      );
      await defaultOnPhaseSettled(
        makeSettledArgs({
          phaseId: 'coding',
          tasks: [makeTask({ id: 'c1', status: 'complete', result: 'cr' })],
          state,
        }),
        makeCtx(),
      );
      expect(state['scoutingResults']).toEqual({ s1: 'sr' });
      expect(state['codingResults']).toEqual({ c1: 'cr' });
    });

    it('writes an empty object when no tasks are complete', async () => {
      const state: Record<string, unknown> = {};
      await defaultOnPhaseSettled(
        makeSettledArgs({ phaseId: 'p', tasks: [makeTask({ id: 't1', status: 'active' })], state }),
        makeCtx(),
      );
      expect(state['pResults']).toEqual({});
    });

    it('does NOT delete preexisting, unrelated state keys', async () => {
      const state: Record<string, unknown> = { keepMe: 'yes', otherResults: { x: 1 } };
      await defaultOnPhaseSettled(
        makeSettledArgs({
          phaseId: 'scouting',
          tasks: [makeTask({ id: 't1', status: 'complete', result: 'r' })],
          state,
        }),
        makeCtx(),
      );
      expect(state['keepMe']).toBe('yes');
      expect(state['otherResults']).toEqual({ x: 1 });
      expect(state['scoutingResults']).toEqual({ t1: 'r' });
    });

    it('the stored value matches the returned contribution', async () => {
      const state: Record<string, unknown> = {};
      const tasks = [
        makeTask({ id: 't1', status: 'complete', result: { a: 1 } }),
        makeTask({ id: 't2', status: 'complete', result: { b: 2 } }),
      ];
      const returned = await defaultOnPhaseSettled(makeSettledArgs({ phaseId: 'p', tasks, state }), makeCtx());
      expect(state['pResults']).toEqual(returned);
    });
  });
});

// ── PHASE_RESULTS_REDUCER (companion reducer in hooks/reducers.ts) ──────────

describe('PHASE_RESULTS_REDUCER', () => {
  it('is a function', () => {
    expect(typeof PHASE_RESULTS_REDUCER).toBe('function');
  });

  it('merges two contribution objects into one', () => {
    const merged = PHASE_RESULTS_REDUCER({ a: 1 } as Record<string, unknown>, { b: 2 });
    expect(merged).toEqual({ a: 1, b: 2 });
  });

  it('seeds from undefined (acc ?? {}): undefined + { a: 1 } = { a: 1 }', () => {
    // The registry seeds the accumulator with undefined; the reducer must treat
    // an undefined acc as an empty object.
    const merged = PHASE_RESULTS_REDUCER(undefined, { a: 1 });
    expect(merged).toEqual({ a: 1 });
  });

  it('returns an empty object when both acc and next are empty-ish', () => {
    expect(PHASE_RESULTS_REDUCER(undefined, {})).toEqual({});
  });

  it('later contributions WIN on key conflicts (shallow merge, next overrides)', () => {
    // ({ ...(acc ?? {}), ...next }) — next's keys override acc's.
    const merged = PHASE_RESULTS_REDUCER({ a: 1, b: 2 } as Record<string, unknown>, { b: 99, c: 3 });
    expect(merged).toEqual({ a: 1, b: 99, c: 3 });
  });

  it('folds a chain of contributions in order (registry contract)', () => {
    // The registry folds in subscriber order: acc = reducer(acc, contribution).
    let acc: unknown = undefined;
    for (const contribution of [{ a: 1 }, { b: 2 }, { c: 3, a: 9 }] as Record<string, unknown>[]) {
      acc = PHASE_RESULTS_REDUCER(acc, contribution);
    }
    expect(acc).toEqual({ a: 9, b: 2, c: 3 });
  });

  it('does NOT mutate the accumulator (returns a new object)', () => {
    const acc = { a: 1 } as Record<string, unknown>;
    const merged = PHASE_RESULTS_REDUCER(acc, { b: 2 });
    expect(merged).toEqual({ a: 1, b: 2 });
    // Original acc is untouched (no `b` key added in place).
    expect(acc).toEqual({ a: 1 });
    expect(merged).not.toBe(acc);
  });
});

// ── createDefaultAfterPhase ─────────────────────────────────────────────────
//
// Implemented as a FACTORY because an ObserveHook<AfterPhaseArgs> has no
// channel to receive the StatusCallbacks.onSidebarUpdate dependency — it is
// neither on HookContext nor on AfterPhaseArgs. Capturing it via a factory
// mirrors createDefaultOnPersist(tracker) / createDefaultOnRestore(workDir).

describe('createDefaultAfterPhase', () => {
  it('returns a function (an ObserveHook)', () => {
    const hook = createDefaultAfterPhase();
    expect(typeof hook).toBe('function');
  });

  it('is assignable to WorkflowHooks.afterPhase (type-level + identity)', () => {
    const hook = createDefaultAfterPhase();
    const hooks: WorkflowHooks = { afterPhase: hook };
    expect(hooks.afterPhase).toBe(hook);
  });

  it('accepts an onSidebarUpdate callback as the factory argument', () => {
    const calls: Array<{ title?: string; indicator?: string }> = [];
    const hook = createDefaultAfterPhase((info) => calls.push(info));
    expect(typeof hook).toBe('function');
  });

  it('fires the captured onSidebarUpdate callback exactly once per invocation', async () => {
    const calls: Array<{ title?: string; indicator?: string }> = [];
    const hook = createDefaultAfterPhase((info) => calls.push(info));

    await hook(makeAfterArgs({ phaseId: 'scouting' }), makeCtx());

    expect(calls).toHaveLength(1);
  });

  it('passes a meaningful payload (title and/or indicator) to the callback', async () => {
    const calls: Array<{ title?: string; indicator?: string }> = [];
    const hook = createDefaultAfterPhase((info) => calls.push(info));

    await hook(makeAfterArgs({ phaseId: 'scouting' }), makeCtx());

    const payload = calls[0];
    expect(payload).toBeDefined();
    // At least one of the sidebar fields must carry a non-empty string — a
    // bare {} update is pointless (the sidebar evolve handler patches only
    // defined fields).
    const hasTitle = typeof payload!.title === 'string' && payload!.title.length > 0;
    const hasIndicator = typeof payload!.indicator === 'string' && payload!.indicator.length > 0;
    expect(hasTitle || hasIndicator).toBe(true);
  });

  it('derives the fired info from args (different phaseId → different payload)', async () => {
    // Proves the hook reads args.phaseId rather than emitting a constant.
    const calls: Array<{ title?: string; indicator?: string }> = [];
    const hook = createDefaultAfterPhase((info) => calls.push(info));

    await hook(makeAfterArgs({ phaseId: 'scouting' }), makeCtx());
    await hook(makeAfterArgs({ phaseId: 'coding' }), makeCtx());

    expect(calls).toHaveLength(2);
    // The serialized payloads differ because they reflect different phaseIds.
    expect(JSON.stringify(calls[0])).not.toEqual(JSON.stringify(calls[1]));
    // And each payload carries its own phaseId somewhere in the fired info.
    expect(JSON.stringify(calls[0])).toContain('scouting');
    expect(JSON.stringify(calls[1])).toContain('coding');
  });

  it('does not throw when no onSidebarUpdate callback is supplied (graceful no-op)', async () => {
    const hook = createDefaultAfterPhase();
    await expect(hook(makeAfterArgs({ phaseId: 'scouting' }), makeCtx())).resolves.toBeUndefined();
  });

  it('does not throw when the captured callback is undefined', async () => {
    const hook = createDefaultAfterPhase(undefined);
    await expect(hook(makeAfterArgs({ phaseId: 'scouting' }), makeCtx())).resolves.toBeUndefined();
  });

  it('resolves undefined (observe hooks have no return value)', async () => {
    const hook = createDefaultAfterPhase(() => {});
    const result = await hook(makeAfterArgs({ phaseId: 'scouting' }), makeCtx());
    expect(result).toBeUndefined();
  });

  it('does not mutate the args', async () => {
    const hook = createDefaultAfterPhase(() => {});
    const args = makeAfterArgs({ phaseId: 'scouting', result: { x: 1 }, durationMs: 99 });
    await hook(args, makeCtx());
    expect(args.phaseId).toBe('scouting');
    expect(args.result).toEqual({ x: 1 });
    expect(args.durationMs).toBe(99);
  });
});

// ── Defaults compose through the HookRegistry ───────────────────────────────
//
// These verify the defaults satisfy their declared composition rule when wired
// into a real HookRegistry (the engine's invocation path). `WorkflowHooks`
// already declares these fields, so the hook-name literals typecheck without
// the `as never` cast the mechanism-only registry tests needed.

describe('defaults compose through the HookRegistry', () => {
  it('shouldRetryPhase: default decision wins via invokeFirstWins (retry signalled)', async () => {
    const reg = createHookRegistry();
    reg.defineHook('shouldRetryPhase', 'first-wins');
    reg.register({ shouldRetryPhase: defaultShouldRetryPhase });

    const result = await reg.invokeFirstWins(
      'shouldRetryPhase',
      makeRetryArgs({ result: { retry: true }, round: 1 }),
      makeCtx({ registry: reg }),
    );

    expect(result).toBe(true);
  });

  it('shouldRetryPhase: default abstains (undefined) when round hits the ceiling', async () => {
    const reg = createHookRegistry();
    reg.defineHook('shouldRetryPhase', 'first-wins');
    reg.register({ shouldRetryPhase: defaultShouldRetryPhase });

    const result = await reg.invokeFirstWins(
      'shouldRetryPhase',
      makeRetryArgs({ result: { retry: true }, round: 3 }),
      makeCtx({ registry: reg }),
    );

    expect(result).toBeUndefined();
  });

  it('shouldRetryPhase: a workflow override registered before the default short-circuits it', async () => {
    // Proves the default composes correctly: when a user hook is registered
    // BEFORE the default, first-wins honors the earlier subscriber.
    const reg = createHookRegistry();
    reg.defineHook('shouldRetryPhase', 'first-wins');
    reg.register({
      shouldRetryPhase: [async () => false, defaultShouldRetryPhase],
    });

    const result = await reg.invokeFirstWins(
      'shouldRetryPhase',
      makeRetryArgs({ result: { retry: true }, round: 1 }),
      makeCtx({ registry: reg }),
    );

    expect(result).toBe(false);
  });

  it('beforePhaseTransition: default advance wins via invokeFirstWins', async () => {
    const reg = createHookRegistry();
    reg.defineHook('beforePhaseTransition', 'first-wins');
    reg.register({ beforePhaseTransition: defaultBeforePhaseTransition });

    const result = await reg.invokeFirstWins('beforePhaseTransition', makeTransitionArgs(), makeCtx({ registry: reg }));

    expect(result).toEqual({ type: 'advance' });
  });

  it('beforePhaseTransition: a jump override short-circuits the default advance', async () => {
    const reg = createHookRegistry();
    reg.defineHook('beforePhaseTransition', 'first-wins');
    reg.register({
      beforePhaseTransition: [async () => ({ type: 'jump' as const, target: 'coding' }), defaultBeforePhaseTransition],
    });

    const result = await reg.invokeFirstWins('beforePhaseTransition', makeTransitionArgs(), makeCtx({ registry: reg }));

    expect(result).toEqual({ type: 'jump', target: 'coding' });
  });

  it('onPhaseSettled: default folds complete-task results via invokeAllRun + PHASE_RESULTS_REDUCER', async () => {
    const reg = createHookRegistry();
    reg.defineHook('onPhaseSettled', 'all-run', PHASE_RESULTS_REDUCER);
    reg.register({ onPhaseSettled: defaultOnPhaseSettled });

    const state: Record<string, unknown> = {};
    const tasks = [
      makeTask({ id: 't1', status: 'complete', result: 'r1' }),
      makeTask({ id: 't2', status: 'active', result: 'ignored' }),
      makeTask({ id: 't3', status: 'complete', result: 'r3' }),
    ];

    const folded = await reg.invokeAllRun(
      'onPhaseSettled',
      makeSettledArgs({ phaseId: 'scouting', tasks, state }),
      makeCtx({ registry: reg }),
    );

    expect(folded).toEqual({ t1: 'r1', t3: 'r3' });
    // The default also writes the contribution to state (side effect).
    expect(state['scoutingResults']).toEqual({ t1: 'r1', t3: 'r3' });
  });

  it('onPhaseSettled: multiple subscribers merge via PHASE_RESULTS_REDUCER', async () => {
    // The default contributes complete-task results; a second subscriber
    // contributes an extra entry. The reducer merges both.
    const reg = createHookRegistry();
    reg.defineHook('onPhaseSettled', 'all-run', PHASE_RESULTS_REDUCER);
    reg.register({
      onPhaseSettled: [defaultOnPhaseSettled, async () => ({ custom: 'from-other-subscriber' })],
    });

    const tasks = [makeTask({ id: 't1', status: 'complete', result: 'r1' })];
    const folded = await reg.invokeAllRun(
      'onPhaseSettled',
      makeSettledArgs({ phaseId: 'p', tasks, state: {} }),
      makeCtx({ registry: reg }),
    );

    expect(folded).toEqual({ t1: 'r1', custom: 'from-other-subscriber' });
  });

  it('afterPhase: default fires onSidebarUpdate via invokeObserve', async () => {
    const calls: Array<{ title?: string; indicator?: string }> = [];
    const reg = createHookRegistry();
    reg.defineHook('afterPhase', 'observe');
    reg.register({ afterPhase: createDefaultAfterPhase((info) => calls.push(info)) });

    await reg.invokeObserve('afterPhase', makeAfterArgs({ phaseId: 'scouting' }), makeCtx({ registry: reg }));

    expect(calls).toHaveLength(1);
  });

  it('afterPhase: default is a graceful no-op via invokeObserve when no callback captured', async () => {
    const reg = createHookRegistry();
    reg.defineHook('afterPhase', 'observe');
    reg.register({ afterPhase: createDefaultAfterPhase() });

    await expect(
      reg.invokeObserve('afterPhase', makeAfterArgs({ phaseId: 'scouting' }), makeCtx({ registry: reg })),
    ).resolves.toBeUndefined();
  });
});

// ── Defaults barrel (./index.js) ────────────────────────────────────────────
//
// The task requires "Export all four from this file. Add to
// packages/engine/src/hooks/defaults/index.ts." plus "Add PHASE_RESULTS_REDUCER
// to packages/engine/src/hooks/reducers.ts." These pin those re-exports so a
// consumer importing from the defaults barrel gets every phase default.
// Accessed via a Record cast so the test is a pure runtime check.

describe('defaults barrel (./index.js) + reducer export', () => {
  it('re-exports all four phase defaults from the defaults barrel', () => {
    const barrel = defaultsBarrel as unknown as Record<string, unknown>;
    expect(typeof barrel.defaultShouldRetryPhase).toBe('function');
    expect(typeof barrel.defaultBeforePhaseTransition).toBe('function');
    expect(typeof barrel.defaultOnPhaseSettled).toBe('function');
    expect(typeof barrel.createDefaultAfterPhase).toBe('function');
  });

  it('PHASE_RESULTS_REDUCER is importable from ../reducers.js', () => {
    // Already imported at the top of this file; assert it is a real function.
    expect(typeof PHASE_RESULTS_REDUCER).toBe('function');
  });
});
