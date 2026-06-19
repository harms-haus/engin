// ─── PhaseRunner type-contract tests ───────────────────────────────────────
//
// These tests pin the three new types introduced in
// packages/engine/src/core/phase-runner.ts:
//
//   export interface PhaseDefinition {
//     id: string;
//     label: string;
//     icon: string;
//     run: (ctx: PhaseRunContext) => Promise<unknown>;
//   }
//
//   export interface PhaseRunContext {
//     tracker: WorkflowStatusTracker;
//     hookRegistry?: HookRegistry;
//     state: Record<string, unknown>; // mutable state shared across phases
//     cwd: string;
//     workDir: string;
//     signal?: AbortSignal;
//     // ... forwarded options
//   }
//
//   export interface PhaseRunnerOptions {
//     phases: PhaseDefinition[];
//     tracker: WorkflowStatusTracker;
//     hookRegistry?: HookRegistry;
//     cwd: string;
//     workDir: string;
//     signal?: AbortSignal;
//     maxRounds?: number; // default 3 — reproduces the ≤3-rounds logic
//   }
//
// `WorkflowStatusTracker` is imported from ../tracking/workflow-status.js and
// `HookRegistry` (type-only) from ../hooks/types.js. The type-only HookRegistry
// reference keeps phase-runner.ts free of a runtime dependency on the registry
// implementation.
//
// PhaseDefinition and PhaseRunnerOptions are fully specified interfaces → pinned
// with exact structural equality. PhaseRunContext carries a documented
// "// ... forwarded options" tail, so it is pinned PER-FIELD (robust to extra
// OPTIONAL forwarded fields) rather than as a whole-object equality.
//
// Like tests/hooks/types.test.ts and tests/hooks/workflow-hooks.test.ts, this
// file mixes compile-time exact-equality assertions (enforced by `tsc --noEmit`)
// with runtime checks (enforced by `bun test`). NOTE: because phase-runner.ts
// is not yet created, the compile-time assertions are currently RED; they go
// GREEN once the spec is implemented.

import { describe, expect, it } from 'bun:test';
import type {
  PhaseDefinition,
  PhaseRunContext,
  PhaseRunnerOptions,
} from '../../packages/engine/src/core/phase-runner.js';
import type { HookContext, HookRegistry, WorkflowHooks } from '../../packages/engine/src/hooks/types.js';
import { WorkflowStatusTracker } from '../../packages/engine/src/tracking/workflow-status.js';

// ─── Type-level exact equality utility ─────────────────────────────────────

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// ─── Compile-time assertions ───────────────────────────────────────────────
// PhaseDefinition and PhaseRunnerOptions are complete (no trailing "..."), so
// we assert EXACT structural equality against independent expected copies.

interface ExpectedPhaseDefinition {
  id: string;
  label: string;
  icon: string;
  run: (ctx: PhaseRunContext) => Promise<unknown>;
}

interface ExpectedPhaseRunnerOptions {
  phases: PhaseDefinition[];
  tracker: WorkflowStatusTracker;
  hookRegistry?: HookRegistry;
  cwd: string;
  workDir: string;
  signal?: AbortSignal;
  maxRounds?: number;
}

assertEqual<Equal<PhaseDefinition, ExpectedPhaseDefinition>>('PhaseDefinition exact shape');
assertEqual<Equal<PhaseRunnerOptions, ExpectedPhaseRunnerOptions>>('PhaseRunnerOptions exact shape');

// PhaseRunContext carries a documented "// ... forwarded options" tail, so we
// pin EACH declared field (presence + exact type) rather than asserting the
// whole object is minimal — extra OPTIONAL forwarded fields must not break this.

assertEqual<Equal<'tracker' extends keyof PhaseRunContext ? true : false, true>>('PhaseRunContext.tracker present');
assertEqual<Equal<PhaseRunContext['tracker'], WorkflowStatusTracker>>('PhaseRunContext.tracker: WorkflowStatusTracker');

assertEqual<Equal<'hookRegistry' extends keyof PhaseRunContext ? true : false, true>>(
  'PhaseRunContext.hookRegistry present',
);
assertEqual<Equal<PhaseRunContext['hookRegistry'], HookRegistry | undefined>>(
  'PhaseRunContext.hookRegistry is optional HookRegistry',
);

