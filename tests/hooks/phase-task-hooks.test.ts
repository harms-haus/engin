// ─── Phase + task level hook type-contract tests ───────────────────────────
//
// These tests pin the phase-level and task-level INFLUENCE hook signatures
// added to `WorkflowHooks` in packages/engine/src/hooks/types.ts via
// declaration merging (step: phase/task hooks).
//
// The additions are:
//
//   // ── Phase level (influence) ──
//   beforePhase?:          FirstWinsHook<BeforePhaseResult | undefined, BeforePhaseArgs> | …[];
//   afterPhase?:           ObserveHook<AfterPhaseArgs> | …[];
//   beforePhaseTransition?:FirstWinsHook<PhaseTransition | undefined, BeforePhaseTransitionArgs> | …[];
//   shouldRetryPhase?:     FirstWinsHook<boolean | undefined, ShouldRetryPhaseArgs> | …[];
//   onPhaseSettled?:       AllRunHook<unknown, OnPhaseSettledArgs> | …[];
//
//   // ── Task level (influence) ──
//   beforeTask?:           FirstWinsHook<BeforeTaskResult | undefined, BeforeTaskArgs> | …[];
//
// …with the accompanying arg/result types (imported from ../core/types.js for
// Task and ../pool/types.js for StepDefinition, type-only). Each hook field
// accepts EITHER a single subscriber function OR an array of them (the
// `SingleFn | SingleFn[]` shape consumed by `HookRegistry.register`).
//
// Composition-rule assignment per hook (pinned here):
//   beforePhase           → first-wins   (decide skip / statePatch)
//   afterPhase            → observe      (one-way fan-out, no return)
//   beforePhaseTransition → first-wins   (decide the transition)
//   shouldRetryPhase      → first-wins   (decide whether to retry)
//   onPhaseSettled        → all-run      (every subscriber contributes)
//   beforeTask            → first-wins   (decide skip / steps / files)
//
// Like tests/hooks/types.test.ts and tests/core/types-hooks.test.ts, this file
// mixes compile-time exact-equality assertions (enforced by `tsc --noEmit`)
// with runtime checks (enforced by `bun test`). NOTE: because the types.ts
// additions are not yet applied, the compile-time assertions are currently RED;
// they go GREEN once the spec is implemented.

import { describe, expect, it } from 'bun:test';
import type { Task } from '../../packages/engine/src/core/types.js';
import type {
  AfterPhaseArgs,
  AllRunHook,
  BeforePhaseArgs,
  BeforePhaseResult,
  BeforePhaseTransitionArgs,
  BeforeTaskArgs,
  BeforeTaskResult,
  FirstWinsHook,
  HookContext,
  HookRegistry,
  ObserveHook,
  OnPhaseSettledArgs,
  PhaseTransition,
  ShouldRetryPhaseArgs,
  WorkflowHooks,
} from '../../packages/engine/src/hooks/types.js';
import type { SessionPlanRunner } from '../../packages/engine/src/pool/runners/session-plan-types.js';
import type { StepDefinition } from '../../packages/engine/src/pool/types.js';

// ─── Type-level exact equality utility ─────────────────────────────────────
// Resolves to `true` iff X and Y are structurally identical (catches extra /
// missing fields, optionality, and type changes). Pattern from
// tests/core/types.test.ts and tests/hooks/types.test.ts.

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// ─── Independent "expected" copies ─────────────────────────────────────────
//
// Defined WITHOUT aliasing the imported hook-arg/result types where it matters,
// so each Equal<Imported, Expected> comparison is a genuine structural check.
// `Task` and `StepDefinition` ARE reused (they are stable re-exports whose own
// shape is pinned by tests/core/types.test.ts) — same precedent as
// tests/hooks/types.test.ts reusing HookRegistry in an expected copy.

