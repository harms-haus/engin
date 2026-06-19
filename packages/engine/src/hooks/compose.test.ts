// ─── Tests for compose.ts (composeHooks) ────────────────────────────────────
//
// `composeHooks` is the composition seam introduced in step 1 of the hook
// system (see hooks.prompt.md §10). It replaces the single
// `options.onStatus = storeCallbacks` assignment in `run-executor.ts` with:
//
//   const { onStatus, registry } = composeHooks(storeCallbacks, workflow.hooks);
//   options.onStatus = onStatus;          // behaviorally identical to storeCallbacks
//   options.hookRegistry = registry;      // consumed by engine primitives
//
// DESIGN DECISION pinned by these tests (documented in compose.ts header):
// observe/influence-hook firing from within `onStatus` is DEFERRED to the
// engine primitives (runStep, LanePool, PhaseRunner) that own a proper
// `HookContext`. The composed `onStatus` wraps ONLY the store callbacks — so
// `composeHooks(storeCallbacks, hooks).onStatus` is behaviorally IDENTICAL to
// `storeCallbacks` (zero behavior change), and the returned registry is
// consumed separately by the engine primitives via `registry.invoke*`.
//
// Required scenarios (from the task):
//   (a) no hooks → onStatus delegates every callback to storeCallbacks identically
//   (b) hooks   → the returned registry contains the registered influence hooks
//   (c) store callbacks ALWAYS fire even when influence hooks are registered
//
// The module under test is imported from './compose.js'. `WorkflowHooks` is
// still empty (mechanism-only) so hook-name literals / provider objects are
// cast — same pattern as registry.test.ts.

import { describe, expect, it, mock } from 'bun:test';
import type { StatusCallbacks } from '../core/types.js';
import { STATUS_CALLBACK_METHODS } from '../core/types.js';
import { composeHooks } from './compose.js';
import { HookRegistry } from './registry.js';
import type { HookContext, HookProvider, HookRegistry as HookRegistryInterface, WorkflowHooks } from './types.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/**
 * Build a "mock store": a full {@link StatusCallbacks} object where every one
 * of the {@link STATUS_CALLBACK_METHODS} records its invocations (args list)
 * keyed by method name. Mirrors the role of `createStoreCallbacks(store)` but
 * captures calls in-memory instead of fanning them into an `EventStore`.
 *
 * Each entry in `calls[name]` is the `unknown[]` args tuple of one call, in
 * call order — so a test can assert both call count and the exact forwarded
 * args (including multi-arg forwarding).
 */
