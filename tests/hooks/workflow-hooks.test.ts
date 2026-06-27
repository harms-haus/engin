// ─── Workflow-level hook type-contract tests ───────────────────────────────
//
// This suite pins the SIX workflow-level hooks that are added to
// packages/engine/src/hooks/types.ts via declaration merging on `WorkflowHooks`:
//
//   // ── Workflow level ──
//   onWorkflowResume?: ObserveHook<OnWorkflowResumeArgs>
//                       | ObserveHook<OnWorkflowResumeArgs>[];
//   onWorkflowAbort?:  ObserveHook<OnWorkflowAbortArgs>
//                       | ObserveHook<OnWorkflowAbortArgs>[];
//   onPersist?:        PipelineHook<WorkflowState, OnPersistArgs>
//                       | PipelineHook<WorkflowState, OnPersistArgs>[];
//   onRestore?:        PipelineHook<WorkflowState, OnRestoreArgs>
//                       | PipelineHook<WorkflowState, OnRestoreArgs>[];
//   beforeRunMerge?:   FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs>
//                       | FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs>[];
//   onRunMergeConflict?: FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs>
//                          | FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs>[];
//
// And the companion arg/result type aliases:
//
//   OnWorkflowResumeArgs   = { workDir: string; tracker: unknown }
//   OnWorkflowAbortArgs    = { reason: string; workDir: string }
//   OnPersistArgs          = { workDir: string }
//   OnRestoreArgs          = { workDir: string }
//   BeforeRunMergeArgs     = { worktree?: WorktreeInfo; repoRoot: string; mainBranch: string }
//   OnRunMergeConflictArgs = { conflicts: string[]; worktreePath: string; repoRoot: string }
//   RunMergeDecision       = { proceed: boolean; strategy?: 'squash' | 'merge' | 'rebase' }
//   ConflictResolution     = { strategy: 'agent' | 'manual' | 'abort'; resolvedFiles?: string[] }
//
// `WorkflowState` and `WorktreeInfo` are imported into types.ts from
// `../core/types.js` (type-only). This suite asserts those are the SAME
// declarations the engine uses elsewhere, not re-declared copies.
//
// Every field is OPTIONAL (so existing workflows that omit them are
// unchanged). The runtime DEFAULT implementations ship in task-24 (the
// defaults barrel); they are:
//   onPersist/onRestore      → tracker.save() / WorkflowStatusTracker.load()
//   beforeRunMerge           → { proceed: true, strategy: 'squash' }
//   onRunMergeConflict       → { strategy: 'agent' }
// Those defaults are NOT exercised here — only the TYPE CONTRACT is.
//
// Like tests/hooks/types.test.ts, this file mixes compile-time exact-equality
// assertions (enforced by `tsc --noEmit` on this file) with runtime checks
// (enforced by `bun test`). Written TEST-FIRST: the compile-time assertions
// are RED until the spec is implemented in types.ts.

import { describe, expect, it } from 'bun:test';
import type { Task, TaskStatus, WorkflowState, WorktreeInfo } from '../../packages/engine/src/core/types.js';
import type {
  BeforeRunMergeArgs,
  ConflictResolution,
  FirstWinsHook,
  HookContext,
  HookRegistry,
  ObserveHook,
  OnPersistArgs,
  OnRestoreArgs,
  OnRunMergeConflictArgs,
  OnWorkflowAbortArgs,
  OnWorkflowResumeArgs,
  PipelineHook,
  RunMergeDecision,
  WorkflowHooks,
} from '../../packages/engine/src/hooks/types.js';

// ─── Type-level exact equality utility ─────────────────────────────────────
// Resolves to `true` iff X and Y are structurally identical (catches extra /
// missing fields, optionality, type changes, and divergent generic-method
// signatures on interfaces). Pattern from tests/hooks/types.test.ts.

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// ─── Independent "expected" copies ─────────────────────────────────────────
// Defined WITHOUT aliasing the imported types where it matters, so each
// Equal<Imported, Expected> comparison is a genuine structural check rather
// than identity. Keeping these in sync with the real definitions is exactly
// what guards the contract.

