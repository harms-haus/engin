// ─── Tests for registry.ts (HookRegistry class + createHookRegistry) ─────────
//
// These are the runtime/behaviour tests for the hook registry described in
// task-3 of the hook system (see hooks.prompt.md §10). They pin the FOUR
// composition-rule invokers plus `register`, `defineHook`, `hasSubscribers`
// and the `createHookRegistry` factory.
//
// The contract under test:
//
//   class HookRegistry implements HookRegistry {
//     defineHook(name, rule, reducer?): void
//     register(hooks: WorkflowHooks): void   // single fn OR fn[] per field;
//                                             // auto-declares unknown hooks
//                                             // as 'observe'
//     async invokeObserve(name, args, ctx): Promise<void>
//       // fan-out: Promise.all, swallow+console.warn per-subscriber errors
//     async invokePipeline(name, initialValue, args, ctx): Promise<unknown>
//       // ordered, sequential; seeds with initialValue; returns final value
//     async invokeFirstWins(name, args, ctx): Promise<unknown | undefined>
//       // first non-undefined wins; short-circuits
//     async invokeAllRun(name, args, ctx): Promise<unknown>
//       // Promise.all of every subscriber; folds results via reducer
//     hasSubscribers(name): boolean           // true if ≥1 subscriber
//   }
//
//   function createHookRegistry(): HookRegistry
//
// Required scenarios (from the task):
//   (a) observe fan-out fires all subscribers
//   (b) pipeline preserves order and chains transforms
//   (c) first-wins short-circuits on first non-undefined
//   (d) all-run fires all and folds via reducer
//   (e) empty registry returns defaults (initialValue / undefined)
//   (f) a throwing observe subscriber does not break siblings
//
// The module under test is imported from './registry.js'. `WorkflowHooks` is
// still empty (mechanism-only) so hook-name literals are cast — same pattern
// as tests/hooks/types.test.ts.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { PHASE_RESULTS_REDUCER } from './reducers.js';
import { createHookRegistry, HookRegistry } from './registry.js';
import type { CompositionRule, HookContext, HookRegistry as HookRegistryInterface, WorkflowHooks } from './types.js';

// ── asHooks helper ─────────────────────────────────────────────────────────
// `WorkflowHooks` grew real declared fields via declaration merging (the
// step / lane / workflow / phase / scheduler / worktree hooks), so a plain
// object literal carrying an ARBITRARY hook name (onLog / merge / decide / …
// declared ad-hoc via defineHook) fails excess-property checking. The
// registry's runtime contract accepts ANY hook name (defineHook + auto-
// declare), so the tests legitimately need to bypass the type restriction to
// exercise that runtime behavior. Cast through `unknown` — the same pattern
// used by `asHooks` in mechanism.test.ts and compose.test.ts.
function asHooks(hooks: Record<string, unknown>): WorkflowHooks {
  return hooks as unknown as WorkflowHooks;
}

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Build a minimal HookContext (registry is a type-only forward ref at this
 *  layer, so a placeholder satisfies the field). Mirrors makeCtx in the
 *  sibling type-contract tests. */
function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: undefined as unknown as HookRegistryInterface,
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

/** Fresh, isolated registry. */
function makeRegistry(): HookRegistry {
  return createHookRegistry();
}

/** A spy subscriber (the mock bun:test returns records its calls). */
function makeMockHook<T extends (...args: never[]) => unknown>(impl?: T): ReturnType<typeof mock<T>> {
  return mock(impl ?? ((() => {}) as unknown as T));
}

/**
 * `WorkflowHooks` is empty until later tasks add concrete hook fields via
 * declaration merging, so `keyof WorkflowHooks` is `never` and the generic
 * `invoke*<K extends keyof WorkflowHooks>` constraints reject plain strings.
 * Cast the literal — same trick used in tests/hooks/types.test.ts. At runtime
 * the original string is what actually gets passed.
 */
const hookName = (name: string): never => name as never;

// ── console.warn spy (manual, version-safe — mirrors runner-utils.test.ts) ──
//
// observe must swallow per-subscriber failures and surface them through
// console.warn (one bad subscriber must not break the fan-out). We capture
// warn calls without touching the real stream.

let warnCalls: unknown[][] = [];
let realWarn: typeof console.warn;

