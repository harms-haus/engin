// ─── Hook mechanism type-contract tests ────────────────────────────────────
//
// These tests pin the EXACT structural shape of the hook MECHANISM types
// defined in packages/engine/src/hooks/types.ts. This is step 1 of the hook
// system (see hooks.prompt.md §10): it introduces the mechanism ONLY — no
// specific hook signatures (beforeStepPrompt, onPhaseSettled, …) exist yet.
// Those arrive incrementally via declaration merging on WorkflowHooks in
// later tasks.
//
// The contract under test:
//
//   export type CompositionRule =
//     | 'observe' | 'pipeline' | 'first-wins' | 'all-run';
//
//   export interface HookContext {
//     registry: HookRegistry;
//     cwd: string;
//     workDir: string;
//     signal?: AbortSignal;
//   }
//
//   export type ObserveHook<Args> =
//     (args: Args, ctx: HookContext) => void | Promise<void>;
//   export type PipelineHook<Value, Args> =
//     (value: Value, args: Args, ctx: HookContext) => Value | Promise<Value>;
//   export type FirstWinsHook<Result, Args> =
//     (args: Args, ctx: HookContext) => Result | undefined | Promise<Result | undefined>;
//   export type AllRunHook<Contribution, Args> =
//     (args: Args, ctx: HookContext) => Contribution | Promise<Contribution>;
//
//   export interface HookDefinition {
//     name: string;
//     rule: CompositionRule;
//     reducer?: (acc: unknown, next: unknown) => unknown; // required for 'all-run'
//   }
//
//   export interface HookRegistry {
//     register(hooks: WorkflowHooks): void;
//     invokeObserve<K extends keyof WorkflowHooks>(name: K, args: unknown, ctx: HookContext): Promise<void>;
//     invokePipeline<K extends keyof WorkflowHooks>(name: K, initialValue: unknown, args: unknown, ctx: HookContext): Promise<unknown>;
//     invokeFirstWins<K extends keyof WorkflowHooks>(name: K, args: unknown, ctx: HookContext): Promise<unknown | undefined>;
//     invokeAllRun<K extends keyof WorkflowHooks>(name: K, args: unknown, ctx: HookContext): Promise<unknown>;
//     hasSubscribers(name: string): boolean;
//   }
//
//   /** Registry of workflow-provided hooks. Grows incrementally … */
//   export interface WorkflowHooks {}
//
//   export type HookProvider = WorkflowHooks | WorkflowHooks[];
//
// Both compile-time (Equal<X,Y> + assertEqual, the pattern from
// tests/core/types.test.ts) and runtime checks are exercised. The compile-time
// checks are enforced by `tsc --noEmit` on this file; the runtime checks run
// under `bun test`.

import { describe, expect, it } from 'bun:test';
import type {
  AllRunHook,
  CompositionRule,
  FirstWinsHook,
  HookContext,
  HookDefinition,
  HookProvider,
  HookRegistry,
  ObserveHook,
  PipelineHook,
  WorkflowHooks,
} from '../../packages/engine/src/hooks/types.js';

// ─── Type-level exact equality utility ─────────────────────────────────────
// Resolves to `true` iff X and Y are structurally identical (catches extra /
// missing fields, optionality, type changes, and — verified separately —
// divergent generic-method signatures on interfaces).

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// ─── Independent "expected" copies ─────────────────────────────────────────
// Defined WITHOUT aliasing the imported types where it matters, so each
// Equal<Imported, Expected> comparison is a genuine structural check rather
// than identity.

type ExpectedCompositionRule = 'observe' | 'pipeline' | 'first-wins' | 'all-run';

interface ExpectedHookContext {
  registry: HookRegistry;
  cwd: string;
  workDir: string;
  signal?: AbortSignal;
}

type ExpectedObserveHook<Args> = (args: Args, ctx: HookContext) => void | Promise<void>;
type ExpectedPipelineHook<Value, Args> = (value: Value, args: Args, ctx: HookContext) => Value | Promise<Value>;
type ExpectedFirstWinsHook<Result, Args> = (
  args: Args,
  ctx: HookContext,
) => Result | undefined | Promise<Result | undefined>;
type ExpectedAllRunHook<Contribution, Args> = (args: Args, ctx: HookContext) => Contribution | Promise<Contribution>;

interface ExpectedHookDefinition {
  name: string;
  rule: CompositionRule;
  reducer?: (acc: unknown, next: unknown) => unknown;
}

