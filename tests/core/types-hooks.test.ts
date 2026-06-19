// ─── Type-contract tests: hooks integration on WorkflowModule / WorkflowRunOptions ─
//
// These tests pin the two hooks-related additions to packages/engine/src/core/types.ts:
//
//   1. A type-only import at the top of the file:
//        import type { HookRegistry, HookProvider, WorkflowHooks } from '../hooks/types.js';
//
//   2. An OPTIONAL `hooks` field on `WorkflowModule` (the PROVIDER side — the
//      workflow supplies hooks to the engine; mirrors the `registerRenderers`
//      pattern):
//        /** Optional workflow-provided hooks. … */
//        hooks?: HookProvider;
//
//   3. An OPTIONAL `hookRegistry` field on `WorkflowRunOptions` (the REGISTRY
//      side — the engine assembles it and forwards it to LanePool /
//      runStepTask / runMultiStepTask so engine primitives can invoke hooks):
//        /** The engine-assembled hook registry. … */
//        hookRegistry?: HookRegistry;
//
// Naming-direction contract (the prior review's collision fix): `hooks` lives
// ONLY on `WorkflowModule`; `hookRegistry` lives ONLY on `WorkflowRunOptions`.
// The two names must NEVER coexist on the same interface — `hookRegistry` was
// deliberately chosen (not `hooks`) on `WorkflowRunOptions` so the
// provider → registry direction is unambiguous.
//
// Both fields are OPTIONAL, so existing workflows that omit `hooks` and never
// read `hookRegistry` are unaffected.
//
// Like tests/hooks/types.test.ts and tests/core/types.test.ts, this file mixes
// compile-time exact-equality assertions (enforced by `tsc --noEmit` on this
// file) with runtime checks (enforced by `bun test`). NOTE: because the
// types.ts additions are not yet applied, the compile-time assertions are
// currently RED; they go GREEN once the spec is implemented.

import { describe, expect, it } from 'bun:test';
import type { WorkflowModule, WorkflowRunOptions } from '../../packages/engine/src/core/types.js';
import { STATUS_CALLBACK_METHODS } from '../../packages/engine/src/core/types.js';
import type { HookContext, HookProvider, HookRegistry, WorkflowHooks } from '../../packages/engine/src/hooks/types.js';

// ─── Type-level exact equality utility ─────────────────────────────────────
// Resolves to `true` iff X and Y are structurally identical (catches extra /
// missing fields, optionality, and type changes). Pattern from
// tests/core/types.test.ts and tests/hooks/types.test.ts.

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// ─── Compile-time field-presence & type assertions ─────────────────────────

// WorkflowModule.hooks — present, optional, typed HookProvider.
assertEqual<Equal<'hooks' extends keyof WorkflowModule ? true : false, true>>(
  'WorkflowModule declares a `hooks` field',
);
// Indexed access on an optional property yields `T | undefined`, so this also
// pins OPTIONALITY (a required `hooks: HookProvider` would resolve to just
// `HookProvider` and fail this assertion).
assertEqual<Equal<WorkflowModule['hooks'], HookProvider | undefined>>(
  'WorkflowModule.hooks is typed HookProvider and is optional',
);

// WorkflowRunOptions.hookRegistry — present, optional, typed HookRegistry.
assertEqual<Equal<'hookRegistry' extends keyof WorkflowRunOptions ? true : false, true>>(
  'WorkflowRunOptions declares a `hookRegistry` field',
);
assertEqual<Equal<WorkflowRunOptions['hookRegistry'], HookRegistry | undefined>>(
  'WorkflowRunOptions.hookRegistry is typed HookRegistry and is optional',
);

// Naming-direction / collision-avoidance contract (the IMPORTANT note).
assertEqual<Equal<'hooks' extends keyof WorkflowRunOptions ? true : false, false>>(
  'WorkflowRunOptions does NOT declare `hooks` (avoids collision with WorkflowModule.hooks)',
);
assertEqual<Equal<'hookRegistry' extends keyof WorkflowModule ? true : false, false>>(
  'WorkflowModule does NOT declare `hookRegistry` (it lives on WorkflowRunOptions)',
);

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
 * A minimal structurally-conforming HookRegistry. The `implements` clause is a
 * compile-time contract (any HookRegistry signature drift breaks this class),
 * and the instance gives runtime tests a concrete value to assign to
 * `WorkflowRunOptions.hookRegistry`.
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
}

/** A no-op `run` matching WorkflowModule.run's signature. */
function makeRun(): (taskPrompt: string, options: WorkflowRunOptions) => Promise<void> {
  return async () => {};
}

const BASE_OPTS = { cwd: '/repo', workDir: '/repo/.engin/work/run-1' } as const;

// ─── WorkflowModule.hooks (provider side) ──────────────────────────────────