assertEqual<Equal<'state' extends keyof PhaseRunContext ? true : false, true>>('PhaseRunContext.state present');
assertEqual<Equal<PhaseRunContext['state'], Record<string, unknown>>>('PhaseRunContext.state: Record<string, unknown>');

assertEqual<Equal<'cwd' extends keyof PhaseRunContext ? true : false, true>>('PhaseRunContext.cwd present');
assertEqual<Equal<PhaseRunContext['cwd'], string>>('PhaseRunContext.cwd: string');

assertEqual<Equal<'workDir' extends keyof PhaseRunContext ? true : false, true>>('PhaseRunContext.workDir present');
assertEqual<Equal<PhaseRunContext['workDir'], string>>('PhaseRunContext.workDir: string');

assertEqual<Equal<'signal' extends keyof PhaseRunContext ? true : false, true>>('PhaseRunContext.signal present');
assertEqual<Equal<PhaseRunContext['signal'], AbortSignal | undefined>>(
  'PhaseRunContext.signal is optional AbortSignal',
);

// ─── Runtime helpers ───────────────────────────────────────────────────────

/**
 * A minimal structurally-conforming HookRegistry. The `implements` clause is a
 * compile-time contract (any HookRegistry signature drift breaks this class);
 * the instance gives runtime tests a concrete value to assign to the optional
 * `hookRegistry` fields. Mirrors FakeRegistry in tests/hooks/types.test.ts.
 */
class FakeRegistry implements HookRegistry {
  readonly registered: unknown[] = [];

  register(hooks: unknown): void {
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
    return undefined;
  }

  hasSubscribers(_name: string): boolean {
    return false;
  }
}

/**
 * A placeholder tracker value for the `PhaseRunContext.tracker` /
 * `PhaseRunnerOptions.tracker` fields. The TYPE contract (`tracker:
 * WorkflowStatusTracker`) is pinned by the `Equal<PhaseRunContext['tracker'],
 * WorkflowStatusTracker>` assertion above; this cast supplies a runtime value
 * without constructing a real tracker (which would touch the filesystem via its
 * AuditLog). Same pattern as `registry: {} as HookRegistry` in the sibling
 * type-contract suites.
 */
function fakeTracker(): WorkflowStatusTracker {
  return {} as WorkflowStatusTracker;
}