function makeRecordingStore(): {
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

/**
 * `WorkflowHooks` is empty until concrete hooks are added via declaration
 * merging, so a plain record of `{ hookName: fn }` fails excess-property
 * checking against the empty interface. Cast through `unknown` into a
 * `WorkflowHooks` so it can be passed as a `HookProvider` — same trick the
 * registry tests use for hook-name literals.
 */
function asHooks(hooks: Record<string, unknown>): WorkflowHooks {
  return hooks as unknown as WorkflowHooks;
}

/**
 * Minimal `HookContext` for exercising `registry.invoke*` from the tests.
 * `registry` is a forward (type-only) ref at the types layer, so the real
 * registry instance is wired in here. Mirrors `makeCtx` in registry.test.ts.
 */
function makeCtx(registry: HookRegistryInterface): HookContext {
  return { registry, cwd: '/repo', workDir: '/repo/.engin/work/run-1' };
}

/**
 * `keyof WorkflowHooks` is `never` (mechanism-only interface), so the generic
 * `invoke*<K extends keyof WorkflowHooks>` constraints reject plain strings.
 * Cast the literal — same trick used in registry.test.ts. At runtime the
 * original string is what actually gets passed.
 */
const hookName = (name: string): never => name as never;

// ── Return shape ────────────────────────────────────────────────────────────

describe('composeHooks — return shape', () => {
  it('returns an object with `onStatus` and `registry` properties', () => {
    const { callbacks } = makeRecordingStore();
    const result = composeHooks(callbacks, {});
    expect(result).toHaveProperty('onStatus');
    expect(result).toHaveProperty('registry');
    expect(Object.keys(result).sort()).toEqual(['onStatus', 'registry']);
  });

  it('`registry` is a HookRegistry instance (created via createHookRegistry)', () => {
    const { callbacks } = makeRecordingStore();
    const { registry } = composeHooks(callbacks, {});
    expect(registry).toBeInstanceOf(HookRegistry);
  });

  it('`registry` satisfies the HookRegistry interface (structural typing)', () => {
    const { callbacks } = makeRecordingStore();
    const { registry } = composeHooks(callbacks, {});
    // Assignment is the compile-time contract; the runtime methods exist.
    const asInterface: HookRegistryInterface = registry;
    expect(asInterface).toBe(registry);
    expect(typeof registry.register).toBe('function');
    expect(typeof registry.invokeObserve).toBe('function');
    expect(typeof registry.hasSubscribers).toBe('function');
  });

  it('`onStatus` has every STATUS_CALLBACK_METHOD as a function (exact 21-method shape)', () => {
    const { callbacks } = makeRecordingStore();
    const { onStatus } = composeHooks(callbacks, {});
    // Exactly the declared methods, no more, no less.
    expect(Object.keys(onStatus).sort()).toEqual([...STATUS_CALLBACK_METHODS].sort());
    for (const name of STATUS_CALLBACK_METHODS) {
      expect(typeof (onStatus as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

// ── (a) no hooks — onStatus delegates identically to storeCallbacks ─────────
//
// `composeHooks(storeCallbacks, {}).onStatus` must be behaviorally IDENTICAL
// to `storeCallbacks` when no hooks are registered (zero behavior change —
// the firmest constraint in hooks.prompt.md §2 #2).

describe('(a) no hooks — onStatus delegates identically to storeCallbacks', () => {
  it('delegates every STATUS_CALLBACK_METHOD call to the matching store callback with identical args', () => {
    const { callbacks, calls } = makeRecordingStore();
    const { onStatus } = composeHooks(callbacks, {});

    // A distinct sentinel payload per method; the recording store accepts any
    // value, so this verifies EXACT arg forwarding (identity) for all 21.
    for (const name of STATUS_CALLBACK_METHODS) {
      const payload = { __method: name, n: Math.random() };
      (onStatus as Record<string, (info: unknown) => void>)[name]!(payload);
      expect(calls[name]).toHaveLength(1);
      // The store received the EXACT same object reference, not a copy.
      expect(calls[name][0][0]).toBe(payload);
    }
  });

  it('does not throw when a store callback is undefined (every method is optional)', () => {
    // A StatusCallbacks with NO methods defined — legal because every field
    // is optional. The composed wrapper must tolerate the missing handler.
    const sparse: StatusCallbacks = {};
    const { onStatus } = composeHooks(sparse, {});

    expect(() => {
      for (const name of STATUS_CALLBACK_METHODS) {
        (onStatus as Record<string, (info: unknown) => void>)[name]?.({ __method: name });
      }
    }).not.toThrow();
  });

  it('forwards ALL received args unchanged to the store (...args spread, not just the first)', () => {
    // Although each status callback formally takes a single `info` object, the
    // composed method is documented to accept `...args: unknown[]` and forward
    // them — store is the source of truth, so nothing may be dropped.
    const received: unknown[][] = [];
    const store = {
      onWorkflowStart: (...args: unknown[]) => received.push(args),
    } as unknown as StatusCallbacks;
    const { onStatus } = composeHooks(store, {});

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

  it("delegates synchronously and returns void (no Promise — matches today's store behavior)", () => {
    const { callbacks } = makeRecordingStore();
    const { onStatus } = composeHooks(callbacks, {});

    const result = onStatus.onWorkflowStart?.({ taskPrompt: '', resumed: false, workDir: '' });

    expect(result).toBeUndefined();
  });

  it('two independent stores do not cross-contaminate through composeHooks', () => {
    const a = makeRecordingStore();
    const b = makeRecordingStore();
    const { onStatus: onA } = composeHooks(a.callbacks, {});
    const { onStatus: onB } = composeHooks(b.callbacks, {});

    onA.onWorkflowStart?.({ taskPrompt: 'a', resumed: false, workDir: '' });

    expect(a.calls.onWorkflowStart).toHaveLength(1);
    expect(b.calls.onWorkflowStart).toBeUndefined();

    onB.onPhaseStart?.({ phase: 'p', round: 1 });

    expect(b.calls.onPhaseStart).toHaveLength(1);
    expect(a.calls.onPhaseStart).toBeUndefined();
  });
});

// ── (b) registry contains the registered influence hooks ───────────────────

describe('(b) registry contains the registered influence hooks', () => {
  it('registers a single influence hook from a single provider object', () => {
    const { callbacks } = makeRecordingStore();
    const fn = mock(() => undefined);
    const { registry } = composeHooks(callbacks, asHooks({ beforeStepPrompt: fn }));

    expect(registry.hasSubscribers('beforeStepPrompt')).toBe(true);
  });

  it('registers multiple distinct hooks from one provider', () => {
    const { callbacks } = makeRecordingStore();
    const { registry } = composeHooks(
      callbacks,
      asHooks({
        beforeStepPrompt: mock(() => undefined),
        shouldRetryPhase: mock(() => undefined),
        onPhaseSettled: mock(() => undefined),
      }),
    );

    expect(registry.hasSubscribers('beforeStepPrompt')).toBe(true);
    expect(registry.hasSubscribers('shouldRetryPhase')).toBe(true);
    expect(registry.hasSubscribers('onPhaseSettled')).toBe(true);
  });

  it('registers an array of functions under a single hook name', () => {
    const { callbacks } = makeRecordingStore();
    const a = mock(() => undefined);
    const b = mock(() => undefined);
    const { registry } = composeHooks(callbacks, asHooks({ beforeStepPrompt: [a, b] }));

    expect(registry.hasSubscribers('beforeStepPrompt')).toBe(true);
  });

  it('normalizes an ARRAY of providers (HookProvider = WorkflowHooks | WorkflowHooks[])', () => {
    const { callbacks } = makeRecordingStore();
    const providers: HookProvider = [
      asHooks({ beforeStepPrompt: mock(() => undefined) }),
      asHooks({ shouldRetryPhase: mock(() => undefined) }),
    ];
    const { registry } = composeHooks(callbacks, providers);

    expect(registry.hasSubscribers('beforeStepPrompt')).toBe(true);
    expect(registry.hasSubscribers('shouldRetryPhase')).toBe(true);
  });

  it('accumulates subscribers for the same hook across multiple providers (no overwrite)', async () => {
    const { callbacks } = makeRecordingStore();
    const a = mock(() => undefined);
    const b = mock(() => undefined);
    const { registry } = composeHooks(callbacks, [asHooks({ beforeStepPrompt: a }), asHooks({ beforeStepPrompt: b })]);

    expect(registry.hasSubscribers('beforeStepPrompt')).toBe(true);
    // Both subscribers are registered — verify by fanning out via the registry
    // (the hook is auto-declared 'observe' by register()).
    await registry.invokeObserve(hookName('beforeStepPrompt'), undefined, makeCtx(registry));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('registers influence hooks that are invokable via the registry', async () => {
    const { callbacks } = makeRecordingStore();
    const seen: unknown[] = [];
    const { registry } = composeHooks(callbacks, asHooks({ beforeStepPrompt: (args: unknown) => seen.push(args) }));

    const args = { prompt: 'hello' };
    await registry.invokeObserve(hookName('beforeStepPrompt'), args, makeCtx(registry));

    expect(seen).toEqual([args]);
  });

  it('an empty provider object ({}) yields a registry with no subscribers', () => {
    const { callbacks } = makeRecordingStore();
    const { registry } = composeHooks(callbacks, {});

    expect(registry.hasSubscribers('beforeStepPrompt')).toBe(false);
    expect(registry.hasSubscribers('anyHook')).toBe(false);
  });

  it('an empty provider array ([]) yields a registry with no subscribers', () => {
    const { callbacks } = makeRecordingStore();
    const { registry } = composeHooks(callbacks, []);

    expect(registry.hasSubscribers('beforeStepPrompt')).toBe(false);
  });

  it('each composeHooks call returns a fresh, independent registry (no shared state)', () => {
    const { callbacks } = makeRecordingStore();
    const { registry: regA } = composeHooks(callbacks, asHooks({ beforeStepPrompt: mock(() => undefined) }));
    const { registry: regB } = composeHooks(callbacks, {});

    expect(regA).not.toBe(regB);
    expect(regA.hasSubscribers('beforeStepPrompt')).toBe(true);
    expect(regB.hasSubscribers('beforeStepPrompt')).toBe(false);
  });
});

// ── (c) store callbacks always fire even when influence hooks are registered ─

describe('(c) store callbacks always fire even when influence hooks are registered', () => {
  it('a store callback fires on onStatus even when an influence hook is also registered', () => {
    const { callbacks, calls } = makeRecordingStore();
    const influence = mock(() => undefined);
    const { onStatus } = composeHooks(callbacks, asHooks({ beforeStepPrompt: influence }));

    const info = { taskPrompt: 't', resumed: false, workDir: '/w' };
    onStatus.onWorkflowStart?.(info);

    // The store is the source of truth — it MUST have recorded the call,
    // even though an influence hook was registered alongside it.
    expect(calls.onWorkflowStart).toHaveLength(1);
    expect(calls.onWorkflowStart[0][0]).toBe(info);
  });

  it('the store fires for ALL 21 status methods while influence hooks are registered', () => {
    const { callbacks, calls } = makeRecordingStore();
    const { onStatus } = composeHooks(
      callbacks,
      asHooks({
        beforeStepPrompt: mock(() => undefined),
        shouldRetryPhase: mock(() => undefined),
        onPhaseSettled: mock(() => undefined),
      }),
    );

    for (const name of STATUS_CALLBACK_METHODS) {
      (onStatus as Record<string, (info: unknown) => void>)[name]!({ __method: name });
    }

    // Every store method fired exactly once — influence hooks never suppress
    // or replace store callbacks.
    for (const name of STATUS_CALLBACK_METHODS) {
      expect(calls[name]).toHaveLength(1);
    }
  });

  it('influence hooks do NOT fire from within onStatus (deferred to engine primitives)', () => {
    // Pin the documented "simpler approach": observe/influence subscribers are
    // NOT invoked when onStatus fires — they live only in the registry, to be
    // invoked by engine primitives (runStep / LanePool / PhaseRunner) that own
    // a HookContext. Register a subscriber under the SAME name as a status
    // callback to prove onStatus does not fan into the registry.
    const order: string[] = [];
    const store = {
      onWorkflowStart: () => order.push('store'),
    } as unknown as StatusCallbacks;
    const hookSubscriber = mock(() => order.push('hook'));

    const { onStatus, registry } = composeHooks(store, asHooks({ onWorkflowStart: hookSubscriber }));

    onStatus.onWorkflowStart?.({ taskPrompt: '', resumed: false, workDir: '' });

    // Store fired (source of truth); the registry subscriber was NOT invoked
    // from within onStatus.
    expect(order).toEqual(['store']);
    expect(hookSubscriber).not.toHaveBeenCalled();
    // ...but it IS registered in the registry, available to engine primitives.
    expect(registry.hasSubscribers('onWorkflowStart')).toBe(true);
  });

  it('store callbacks fire even when influence hooks are provided as an array of providers', () => {
    const { callbacks, calls } = makeRecordingStore();
    const { onStatus } = composeHooks(callbacks, [
      asHooks({ beforeStepPrompt: mock(() => undefined) }),
      asHooks({ shouldRetryPhase: mock(() => undefined) }),
    ]);

    const info = { phase: 'scouting', round: 2 };
    onStatus.onPhaseStart?.(info);

    expect(calls.onPhaseStart).toHaveLength(1);
    expect(calls.onPhaseStart[0][0]).toBe(info);
  });
});
