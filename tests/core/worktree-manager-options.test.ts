// ─── Tests: worktreeManager field threading through execution types ────────
//
// Test-first specification for the additive type change that threads an
// optional `worktreeManager?: WorktreeManager` through every options/context
// interface on the execution path:
//
//   - WorkflowRunOptions          (core/types.ts)
//   - LanePoolOptions             (pool/types.ts)
//   - TaskRunnerContext           (pool/types.ts)
//   - StepExecutionContext        (pool/step-execution.ts)
//   - RunStepTaskOptions          (core/phase-tasks.ts)
//   - RunMultiStepTaskOptions     (core/phase-tasks.ts)
//
// The change is PURELY ADDITIVE: every field is optional, so existing callers
// that don't pass `worktreeManager` compile unchanged. These tests pin:
//
//   1. COMPILE-TIME (tsc --noEmit): each interface has the field, it is
//      OPTIONAL, and its type is EXACTLY `WorktreeManager | undefined`
//      (no `unknown`, not required, not widened to `object`, etc.). Enforced
//      by `OptionalFieldIs` + `assertType` (TS2344 when the shape diverges).
//      Mirrors the pattern in tests/core/types.test.ts.
//
//   2. RUNTIME (bun test): the field can be set to a real WorktreeManager and
//      read back, and omitting it yields `undefined` (backward compat). bun
//      strips types so these run regardless of the compile-time gates.
//
// Until the source interfaces gain the field, the compile-time gates fail to
// type-check (expected for test-first authoring); the runtime tests pass.

import { describe, expect, it } from 'bun:test';

import type { RunMultiStepTaskOptions, RunStepTaskOptions } from '../../packages/engine/src/core/phase-tasks.js';
import type { Task, WorkflowRunOptions } from '../../packages/engine/src/core/types.js';
import type { WorktreeManagerOptions } from '../../packages/engine/src/core/worktree-manager.js';
import { WorktreeManager } from '../../packages/engine/src/core/worktree-manager.js';
import type { HookRegistry } from '../../packages/engine/src/hooks/types.js';
import type { StepExecutionContext } from '../../packages/engine/src/pool/step-execution.js';
import type { LanePoolOptions, TaskRunnerContext } from '../../packages/engine/src/pool/types.js';
import { TaskTracker } from '../../packages/engine/src/tracking/task-status.js';

// ─── Type-level utilities ──────────────────────────────────────────────────

/**
 * Exact structural equality via the function-call-signature trick. Resolves to
 * `true` iff X and Y are structurally identical (catches extra/missing
 * optionality, type widening, etc.). Copied from tests/core/types.test.ts.
 */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * Compile-time assertion. Produces TS2344
 * ("Type 'false' does not satisfy the constraint 'true'") when the type-level
 * boolean is not `true`. No runtime effect (empty body).
 */
function assertType<T extends true>(_desc?: string): void {}

/**
 * Resolves to `true` iff interface `T` has a field named `K` whose type is
 * EXACTLY `V | undefined` (i.e. declared as `K?: V`).
 *
 * - Missing field  → `false` (via the `K extends keyof T` guard)
 * - Required field → `false` (no `undefined` in the type)
 * - Wrong type     → `false` (Equal is exact)
 * - Widened type   → `false` (e.g. `unknown` ≠ `WorktreeManager | undefined`)
 */
type OptionalFieldIs<T, K extends string, V> = K extends keyof T ? Equal<T[K], V | undefined> : false;

// ─── Compile-time gates ────────────────────────────────────────────────────
//
// Each line fails to compile (TS2344) until the named interface gains the
// optional `worktreeManager?: WorktreeManager` field. They are the precise
// feature gate; once the additive change lands, all six resolve to `true`.

assertType<OptionalFieldIs<WorkflowRunOptions, 'worktreeManager', WorktreeManager>>(
  'WorkflowRunOptions.worktreeManager is optional WorktreeManager',
);
assertType<OptionalFieldIs<LanePoolOptions, 'worktreeManager', WorktreeManager>>(
  'LanePoolOptions.worktreeManager is optional WorktreeManager',
);
assertType<OptionalFieldIs<TaskRunnerContext, 'worktreeManager', WorktreeManager>>(
  'TaskRunnerContext.worktreeManager is optional WorktreeManager',
);
assertType<OptionalFieldIs<StepExecutionContext, 'worktreeManager', WorktreeManager>>(
  'StepExecutionContext.worktreeManager is optional WorktreeManager',
);
assertType<OptionalFieldIs<RunStepTaskOptions, 'worktreeManager', WorktreeManager>>(
  'RunStepTaskOptions.worktreeManager is optional WorktreeManager',
);
assertType<OptionalFieldIs<RunMultiStepTaskOptions, 'worktreeManager', WorktreeManager>>(
  'RunMultiStepTaskOptions.worktreeManager is optional WorktreeManager',
);