/** Build a PhaseRunContext with all the declared required fields filled in. */
function makeRunContext(overrides: Partial<PhaseRunContext> = {}): PhaseRunContext {
  return {
    tracker: fakeTracker(),
    hookRegistry: new FakeRegistry(),
    state: {},
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

/** Build a minimal valid PhaseDefinition whose run resolves to a sentinel. */
function makePhase(
  overrides: Partial<Omit<PhaseDefinition, 'run'>> & { run?: PhaseDefinition['run'] } = {},
): PhaseDefinition {
  return {
    id: 'plan',
    label: 'Plan',
    icon: '🗺️',
    run: async () => 'phase-done',
    ...overrides,
  };
}

/** Build a minimal valid PhaseRunnerOptions. */
function makeOptions(overrides: Partial<PhaseRunnerOptions> = {}): PhaseRunnerOptions {
  return {
    phases: [makePhase()],
    tracker: fakeTracker(),
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

// ─── PhaseDefinition ───────────────────────────────────────────────────────

describe('PhaseDefinition', () => {
  it('accepts a minimal phase with id, label, icon, and an async run', () => {
    const phase = makePhase();
    expect(phase.id).toBe('plan');
    expect(phase.label).toBe('Plan');
    expect(phase.icon).toBe('🗺️');
    expect(typeof phase.run).toBe('function');
  });

  it('run receives a PhaseRunContext and returns a Promise', async () => {
    const phase = makePhase({
      run: async (ctx) => {
        expect(ctx.cwd).toBe('/repo');
        return { ok: true };
      },
    });
    const result = phase.run(makeRunContext());
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('run may return any value (Promise<unknown>) — e.g. a string', async () => {
    const phase = makePhase({ run: async () => 'settled' });
    await expect(phase.run(makeRunContext())).resolves.toBe('settled');
  });

  it('requires id (negative compile check)', () => {
    // @ts-expect-error — missing required `id`
    const bad: PhaseDefinition = { label: 'Plan', icon: 'x', run: async () => undefined };
    void bad;
  });

  it('requires label and icon (negative compile check)', () => {
    // @ts-expect-error — missing required `label` and `icon`
    const bad: PhaseDefinition = { id: 'plan', run: async () => undefined };
    void bad;
  });

  it('requires run (negative compile check)', () => {
    // @ts-expect-error — missing required `run`
    const bad: PhaseDefinition = { id: 'plan', label: 'Plan', icon: 'x' };
    void bad;
  });

  it('rejects a synchronous run (must return a Promise) (negative compile check)', () => {
    // @ts-expect-error — run must return Promise<unknown>, not a bare value
    const bad: PhaseDefinition = { id: 'plan', label: 'Plan', icon: 'x', run: () => 'sync' };
    void bad;
  });
});

// ─── PhaseRunContext ───────────────────────────────────────────────────────

describe('PhaseRunContext', () => {
  it('accepts an object with the declared fields (tracker, state, cwd, workDir)', () => {
    const ctx = makeRunContext();
    expect(ctx.tracker).toBeDefined();
    expect(ctx.state).toEqual({});
    expect(ctx.cwd).toBe('/repo');
    expect(ctx.workDir).toBe('/repo/.engin/work/run-1');
  });

  it('hookRegistry is optional — a context without it is valid', () => {
    const ctx: PhaseRunContext = {
      tracker: fakeTracker(),
      state: {},
      cwd: '/repo',
      workDir: '/repo/.engin/work/run-1',
    };
    expect(ctx.hookRegistry).toBeUndefined();
  });

  it('accepts a concrete HookRegistry instance for hookRegistry', () => {
    const registry: HookRegistry = new FakeRegistry();
    const ctx = makeRunContext({ hookRegistry: registry });
    expect(ctx.hookRegistry).toBe(registry);
  });

  it('signal is optional — a context without it is valid', () => {
    const ctx = makeRunContext();
    expect(ctx.signal).toBeUndefined();
  });

  it('accepts an AbortSignal for signal', () => {
    const ac = new AbortController();
    const ctx = makeRunContext({ signal: ac.signal });
    expect(ctx.signal).toBe(ac.signal);
    expect(ctx.signal?.aborted).toBe(false);
  });

  it('state is the mutable bag shared across phases (can carry arbitrary keys)', () => {
    const ctx = makeRunContext({ state: { count: 3, names: ['a'], nested: { x: 1 } } });
    // Mutating state in place is the documented contract.
    ctx.state.count = 4;
    expect(ctx.state.count).toBe(4);
    expect(ctx.state.names).toEqual(['a']);
  });

  it('requires tracker (negative compile check)', () => {
    // @ts-expect-error — missing required `tracker`
    const bad: PhaseRunContext = { state: {}, cwd: '/repo', workDir: '/repo/w' };
    void bad;
  });

  it('requires state (negative compile check)', () => {
    // @ts-expect-error — missing required `state`
    const bad: PhaseRunContext = { tracker: fakeTracker(), cwd: '/repo', workDir: '/repo/w' };
    void bad;
  });

  it('requires cwd and workDir (negative compile check)', () => {
    // @ts-expect-error — missing required `cwd` and `workDir`
    const bad: PhaseRunContext = { tracker: fakeTracker(), state: {} };
    void bad;
  });

  it('tracker is typed WorkflowStatusTracker (negative compile check)', () => {
    // @ts-expect-error — tracker must be a WorkflowStatusTracker, not a string
    const bad: PhaseRunContext = { tracker: 'nope', state: {}, cwd: '/repo', workDir: '/repo/w' };
    void bad;
  });
});

// ─── PhaseRunnerOptions ────────────────────────────────────────────────────

describe('PhaseRunnerOptions', () => {
  it('accepts a minimal options object (phases, tracker, cwd, workDir)', () => {
    const opts = makeOptions();
    expect(opts.phases).toHaveLength(1);
    expect(opts.maxRounds).toBeUndefined();
    expect(opts.hookRegistry).toBeUndefined();
    expect(opts.signal).toBeUndefined();
  });

  it('accepts the optional maxRounds (number)', () => {
    const opts = makeOptions({ maxRounds: 3 });
    expect(opts.maxRounds).toBe(3);
  });

  it('accepts optional hookRegistry and signal', () => {
    const ac = new AbortController();
    const opts = makeOptions({
      hookRegistry: new FakeRegistry(),
      signal: ac.signal,
      maxRounds: 5,
    });
    expect(opts.hookRegistry).toBeInstanceOf(FakeRegistry);
    expect(opts.signal).toBe(ac.signal);
    expect(opts.maxRounds).toBe(5);
  });

  it('phases is typed PhaseDefinition[] (negative compile check)', () => {
    // @ts-expect-error — phases must be PhaseDefinition[], not a string array
    const bad: PhaseRunnerOptions = {
      phases: ['not-a-phase'],
      tracker: fakeTracker(),
      cwd: '/repo',
      workDir: '/repo/w',
    };
    void bad;
  });

  it('requires phases (negative compile check)', () => {
    // @ts-expect-error — missing required `phases`
    const bad: PhaseRunnerOptions = { tracker: fakeTracker(), cwd: '/repo', workDir: '/repo/w' };
    void bad;
  });

  it('requires tracker (negative compile check)', () => {
    // @ts-expect-error — missing required `tracker`
    const bad: PhaseRunnerOptions = { phases: [], cwd: '/repo', workDir: '/repo/w' };
    void bad;
  });

  it('requires cwd and workDir (negative compile check)', () => {
    // @ts-expect-error — missing required `cwd` and `workDir`
    const bad: PhaseRunnerOptions = { phases: [], tracker: fakeTracker() };
    void bad;
  });

  it('maxRounds is typed number (negative compile check)', () => {
    // @ts-expect-error — maxRounds must be number, not a string
    const bad: PhaseRunnerOptions = {
      phases: [],
      tracker: fakeTracker(),
      cwd: '/repo',
      workDir: '/repo/w',
      maxRounds: 'three',
    };
    void bad;
  });

  it('hookRegistry, when present, must satisfy HookRegistry (negative compile check)', () => {
    // @ts-expect-error — hookRegistry must be a HookRegistry, not a plain object
    const bad: PhaseRunnerOptions = {
      phases: [],
      tracker: fakeTracker(),
      hookRegistry: {},
      cwd: '/repo',
      workDir: '/repo/w',
    };
    void bad;
  });
});

// ─── Module surface & cross-module imports ─────────────────────────────────

describe('module surface', () => {
  it('WorkflowStatusTracker is the imported class from tracking/workflow-status.js', () => {
    // Pin that phase-runner.ts reuses the REAL tracker type (not a redeclared
    // duplicate): the imported symbol is the same class the rest of the engine
    // constructs and persists.
    expect(typeof WorkflowStatusTracker).toBe('function');
    expect(WorkflowStatusTracker.name).toBe('WorkflowStatusTracker');
  });

  it('a PhaseDefinition.run can be invoked through a PhaseRunContext derived from PhaseRunnerOptions', async () => {
    // End-to-end wiring smoke test: build options, derive a run context from
    // them, and invoke the phase's run — the PhaseRunner's core interaction.
    // Proves tracker / cwd / state flow through from options → context → run.
    const opts = makeOptions({
      phases: [
        makePhase({
          run: async (ctx) => ({ cwd: ctx.cwd, hasTracker: typeof ctx.tracker === 'object' }),
        }),
      ],
      maxRounds: 3,
    });
    const ctx: PhaseRunContext = {
      tracker: opts.tracker,
      hookRegistry: opts.hookRegistry,
      state: {},
      cwd: opts.cwd,
      workDir: opts.workDir,
      signal: opts.signal,
    };
    const result = await opts.phases[0]!.run(ctx);
    expect(result).toEqual({ cwd: '/repo', hasTracker: true });
  });
});