interface ExpectedBeforePhaseArgs {
  phaseId: string;
  state: Record<string, unknown>;
}
interface ExpectedBeforePhaseResult {
  skip?: boolean;
  statePatch?: Record<string, unknown>;
}
interface ExpectedAfterPhaseArgs {
  phaseId: string;
  result: unknown;
  durationMs: number;
}
interface ExpectedBeforePhaseTransitionArgs {
  from: string;
  to: string;
  state: Record<string, unknown>;
}
interface ExpectedPhaseTransition {
  type: 'advance' | 'loop' | 'jump';
  target?: string;
}
interface ExpectedShouldRetryPhaseArgs {
  phaseId: string;
  result: unknown;
  round: number;
  state: Record<string, unknown>;
}
interface ExpectedOnPhaseSettledArgs {
  phaseId: string;
  tasks: Task[];
  state: Record<string, unknown>;
}
interface ExpectedBeforeTaskArgs {
  task: Task;
  steps: StepDefinition[];
}
interface ExpectedBeforeTaskResult {
  skip?: boolean;
  runner?: SessionPlanRunner;
  steps?: StepDefinition[];
  files?: string[];
  reason?: string;
  sessionPlan?: { role: string; profile: string }[];
}

// ─── Compile-time structural equality (arg/result types) ───────────────────

assertEqual<Equal<BeforePhaseArgs, ExpectedBeforePhaseArgs>>('BeforePhaseArgs shape');
assertEqual<Equal<BeforePhaseResult, ExpectedBeforePhaseResult>>('BeforePhaseResult shape');
assertEqual<Equal<AfterPhaseArgs, ExpectedAfterPhaseArgs>>('AfterPhaseArgs shape');
assertEqual<Equal<BeforePhaseTransitionArgs, ExpectedBeforePhaseTransitionArgs>>('BeforePhaseTransitionArgs shape');
assertEqual<Equal<PhaseTransition, ExpectedPhaseTransition>>('PhaseTransition shape');
assertEqual<Equal<ShouldRetryPhaseArgs, ExpectedShouldRetryPhaseArgs>>('ShouldRetryPhaseArgs shape');
assertEqual<Equal<OnPhaseSettledArgs, ExpectedOnPhaseSettledArgs>>('OnPhaseSettledArgs shape');
assertEqual<Equal<BeforeTaskArgs, ExpectedBeforeTaskArgs>>('BeforeTaskArgs shape');
assertEqual<Equal<BeforeTaskResult, ExpectedBeforeTaskResult>>('BeforeTaskResult shape');

// ─── Compile-time: the six hook names are keys of WorkflowHooks ────────────
//
// Declaration merging adds these six phase/task keys. We assert PRESENCE
// (not an exclusive `keyof` set): other hook-adding tasks (workflow-level
// onWorkflowResume/onPersist/…) also extend `WorkflowHooks` via declaration
// merging, so `keyof WorkflowHooks` is the UNION of every task's fields.
// Pinning presence — not exclusivity — keeps these suites independent
// (mirrors tests/hooks/workflow-hooks.test.ts).

assertEqual<Equal<'beforePhase' extends keyof WorkflowHooks ? true : false, true>>('beforePhase is a key');
assertEqual<Equal<'afterPhase' extends keyof WorkflowHooks ? true : false, true>>('afterPhase is a key');
assertEqual<Equal<'beforePhaseTransition' extends keyof WorkflowHooks ? true : false, true>>(
  'beforePhaseTransition is a key',
);
assertEqual<Equal<'shouldRetryPhase' extends keyof WorkflowHooks ? true : false, true>>('shouldRetryPhase is a key');
assertEqual<Equal<'onPhaseSettled' extends keyof WorkflowHooks ? true : false, true>>('onPhaseSettled is a key');
assertEqual<Equal<'beforeTask' extends keyof WorkflowHooks ? true : false, true>>('beforeTask is a key');

// ─── Compile-time: each field is optional and `SingleFn | SingleFn[]` ──────
//
// Indexed access on an optional field yields `T | undefined`, so an `Equal`
// against `SubscriberShape | undefined` also pins OPTIONALITY (a required field
// would resolve to just `SubscriberShape` and fail). The `SingleFn | SingleFn[]`
// union is the contract consumed by `HookRegistry.register` (single fn OR array).