// ─── WorktreeManagerOptions.hookRegistry ───────────────────────────────────
//
// The worktree-hook wiring task adds an OPTIONAL `hookRegistry?: HookRegistry`
// to WorktreeManagerOptions so the manager can invoke worktree-lifecycle hooks
// (populateWorktree, beforeTaskWorktreeCreate, onTaskMerge, …) instead of
// hard-coding the direct git/agent primitives. The field MUST be optional
// (backward compat: existing callers that omit it compile unchanged).

assertType<OptionalFieldIs<WorktreeManagerOptions, 'hookRegistry', HookRegistry>>(
  'WorktreeManagerOptions.hookRegistry is optional HookRegistry',
);

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeManager(): WorktreeManager {
  // The constructor only stores fields (no git I/O), so dummy paths are safe.
  return new WorktreeManager({
    repoRoot: '/repo',
    sourceCwd: '/repo',
    workDir: '/run',
    mainBranch: 'engin/main',
    mainWorktreePath: '/run/worktree',
    profilesDirs: ['/profiles'],
  });
}

const sampleTask: Task = {
  id: 'task-1',
  title: 'Sample task',
  prompt: 'do the work',
  profile: 'coder',
  files: [],
  dependencies: [],
  status: 'ready',
  worktree: 'none',
  phaseId: 'phase-1',
};

/**
 * Minimal required-field objects for each interface. `worktreeManager` is
 * deliberately OMITTED here and added per-test. Typed via `Omit<…,
 * 'worktreeManager'>` so the helpers type-check both BEFORE the field is added
 * (Omit of a non-existent key is a harmless no-op) and AFTER.
 */
function baseRunOptions(): Omit<WorkflowRunOptions, 'worktreeManager'> {
  return { cwd: '/repo', workDir: '/run' };
}

function basePoolOptions(): Omit<LanePoolOptions, 'worktreeManager'> {
  return {
    maxConcurrentLanes: 1,
    profilesDirs: ['/profiles'],
    sessionBaseDir: '/sessions',
    cwd: '/repo',
    taskTracker: new TaskTracker(),
    phaseId: 'phase-1',
  };
}

function baseRunnerContext(): Omit<TaskRunnerContext, 'worktreeManager'> {
  return {
    task: sampleTask,
    agentId: 'agent-1',
    profiles: new Map(),
    onStatus: undefined,
    activeSessions: new Set(),
    phaseId: 'phase-1',
    sessionBaseDir: '/sessions',
    cwd: '/repo',
    maxStepRetries: 3,
    completeTask: () => true,
    failTask: () => {},
  };
}

function baseExecContext(): Omit<StepExecutionContext, 'worktreeManager'> {
  return {
    sessionBaseDir: '/sessions',
    cwd: '/repo',
    onStatus: undefined,
    activeSessions: new Set(),
    phaseId: 'phase-1',
  };
}

function baseStepTaskOptions(): Omit<RunStepTaskOptions, 'worktreeManager'> {
  return {
    profilesDirs: ['/profiles'],
    phaseId: 'phase-1',
    taskId: 'task-1',
    title: 'Step task',
    profileId: 'coder',
    stepName: 'step',
    cwd: '/repo',
    prompt: 'do the work',
  };
}

function baseMultiStepOptions(): Omit<RunMultiStepTaskOptions, 'worktreeManager'> {
  return {
    profilesDirs: ['/profiles'],
    phaseId: 'phase-1',
    taskId: 'task-1',
    title: 'Multi-step task',
    cwd: '/repo',
    steps: [],
  };
}

// ─── Runtime tests ─────────────────────────────────────────────────────────
//
// For each interface: one acceptance test (set the field, read it back) and
// one backward-compat test (omit the field, it is undefined). bun strips types
// so these execute regardless of the compile-time gates above.