interface ExpectedHookRegistry {
  register(hooks: WorkflowHooks): void;
  invokeObserve<K extends keyof WorkflowHooks>(name: K, args: unknown, ctx: HookContext): Promise<void>;
  invokePipeline<K extends keyof WorkflowHooks>(
    name: K,
    initialValue: unknown,
    args: unknown,
    ctx: HookContext,
  ): Promise<unknown>;
  invokeFirstWins<K extends keyof WorkflowHooks>(
    name: K,
    args: unknown,
    ctx: HookContext,
  ): Promise<unknown | undefined>;
  invokeAllRun<K extends keyof WorkflowHooks>(name: K, args: unknown, ctx: HookContext): Promise<unknown>;
  hasSubscribers(name: string): boolean;
  clone(): ExpectedHookRegistry;
}

// ─── Compile-time structural equality assertions ───────────────────────────

assertEqual<Equal<CompositionRule, ExpectedCompositionRule>>('CompositionRule is exactly the four-rule union');
assertEqual<Equal<HookContext['registry'], HookRegistry>>('HookContext.registry is typed as HookRegistry');
assertEqual<Equal<HookContext, ExpectedHookContext>>('HookContext shape is unchanged');
assertEqual<Equal<ObserveHook<{ msg: string }>, ExpectedObserveHook<{ msg: string }>>>(
  'ObserveHook<Args> shape is unchanged',
);
assertEqual<Equal<PipelineHook<string, number>, ExpectedPipelineHook<string, number>>>(
  'PipelineHook<Value, Args> shape is unchanged',
);
assertEqual<Equal<FirstWinsHook<boolean, { q: string }>, ExpectedFirstWinsHook<boolean, { q: string }>>>(
  'FirstWinsHook<Result, Args> shape is unchanged',
);
assertEqual<Equal<AllRunHook<string[], { tag: number }>, ExpectedAllRunHook<string[], { tag: number }>>>(
  'AllRunHook<Contribution, Args> shape is unchanged',
);
assertEqual<Equal<HookDefinition, ExpectedHookDefinition>>('HookDefinition shape is unchanged');
assertEqual<Equal<HookRegistry, ExpectedHookRegistry>>('HookRegistry interface matches the expected signatures');
assertEqual<Equal<HookProvider, WorkflowHooks | WorkflowHooks[]>>('HookProvider is WorkflowHooks | WorkflowHooks[]');
// NOTE: `WorkflowHooks` is no longer pinned to `{}` here. The mechanism-only
// step left it empty, but later tasks grow it via declaration merging (the
// workflow-level hooks onWorkflowResume / onWorkflowAbort / onPersist /
// onRestore / beforeRunMerge / onRunMergeConflict are added by the
// workflow-level-hooks task). The exhaustive structural contract for those
// fields lives in tests/hooks/workflow-hooks.test.ts; this file pins only the
// MECHANISM types (CompositionRule, HookContext, the four hook-function
// shapes, HookDefinition, HookRegistry).

// Bidirectional assignability for HookRegistry — the gold-standard structural
// equality check for an interface with generic methods. If both lines compile,
// HookRegistry ⊆ ExpectedHookRegistry and vice versa.
const _registryAsExpected: ExpectedHookRegistry = null as unknown as HookRegistry;
const _expectedAsRegistry: HookRegistry = null as unknown as ExpectedHookRegistry;
void _registryAsExpected;
void _expectedAsRegistry;

// ─── Runtime helpers ───────────────────────────────────────────────────────

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: {} as HookRegistry,
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

/**
 * A class that `implements HookRegistry`. The `implements` clause is itself a
 * compile-time contract: if any HookRegistry method signature changes, this
 * class stops compiling. It also gives the runtime tests a concrete instance
 * to exercise the register / hasSubscribers / invoke* return shapes against.
 */
class FakeRegistry implements HookRegistry {
  readonly registered: WorkflowHooks[] = [];

  register(hooks: WorkflowHooks): void {
    this.registered.push(hooks);
  }

  async invokeObserve<K extends keyof WorkflowHooks>(_name: K, _args: unknown, _ctx: HookContext): Promise<void> {
    /* no-op observe fan-out */
  }

  async invokePipeline<K extends keyof WorkflowHooks>(
    _name: K,
    initialValue: unknown,
    _args: unknown,
    _ctx: HookContext,
  ): Promise<unknown> {
    return initialValue;
  }

  async invokeFirstWins<K extends keyof WorkflowHooks>(
    _name: K,
    _args: unknown,
    _ctx: HookContext,
  ): Promise<unknown | undefined> {
    return undefined;
  }