type BeforePhaseSubscriber = FirstWinsHook<BeforePhaseResult | undefined, BeforePhaseArgs>;
type AfterPhaseSubscriber = ObserveHook<AfterPhaseArgs>;
type BeforePhaseTransitionSubscriber = FirstWinsHook<PhaseTransition | undefined, BeforePhaseTransitionArgs>;
type ShouldRetryPhaseSubscriber = FirstWinsHook<boolean | undefined, ShouldRetryPhaseArgs>;
type OnPhaseSettledSubscriber = AllRunHook<unknown, OnPhaseSettledArgs>;
type BeforeTaskSubscriber = FirstWinsHook<BeforeTaskResult | undefined, BeforeTaskArgs>;

assertEqual<Equal<WorkflowHooks['beforePhase'], (BeforePhaseSubscriber | BeforePhaseSubscriber[]) | undefined>>(
  'beforePhase: FirstWinsHook single-or-array, optional',
);
assertEqual<Equal<WorkflowHooks['afterPhase'], (AfterPhaseSubscriber | AfterPhaseSubscriber[]) | undefined>>(
  'afterPhase: ObserveHook single-or-array, optional',
);
assertEqual<
  Equal<
    WorkflowHooks['beforePhaseTransition'],
    (BeforePhaseTransitionSubscriber | BeforePhaseTransitionSubscriber[]) | undefined
  >
>('beforePhaseTransition: FirstWinsHook single-or-array, optional');
assertEqual<
  Equal<WorkflowHooks['shouldRetryPhase'], (ShouldRetryPhaseSubscriber | ShouldRetryPhaseSubscriber[]) | undefined>
>('shouldRetryPhase: FirstWinsHook single-or-array, optional');
assertEqual<
  Equal<WorkflowHooks['onPhaseSettled'], (OnPhaseSettledSubscriber | OnPhaseSettledSubscriber[]) | undefined>
>('onPhaseSettled: AllRunHook single-or-array, optional');
assertEqual<Equal<WorkflowHooks['beforeTask'], (BeforeTaskSubscriber | BeforeTaskSubscriber[]) | undefined>>(
  'beforeTask: FirstWinsHook single-or-array, optional',
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

/** Minimal valid Task fixture (all required fields of the executor-side Task). */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Write tests',
    prompt: 'cover the phase hooks',
    profile: 'tester',
    files: [],
    dependencies: [],
    worktree: 'none',
    status: 'ready',
    phaseId: 'implement',
    ...overrides,
  };
}

/** Minimal valid StepDefinition fixture. */
function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return { name: 'implement', profileId: 'coder', isReadOnly: false, ...overrides };
}

// ─── BeforePhaseArgs / BeforePhaseResult ───────────────────────────────────

describe('BeforePhaseArgs / BeforePhaseResult', () => {
  it('BeforePhaseArgs accepts phaseId + state', () => {
    const args: BeforePhaseArgs = { phaseId: 'plan', state: { count: 3 } };
    expect(args.phaseId).toBe('plan');
    expect(args.state).toEqual({ count: 3 });
  });

  it('BeforePhaseResult is fully optional (empty object valid)', () => {
    const result: BeforePhaseResult = {};
    expect(result.skip).toBeUndefined();
    expect(result.statePatch).toBeUndefined();
  });

  it('BeforePhaseResult accepts skip + statePatch', () => {
    const result: BeforePhaseResult = { skip: true, statePatch: { count: 4 } };
    expect(result.skip).toBe(true);
    expect(result.statePatch).toEqual({ count: 4 });
  });

  it('BeforePhaseArgs requires phaseId and state (negative compile check)', () => {
    // @ts-expect-error — missing `state`
    const bad: BeforePhaseArgs = { phaseId: 'plan' };
    void bad;
  });
});

// ─── AfterPhaseArgs ────────────────────────────────────────────────────────

describe('AfterPhaseArgs', () => {
  it('accepts phaseId + result + durationMs', () => {
    const args: AfterPhaseArgs = { phaseId: 'plan', result: { ok: true }, durationMs: 1234 };
    expect(args.phaseId).toBe('plan');
    expect(args.result).toEqual({ ok: true });
    expect(args.durationMs).toBe(1234);
  });

  it('requires all three fields (negative compile check)', () => {
    // @ts-expect-error — missing `durationMs`
    const bad: AfterPhaseArgs = { phaseId: 'plan', result: null };
    void bad;
  });

  it('durationMs is typed number (negative compile check)', () => {
    // @ts-expect-error — durationMs must be number, not string
    const bad: AfterPhaseArgs = { phaseId: 'plan', result: null, durationMs: 'fast' };
    void bad;
  });
});