describe('WorkflowModule.hooks (provider side)', () => {
  it('is optional — a module without `hooks` is still valid', () => {
    const mod: WorkflowModule = { run: makeRun() };
    expect(mod.hooks).toBeUndefined();
  });

  it('accepts a single WorkflowHooks object as the provider', () => {
    const hooks: WorkflowHooks = {};
    const mod: WorkflowModule = { run: makeRun(), hooks };
    expect(mod.hooks).toBe(hooks);
    expect(Array.isArray(mod.hooks)).toBe(false);
  });

  it('accepts an array of WorkflowHooks objects as the provider', () => {
    const a: WorkflowHooks = {};
    const b: WorkflowHooks = {};
    const mod: WorkflowModule = { run: makeRun(), hooks: [a, b] };
    expect(Array.isArray(mod.hooks)).toBe(true);
    expect(mod.hooks).toHaveLength(2);
  });

  it('accepts an empty array as the provider', () => {
    const mod: WorkflowModule = { run: makeRun(), hooks: [] };
    expect(mod.hooks).toHaveLength(0);
  });

  it('coexists with registerRenderers (parallel registration pattern)', () => {
    const mod: WorkflowModule = {
      run: makeRun(),
      registerRenderers: () => {},
      hooks: {},
    };
    expect(typeof mod.registerRenderers).toBe('function');
    expect(mod.hooks).toEqual({});
  });

  it('rejects null for `hooks` (negative compile check)', () => {
    // HookProvider = WorkflowHooks | WorkflowHooks[]. While the empty interface
    // admits arbitrary non-null objects, bare null is genuinely rejected — the
    // discriminating negative case.
    // @ts-expect-error — null is not assignable to HookProvider
    const mod: WorkflowModule = { run: makeRun(), hooks: null };
    expect(mod.hooks).toBeNull();
  });
});

// ─── WorkflowRunOptions.hookRegistry (registry side) ───────────────────────

describe('WorkflowRunOptions.hookRegistry (registry side)', () => {
  it('is optional — options without `hookRegistry` are still valid', () => {
    const opts: WorkflowRunOptions = { ...BASE_OPTS };
    expect(opts.hookRegistry).toBeUndefined();
  });

  it('accepts a HookRegistry instance', () => {
    const registry: HookRegistry = new FakeRegistry();
    const opts: WorkflowRunOptions = { ...BASE_OPTS, hookRegistry: registry };
    expect(opts.hookRegistry).toBe(registry);
    expect(opts.hookRegistry).toBeInstanceOf(FakeRegistry);
  });

  it('the HookRegistry can be invoked through the forwarded reference', async () => {
    const registry = new FakeRegistry();
    const opts: WorkflowRunOptions = { ...BASE_OPTS, hookRegistry: registry };
    // Exercise the registry the way an engine primitive (LanePool / runStepTask)
    // would after receiving hookRegistry via WorkflowRunOptions.
    opts.hookRegistry!.register({} as WorkflowHooks);
    const observed = await opts.hookRegistry!.invokeObserve(undefined as never, undefined, makeCtx());
    expect(observed).toBeUndefined();
    expect(registry.registered).toHaveLength(1);
  });

  it('rejects a plain object missing the HookRegistry methods (negative compile check)', () => {
    // @ts-expect-error — {} lacks register / invoke* / hasSubscribers
    const opts: WorkflowRunOptions = { ...BASE_OPTS, hookRegistry: {} };
    // The `@ts-expect-error` above pins the compile-time rejection. The
    // declared type stays `HookRegistry | undefined`, so cast the subject to
    // `unknown` for the runtime corroborating check (`{}` is the runtime value).
    expect(opts.hookRegistry as unknown).toEqual({});
  });

  it('rejects null for `hookRegistry` (negative compile check)', () => {
    // @ts-expect-error — null is not assignable to HookRegistry
    const opts: WorkflowRunOptions = { ...BASE_OPTS, hookRegistry: null };
    expect(opts.hookRegistry).toBeNull();
  });
});

// ─── Naming direction (provider vs registry) ───────────────────────────────

describe('naming direction — hooks vs hookRegistry', () => {
  it('`hooks` is supplied on WorkflowModule; `hookRegistry` is read from WorkflowRunOptions', () => {
    // Documents the documented wiring direction: the workflow PROVIDES hooks on
    // the module; the engine-assembled registry arrives via run options. The two
    // never live on the same object.
    const moduleWithHooks: WorkflowModule = { run: makeRun(), hooks: {} };
    const optionsWithRegistry: WorkflowRunOptions = {
      ...BASE_OPTS,
      hookRegistry: new FakeRegistry(),
    };

    // Provider lives on the module:
    expect(moduleWithHooks.hooks).toEqual({});
    // Registry lives on the options:
    expect(optionsWithRegistry.hookRegistry).toBeInstanceOf(FakeRegistry);
  });

  it('run() still receives WorkflowRunOptions; omitting hookRegistry typechecks and runs', () => {
    const mod: WorkflowModule = { run: makeRun(), hooks: {} };
    const opts: WorkflowRunOptions = { ...BASE_OPTS };
    expect(mod.hooks).toEqual({});
    expect(opts.hookRegistry).toBeUndefined();
  });
});

// ─── Module load surface ───────────────────────────────────────────────────

describe('src/core/types.js runtime surface', () => {
  it('remains a loadable module after adding the type-only hooks import', () => {
    // The new `import type { ... } from '../hooks/types.js'` is erased at
    // runtime, so it must NOT introduce a runtime dependency on a not-yet-shipped
    // registry implementation (registry.js ships in a later task). The module
    // must keep loading its value exports unchanged.
    expect(Array.isArray(STATUS_CALLBACK_METHODS)).toBe(true);
    expect(STATUS_CALLBACK_METHODS.length).toBeGreaterThan(0);
  });
});
