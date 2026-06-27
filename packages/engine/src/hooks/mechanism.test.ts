// ─── Tests for the hook MECHANISM as a whole (§9 caveats / §10 step 1) ──────
//
// This module is the SPEC-LEVEL verification suite for the hook system's
// mechanism + composition seam (hooks.prompt.md §10 step 1: "Mechanism +
// composition seam … Additive, zero behavior change, unblocks the rest.").
//
// It exercises the `HookRegistry` + `composeHooks` pair end-to-end against the
// concrete scenarios enumerated in the task — each tied to a §6.1 composition
// rule or a §9 caveat:
//
//   1. Composition rules (§6.1):
//        - pipeline  : ordered value transform, ORDER matters ("hello" → "[HELLO!]")
//        - first-wins: first non-undefined wins; later subscribers short-circuit
//        - all-run   : every subscriber contributes; a reducer folds them (1+2+3=6)
//   2. Observe fan-out (§6.1 observe): every subscriber fires with identical (args, ctx)
//   3. Default-vs-override / backward compat (§10 step 1, §9 #1): no hooks → the
//        composed `onStatus` delegates IDENTICALLY to the store and the registry
//        carries zero subscribers (bit-for-bit today's behavior).
//   4. Store always fires (§9 #3 / "deterministic settlement"): the store callback
//        fires even when an influence hook is registered — `onStatus` never reaches
//        into the registry.
//   5. Error isolation (§9 #2 "two-way-hook tax"): a throwing observe subscriber
//        is swallowed + logged via console.warn; its siblings still fire.
//
// registry.test.ts and compose.test.ts pin individual methods; THIS file pins
// the cross-cutting guarantees the mechanism must uphold as a whole. Some
// overlap is intentional — it documents the spec guarantees in one place.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { StatusCallbacks } from '../core/types.js';
import { STATUS_CALLBACK_METHODS } from '../core/types.js';
import { composeHooks } from './compose.js';
import { createHookRegistry, HookRegistry } from './registry.js';
import type { HookContext, WorkflowHooks } from './types.js';

// ── Fixture helpers (inline make* pattern — mirrors legacy runner tests) ───
//
// Manual mocks only — no shared test-utilities module. Each helper builds an
// isolated, spyable fixture so every `it` is independent.

/** A spy subscriber. bun:test's `mock` records call count + args. Defaults to a
 *  void no-op; pass an impl for subscribers that must return a value. */
function makeMockHook<T extends (...args: never[]) => unknown>(impl?: T): ReturnType<typeof mock<T>> {
  return mock(impl ?? ((() => {}) as unknown as T));
}

/**
 * Build a "mock store": a full {@link StatusCallbacks} where every
 * {@link STATUS_CALLBACK_METHODS} records its invocations (the `unknown[]`
 * args tuple, in call order) keyed by method name. Used to verify
 * default-vs-override delegation and the "store always fires" guarantee.
 */
function makeMockStatusCallbacks(): {
  callbacks: StatusCallbacks;
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {};
  const callbacks = Object.fromEntries(
    STATUS_CALLBACK_METHODS.map((name) => [
      name,
      (...args: unknown[]) => {
        (calls[name] ??= []).push(args);
      },
    ]),
  ) as unknown as StatusCallbacks;
  return { callbacks, calls };
}

/** Fresh, isolated {@link HookRegistry} (no shared subscriber state). Typed as
 *  the concrete class so `defineHook` is available — that method is class-only;
 *  the HookRegistry INTERFACE in types.ts exposes only register, the invoke*
 *  methods, and hasSubscribers. Mirrors registry.test.ts. */
function makeRegistry(): HookRegistry {
  return createHookRegistry();
}

/** Minimal {@link HookContext} with the registry wired in. The class is
 *  structurally assignable to the `HookContext.registry` interface field. */