interface ExpectedOnWorkflowResumeArgs {
  workDir: string;
  tracker: unknown;
}
interface ExpectedOnWorkflowAbortArgs {
  reason: string;
  workDir: string;
}
interface ExpectedOnPersistArgs {
  workDir: string;
}
interface ExpectedOnRestoreArgs {
  workDir: string;
}
interface ExpectedBeforeRunMergeArgs {
  worktree?: WorktreeInfo;
  repoRoot: string;
  mainBranch: string;
}
interface ExpectedOnRunMergeConflictArgs {
  conflicts: string[];
  worktreePath: string;
  repoRoot: string;
}
interface ExpectedRunMergeDecision {
  proceed: boolean;
  strategy?: 'squash' | 'merge' | 'rebase';
}
interface ExpectedConflictResolution {
  strategy: 'agent' | 'manual' | 'abort';
  resolvedFiles?: string[];
}

// ─── Compile-time structural equality assertions ───────────────────────────

// Each new arg/result alias matches its expected shape exactly.
assertEqual<Equal<OnWorkflowResumeArgs, ExpectedOnWorkflowResumeArgs>>('OnWorkflowResumeArgs shape is unchanged');
assertEqual<Equal<OnWorkflowAbortArgs, ExpectedOnWorkflowAbortArgs>>('OnWorkflowAbortArgs shape is unchanged');
assertEqual<Equal<OnPersistArgs, ExpectedOnPersistArgs>>('OnPersistArgs shape is unchanged');
assertEqual<Equal<OnRestoreArgs, ExpectedOnRestoreArgs>>('OnRestoreArgs shape is unchanged');
assertEqual<Equal<BeforeRunMergeArgs, ExpectedBeforeRunMergeArgs>>('BeforeRunMergeArgs shape is unchanged');
assertEqual<Equal<OnRunMergeConflictArgs, ExpectedOnRunMergeConflictArgs>>('OnRunMergeConflictArgs shape is unchanged');
assertEqual<Equal<RunMergeDecision, ExpectedRunMergeDecision>>('RunMergeDecision shape is unchanged');
assertEqual<Equal<ConflictResolution, ExpectedConflictResolution>>('ConflictResolution shape is unchanged');

// ── WorkflowHooks declaration merging: each field present + optional + typed ──
//
// Indexed access on an OPTIONAL field yields `T | undefined`, so each Equal
// also pins OPTIONALITY (a required field would resolve to just `T`). The
// expected type spells out BOTH the single-function arm AND the array arm so
// the `single fn | fn[]` shape is pinned too.

assertEqual<
  Equal<
    WorkflowHooks['onWorkflowResume'],
    ObserveHook<OnWorkflowResumeArgs> | ObserveHook<OnWorkflowResumeArgs>[] | undefined
  >
>('onWorkflowResume is an optional ObserveHook<OnWorkflowResumeArgs> | array');
assertEqual<
  Equal<
    WorkflowHooks['onWorkflowAbort'],
    ObserveHook<OnWorkflowAbortArgs> | ObserveHook<OnWorkflowAbortArgs>[] | undefined
  >
>('onWorkflowAbort is an optional ObserveHook<OnWorkflowAbortArgs> | array');
assertEqual<
  Equal<
    WorkflowHooks['onPersist'],
    PipelineHook<WorkflowState, OnPersistArgs> | PipelineHook<WorkflowState, OnPersistArgs>[] | undefined
  >
>('onPersist is an optional PipelineHook<WorkflowState, OnPersistArgs> | array');
assertEqual<
  Equal<
    WorkflowHooks['onRestore'],
    PipelineHook<WorkflowState, OnRestoreArgs> | PipelineHook<WorkflowState, OnRestoreArgs>[] | undefined
  >
>('onRestore is an optional PipelineHook<WorkflowState, OnRestoreArgs> | array');
assertEqual<
  Equal<
    WorkflowHooks['beforeRunMerge'],
    | FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs>
    | FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs>[]
    | undefined
  >