describe('worktreeManager optional field — acceptance + backward compat', () => {
  describe('WorkflowRunOptions', () => {
    it('accepts an optional worktreeManager (round-trips the instance)', () => {
      const opts: WorkflowRunOptions = { ...baseRunOptions(), worktreeManager: makeManager() };
      expect(opts.worktreeManager).toBeInstanceOf(WorktreeManager);
    });

    it('can be constructed without worktreeManager (backward compat)', () => {
      const opts: WorkflowRunOptions = baseRunOptions();
      expect(opts.worktreeManager).toBeUndefined();
    });
  });

  describe('LanePoolOptions', () => {
    it('accepts an optional worktreeManager', () => {
      const opts: LanePoolOptions = { ...basePoolOptions(), worktreeManager: makeManager() };
      expect(opts.worktreeManager).toBeInstanceOf(WorktreeManager);
    });

    it('can be constructed without worktreeManager (backward compat)', () => {
      const opts: LanePoolOptions = basePoolOptions();
      expect(opts.worktreeManager).toBeUndefined();
    });
  });

  describe('TaskRunnerContext', () => {
    it('accepts an optional worktreeManager', () => {
      const ctx: TaskRunnerContext = { ...baseRunnerContext(), worktreeManager: makeManager() };
      expect(ctx.worktreeManager).toBeInstanceOf(WorktreeManager);
    });

    it('can be constructed without worktreeManager (backward compat)', () => {
      const ctx: TaskRunnerContext = baseRunnerContext();
      expect(ctx.worktreeManager).toBeUndefined();
    });
  });

  describe('StepExecutionContext', () => {
    it('accepts an optional worktreeManager', () => {
      const ctx: StepExecutionContext = { ...baseExecContext(), worktreeManager: makeManager() };
      expect(ctx.worktreeManager).toBeInstanceOf(WorktreeManager);
    });

    it('can be constructed without worktreeManager (backward compat)', () => {
      const ctx: StepExecutionContext = baseExecContext();
      expect(ctx.worktreeManager).toBeUndefined();
    });
  });

  describe('RunStepTaskOptions', () => {
    it('accepts an optional worktreeManager', () => {
      const opts: RunStepTaskOptions = { ...baseStepTaskOptions(), worktreeManager: makeManager() };
      expect(opts.worktreeManager).toBeInstanceOf(WorktreeManager);
    });

    it('can be constructed without worktreeManager (backward compat)', () => {
      const opts: RunStepTaskOptions = baseStepTaskOptions();
      expect(opts.worktreeManager).toBeUndefined();
    });
  });

  describe('RunMultiStepTaskOptions', () => {
    it('accepts an optional worktreeManager', () => {
      const opts: RunMultiStepTaskOptions = { ...baseMultiStepOptions(), worktreeManager: makeManager() };
      expect(opts.worktreeManager).toBeInstanceOf(WorktreeManager);
    });

    it('can be constructed without worktreeManager (backward compat)', () => {
      const opts: RunMultiStepTaskOptions = baseMultiStepOptions();
      expect(opts.worktreeManager).toBeUndefined();
    });
  });
});

// ─── WorktreeManager import target sanity ──────────────────────────────────
//
// Guards that the type the new fields reference is the real class exported
// from core/worktree-manager.ts — so the type-only `import type { WorktreeManager }`
// added to the source interfaces resolves correctly.

describe('WorktreeManager import target', () => {
  it('is constructible with the documented options (no git I/O in the constructor)', () => {
    const mgr = makeManager();
    expect(mgr).toBeInstanceOf(WorktreeManager);
    expect(mgr.mainBranch).toBe('engin/main');
    expect(mgr.mainWorktreePath).toBe('/run/worktree');
    expect(mgr.repoRoot).toBe('/repo');
    expect(mgr.sourceCwd).toBe('/repo');
  });
});

// ─── WorktreeManagerOptions.hookRegistry — runtime acceptance + backward compat ──

describe('WorktreeManagerOptions.hookRegistry — acceptance + backward compat', () => {
  it('accepts an optional hookRegistry (round-trips a registry instance via opts)', () => {
    // The constructor accepts hookRegistry without throwing. The registry is
    // stored internally (verified behaviourally in worktree-manager-hooks.test.ts).
    // A minimal stand-in is sufficient here — the constructor only stores it.
    const fakeRegistry = { hasSubscribers: () => false } as unknown as HookRegistry;
    const mgr = new WorktreeManager({
      ...makeManagerOptsBase(),
      hookRegistry: fakeRegistry,
    });
    expect(mgr).toBeInstanceOf(WorktreeManager);
  });

  it('can be constructed WITHOUT hookRegistry (backward compat)', () => {
    const mgr = new WorktreeManager(makeManagerOptsBase());
    expect(mgr).toBeInstanceOf(WorktreeManager);
  });
});

/** Base WorktreeManagerOptions without hookRegistry (used by the acceptance tests above). */
function makeManagerOptsBase(): WorktreeManagerOptions {
  return {
    repoRoot: '/repo',
    sourceCwd: '/repo',
    workDir: '/run',
    mainBranch: 'engin/main',
    mainWorktreePath: '/run/worktree',
    profilesDirs: ['/profiles'],
  };
}