  async invokeAllRun<K extends keyof WorkflowHooks>(_name: K, _args: unknown, _ctx: HookContext): Promise<unknown> {
    return [];
  }

  hasSubscribers(_name: string): boolean {
    return false;
  }

  clone(): HookRegistry {
    return new FakeRegistry();
  }
}

// ─── CompositionRule ───────────────────────────────────────────────────────

describe('CompositionRule', () => {
  it('contains exactly the four documented rules', () => {
    const rules: CompositionRule[] = ['observe', 'pipeline', 'first-wins', 'all-run'];
    expect(rules).toHaveLength(4);
    expect(new Set(rules).size).toBe(4);
  });

  it('every member is a string literal', () => {
    const rules: CompositionRule[] = ['observe', 'pipeline', 'first-wins', 'all-run'];
    for (const rule of rules) {
      expect(typeof rule).toBe('string');
    }
  });

  it('rejects strings outside the union at compile time', () => {
    // The union is CLOSED — the Equal assertion above is the strict guard.
    // The directive below documents that an unknown rule string is a type error.
    // @ts-expect-error — 'concat' is not a member of CompositionRule
    const bad: CompositionRule = 'concat';
    expect(bad as string).toBe('concat');
  });

  it('every rule is a valid HookDefinition.rule value', () => {
    // CompositionRule feeds HookDefinition.rule, so each member must round-trip.
    const rules: CompositionRule[] = ['observe', 'pipeline', 'first-wins', 'all-run'];
    for (const rule of rules) {
      const def: HookDefinition = { name: `hook-${rule}`, rule };
      expect(def.rule).toBe(rule);
    }
  });
});

// ─── HookContext ───────────────────────────────────────────────────────────

describe('HookContext', () => {
  it('accepts a minimal object with registry, cwd, and workDir', () => {
    const ctx: HookContext = {
      registry: {} as HookRegistry,
      cwd: '/repo',
      workDir: '/repo/.engin/work/run-1',
    };
    expect(ctx.cwd).toBe('/repo');
    expect(ctx.workDir).toBe('/repo/.engin/work/run-1');
    expect(ctx.signal).toBeUndefined();
  });

  it('accepts an optional AbortSignal', () => {
    const ac = new AbortController();
    const ctx: HookContext = makeCtx({ signal: ac.signal });
    expect(ctx.signal).toBe(ac.signal);
    expect(ctx.signal?.aborted).toBe(false);
  });

  it('requires registry, cwd, and workDir (negative compile check)', () => {
    // @ts-expect-error — missing required fields cwd and workDir
    const bad: HookContext = { registry: {} as HookRegistry };
    expect(bad).toBeDefined();
  });

  it('treats signal as optional (omitting it is valid)', () => {
    const ctx: HookContext = makeCtx();
    expect('signal' in ctx).toBe(false);
  });
});

// ─── ObserveHook ───────────────────────────────────────────────────────────