>('beforeRunMerge is an optional FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs> | array');
assertEqual<
  Equal<
    WorkflowHooks['onRunMergeConflict'],
    | FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs>
    | FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs>[]
    | undefined
  >
>('onRunMergeConflict is an optional FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs> | array');

// Bidirectional assignability for the WorkflowState-typed pipeline hooks —
// proves `WorkflowState` (imported from core/types.js) flows through both
// `onPersist` and `onRestore` as the pipeline VALUE. If the source re-declared
// an incompatible WorkflowState, one direction would fail.
const _persistAcceptsState: NonNullable<WorkflowHooks['onPersist']> = (value: WorkflowState): WorkflowState => value;
const _restoreAcceptsState: NonNullable<WorkflowHooks['onRestore']> = (value: WorkflowState): WorkflowState => value;
void _persistAcceptsState;
void _restoreAcceptsState;

// ─── Runtime helpers ───────────────────────────────────────────────────────

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: {} as HookRegistry,
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

/** Minimal, type-correct WorkflowState for pipeline-hook runtime calls. */
function makeState(): WorkflowState {
  const task: Task = {
    id: 't1',
    title: 'Seed task',
    prompt: 'do the thing',
    profile: 'coder',
    files: [],
    dependencies: [],
    status: 'ready' as TaskStatus,
    worktree: 'none',
    phaseId: 'coding',
  };
  return {
    taskPrompt: 'implement feature X',
    currentPhaseId: 'coding',
    completedPhaseIds: [],
    tasks: [task],
    workflowData: {},
    stats: { totalTokens: 0, totalCost: 0, agentCount: 0 },
  };
}