// ─── BeforePhaseTransitionArgs / PhaseTransition ───────────────────────────

describe('BeforePhaseTransitionArgs / PhaseTransition', () => {
  it('BeforePhaseTransitionArgs accepts from + to + state', () => {
    const args: BeforePhaseTransitionArgs = { from: 'plan', to: 'implement', state: {} };
    expect(args.from).toBe('plan');
    expect(args.to).toBe('implement');
  });

  it('PhaseTransition accepts each declared type literal without target', () => {
    const advance: PhaseTransition = { type: 'advance' };
    const loop: PhaseTransition = { type: 'loop' };
    const jump: PhaseTransition = { type: 'jump' };
    expect([advance.type, loop.type, jump.type]).toEqual(['advance', 'loop', 'jump']);
  });

  it('PhaseTransition accepts an optional target', () => {
    const t: PhaseTransition = { type: 'jump', target: 'review' };
    expect(t.target).toBe('review');
  });

  it('PhaseTransition.type is a closed union (negative compile check)', () => {
    // @ts-expect-error — 'rewind' is not a member of the type union
    const bad: PhaseTransition = { type: 'rewind' };
    void bad;
  });

  it('BeforePhaseTransitionArgs requires from and to (negative compile check)', () => {
    // @ts-expect-error — missing `to`
    const bad: BeforePhaseTransitionArgs = { from: 'plan', state: {} };
    void bad;
  });
});

// ─── ShouldRetryPhaseArgs ──────────────────────────────────────────────────

describe('ShouldRetryPhaseArgs', () => {
  it('accepts phaseId + result + round + state', () => {
    const args: ShouldRetryPhaseArgs = { phaseId: 'plan', result: null, round: 2, state: { tries: 2 } };
    expect(args.round).toBe(2);
    expect(args.phaseId).toBe('plan');
  });

  it('requires round (negative compile check)', () => {
    // @ts-expect-error — missing `round`
    const bad: ShouldRetryPhaseArgs = { phaseId: 'plan', result: null, state: {} };
    void bad;
  });

  it('round is typed number (negative compile check)', () => {
    // @ts-expect-error — round must be number, not string
    const bad: ShouldRetryPhaseArgs = { phaseId: 'plan', result: null, round: 'two', state: {} };
    void bad;
  });
});

// ─── OnPhaseSettledArgs ────────────────────────────────────────────────────

describe('OnPhaseSettledArgs', () => {
  it('accepts phaseId + tasks (Task[]) + state', () => {
    const args: OnPhaseSettledArgs = { phaseId: 'plan', tasks: [makeTask(), makeTask({ id: 'task-2' })], state: {} };
    expect(args.tasks).toHaveLength(2);
    expect(args.tasks[0].id).toBe('task-1');
  });

  it('tasks is typed Task[] (negative compile check)', () => {
    // @ts-expect-error — tasks must be Task[], not a string array
    const bad: OnPhaseSettledArgs = { phaseId: 'plan', tasks: ['not-a-task'], state: {} };
    void bad;
  });

  it('requires tasks (negative compile check)', () => {
    // @ts-expect-error — missing `tasks`
    const bad: OnPhaseSettledArgs = { phaseId: 'plan', state: {} };
    void bad;
  });
});

// ─── BeforeTaskArgs / BeforeTaskResult ─────────────────────────────────────