function makeCtx(registry: HookRegistry, overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry,
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

/**
 * `WorkflowHooks` is grown via declaration merging, so a plain record of
 * `{ hookName: fn }` trips excess-property checking. Cast through `unknown`
 * — same trick as compose.test.ts. At runtime the original object is passed.
 */
function asHooks(hooks: Record<string, unknown>): WorkflowHooks {
  return hooks as unknown as WorkflowHooks;
}

/**
 * `keyof WorkflowHooks` is widened at this layer, but the generic
 * `invoke*<K extends keyof WorkflowHooks>` constraints can still reject ad-hoc
 * string literals we use for untyped hook names. Cast the literal — same trick
 * as registry.test.ts. At runtime the original string is what gets passed.
 */
const hookName = (name: string): never => name as never;

// ── console.warn spy (manual, version-safe — mirrors legacy runner tests) ──
//
// Error isolation (§9 #2): observe must swallow per-subscriber failures and
// surface them through console.warn (one bad subscriber must not break the
// fan-out, and the error must NOT propagate to the caller). We capture warn
// calls without touching the real stream.

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

// ────────────────────────────────────────────────────────────────────────────
// 1. Composition rules (§6.1)
// ────────────────────────────────────────────────────────────────────────────

describe('§6.1 composition rules', () => {
  // ── Pipeline ──────────────────────────────────────────────────────────────
  describe('pipeline (ordered value transform — ORDER matters)', () => {
    it('chains transforms in registration order: "hello" → "[HELLO!]"', async () => {
      const reg = makeRegistry();
      reg.defineHook('transform', 'pipeline');
      // uppercase → add "!" → wrap in brackets
      reg.register(
        asHooks({
          transform: [(v: string) => v.toUpperCase(), (v: string) => `${v}!`, (v: string) => `[${v}]`],
        }),
      );

      const result = await reg.invokePipeline(hookName('transform'), 'hello', undefined, makeCtx(reg));

      expect(result).toBe('[HELLO!]');
    });

    it('runs subscribers strictly in registration order', async () => {
      const reg = makeRegistry();
      reg.defineHook('transform', 'pipeline');
      const order: string[] = [];
      reg.register(
        asHooks({
          transform: [
            (v: string) => {
              order.push('upper');
              return v.toUpperCase();
            },
            (v: string) => {
              order.push('bang');
              return `${v}!`;
            },
            async (v: string) => {
              order.push('bracket');
              return `[${v}]`;
            },
          ],
        }),
      );

      await reg.invokePipeline(hookName('transform'), 'hello', undefined, makeCtx(reg));

      // Sequential — not Promise.all (which would fire all against the seed).
      expect(order).toEqual(['upper', 'bang', 'bracket']);
    });

    it('ORDER matters — reversing the subscriber order yields a DIFFERENT result', async () => {
      // Same three transforms, registered in opposite orders. A fan-out
      // (Promise.all) would feed every subscriber the same seed and produce
      // identical results; a true ordered pipeline is order-sensitive.
      const forward = makeRegistry();
      forward.defineHook('transform', 'pipeline');
      forward.register(
        asHooks({
          transform: [(v: string) => v.toUpperCase(), (v: string) => `${v}!`, (v: string) => `[${v}]`],
        }),
      );

      const reversed = makeRegistry();
      reversed.defineHook('transform', 'pipeline');
      reversed.register(
        asHooks({
          transform: [(v: string) => `[${v}]`, (v: string) => `${v}!`, (v: string) => v.toUpperCase()],
        }),
      );

      const fwd = await forward.invokePipeline(hookName('transform'), 'hello', undefined, makeCtx(forward));
      const rev = await reversed.invokePipeline(hookName('transform'), 'hello', undefined, makeCtx(reversed));

      // forward: hello → HELLO → HELLO! → [HELLO!]
      // reversed: hello → [hello] → [hello]! → [HELLO]!
      expect(fwd).toBe('[HELLO!]');
      expect(rev).toBe('[HELLO]!');
      expect(fwd).not.toBe(rev);
    });

    it('each subscriber observes the PREVIOUS output, not the seed (true sequencing)', async () => {
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

      const result = await reg.invokePipeline(hookName('transform'), 0, undefined, makeCtx(reg));

      expect(observed).toEqual([0, 1, 2]);
      expect(result).toBe(3);
    });
  });

  // ── First-wins ────────────────────────────────────────────────────────────
  describe('first-wins (first non-undefined wins; later subscribers short-circuit)', () => {
    it('returns "stop" and short-circuits — the subscriber AFTER the winner is NOT called', async () => {
      // Three subscribers: the first ABSTAINS (undefined), the second WINS
      // ("stop"), the third is short-circuited and MUST NOT run. This pins the
      // first-wins rule: a non-undefined value decides and halts traversal.
      // (Placing the winner second is what makes "first two called, third not"
      // observable — the winner is the LAST subscriber that runs.)
      const reg = makeRegistry();
      reg.defineHook('decide', 'first-wins');
      const abstain = makeMockHook(() => undefined);
      const winner = makeMockHook(() => 'stop');
      const after = makeMockHook(() => 'should-not-run');
      reg.register(asHooks({ decide: [abstain, winner, after] }));

      const result = await reg.invokeFirstWins(hookName('decide'), undefined, makeCtx(reg));

      expect(result).toBe('stop');
      expect(abstain).toHaveBeenCalledTimes(1); // abstained, so traversal continued
      expect(winner).toHaveBeenCalledTimes(1); // the decider
      expect(after).not.toHaveBeenCalled(); // short-circuited
    });

    it('abstentions do not prevent reaching a later winner ([undefined, undefined, "stop"] → "stop")', async () => {
      // Two abstainers, then the winner last. Every subscriber up to and
      // including the winner runs; nothing after it does (here there is none).
      const reg = makeRegistry();
      reg.defineHook('decide', 'first-wins');
      const a = makeMockHook(() => undefined);
      const b = makeMockHook(() => undefined);
      const c = makeMockHook(() => 'stop');
      reg.register(asHooks({ decide: [a, b, c] }));

      const result = await reg.invokeFirstWins(hookName('decide'), undefined, makeCtx(reg));

      expect(result).toBe('stop');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(c).toHaveBeenCalledTimes(1);
    });

    it('returns undefined when every subscriber abstains (no winner)', async () => {
      const reg = makeRegistry();
      reg.defineHook('decide', 'first-wins');
      reg.register(asHooks({ decide: [() => undefined, () => undefined, () => undefined] }));

      const result = await reg.invokeFirstWins(hookName('decide'), undefined, makeCtx(reg));

      expect(result).toBeUndefined();
    });
  });

  // ── All-run ───────────────────────────────────────────────────────────────
  describe('all-run (every subscriber contributes; reducer folds them)', () => {
    it('fires ALL subscribers and sums their contributions: 1 + 2 + 3 = 6', async () => {
      const reg = makeRegistry();
      const sumReducer = (acc: unknown, next: unknown) => ((acc as number | undefined) ?? 0) + (next as number);
      reg.defineHook('tally', 'all-run', sumReducer);
      const a = makeMockHook(() => 1);
      const b = makeMockHook(() => 2);
      const c = makeMockHook(() => 3);
      reg.register(asHooks({ tally: [a, b, c] }));

      const result = await reg.invokeAllRun(hookName('tally'), undefined, makeCtx(reg));

      expect(result).toBe(6);
      // ALL fire regardless of value — all-run never short-circuits.
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(c).toHaveBeenCalledTimes(1);
    });

    it('ALL subscribers fire even when one contributes a falsy value (0)', async () => {
      // all-run must fire every subscriber — a 0 contribution is not an
      // abstention (that distinction belongs to first-wins' `undefined`).
      const reg = makeRegistry();
      const sumReducer = (acc: unknown, next: unknown) => ((acc as number | undefined) ?? 0) + (next as number);
      reg.defineHook('tally', 'all-run', sumReducer);
      const a = makeMockHook(() => 0);
      const b = makeMockHook(() => 2);
      const c = makeMockHook(() => 4);
      reg.register(asHooks({ tally: [a, b, c] }));

      const result = await reg.invokeAllRun(hookName('tally'), undefined, makeCtx(reg));

      expect(result).toBe(6);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(c).toHaveBeenCalledTimes(1);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Observe fan-out (§6.1 observe)
// ────────────────────────────────────────────────────────────────────────────

describe('§6.1 observe fan-out', () => {
  it('fires every registered subscriber with identical (args, ctx)', async () => {
    const reg = makeRegistry();
    reg.defineHook('onEvent', 'observe');
    const a = makeMockHook();
    const b = makeMockHook(async () => {});
    const c = makeMockHook();
    reg.register(asHooks({ onEvent: [a, b, c] }));
    const args = { msg: 'ping', n: 7 };
    const ctx = makeCtx(reg, { cwd: '/custom', workDir: '/custom/.engin/work/r' });

    await reg.invokeObserve(hookName('onEvent'), args, ctx);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    // Same args + same context object reach every subscriber.
    expect(a).toHaveBeenCalledWith(args, ctx);
    expect(b).toHaveBeenCalledWith(args, ctx);
    expect(c).toHaveBeenCalledWith(args, ctx);
  });

  it('resolves to undefined (observe collects no return value)', async () => {
    const reg = makeRegistry();
    reg.defineHook('onEvent', 'observe');
    reg.register(asHooks({ onEvent: [() => 'ignored', () => 'also-ignored'] }));

    const result = await reg.invokeObserve(hookName('onEvent'), undefined, makeCtx(reg));

    expect(result).toBeUndefined();
  });

  it('is a no-op (resolves undefined) when no subscribers are registered', async () => {
    const reg = makeRegistry();
    reg.defineHook('onEvent', 'observe');

    await expect(reg.invokeObserve(hookName('onEvent'), { x: 1 }, makeCtx(reg))).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Default-vs-override / backward compat (§10 step 1, §9 #1)
// ────────────────────────────────────────────────────────────────────────────
//
// §10 step 1: "Make the single `onStatus = storeCallbacks` line a composition.
// Additive, zero behavior change." With NO hooks registered, the composed
// `onStatus` must be behaviorally IDENTICAL to the store, and the registry
// must be empty. This is the firmest constraint in the design.

describe('§10 step 1 / §9 #1 — default-vs-override (backward compat)', () => {
  it('composeHooks(store, []) returns { onStatus, registry }', () => {
    const { callbacks } = makeMockStatusCallbacks();
    const result = composeHooks(callbacks, []);

    expect(Object.keys(result).sort()).toEqual(['onStatus', 'registry']);
  });

  it('with no hooks, EVERY StatusCallbacks method delegates to the store with identical args', () => {
    const { callbacks, calls } = makeMockStatusCallbacks();
    const { onStatus } = composeHooks(callbacks, []);

    // A distinct sentinel payload per method — verifies EXACT arg forwarding
    // (same reference, not a copy) for all 21 status methods.
    for (const name of STATUS_CALLBACK_METHODS) {
      const payload = { __method: name, n: Math.random() };
      (onStatus as Record<string, (info: unknown) => void>)[name]!(payload);
      expect(calls[name]).toHaveLength(1);
      expect(calls[name][0][0]).toBe(payload); // identity, not a copy
    }
  });

  it('with no hooks, onStatus forwards ALL received args (...args spread, not just the first)', () => {
    const received: unknown[][] = [];
    const store = {
      onWorkflowStart: (...args: unknown[]) => received.push(args),
    } as unknown as StatusCallbacks;
    const { onStatus } = composeHooks(store, []);

    const a = { x: 1 };
    const b = { y: 2 };
    const c = 'third';
    // The composed method is typed as a single-arg `StatusCallbacks` member,
    // but its RUNTIME contract (pinned by compose.ts) forwards `...args`
    // verbatim. Cast through a variadic record so the test can pass multiple
    // args and assert they reach the store unchanged.
    (onStatus as unknown as Record<string, (...args: unknown[]) => void>).onWorkflowStart(a, b, c);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([a, b, c]);
  });

  it('with no hooks, onStatus does not throw when a store callback is undefined', () => {
    // Every StatusCallbacks field is optional; a sparse store must not break
    // the composed wrapper.
    const sparse: StatusCallbacks = {};
    const { onStatus } = composeHooks(sparse, []);

    expect(() => {
      for (const name of STATUS_CALLBACK_METHODS) {
        (onStatus as Record<string, (info: unknown) => void>)[name]?.({ __method: name });
      }
    }).not.toThrow();
  });

  it('with no hooks, the registry has ZERO subscribers for every status method name', () => {
    const { callbacks } = makeMockStatusCallbacks();
    const { registry } = composeHooks(callbacks, []);

    for (const name of STATUS_CALLBACK_METHODS) {
      expect(registry.hasSubscribers(name)).toBe(false);
    }
  });

  it('with no hooks, the registry has ZERO subscribers for any arbitrary hook name', () => {
    const { callbacks } = makeMockStatusCallbacks();
    const { registry } = composeHooks(callbacks, []);

    expect(registry.hasSubscribers('beforeSessionPrompt')).toBe(false);
    expect(registry.hasSubscribers('onDecision')).toBe(false);
    expect(registry.hasSubscribers('shouldRetryPhase')).toBe(false);
    expect(registry.hasSubscribers('doesNotExist')).toBe(false);
  });

  it('an empty provider object ({}) also yields a zero-subscriber registry', () => {
    const { callbacks } = makeMockStatusCallbacks();
    const { registry } = composeHooks(callbacks, {});

    expect(registry.hasSubscribers('beforeSessionPrompt')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Store always fires (§9 #3 — deterministic settlement)
// ────────────────────────────────────────────────────────────────────────────
//
// §9 #3: settle deterministically when influence-hooks short-circuit. The
// composed `onStatus` wraps ONLY the store — observe/influence firing is
// deferred to engine primitives that own a HookContext. So registering an
// influence hook (even under the SAME name as a status callback) must NEVER
// suppress or replace the store callback.

describe('§9 #3 — store always fires (composed onStatus never bypasses the store)', () => {
  it('the store callback fires when an influence hook is registered alongside it', () => {
    const { callbacks, calls } = makeMockStatusCallbacks();
    const influence = makeMockHook();
    const { onStatus } = composeHooks(callbacks, asHooks({ beforeSessionPrompt: influence }));

    const info = { taskPrompt: 't', resumed: false, workDir: '/w' };
    onStatus.onWorkflowStart?.(info);

    // Store is the source of truth — it recorded the call with identical args.
    expect(calls.onWorkflowStart).toHaveLength(1);
    expect(calls.onWorkflowStart[0][0]).toBe(info);
  });

  it('an influence hook registered under a status name does NOT fire from within onStatus', () => {
    // The registry subscriber is available to engine primitives but is NOT
    // invoked when onStatus fires — onStatus fans only into the store.
    const { callbacks, calls } = makeMockStatusCallbacks();
    const influence = makeMockHook();
    const { onStatus, registry } = composeHooks(callbacks, asHooks({ onWorkflowStart: influence }));

    onStatus.onWorkflowStart?.({ taskPrompt: '', resumed: false, workDir: '' });

    expect(calls.onWorkflowStart).toHaveLength(1); // store fired
    expect(influence).not.toHaveBeenCalled(); // hook did NOT fire from onStatus
    expect(registry.hasSubscribers('onWorkflowStart')).toBe(true); // …but it IS registered
  });

  it('the store fires for EVERY status method while influence hooks are registered', () => {
    const { callbacks, calls } = makeMockStatusCallbacks();
    const { onStatus } = composeHooks(
      callbacks,
      asHooks({
        onDecision: makeMockHook(),
        shouldRetryPhase: makeMockHook(),
      }),
    );

    for (const name of STATUS_CALLBACK_METHODS) {
      (onStatus as Record<string, (info: unknown) => void>)[name]!({ __method: name });
    }

    // No status method is suppressed by the presence of influence hooks.
    for (const name of STATUS_CALLBACK_METHODS) {
      expect(calls[name]).toHaveLength(1);
    }
  });

  it('a first-wins hook short-circuiting in the registry does not suppress the store callback', async () => {
    // §9 #3 (deterministic settlement): even when an influence hook decides
    // (short-circuits) inside the registry, the store's terminal callback —
    // fired separately via onStatus — still records the event. The two paths
    // are independent: registry.invoke* never reaches into onStatus, and vice
    // versa.
    const { callbacks, calls } = makeMockStatusCallbacks();
    const { onStatus, registry } = composeHooks(
      callbacks,
      asHooks({ beforeTask: [() => undefined, () => ({ skip: true })] }),
    );

    // (1) Engine primitive fires the influence hook (short-circuits to skip).
    const decision = await registry.invokeFirstWins(hookName('beforeTask'), undefined, makeCtx(registry));
    expect(decision).toEqual({ skip: true });

    // (2) SEPARATELY, the engine fires the store's terminal callback via the
    // composed onStatus. The store records it regardless of the registry's
    // short-circuit decision.
    const terminal = { taskId: 't-1', title: 'Do thing' };
    onStatus.onTaskComplete?.(terminal);

    expect(calls.onTaskComplete).toHaveLength(1);
    expect(calls.onTaskComplete[0][0]).toBe(terminal);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Error isolation (§9 #2 — mind the two-way-hook tax)
// ────────────────────────────────────────────────────────────────────────────
//
// §9 #2: influence/observe hooks introduce error-handling questions that
// don't exist today. The mechanism's answer (pinned here): observe fan-out
// swallows per-subscriber failures (sync throws AND async rejections), logs
// them via console.warn, and NEVER propagates them to the caller — so one bad
// subscriber cannot break its siblings or the firing primitive.

describe('§9 #2 — error isolation (a throwing observe subscriber is swallowed + logged)', () => {
  it('a synchronously-throwing subscriber does NOT break its siblings', async () => {
    const reg = makeRegistry();
    reg.defineHook('onEvent', 'observe');
    const before = makeMockHook();
    const boom = makeMockHook(() => {
      throw new Error('isolate-me');
    });
    const after = makeMockHook();
    reg.register(asHooks({ onEvent: [before, boom, after] }));

    await expect(reg.invokeObserve(hookName('onEvent'), undefined, makeCtx(reg))).resolves.toBeUndefined();

    expect(before).toHaveBeenCalledTimes(1);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('the error is swallowed (NOT propagated) and logged via console.warn', async () => {
    const reg = makeRegistry();
    reg.defineHook('onEvent', 'observe');
    reg.register(
      asHooks({
        onEvent: () => {
          throw new Error('swallow-this');
        },
      }),
    );

    await expect(reg.invokeObserve(hookName('onEvent'), undefined, makeCtx(reg))).resolves.toBeUndefined();

    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0])).toContain('swallow-this');
  });

  it('an async-rejecting subscriber is also swallowed + logged', async () => {
    const reg = makeRegistry();
    reg.defineHook('onEvent', 'observe');
    const boom = makeMockHook(async () => {
      throw new Error('async-boom');
    });
    const sibling = makeMockHook();
    reg.register(asHooks({ onEvent: [boom, sibling] }));

    await expect(reg.invokeObserve(hookName('onEvent'), undefined, makeCtx(reg))).resolves.toBeUndefined();

    expect(sibling).toHaveBeenCalledTimes(1);
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0])).toContain('async-boom');
  });

  it('multiple throwing subscribers each log independently and all siblings still fire', async () => {
    const reg = makeRegistry();
    reg.defineHook('onEvent', 'observe');
    const ok = makeMockHook();
    const boomA = makeMockHook(() => {
      throw new Error('boom-a');
    });
    const boomB = makeMockHook(async () => {
      throw new Error('boom-b');
    });
    const ok2 = makeMockHook();
    reg.register(asHooks({ onEvent: [ok, boomA, boomB, ok2] }));

    await expect(reg.invokeObserve(hookName('onEvent'), undefined, makeCtx(reg))).resolves.toBeUndefined();

    expect(ok).toHaveBeenCalledTimes(1);
    expect(boomA).toHaveBeenCalledTimes(1);
    expect(boomB).toHaveBeenCalledTimes(1);
    expect(ok2).toHaveBeenCalledTimes(1);
    expect(warnCalls).toHaveLength(2);
    expect(String(warnCalls[0])).toContain('boom-a');
    expect(String(warnCalls[1])).toContain('boom-b');
  });

  it('logs nothing when every subscriber succeeds', async () => {
    const reg = makeRegistry();
    reg.defineHook('onEvent', 'observe');
    reg.register(asHooks({ onEvent: [() => {}, async () => {}, () => undefined] }));

    await reg.invokeObserve(hookName('onEvent'), undefined, makeCtx(reg));

    expect(warnCalls).toHaveLength(0);
  });
});