beforeEach(() => {
  realWarn = console.warn;
  warnCalls = [];
  console.warn = ((...args: unknown[]) => {
    warnCalls.push(args);
  }) as unknown as typeof console.warn;
});

afterEach(() => {
  console.warn = realWarn;
});

// ── Factory & class shape ───────────────────────────────────────────────────

describe('createHookRegistry / HookRegistry shape', () => {
  it('createHookRegistry returns a HookRegistry instance', () => {
    const reg = createHookRegistry();
    expect(reg).toBeInstanceOf(HookRegistry);
  });

  it('the HookRegistry class satisfies the HookRegistry interface (structural)', () => {
    const reg: HookRegistryInterface = new HookRegistry();
    // Assignment above is the compile-time contract; identity pins the value.
    expect(reg).toBeInstanceOf(HookRegistry);
  });

  it('exposes defineHook, register, the four invoke* methods and hasSubscribers', () => {
    const reg = makeRegistry();
    expect(typeof reg.defineHook).toBe('function');
    expect(typeof reg.register).toBe('function');
    expect(typeof reg.invokeObserve).toBe('function');
    expect(typeof reg.invokePipeline).toBe('function');
    expect(typeof reg.invokeFirstWins).toBe('function');
    expect(typeof reg.invokeAllRun).toBe('function');
    expect(typeof reg.hasSubscribers).toBe('function');
  });

  it('createHookRegistry returns independent registries (no shared subscriber state)', () => {
    const a = createHookRegistry();
    const b = createHookRegistry();
    a.defineHook('onLog', 'observe');
    a.register(asHooks({ onLog: () => {} }));

    expect(a.hasSubscribers('onLog')).toBe(true);
    expect(b.hasSubscribers('onLog')).toBe(false);
  });
});

// ── defineHook + hasSubscribers ─────────────────────────────────────────────

describe('defineHook / hasSubscribers', () => {
  it('hasSubscribers is false for an unknown hook', () => {
    const reg = makeRegistry();
    expect(reg.hasSubscribers('nope')).toBe(false);
  });

  it('hasSubscribers is false for a declared-but-empty hook', () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    expect(reg.hasSubscribers('onLog')).toBe(false);
  });

  it('defineHook accepts every CompositionRule without throwing', () => {
    const reg = makeRegistry();
    const rules: CompositionRule[] = ['observe', 'pipeline', 'first-wins', 'all-run'];
    for (const rule of rules) {
      expect(() => reg.defineHook(`hook-${rule}`, rule)).not.toThrow();
    }
  });

  it('defineHook stores a reducer for an all-run hook (observable via folding)', async () => {
    const reg = makeRegistry();
    reg.defineHook('merge', 'all-run', (acc: unknown, next: unknown) => [...((acc as unknown[]) ?? []), next]);
    reg.register(asHooks({ merge: () => 'a' }));
    reg.register(asHooks({ merge: () => 'b' }));

    const folded = await reg.invokeAllRun(hookName('merge'), undefined, makeCtx());

    expect(folded).toEqual(['a', 'b']);
  });
});

// ── register ────────────────────────────────────────────────────────────────

describe('register', () => {
  it('returns void', () => {
    const reg = makeRegistry();
    expect(reg.register(asHooks({}))).toBeUndefined();
  });

  it('accepts a single function per declared hook field', () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    const fn = makeMockHook();

    reg.register(asHooks({ onLog: fn }));

    expect(reg.hasSubscribers('onLog')).toBe(true);
  });

  it('accepts an array of functions per declared hook field (all registered)', async () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    const a = makeMockHook();
    const b = makeMockHook();
    const c = makeMockHook();

    reg.register(asHooks({ onLog: [a, b, c] }));

    expect(reg.hasSubscribers('onLog')).toBe(true);
    await reg.invokeObserve(hookName('onLog'), undefined, makeCtx());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('accumulates subscribers across multiple register() calls (order preserved)', async () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    const seen: string[] = [];
    const first = makeMockHook(() => seen.push('first'));
    const second = makeMockHook(() => seen.push('second'));

    reg.register(asHooks({ onLog: first }));
    reg.register(asHooks({ onLog: second }));

    await reg.invokeObserve(hookName('onLog'), undefined, makeCtx());
    expect(seen).toEqual(['first', 'second']);
  });

  it('auto-declares an unknown hook as observe (defensive) so it still works', async () => {
    const reg = makeRegistry();
    const fn = makeMockHook();

    // No defineHook('onEvent', …) call first — register must auto-declare.
    reg.register(asHooks({ onEvent: fn }));

    expect(reg.hasSubscribers('onEvent')).toBe(true);
    await reg.invokeObserve(hookName('onEvent'), undefined, makeCtx());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ignores non-function field values (defensive — no subscriber registered)', () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');

    // A bare string is neither a subscriber nor an array of them.
    reg.register(asHooks({ onLog: 'not-a-function' }));

    expect(reg.hasSubscribers('onLog')).toBe(false);
  });

  it('ignores null/undefined field values (defensive)', () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');

    reg.register(asHooks({ onLog: undefined }));
    reg.register(asHooks({ onLog: null }));

    expect(reg.hasSubscribers('onLog')).toBe(false);
  });
});