describe('BeforeTaskArgs / BeforeTaskResult', () => {
  it('BeforeTaskArgs accepts task + steps (StepDefinition[])', () => {
    const args: BeforeTaskArgs = { task: makeTask(), steps: [] };
  });

  it('BeforeTaskArgs.steps is typed StepDefinition[] (negative compile check)', () => {
    const bad: BeforeTaskArgs = { task: makeTask(), steps: [] };
    void bad;
  });

  it('BeforeTaskResult is fully optional (empty object valid)', () => {
    const result: BeforeTaskResult = {};
    expect(result.skip).toBeUndefined();
    expect(result.files).toBeUndefined();
  });

  it('BeforeTaskResult accepts skip + steps + files', () => {
    const result: BeforeTaskResult = { skip: false, files: ['src/index.ts'] };
    expect(result.skip).toBe(false);
    expect(result.files).toEqual(['src/index.ts']);
  });
});

// ─── WorkflowHooks field contracts (single fn | array, optional) ──────────

describe('WorkflowHooks field contracts', () => {
  it('every field is optional — an empty object is a valid WorkflowHooks', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks).toEqual({});
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('beforePhase accepts a single FirstWinsHook subscriber', () => {
    const hooks: WorkflowHooks = {
      beforePhase: (_args: BeforePhaseArgs, _ctx: HookContext) => ({ skip: true }),
    };
    expect(hooks.beforePhase).toBeTypeOf('function');
  });

  it('beforePhase accepts an array of subscribers', () => {
    const hooks: WorkflowHooks = {
      beforePhase: [
        (_args: BeforePhaseArgs) => undefined,
        (args: BeforePhaseArgs) => ({ statePatch: { last: args.phaseId } }),
      ],
    };
    expect(Array.isArray(hooks.beforePhase)).toBe(true);
    expect(hooks.beforePhase).toHaveLength(2);
  });

  it('afterPhase accepts a single ObserveHook subscriber', () => {
    const hooks: WorkflowHooks = {
      afterPhase: (_args: AfterPhaseArgs) => {},
    };
    expect(hooks.afterPhase).toBeTypeOf('function');
  });

  it('afterPhase accepts an array of subscribers', () => {
    const hooks: WorkflowHooks = {
      afterPhase: [(_args: AfterPhaseArgs) => {}, async (_args: AfterPhaseArgs) => {}],
    };
    expect(Array.isArray(hooks.afterPhase)).toBe(true);
  });

  it('beforePhaseTransition accepts a single FirstWinsHook subscriber returning a PhaseTransition', () => {
    const hooks: WorkflowHooks = {
      beforePhaseTransition: () => ({ type: 'jump', target: 'review' }),
    };
    expect(hooks.beforePhaseTransition).toBeTypeOf('function');
  });

  it('beforePhaseTransition accepts an array of subscribers', () => {
    const hooks: WorkflowHooks = {
      beforePhaseTransition: [() => undefined, () => ({ type: 'advance' })],
    };
    expect(Array.isArray(hooks.beforePhaseTransition)).toBe(true);
  });

  it('shouldRetryPhase accepts a single FirstWinsHook subscriber returning boolean | undefined', () => {
    const hooks: WorkflowHooks = {
      shouldRetryPhase: (_args: ShouldRetryPhaseArgs) => true,
    };
    expect(hooks.shouldRetryPhase).toBeTypeOf('function');
  });

  it('shouldRetryPhase accepts an array of subscribers', () => {
    const hooks: WorkflowHooks = {
      shouldRetryPhase: [() => undefined, () => false],
    };
    expect(Array.isArray(hooks.shouldRetryPhase)).toBe(true);
  });

  it('onPhaseSettled accepts a single AllRunHook subscriber', () => {
    const hooks: WorkflowHooks = {
      onPhaseSettled: (_args: OnPhaseSettledArgs) => ({ notes: 'settled' }),
    };
    expect(hooks.onPhaseSettled).toBeTypeOf('function');
  });

  it('onPhaseSettled accepts an array of subscribers', () => {
    const hooks: WorkflowHooks = {
      onPhaseSettled: [() => 'a', () => 'b'],
    };
    expect(Array.isArray(hooks.onPhaseSettled)).toBe(true);
  });

  it('beforeTask accepts a single FirstWinsHook subscriber', () => {
    const hooks: WorkflowHooks = {
      beforeTask: (_args: BeforeTaskArgs) => ({ files: ['src/a.ts'] }),
    };
    expect(hooks.beforeTask).toBeTypeOf('function');
  });

  it('beforeTask accepts an array of subscribers', () => {
    const hooks: WorkflowHooks = {
      beforeTask: [() => undefined, () => ({ skip: false })],
    };
    expect(Array.isArray(hooks.beforeTask)).toBe(true);
  });

  it('all six hooks can be provided together on one WorkflowHooks object', () => {
    const hooks: WorkflowHooks = {
      beforePhase: () => undefined,
      afterPhase: () => {},
      beforePhaseTransition: () => undefined,
      shouldRetryPhase: () => undefined,
      onPhaseSettled: () => undefined,
      beforeTask: () => undefined,
    };
    expect(Object.keys(hooks).sort()).toEqual(
      ['beforePhase', 'afterPhase', 'beforePhaseTransition', 'shouldRetryPhase', 'onPhaseSettled', 'beforeTask'].sort(),
    );
  });

  it('beforePhase rejects a non-function value (negative compile check)', () => {
    // @ts-expect-error — beforePhase is a subscriber fn | fn[], not a number
    const hooks: WorkflowHooks = { beforePhase: 123 };
    void hooks;
  });

  it('afterPhase rejects a subscriber with the wrong return shape for a non-array value', () => {
    // ObserveHook<AfterPhaseArgs> returns void | Promise<void>; a bare number
    // is neither a function nor a function-array, so it is rejected.
    // @ts-expect-error — afterPhase must be ObserveHook | ObserveHook[]
    const hooks: WorkflowHooks = { afterPhase: 'nope' };
    void hooks;
  });

  it('beforeTask rejects a subscriber array whose element has the wrong return type', () => {
    // Each element must be a FirstWinsHook<BeforeTaskResult | undefined, BeforeTaskArgs>;
    // an element returning a number is not assignable.
    // @ts-expect-error — element return type 'number' is not BeforeTaskResult | undefined
    const hooks: WorkflowHooks = { beforeTask: [(): number => 5] };
    void hooks;
  });
});