function makeWorktree(): WorktreeInfo {
  return {
    worktreePath: '/repo/.engin/worktrees/wt-1',
    branchName: 'engin/run-1',
    originalCwd: '/repo',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Arg type shapes (runtime structural probes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('OnWorkflowResumeArgs', () => {
  it('accepts { workDir, tracker }', () => {
    const args: OnWorkflowResumeArgs = { workDir: '/run', tracker: { save: () => {} } };
    expect(args.workDir).toBe('/run');
    // tracker is `unknown` on purpose (avoids a circular runtime import); the
    // workflow casts at the use site.
    expect(args.tracker).toEqual({ save: expect.any(Function) });
  });

  it('requires workDir (negative compile check)', () => {
    // @ts-expect-error — missing required `workDir`
    const bad: OnWorkflowResumeArgs = { tracker: {} };
    void bad;
  });

  it('requires tracker (negative compile check)', () => {
    // @ts-expect-error — missing required `tracker`
    const bad: OnWorkflowResumeArgs = { workDir: '/run' };
    void bad;
  });
});

describe('OnWorkflowAbortArgs', () => {
  it('accepts { reason, workDir }', () => {
    const args: OnWorkflowAbortArgs = { reason: 'SIGINT', workDir: '/run' };
    expect(args.reason).toBe('SIGINT');
    expect(args.workDir).toBe('/run');
  });

  it('requires reason (negative compile check)', () => {
    // @ts-expect-error — missing required `reason`
    const bad: OnWorkflowAbortArgs = { workDir: '/run' };
    void bad;
  });
});

describe('OnPersistArgs / OnRestoreArgs', () => {
  it('OnPersistArgs accepts { workDir }', () => {
    const args: OnPersistArgs = { workDir: '/run' };
    expect(args).toEqual({ workDir: '/run' });
  });

  it('OnRestoreArgs accepts { workDir }', () => {
    const args: OnRestoreArgs = { workDir: '/run' };
    expect(args).toEqual({ workDir: '/run' });
  });

  it('OnPersistArgs rejects extra fields (structural exactness)', () => {
    // @ts-expect-error — `repoRoot` is not a member of OnPersistArgs
    const bad: OnPersistArgs = { workDir: '/run', repoRoot: '/repo' };
    void bad;
  });
});

describe('BeforeRunMergeArgs', () => {
  it('accepts a minimal object without the optional worktree', () => {
    const args: BeforeRunMergeArgs = { repoRoot: '/repo', mainBranch: 'main' };
    expect(args.worktree).toBeUndefined();
    expect(args.repoRoot).toBe('/repo');
    expect(args.mainBranch).toBe('main');
  });

  it('accepts a populated worktree (re-uses WorktreeInfo from core/types)', () => {
    const args: BeforeRunMergeArgs = { worktree: makeWorktree(), repoRoot: '/repo', mainBranch: 'main' };
    expect(args.worktree?.branchName).toBe('engin/run-1');
  });

  it('requires repoRoot and mainBranch (negative compile check)', () => {
    // @ts-expect-error — missing required `repoRoot` and `mainBranch`
    const bad: BeforeRunMergeArgs = {};
    void bad;
  });
});

describe('OnRunMergeConflictArgs', () => {
  it('accepts { conflicts, worktreePath, repoRoot }', () => {
    const args: OnRunMergeConflictArgs = {
      conflicts: ['src/a.ts', 'src/b.ts'],
      worktreePath: '/wt',
      repoRoot: '/repo',
    };
    expect(args.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
    expect(args.worktreePath).toBe('/wt');
  });

  it('requires conflicts (negative compile check)', () => {
    // @ts-expect-error — missing required `conflicts`
    const bad: OnRunMergeConflictArgs = { worktreePath: '/wt', repoRoot: '/repo' };
    void bad;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Result type shapes
// ═══════════════════════════════════════════════════════════════════════════════

describe('RunMergeDecision', () => {
  it('accepts { proceed } without strategy', () => {
    const decision: RunMergeDecision = { proceed: true };
    expect(decision.proceed).toBe(true);
    expect(decision.strategy).toBeUndefined();
  });

  it('accepts each documented strategy literal', () => {
    const squash: RunMergeDecision = { proceed: true, strategy: 'squash' };
    const merge: RunMergeDecision = { proceed: false, strategy: 'merge' };
    const rebase: RunMergeDecision = { proceed: true, strategy: 'rebase' };
    expect([squash.strategy, merge.strategy, rebase.strategy]).toEqual(['squash', 'merge', 'rebase']);
  });

  it('requires proceed (negative compile check)', () => {
    // @ts-expect-error — missing required `proceed`
    const bad: RunMergeDecision = { strategy: 'squash' };
    void bad;
  });

  it('rejects an unknown strategy (negative compile check)', () => {
    // @ts-expect-error — 'fast-forward' is not a valid strategy
    const bad: RunMergeDecision = { proceed: true, strategy: 'fast-forward' };
    void bad;
  });
});

describe('ConflictResolution', () => {
  it('accepts { strategy } without resolvedFiles', () => {
    const res: ConflictResolution = { strategy: 'agent' };
    expect(res.strategy).toBe('agent');
    expect(res.resolvedFiles).toBeUndefined();
  });

  it('accepts each documented strategy literal', () => {
    const strategies: ConflictResolution['strategy'][] = ['agent', 'manual', 'abort'];
    expect(new Set(strategies).size).toBe(3);
  });

  it('accepts resolvedFiles', () => {
    const res: ConflictResolution = { strategy: 'manual', resolvedFiles: ['src/a.ts'] };
    expect(res.resolvedFiles).toEqual(['src/a.ts']);
  });

  it('requires strategy (negative compile check)', () => {
    // @ts-expect-error — missing required `strategy`
    const bad: ConflictResolution = { resolvedFiles: [] };
    void bad;
  });

  it('rejects an unknown strategy (negative compile check)', () => {
    // @ts-expect-error — 'auto' is not a valid strategy
    const bad: ConflictResolution = { strategy: 'auto' };
    void bad;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. WorkflowHooks declaration merging — presence, optionality, array form
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorkflowHooks — workflow-level fields present & optional', () => {
  const FIELD_NAMES = [
    'onWorkflowResume',
    'onWorkflowAbort',
    'onPersist',
    'onRestore',
    'beforeRunMerge',
    'onRunMergeConflict',
  ] as const;

  it('declares all six workflow-level hook fields as keys', () => {
    // Compile-time: every name is a declared key of WorkflowHooks. (Optionality
    // — `T | undefined` on each indexed field — is pinned exhaustively by the
    // Equal assertions at the top of this file, so it is not re-checked here.)
    type Keys = keyof WorkflowHooks;
    const assertKey = <K extends Keys>(k: K): K => k;
    assertKey('onWorkflowResume');
    assertKey('onWorkflowAbort');
    assertKey('onPersist');
    assertKey('onRestore');
    assertKey('beforeRunMerge');
    assertKey('onRunMergeConflict');
    expect(FIELD_NAMES).toHaveLength(6);
  });

  it('accepts an empty object literal (every field optional → backward-compat)', () => {
    // Existing workflows that omit all hooks must remain valid — this is the
    // backward-compatibility guarantee that the task-24 defaults rely on.
    const hooks: WorkflowHooks = {};
    expect(hooks).toEqual({});
    expect(Object.keys(hooks)).toHaveLength(0);
  });
});

describe('WorkflowHooks — each field accepts a single function OR an array', () => {
  it('onWorkflowResume accepts a single ObserveHook', () => {
    const fn: ObserveHook<OnWorkflowResumeArgs> = (_args, _ctx) => {};
    const hooks: WorkflowHooks = { onWorkflowResume: fn };
    expect(hooks.onWorkflowResume).toBe(fn);
  });

  it('onWorkflowResume accepts an array of ObserveHooks', () => {
    const a: ObserveHook<OnWorkflowResumeArgs> = () => {};
    const b: ObserveHook<OnWorkflowResumeArgs> = () => {};
    const hooks: WorkflowHooks = { onWorkflowResume: [a, b] };
    expect(Array.isArray(hooks.onWorkflowResume)).toBe(true);
  });

  it('onWorkflowAbort accepts a single ObserveHook', () => {
    const fn: ObserveHook<OnWorkflowAbortArgs> = () => {};
    const hooks: WorkflowHooks = { onWorkflowAbort: fn };
    expect(hooks.onWorkflowAbort).toBe(fn);
  });

  it('onWorkflowAbort accepts an array of ObserveHooks', () => {
    const hooks: WorkflowHooks = { onWorkflowAbort: [() => {}, () => {}] };
    expect(Array.isArray(hooks.onWorkflowAbort)).toBe(true);
    expect((hooks.onWorkflowAbort as unknown[]).length).toBe(2);
  });

  it('onPersist accepts a single PipelineHook<WorkflowState, OnPersistArgs>', () => {
    const fn: PipelineHook<WorkflowState, OnPersistArgs> = (value) => value;
    const hooks: WorkflowHooks = { onPersist: fn };
    expect(hooks.onPersist).toBe(fn);
  });

  it('onPersist accepts an array of PipelineHooks', () => {
    const a: PipelineHook<WorkflowState, OnPersistArgs> = (v) => v;
    const hooks: WorkflowHooks = { onPersist: [a] };
    expect(Array.isArray(hooks.onPersist)).toBe(true);
  });

  it('onRestore accepts a single PipelineHook<WorkflowState, OnRestoreArgs>', () => {
    const fn: PipelineHook<WorkflowState, OnRestoreArgs> = (value) => value;
    const hooks: WorkflowHooks = { onRestore: fn };
    expect(hooks.onRestore).toBe(fn);
  });

  it('onRestore accepts an array of PipelineHooks', () => {
    const hooks: WorkflowHooks = { onRestore: [(v) => v] };
    expect(Array.isArray(hooks.onRestore)).toBe(true);
  });

  it('beforeRunMerge accepts a single FirstWinsHook', () => {
    const fn: FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs> = () => ({
      proceed: true,
      strategy: 'squash',
    });
    const hooks: WorkflowHooks = { beforeRunMerge: fn };
    expect(hooks.beforeRunMerge).toBe(fn);
  });

  it('beforeRunMerge accepts an array of FirstWinsHooks', () => {
    const hooks: WorkflowHooks = {
      beforeRunMerge: [() => undefined, () => ({ proceed: false })],
    };
    expect(Array.isArray(hooks.beforeRunMerge)).toBe(true);
  });

  it('onRunMergeConflict accepts a single FirstWinsHook', () => {
    const fn: FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs> = () => ({
      strategy: 'agent',
    });
    const hooks: WorkflowHooks = { onRunMergeConflict: fn };
    expect(hooks.onRunMergeConflict).toBe(fn);
  });

  it('onRunMergeConflict accepts an array of FirstWinsHooks', () => {
    const hooks: WorkflowHooks = {
      onRunMergeConflict: [() => undefined, () => ({ strategy: 'manual', resolvedFiles: [] })],
    };
    expect(Array.isArray(hooks.onRunMergeConflict)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Composition rule per hook (observe / pipeline / first-wins)
//    — a PipelineHook is NOT assignable where an ObserveHook is expected and
//    vice versa; this guards against wiring the wrong mechanism to a hook name.
// ═══════════════════════════════════════════════════════════════════════════════

describe('composition rule per hook', () => {
  it('onWorkflowResume rejects a PipelineHook (wrong mechanism)', () => {
    const pipeline: PipelineHook<WorkflowState, OnPersistArgs> = (v) => v;
    // @ts-expect-error — onWorkflowResume must be an ObserveHook, not a pipeline
    const bad: WorkflowHooks = { onWorkflowResume: pipeline };
    void bad;
  });

  it('onPersist rejects an ObserveHook (wrong mechanism)', () => {
    const observe: ObserveHook<OnPersistArgs> = () => {};
    // @ts-expect-error — onPersist must be a PipelineHook (returns a value)
    const bad: WorkflowHooks = { onPersist: observe };
    void bad;
  });

  it('beforeRunMerge rejects an ObserveHook (wrong mechanism)', () => {
    const observe: ObserveHook<BeforeRunMergeArgs> = () => {};
    // @ts-expect-error — beforeRunMerge must be a FirstWinsHook
    const bad: WorkflowHooks = { beforeRunMerge: observe };
    void bad;
  });

  it('onWorkflowAbort rejects a FirstWinsHook (wrong mechanism)', () => {
    const firstWins: FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs> = () => undefined;
    // @ts-expect-error — onWorkflowAbort must be an ObserveHook
    const bad: WorkflowHooks = { onWorkflowAbort: firstWins };
    void bad;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Hook-function runtime behavior — callable with the right args/return shape
// ═══════════════════════════════════════════════════════════════════════════════

describe('observe hooks — runtime invocation', () => {
  it('onWorkflowResume can run sync and is passed (args, ctx)', () => {
    const seen: Array<{ workDir: string; cwd: string }> = [];
    const hook: ObserveHook<OnWorkflowResumeArgs> = (args, ctx) => {
      seen.push({ workDir: args.workDir, cwd: ctx.cwd });
    };
    const result = hook({ workDir: '/run', tracker: {} }, makeCtx({ cwd: '/repo' }));
    expect(result).toBeUndefined();
    expect(seen).toEqual([{ workDir: '/run', cwd: '/repo' }]);
  });

  it('onWorkflowResume can run async returning Promise<void>', async () => {
    const hook: ObserveHook<OnWorkflowResumeArgs> = async (args) => {
      expect(args.tracker).toEqual({});
    };
    const result = hook({ workDir: '/run', tracker: {} }, makeCtx());
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('onWorkflowAbort receives the abort reason', async () => {
    const hook: ObserveHook<OnWorkflowAbortArgs> = (args) => {
      expect(args.reason).toBe('SIGINT');
    };
    hook({ reason: 'SIGINT', workDir: '/run' }, makeCtx());
  });
});

describe('pipeline hooks — runtime value transform', () => {
  it('onPersist transforms a WorkflowState synchronously and returns it', async () => {
    const hook: PipelineHook<WorkflowState, OnPersistArgs> = (value) => value;
    const state = makeState();
    const out = await hook(state, { workDir: '/run' }, makeCtx());
    expect(out).toBe(state);
    expect(out.currentPhaseId).toBe('coding');
  });

  it('onPersist can return a Promise<WorkflowState>', async () => {
    const hook: PipelineHook<WorkflowState, OnPersistArgs> = async (value) => value;
    const state = makeState();
    await expect(hook(state, { workDir: '/run' }, makeCtx())).resolves.toBe(state);
  });

  it('onRestore can mutate the restored WorkflowState', async () => {
    const stamp: PipelineHook<WorkflowState, OnRestoreArgs> = (value) => {
      value.workflowData.restoredAt = 123;
      return value;
    };
    const state = makeState();
    const out = await stamp(state, { workDir: '/run' }, makeCtx());
    expect(out.workflowData.restoredAt).toBe(123);
  });
});

describe('first-wins hooks — runtime decision', () => {
  it('beforeRunMerge can decide (winner)', () => {
    const hook: FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs> = () => ({
      proceed: true,
      strategy: 'squash',
    });
    const out = hook({ repoRoot: '/repo', mainBranch: 'main' }, makeCtx());
    expect(out).toEqual({ proceed: true, strategy: 'squash' });
  });

  it('beforeRunMerge can abstain (undefined)', () => {
    const hook: FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs> = () => undefined;
    expect(hook({ repoRoot: '/repo', mainBranch: 'main' }, makeCtx())).toBeUndefined();
  });

  it('beforeRunMerge receives the optional worktree when present', () => {
    let received: BeforeRunMergeArgs | undefined;
    const hook: FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs> = (args) => {
      received = args;
      return { proceed: true, strategy: 'squash' };
    };
    hook({ worktree: makeWorktree(), repoRoot: '/repo', mainBranch: 'main' }, makeCtx());
    expect(received?.worktree?.branchName).toBe('engin/run-1');
  });

  it('onRunMergeConflict can decide (winner)', () => {
    const hook: FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs> = () => ({
      strategy: 'agent',
    });
    const out = hook({ conflicts: ['src/a.ts'], worktreePath: '/wt', repoRoot: '/repo' }, makeCtx());
    expect(out).toEqual({ strategy: 'agent' });
  });

  it('onRunMergeConflict can abstain (undefined)', () => {
    const hook: FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs> = () => undefined;
    expect(hook({ conflicts: [], worktreePath: '/wt', repoRoot: '/repo' }, makeCtx())).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Type reuse — WorkflowState & WorktreeInfo come from core/types.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('type reuse — shared engine types flow through the hooks', () => {
  it('a core/types WorkflowState is the onPersist pipeline value (assignable round-trip)', () => {
    // A function typed over the imported WorkflowState satisfies the field.
    const hook: NonNullable<WorkflowHooks['onPersist']> = (value: WorkflowState): WorkflowState => value;
    const state = makeState();
    expect(hook(state, { workDir: '/run' }, makeCtx())).toBe(state);
  });

  it('a core/types WorktreeInfo populates BeforeRunMergeArgs.worktree', () => {
    const wt: WorktreeInfo = makeWorktree();
    const args: BeforeRunMergeArgs = { worktree: wt, repoRoot: '/repo', mainBranch: 'main' };
    // Identity preserved — the same object flows through without re-shaping.
    expect(args.worktree).toBe(wt);
  });

  it('the hooks module remains a loadable type-only surface (no runtime circular dep)', async () => {
    // The new `import type { WorkflowState, WorktreeInfo } from '../core/types.js'`
    // is erased at runtime, so adding the workflow-level hooks must not introduce
    // a runtime dependency edge. The module namespace stays free of value exports
    // (the mechanism types file never shipped runtime values).
    const mod = await import('../../packages/engine/src/hooks/types.js');
    expect(mod).toBeTypeOf('object');
    expect(Object.keys(mod)).toEqual([]);
  });
});