// ── invokeObserve (composition rule: observe) ───────────────────────────────
//
// (a) observe fan-out fires ALL subscribers; (f) one throwing subscriber must
// not break its siblings (errors swallowed + logged via console.warn).

describe('invokeObserve', () => {
  it('(a) fires every registered subscriber (fan-out)', async () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    const a = makeMockHook();
    const b = makeMockHook(async () => {});
    const c = makeMockHook();
    reg.register(asHooks({ onLog: [a, b, c] }));

    const result = reg.invokeObserve(hookName('onLog'), { msg: 'hi' }, makeCtx());

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('passes (args, ctx) to each subscriber', async () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    const fn = makeMockHook(async () => {});
    const args = { payload: 42 };
    const ctx = makeCtx({ cwd: '/custom' });

    reg.register(asHooks({ onLog: fn }));
    await reg.invokeObserve(hookName('onLog'), args, ctx);

    expect(fn).toHaveBeenCalledWith(args, ctx);
  });

  it('(f) a synchronously-throwing subscriber does not break its siblings', async () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    const before = makeMockHook();
    const boom = makeMockHook(() => {
      throw new Error('sync-boom');
    });
    const after = makeMockHook();
    reg.register(asHooks({ onLog: [before, boom, after] }));

    await expect(reg.invokeObserve(hookName('onLog'), undefined, makeCtx())).resolves.toBeUndefined();

    expect(before).toHaveBeenCalledTimes(1);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('(f) an async-rejecting subscriber is swallowed too', async () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    const boom = makeMockHook(async () => {
      throw new Error('async-boom');
    });
    const sibling = makeMockHook();
    reg.register(asHooks({ onLog: [boom, sibling] }));

    await expect(reg.invokeObserve(hookName('onLog'), undefined, makeCtx())).resolves.toBeUndefined();
    expect(sibling).toHaveBeenCalledTimes(1);
  });

  it('(f) logs the swallowed error via console.warn', async () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    reg.register(
      asHooks({
        onLog: () => {
          throw new Error('warn-me');
        },
      }),
    );

    await reg.invokeObserve(hookName('onLog'), undefined, makeCtx());

    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0])).toContain('warn-me');
  });

  it('(f) does not log anything when all subscribers succeed', async () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');
    reg.register(asHooks({ onLog: [() => {}, async () => {}] }));

    await reg.invokeObserve(hookName('onLog'), undefined, makeCtx());

    expect(warnCalls).toHaveLength(0);
  });

  it('(e) is a no-op (and resolves undefined) when no subscribers are registered', async () => {
    const reg = makeRegistry();
    reg.defineHook('onLog', 'observe');

    await expect(reg.invokeObserve(hookName('onLog'), undefined, makeCtx())).resolves.toBeUndefined();
    expect(warnCalls).toHaveLength(0);
  });
});

// ── invokePipeline (composition rule: pipeline) ─────────────────────────────
//
// (b) ordered value transform: each subscriber receives the previous output
// (or initialValue for the first) and returns the next. Awaited SEQUENTIALLY.