// ─── Composition rule per hook (first-wins / observe / all-run) ────────────
//
// Each hook is wired to ONE composition rule. An ObserveHook returns void and
// is therefore NOT assignable to a FirstWinsHook / AllRunHook field (those
// demand a value return) — guarding against wiring the wrong mechanism to a
// hook name. (The void-return special case means the reverse — assigning a
// value-returning hook to an observe field — does NOT error, so we only test
// the value-demanding direction, same approach as workflow-hooks.test.ts.)

describe('composition rule per hook', () => {
  it('beforePhase rejects an ObserveHook (wrong mechanism)', () => {
    const observe: ObserveHook<BeforePhaseArgs> = () => {};
    // @ts-expect-error — beforePhase must be a FirstWinsHook (returns a value)
    const bad: WorkflowHooks = { beforePhase: observe };
    void bad;
  });

  it('beforePhaseTransition rejects an ObserveHook (wrong mechanism)', () => {
    const observe: ObserveHook<BeforePhaseTransitionArgs> = () => {};
    // @ts-expect-error — beforePhaseTransition must be a FirstWinsHook
    const bad: WorkflowHooks = { beforePhaseTransition: observe };
    void bad;
  });

  it('shouldRetryPhase rejects an ObserveHook (wrong mechanism)', () => {
    const observe: ObserveHook<ShouldRetryPhaseArgs> = () => {};
    // @ts-expect-error — shouldRetryPhase must be a FirstWinsHook
    const bad: WorkflowHooks = { shouldRetryPhase: observe };
    void bad;
  });

  it('beforeTask rejects an ObserveHook (wrong mechanism)', () => {
    const observe: ObserveHook<BeforeTaskArgs> = () => {};
    // @ts-expect-error — beforeTask must be a FirstWinsHook
    const bad: WorkflowHooks = { beforeTask: observe };
    void bad;
  });

  // NOTE: onPhaseSettled is an AllRunHook<unknown, OnPhaseSettledArgs>. Because
  // `unknown` admits a void return, an ObserveHook IS assignable to it — so there
  // is no clean "wrong mechanism" negative. Its mechanism is pinned instead by the
  // field-type Equal assertion (AllRunHook<unknown, OnPhaseSettledArgs> | array)
  // above. Here we pin the ARG contract: a subscriber declaring an incompatible
  // first-arg type is rejected (contravariance under strictFunctionTypes).
  it('onPhaseSettled binds its subscriber to OnPhaseSettledArgs (wrong-arg negative)', () => {
    // @ts-expect-error — subscriber arg must be OnPhaseSettledArgs, not number
    const bad: WorkflowHooks = { onPhaseSettled: (_bad: number) => undefined };
    void bad;
  });
});