describe('ObserveHook', () => {
  it('can be a synchronous function returning void', async () => {
    const seen: string[] = [];
    const hook: ObserveHook<{ msg: string }> = (args, _ctx) => {
      seen.push(args.msg);
    };
    const result = hook({ msg: 'hi' }, makeCtx());
    expect(seen).toEqual(['hi']);
    expect(result).toBeUndefined();
  });

  it('can be an async function returning Promise<void>', async () => {
    const hook: ObserveHook<{ msg: string }> = async (args) => {
      expect(args.msg).toBe('async');
    };
    const result = hook({ msg: 'async' }, makeCtx());
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('passes the HookContext as the second argument', async () => {
    const ctx = makeCtx({ cwd: '/custom' });
    let received: HookContext | undefined;
    const hook: ObserveHook<unknown> = (_args, c) => {
      received = c;
    };
    hook(undefined, ctx);
    expect(received).toBe(ctx);
    expect(received?.cwd).toBe('/custom');
  });
});

// ─── PipelineHook ──────────────────────────────────────────────────────────

describe('PipelineHook', () => {
  it('transforms a value synchronously and returns it', () => {
    const upper: PipelineHook<string, { meta: number }> = (value) => value.toUpperCase();
    expect(upper('hello', { meta: 1 }, makeCtx())).toBe('HELLO');
  });

  it('can return a Promise of the transformed value', async () => {
    const doubler: PipelineHook<number, unknown> = async (value) => value * 2;
    await expect(doubler(3, undefined, makeCtx())).resolves.toBe(6);
  });

  it('receives value, args, and ctx in order', () => {
    const capture: Array<{ v: string; a: number; c: string }> = [];
    const hook: PipelineHook<string, number> = (value, args, ctx) => {
      capture.push({ v: value, a: args, c: ctx.cwd });
      return value;
    };
    hook('v', 9, makeCtx({ cwd: '/p' }));
    expect(capture).toEqual([{ v: 'v', a: 9, c: '/p' }]);
  });
});

// ─── FirstWinsHook ─────────────────────────────────────────────────────────

describe('FirstWinsHook', () => {
  it('can return a defined result (the winner)', () => {
    const hook: FirstWinsHook<string, unknown> = () => 'winner';
    expect(hook(undefined, makeCtx())).toBe('winner');
  });

  it('can return undefined to abstain', () => {
    const hook: FirstWinsHook<string, unknown> = () => undefined;
    expect(hook(undefined, makeCtx())).toBeUndefined();
  });

  it('can resolve to a Promise<Result | undefined>', async () => {
    const hook: FirstWinsHook<number, unknown> = async () => 42;
    await expect(hook(undefined, makeCtx())).resolves.toBe(42);
  });

  it('can resolve to a Promise<undefined>', async () => {
    const hook: FirstWinsHook<number, unknown> = async () => undefined;
    await expect(hook(undefined, makeCtx())).resolves.toBeUndefined();
  });
});

// ─── AllRunHook ────────────────────────────────────────────────────────────

describe('AllRunHook', () => {
  it('contributes a value synchronously', () => {
    const hook: AllRunHook<string, unknown> = () => 'contrib';
    expect(hook(undefined, makeCtx())).toBe('contrib');
  });

  it('can contribute a Promise<Contribution>', async () => {
    const hook: AllRunHook<number, unknown> = async () => 7;
    await expect(hook(undefined, makeCtx())).resolves.toBe(7);
  });
});

// ─── HookDefinition ────────────────────────────────────────────────────────

describe('HookDefinition', () => {
  it('accepts name + rule without a reducer', () => {
    const def: HookDefinition = { name: 'onLog', rule: 'observe' };
    expect(def.name).toBe('onLog');
    expect(def.rule).toBe('observe');
    expect(def.reducer).toBeUndefined();
  });

  it('accepts every CompositionRule as the rule value', () => {
    const rules: CompositionRule[] = ['observe', 'pipeline', 'first-wins', 'all-run'];
    for (const rule of rules) {
      const def: HookDefinition = { name: `hook-${rule}`, rule };
      expect(def.rule).toBe(rule);
    }
  });

  it('accepts a reducer for an all-run hook', () => {
    const def: HookDefinition = {
      name: 'onPhaseSettled',
      rule: 'all-run',
      reducer: (acc: unknown, next: unknown) => [...((acc as unknown[]) ?? []), next],
    };
    expect(def.reducer!(undefined, 'x')).toEqual(['x']);
    expect(def.reducer!(['x'], 'y')).toEqual(['x', 'y']);
  });

  it('reducer is typed (acc: unknown, next: unknown) => unknown', () => {
    const def: HookDefinition = {
      name: 'merge',
      rule: 'all-run',
      reducer: (acc, next) => ({ ...(acc as object), ...(next as object) }),
    };
    expect(def.reducer!({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('requires the name field (negative compile check)', () => {
    // @ts-expect-error — missing required `name`
    const bad: HookDefinition = { rule: 'observe' };
    expect(bad).toBeDefined();
  });

  it('requires the rule field (negative compile check)', () => {
    // @ts-expect-error — missing required `rule`
    const bad: HookDefinition = { name: 'onLog' };
    expect(bad).toBeDefined();
  });

  it('rejects an unknown rule string (negative compile check)', () => {
    // @ts-expect-error — rule must be a CompositionRule member
    const bad: HookDefinition = { name: 'onLog', rule: 'concat' };
    expect(bad).toBeDefined();
  });
});

// ─── HookRegistry interface ────────────────────────────────────────────────

describe('HookRegistry interface', () => {
  it('can be implemented by a structurally-conforming class', () => {
    const reg: HookRegistry = new FakeRegistry();
    expect(reg).toBeInstanceOf(FakeRegistry);
  });

  it('exposes register and the four invoke* methods plus hasSubscribers', () => {
    const reg: HookRegistry = new FakeRegistry();
    expect(typeof reg.register).toBe('function');
    expect(typeof reg.invokeObserve).toBe('function');
    expect(typeof reg.invokePipeline).toBe('function');
    expect(typeof reg.invokeFirstWins).toBe('function');
    expect(typeof reg.invokeAllRun).toBe('function');
    expect(typeof reg.hasSubscribers).toBe('function');
  });

  it('register accepts a WorkflowHooks object and returns void', () => {
    const reg = new FakeRegistry();
    const hooks: WorkflowHooks = {};
    expect(reg.register(hooks)).toBeUndefined();
    expect(reg.registered).toHaveLength(1);
    expect(reg.registered[0]).toBe(hooks);
  });

  it('hasSubscribers returns a boolean', () => {
    const reg = new FakeRegistry();
    const result = reg.hasSubscribers('onLog');
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false);
  });

  it('invokeObserve returns a Promise<void>', async () => {
    const reg: HookRegistry = new FakeRegistry();
    // This file pins the MECHANISM only — we don't assume any particular hook
    // name here, so the name is cast through `never` (works regardless of
    // which concrete hooks later tasks add via declaration merging on
    // WorkflowHooks). At runtime the original value is what gets passed.
    const p = reg.invokeObserve(undefined as never, undefined, makeCtx());
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBeUndefined();
  });

  it('invokePipeline returns a Promise<unknown>', async () => {
    const reg: HookRegistry = new FakeRegistry();
    const p = reg.invokePipeline(undefined as never, 'seed', undefined, makeCtx());
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBe('seed');
  });

  it('invokeFirstWins returns a Promise<unknown | undefined>', async () => {
    const reg: HookRegistry = new FakeRegistry();
    const p = reg.invokeFirstWins(undefined as never, undefined, makeCtx());
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBeUndefined();
  });

  it('invokeAllRun returns a Promise<unknown>', async () => {
    const reg: HookRegistry = new FakeRegistry();
    const p = reg.invokeAllRun(undefined as never, undefined, makeCtx());
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toEqual([]);
  });
});

// ─── WorkflowHooks ─────────────────────────────────────────────────────────

describe('WorkflowHooks', () => {
  it('accepts an empty object literal (every declared field is optional)', () => {
    // WorkflowHooks grows incrementally via declaration merging — each
    // hook-adding task appends an OPTIONAL field, so an empty object literal
    // always remains a valid value (the backward-compat guarantee that the
    // task-24 defaults rely on). This assertion holds both BEFORE and AFTER
    // any specific hook field is added, which is why the mechanism test does
    // NOT pin specific field names here — those live in dedicated suites
    // (e.g. tests/hooks/workflow-hooks.test.ts).
    const hooks: WorkflowHooks = {};
    expect(hooks).toEqual({});
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('is structural so unrelated empty objects satisfy it', () => {
    const obj = Object.create(null);
    const hooks: WorkflowHooks = obj;
    expect(hooks).toBe(obj);
  });
});

// ─── HookProvider ──────────────────────────────────────────────────────────

describe('HookProvider', () => {
  it('accepts a single WorkflowHooks object', () => {
    const provider: HookProvider = {};
    expect(provider).toEqual({});
    expect(Array.isArray(provider)).toBe(false);
  });

  it('accepts an array of WorkflowHooks objects', () => {
    const a: WorkflowHooks = {};
    const b: WorkflowHooks = {};
    const provider: HookProvider = [a, b];
    expect(Array.isArray(provider)).toBe(true);
    expect(provider).toHaveLength(2);
  });

  it('accepts an empty array', () => {
    const provider: HookProvider = [];
    expect(provider).toHaveLength(0);
  });

  it('rejects null under strict null checks (WorkflowHooks excludes it)', () => {
    // The empty interface {} accepts any *non-null* object, so arbitrary
    // objects (and even numbers) ARE assignable while the interface is empty.
    // What is genuinely rejected is null — pinning that HookProvider never
    // implicitly admits a "no hooks" null sentinel. (An array literal like
    // [null] still satisfies the WorkflowHooks arm of the union and so cannot
    // be negative-tested here; the bare-null form is the discriminating case.)
    // @ts-expect-error — null is not assignable to WorkflowHooks | WorkflowHooks[]
    const nope: HookProvider = null;
    void nope;
  });
});

// ─── Module load surface ───────────────────────────────────────────────────

describe('module surface', () => {
  it('is a loadable module with only type-level exports (no runtime circular dep)', async () => {
    // types.ts exports interfaces and type aliases only. The HookContext
    // forward reference to HookRegistry is type-only and erased at runtime, so
    // importing the module must succeed even though registry.js (task-3) does
    // not exist yet. The resulting namespace is an object with no value exports.
    const mod = await import('../../packages/engine/src/hooks/types.js');
    expect(mod).toBeTypeOf('object');
    expect(Object.keys(mod)).toEqual([]);
  });
});