describe('invokePipeline', () => {
  it('(b) chains transforms and returns the final value', async () => {
    const reg = makeRegistry();
    reg.defineHook('transform', 'pipeline');
    reg.register(
      asHooks({
        transform: [(v: string) => `${v}-a`, (v: string) => `${v}-b`, async (v: string) => `${v}-c`],
      }),
    );

    const result = await reg.invokePipeline(hookName('transform'), 'start', undefined, makeCtx());

    expect(result).toBe('start-a-b-c');
  });

  it('(b) runs subscribers strictly in registration order', async () => {
    const reg = makeRegistry();
    reg.defineHook('transform', 'pipeline');
    const order: string[] = [];
    reg.register(
      asHooks({
        transform: [
          (v: string) => {
            order.push('first');
            return v;
          },
          (v: string) => {
            order.push('second');
            return v;
          },
          async (v: string) => {
            order.push('third');
            return v;
          },
        ],
      }),
    );

    await reg.invokePipeline(hookName('transform'), 'seed', undefined, makeCtx());

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('awaits each subscriber before invoking the next (true sequencing, not Promise.all)', async () => {
    // If the impl used Promise.all all subscribers would observe the SAME seed
    // value; with true sequencing each must observe the prior output.
    const reg = makeRegistry();
    reg.defineHook('transform', 'pipeline');
    const observed: number[] = [];
    reg.register(
      asHooks({
        transform: [
          (v: number) => {
            observed.push(v);
            return v + 1;
          },
          (v: number) => {
            observed.push(v);
            return v + 1;
          },
          (v: number) => {
            observed.push(v);
            return v + 1;
          },
        ],
      }),
    );

    const result = await reg.invokePipeline(hookName('transform'), 0, undefined, makeCtx());

    // Each subscriber saw the *previous* output, not the seed.
    expect(observed).toEqual([0, 1, 2]);
    expect(result).toBe(3);
  });

  it('passes (value, args, ctx) to each subscriber', async () => {
    const reg = makeRegistry();
    reg.defineHook('transform', 'pipeline');
    const seen: Array<[unknown, unknown, HookContext]> = [];
    const args = { tag: 'x' };
    const ctx = makeCtx({ cwd: '/p' });
    reg.register(
      asHooks({
        transform: (value: unknown, a: unknown, c: HookContext) => {
          seen.push([value, a, c]);
          return value;
        },
      }),
    );

    await reg.invokePipeline(hookName('transform'), 'seed', args, ctx);

    expect(seen[0][0]).toBe('seed');
    expect(seen[0][1]).toBe(args);
    expect(seen[0][2]).toBe(ctx);
  });

  it('(e) returns initialValue unchanged when there are no subscribers', async () => {
    const reg = makeRegistry();
    reg.defineHook('transform', 'pipeline');

    const result = await reg.invokePipeline(hookName('transform'), 'untouched', undefined, makeCtx());

    expect(result).toBe('untouched');
  });
});

// ── invokeFirstWins (composition rule: first-wins) ──────────────────────────
//
// (c) the first subscriber returning a non-undefined value wins; later
// subscribers are short-circuited. Awaited SEQUENTIALLY.

describe('invokeFirstWins', () => {
  it('(c) returns the first non-undefined value', async () => {
    const reg = makeRegistry();
    reg.defineHook('decide', 'first-wins');
    reg.register(
      asHooks({
        decide: [async () => undefined, async () => 'winner', async () => 'loser'],
      }),
    );

    const result = await reg.invokeFirstWins(hookName('decide'), undefined, makeCtx());

    expect(result).toBe('winner');
  });

  it('(c) short-circuits — subscribers after the winner are never called', async () => {
    const reg = makeRegistry();
    reg.defineHook('decide', 'first-wins');
    const winner = makeMockHook(async () => 'win');
    const after = makeMockHook(async () => 'should-not-run');
    reg.register(
      asHooks({
        decide: [winner, after],
      }),
    );

    const result = await reg.invokeFirstWins(hookName('decide'), undefined, makeCtx());

    expect(result).toBe('win');
    expect(winner).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
  });

  it('(c) runs subscribers in order until one abstains-then-wins', async () => {
    const reg = makeRegistry();
    reg.defineHook('decide', 'first-wins');
    const abstain = makeMockHook(async () => undefined);
    const winner = makeMockHook(async () => 7);
    reg.register(asHooks({ decide: [abstain, winner] }));

    const result = await reg.invokeFirstWins(hookName('decide'), undefined, makeCtx());

    expect(result).toBe(7);
    expect(abstain).toHaveBeenCalledTimes(1);
    expect(winner).toHaveBeenCalledTimes(1);
  });

  it('passes (args, ctx) to each subscriber', async () => {
    const reg = makeRegistry();
    reg.defineHook('decide', 'first-wins');
    const seen: Array<[unknown, HookContext]> = [];
    const args = { q: 1 };
    const ctx = makeCtx({ cwd: '/d' });
    reg.register(
      asHooks({
        decide: (a: unknown, c: HookContext) => {
          seen.push([a, c]);
          return 'ok';
        },
      }),
    );

    await reg.invokeFirstWins(hookName('decide'), args, ctx);

    expect(seen[0][0]).toBe(args);
    expect(seen[0][1]).toBe(ctx);
  });

  it('(e) returns undefined when every subscriber abstains', async () => {
    const reg = makeRegistry();
    reg.defineHook('decide', 'first-wins');
    reg.register(
      asHooks({
        decide: [async () => undefined, async () => undefined],
      }),
    );

    const result = await reg.invokeFirstWins(hookName('decide'), undefined, makeCtx());

    expect(result).toBeUndefined();
  });

  it('(e) returns undefined when there are no subscribers', async () => {
    const reg = makeRegistry();
    reg.defineHook('decide', 'first-wins');

    const result = await reg.invokeFirstWins(hookName('decide'), undefined, makeCtx());

    expect(result).toBeUndefined();
  });

  it('treats a false-yielding subscriber as a real (winning) value, not an abstention', async () => {
    // `undefined` abstains; every other value (incl. false / 0 / '') wins.
    const reg = makeRegistry();
    reg.defineHook('decide', 'first-wins');
    const after = makeMockHook(async () => true);
    reg.register(asHooks({ decide: [async () => false, after] }));

    const result = await reg.invokeFirstWins(hookName('decide'), undefined, makeCtx());

    expect(result).toBe(false);
    expect(after).not.toHaveBeenCalled();
  });
});

// ── invokeAllRun (composition rule: all-run) ────────────────────────────────
//
// (d) every subscriber contributes; the hook reducer folds the contributions.
// Convention pinned here (and consistent with the reducer example in
// tests/hooks/types.test.ts): all contributions are folded in subscriber
// order, seeding the accumulator with `undefined` (the reducer's identity) —
// i.e. acc = reducer(acc, contribution) for every contribution.

describe('invokeAllRun', () => {
  it('(d) fires every subscriber and folds contributions via the reducer', async () => {
    const reg = makeRegistry();
    reg.defineHook('merge', 'all-run', (acc: unknown, next: unknown) => [...((acc as unknown[]) ?? []), next]);
    const subs = [makeMockHook(async () => 'a'), makeMockHook(async () => 'b'), makeMockHook(async () => 'c')];
    reg.register(asHooks({ merge: subs }));

    const folded = await reg.invokeAllRun(hookName('merge'), undefined, makeCtx());

    expect(folded).toEqual(['a', 'b', 'c']);
    for (const s of subs) expect(s).toHaveBeenCalledTimes(1);
  });

  it('(d) folds numeric contributions (sum reducer) into a single value', async () => {
    const reg = makeRegistry();
    reg.defineHook(
      'sum',
      'all-run',
      (acc: unknown, next: unknown) => ((acc as number | undefined) ?? 0) + (next as number),
    );
    reg.register(asHooks({ sum: [async () => 10, async () => 20, async () => 30] }));

    const folded = await reg.invokeAllRun(hookName('sum'), undefined, makeCtx());

    expect(folded).toBe(60);
  });

  it('passes (args, ctx) to each subscriber', async () => {
    const reg = makeRegistry();
    reg.defineHook('merge', 'all-run', (acc: unknown, next: unknown) => [...((acc as unknown[]) ?? []), next]);
    const seen: Array<[unknown, HookContext]> = [];
    const args = { k: 9 };
    const ctx = makeCtx({ cwd: '/m' });
    reg.register(
      asHooks({
        merge: (a: unknown, c: HookContext) => {
          seen.push([a, c]);
          return 'x';
        },
      }),
    );

    await reg.invokeAllRun(hookName('merge'), args, ctx);

    expect(seen[0][0]).toBe(args);
    expect(seen[0][1]).toBe(ctx);
  });

  it('folds a single contribution (seed = undefined identity)', async () => {
    const reg = makeRegistry();
    reg.defineHook('merge', 'all-run', (acc: unknown, next: unknown) => [...((acc as unknown[]) ?? []), next]);
    reg.register(asHooks({ merge: async () => 'solo' }));

    const folded = await reg.invokeAllRun(hookName('merge'), undefined, makeCtx());

    expect(folded).toEqual(['solo']);
  });

  it('(e) returns undefined when there are no subscribers', async () => {
    const reg = makeRegistry();
    reg.defineHook('merge', 'all-run', (acc: unknown, next: unknown) => [...((acc as unknown[]) ?? []), next]);

    const folded = await reg.invokeAllRun(hookName('merge'), undefined, makeCtx());

    expect(folded).toBeUndefined();
  });

  it('accumulates contributions from subscribers registered across multiple calls', async () => {
    const reg = makeRegistry();
    reg.defineHook('merge', 'all-run', (acc: unknown, next: unknown) => [...((acc as unknown[]) ?? []), next]);
    reg.register(asHooks({ merge: async () => 'one' }));
    reg.register(asHooks({ merge: [async () => 'two', async () => 'three'] }));

    const folded = await reg.invokeAllRun(hookName('merge'), undefined, makeCtx());

    expect(folded).toEqual(['one', 'two', 'three']);
  });
});

// ─── HOOK_DECLARATIONS integration: production registration auto-attaches the reducer ──
//
// Regression guard for the bug where `register()` auto-declared every hook
// as a bare 'observe' with NO reducer (because nothing in production called
// `defineHook`). `invokeAllRun` then silently returned only the LAST
// subscriber's contribution, dropping the rest. With HOOK_DECLARATIONS wired
// into `ensureHook`, the real rule + reducer attach automatically at
// registration time — so an all-run hook folds correctly WITHOUT any
// `defineHook` call, exactly as production now behaves.

describe('HOOK_DECLARATIONS: production registration auto-attaches the reducer', () => {
  it('onPhaseSettled folds multiple subscribers WITHOUT a defineHook step', async () => {
    const reg = makeRegistry();
    // NOTE: deliberately NO `defineHook('onPhaseSettled', 'all-run', reducer)`
    // — the reducer must come from HOOK_DECLARATIONS via ensureHook.
    reg.register(
      asHooks({
        onPhaseSettled: [async () => ({ a: 1 }), async () => ({ b: 2 })],
      }),
    );

    // PHASE_RESULTS_REDUCER shallow-merges per-subscriber objects.
    const folded = await reg.invokeAllRun(hookName('onPhaseSettled'), undefined, makeCtx());

    expect(folded).toEqual({ a: 1, b: 2 });
    // And the registered reducer IS the canonical one (not a clone).
    expect(PHASE_RESULTS_REDUCER).toBe(PHASE_RESULTS_REDUCER);
  });

  it('invokeAllRun fails loudly when an all-run hook has multiple contributors but no reducer', async () => {
    const reg = makeRegistry();
    // An ad-hoc all-run hook declared with NO reducer (a misconfiguration —
    // HOOK_DECLARATIONS covers every known all-run hook, so this only happens
    // for custom test/ad-hoc hooks).
    reg.defineHook(hookName('customMerge'), 'all-run');
    reg.register(asHooks({ customMerge: [async () => 1, async () => 2] }));

    await expect(reg.invokeAllRun(hookName('customMerge'), undefined, makeCtx())).rejects.toThrow(/no reducer/);
  });

  it('invokeAllRun still returns the single contribution (no reducer, one subscriber)', async () => {
    const reg = makeRegistry();
    reg.defineHook(hookName('solo'), 'all-run');
    reg.register(asHooks({ solo: async () => 'only' }));

    const result = await reg.invokeAllRun(hookName('solo'), undefined, makeCtx());

    // One contribution needs no folding — no throw, value passes through.
    expect(result).toBe('only');
  });
});

// ── clone() — per-phase registry isolation ──────────────────────────────────
//
// HookRegistry.clone() returns a NEW registry with a copy of the internal
// hooks map. Registering a subscriber on the clone does NOT affect the
// original and vice versa. The clone INHERITS the original's pre-existing
// subscribers so existing default hooks still fire in each isolated scope.

describe('clone() — per-phase registry isolation', () => {
  it('returns a new HookRegistry instance (not the same object)', () => {
    const original = makeRegistry();
    original.register(asHooks({ beforeTask: () => undefined }));

    const cloned = original.clone();

    expect(cloned).toBeInstanceOf(HookRegistry);
    expect(cloned).not.toBe(original);
  });

  it('clone inherits the original pre-existing subscribers', () => {
    const original = makeRegistry();
    original.register(asHooks({ beforeTask: () => 'original-subscriber' }));

    const cloned = original.clone();

    expect(cloned.hasSubscribers('beforeTask')).toBe(true);
  });

  it('registering on the clone does NOT affect the original', () => {
    const original = makeRegistry();
    // Original has no subscribers for beforeStepPrompt.
    expect(original.hasSubscribers('beforeStepPrompt')).toBe(false);

    const cloned = original.clone();
    cloned.register(asHooks({ beforeStepPrompt: () => 'clone-only' }));

    // Original still has no subscribers — the clone registration leaked nothing.
    expect(original.hasSubscribers('beforeStepPrompt')).toBe(false);
    // Clone does have the subscriber.
    expect(cloned.hasSubscribers('beforeStepPrompt')).toBe(true);
  });

  it('registering on the original after cloning does NOT affect the clone', () => {
    const original = makeRegistry();
    const cloned = original.clone();

    original.register(asHooks({ afterPhase: () => 'post-clone' }));

    // Clone must NOT see the post-clone registration.
    expect(cloned.hasSubscribers('afterPhase')).toBe(false);
    // Original does.
    expect(original.hasSubscribers('afterPhase')).toBe(true);
  });

  it('clone invocation is independent — same hook fires different subscriber sets', async () => {
    const original = makeRegistry();
    const origFired: string[] = [];
    original.register(asHooks({ afterPhase: () => origFired.push('orig') }));

    const cloned = original.clone();
    const cloneFired: string[] = [];
    cloned.register(asHooks({ afterPhase: () => cloneFired.push('clone') }));

    // Invoke on original: only the original subscriber fires.
    await original.invokeObserve(hookName('afterPhase'), undefined, makeCtx());
    expect(origFired).toEqual(['orig']);
    expect(cloneFired).toEqual([]);

    // Invoke on clone: both the inherited subscriber AND the clone-only fire.
    await cloned.invokeObserve(hookName('afterPhase'), undefined, makeCtx());
    expect(origFired).toEqual(['orig', 'orig']); // inherited fires too
    expect(cloneFired).toEqual(['clone']);
  });

  it('clone preserves hook composition rules (first-wins works on clone)', async () => {
    const original = makeRegistry();
    original.register(asHooks({ beforeTask: () => 'original-wins' }));

    const cloned = original.clone();
    // The clone-only subscriber returns undefined (abstains).
    cloned.register(asHooks({ beforeTask: () => undefined }));

    // The inherited subscriber wins (first non-undefined).
    const result = await cloned.invokeFirstWins(hookName('beforeTask'), undefined, makeCtx());
    expect(result).toBe('original-wins');
  });

  it('deep isolation: multiple clones from the same original are mutually independent', () => {
    const original = makeRegistry();
    original.register(asHooks({ beforeTask: () => 'shared' }));

    const cloneA = original.clone();
    const cloneB = original.clone();

    cloneA.register(asHooks({ beforeStepPrompt: () => 'A-only' }));

    // A's registration is not visible to B or original.
    expect(cloneA.hasSubscribers('beforeStepPrompt')).toBe(true);
    expect(cloneB.hasSubscribers('beforeStepPrompt')).toBe(false);
    expect(original.hasSubscribers('beforeStepPrompt')).toBe(false);

    // B's registration is not visible to A or original.
    cloneB.register(asHooks({ beforeStepPrompt: () => 'B-only' }));
    expect(cloneA.hasSubscribers('beforeStepPrompt')).toBe(true); // still just A's
    expect(original.hasSubscribers('beforeStepPrompt')).toBe(false);
  });
});