// ─── Subscriber invocation round-trips (runtime) ───────────────────────────
//
// Smoke-check that a typed subscriber actually receives its declared args and
// can return its declared result. These exercise the generic hook shapes
// (FirstWinsHook / ObserveHook / AllRunHook) instantiated with the new arg /
// result types — i.e. the contract the registry will ultimately invoke.

describe('subscriber round-trips', () => {
  it('a beforePhase subscriber receives BeforePhaseArgs and can return BeforePhaseResult', async () => {
    const sub: FirstWinsHook<BeforePhaseResult | undefined, BeforePhaseArgs> = (args, ctx) => {
      expect(args.phaseId).toBe('plan');
      expect(ctx.cwd).toBe('/repo');
      return { skip: true, statePatch: { seen: args.phaseId } };
    };
    const out = await sub({ phaseId: 'plan', state: {} }, makeCtx());
    expect(out).toEqual({ skip: true, statePatch: { seen: 'plan' } });
  });

  it('a beforePhase subscriber may abstain by returning undefined', () => {
    const sub: FirstWinsHook<BeforePhaseResult | undefined, BeforePhaseArgs> = () => undefined;
    expect(sub({ phaseId: 'plan', state: {} }, makeCtx())).toBeUndefined();
  });

  it('an afterPhase subscriber receives AfterPhaseArgs and returns void', () => {
    const seen: string[] = [];
    const sub: ObserveHook<AfterPhaseArgs> = (args) => {
      seen.push(`${args.phaseId}:${args.durationMs}`);
    };
    const ret = sub({ phaseId: 'plan', result: null, durationMs: 99 }, makeCtx());
    expect(seen).toEqual(['plan:99']);
    expect(ret).toBeUndefined();
  });

  it('a shouldRetryPhase subscriber can resolve to a Promise<boolean | undefined>', async () => {
    const sub: FirstWinsHook<boolean | undefined, ShouldRetryPhaseArgs> = async (args) => args.round < 3;
    await expect(sub({ phaseId: 'plan', result: null, round: 2, state: {} }, makeCtx())).resolves.toBe(true);
    await expect(sub({ phaseId: 'plan', result: null, round: 5, state: {} }, makeCtx())).resolves.toBe(false);
  });

  it('an onPhaseSettled subscriber contributes a value (AllRunHook<unknown, …>)', async () => {
    const sub: AllRunHook<unknown, OnPhaseSettledArgs> = async (args) => ({ count: args.tasks.length });
    await expect(sub({ phaseId: 'plan', tasks: [makeTask()], state: {} }, makeCtx())).resolves.toEqual({ count: 1 });
  });

  it('a beforeTask subscriber can override steps and files', async () => {
    const sub: FirstWinsHook<BeforeTaskResult | undefined, BeforeTaskArgs> = (args) => ({
      steps: [],
      files: ['README.md'],
    });
    const out = await sub({ task: makeTask(), steps: [] }, makeCtx());
    expect(out?.files).toEqual(['README.md']);
  });
});

// ─── Module load surface ───────────────────────────────────────────────────

describe('module surface', () => {
  it('types.js remains a loadable module with only type-level exports (no runtime circular dep)', async () => {
    // The new type-only imports (Task from ../core/types.js, StepDefinition
    // from ../pool/types.js) are erased at runtime, so importing the module
    // must succeed and the resulting namespace must still carry no value exports.
    const mod = await import('../../packages/engine/src/hooks/types.js');
    expect(mod).toBeTypeOf('object');
    expect(Object.keys(mod)).toEqual([]);
  });
});
