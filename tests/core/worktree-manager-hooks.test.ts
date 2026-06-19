// ─── Tests for WorktreeManager worktree-hook wiring (TEST-FIRST) ──────────────
//
// Test-first specification for wiring the six worktree-lifecycle hooks
// (declared in hooks/types.ts, with defaults in hooks/defaults/worktree.ts)
// into `packages/engine/src/core/worktree-manager.ts`.
//
// WHAT IT PINS
//   WorktreeManager gains an OPTIONAL `hookRegistry?: HookRegistry` on
//   `WorktreeManagerOptions`. When a registry is threaded, the manager
//   INVOKES hooks at every worktree lifecycle seam INSTEAD of hard-coding
//   the direct git/agent primitives. When NO registry is threaded, EVERY
//   method behaves EXACTLY as today (the firmest backward-compat guarantee).
//
//   The six wiring seams:
//
//   1. setupMainWorktree / createTaskWorktree — POPULATE:
//        Replaces the direct `populateWorktree(sourceCwd, worktreePath)` call
//        with `registry.invokePipeline('populateWorktree', undefined,
//        { worktreePath, sourceCwd, task? }, ctx)`. The default subscriber
//        (createDefaultPopulateWorktree) calls the existing primitive.
//
//   2. createTaskWorktree — BEFORE CREATE (first-wins decision):
//        Before creating, invokes
//        `registry.invokeFirstWins('beforeTaskWorktreeCreate',
//        { task, worktreeManager: this }, ctx)`. When the result is
//        `{ skip: true }`, returns the MAIN worktree path (no isolation)
//        WITHOUT creating a task worktree.
//
//   3. createTaskWorktree — AFTER CREATE (observe):
//        After creating, invokes `registry.invokeObserve(
//        'afterTaskWorktreeCreate', { task, worktreePath, branch }, ctx)`.
//
//   4. mergeTaskBranch — ON TASK MERGE (first-wins decision):
//        Before merging, invokes `registry.invokeFirstWins('onTaskMerge',
//        { task, worktreePath, branch }, ctx)`. When `{ proceed: false }`,
//        skips the merge and returns `{ success: false, conflictsResolved: false }`.
//
//   5. mergeTaskBranch — ON MERGE CONFLICT (first-wins decision):
//        On a squash-merge conflict, invokes `registry.invokeFirstWins(
//        'onMergeConflict', { task, conflicts, worktreePath, mainBranch },
//        ctx)` INSTEAD of the direct `resolveConflictsWithAgent` call. The
//        strategy marker drives the follow-up ('agent' → resolve via the
//        tooled primitive; 'manual'/'abort' → leave unresolved).
//
//   6. mergeTaskBranch — ON COMMIT FAILURE (first-wins decision):
//        When `commitWorktreeChanges` throws, invokes
//        `registry.invokeFirstWins('onCommitFailure', { task, errors,
//        worktreePath }, ctx)`.
//
// SIGNATURE ASSUMPTION (documented for the implementer):
//   `createTaskWorktree(taskId: string, taskPrompt?: string, task?: Task)`
//   — a backward-compatible OPTIONAL third `task` param. When provided AND a
//   registry is threaded, the hooks receive the full Task. When omitted, the
//   manager synthesizes a minimal Task (id/taskPrompt only) so the hook args
//   type-check. The hooks' high-value behavior (e.g. scout-skip via
//   task.profile) is only active when the caller (LanePool) passes the Task.
//
// APPROACH: mirrors the mock pattern in tests/core/worktree-manager.test.ts
// (mocks git.js / worktree-operations.js / worktree-lifecycle.js), but uses a
// REAL HookRegistry (from hooks/registry.ts) with spy subscribers so the
// invocation paths (invokeFirstWins / invokePipeline / invokeObserve) are
// exercised against the real composition engine.
//
// Tests are RED until the wiring lands in worktree-manager.ts.

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { join } from 'node:path';

import type { Task } from '../../packages/engine/src/core/types.js';

// ─── Capture real modules before mocking ────────────────────────────────────
const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realWorktreeOperations = Object.assign({}, await import('../../packages/engine/src/core/worktree-operations.js'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.js'));

// ─── Mock functions for git.ts ──────────────────────────────────────────────

const mockCreateWorktree = mock((_repoRoot: string, _branch: string, _targetPath: string): void => {});
const mockRemoveWorktree = mock((_repoRoot: string, _worktreePath: string): void => {});
const mockWorktreePrune = mock((_repoRoot: string): void => {});
const mockPopulateWorktree = mock((_sourceCwd: string, _worktreePath: string): void => {});
const mockSquashMergeBranch = mock(
  (
    _repoRoot: string,
    _branch: string,
  ): { success: true } | { success: false; conflicts: string[]; error?: string } => ({ success: true }),
);
const mockStageFiles = mock((_repoRoot: string, _files: string[]): void => {});
const mockDeleteBranchForce = mock((_repoRoot: string, _branch: string): void => {});
const mockCommitChanges = mock((_dir: string, _message: string): void => {});
const mockGetMainBranch = mock((_dir: string): string => 'main');
const mockGetCurrentBranch = mock((_dir: string): string => 'previous-branch');
const mockCheckoutBranch = mock((_repoRoot: string, _branch: string): void => {});
const mockAbortMerge = mock((_repoRoot: string): void => {});

// ─── Mock functions for worktree-operations.ts ──────────────────────────────

const mockCommitWorktreeChanges = mock(async (_opts: unknown): Promise<void> => {});

// ─── Mock functions for worktree-lifecycle.ts ───────────────────────────────

const mockResolveConflictsWithAgent = mock(
  async (
    _profilesDirs: string[],
    _repoRoot: string,
    _conflicts: string[],
    _taskPrompt: string,
    _apiKeys?: Record<string, string>,
  ): Promise<{ resolved: boolean; error?: string }> => ({ resolved: true }),
);

// ─── Mock modules ────────────────────────────────────────────────────────────

mock.module('../../packages/engine/src/core/git.js', () => ({
  ...realGit,
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  worktreePrune: mockWorktreePrune,
  populateWorktree: mockPopulateWorktree,
  squashMergeBranch: mockSquashMergeBranch,
  stageFiles: mockStageFiles,
  deleteBranchForce: mockDeleteBranchForce,
  commitChanges: mockCommitChanges,
  getMainBranch: mockGetMainBranch,
  getCurrentBranch: mockGetCurrentBranch,
  checkoutBranch: mockCheckoutBranch,
  abortMerge: mockAbortMerge,
}));

mock.module('../../packages/engine/src/core/worktree-operations.js', () => ({
  ...realWorktreeOperations,
  commitWorktreeChanges: mockCommitWorktreeChanges,
}));

mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => ({
  ...realWorktreeLifecycle,
  resolveConflictsWithAgent: mockResolveConflictsWithAgent,
}));

// ─── Import SUT + real HookRegistry after mocks ──────────────────────────────

import { WorktreeManager, type WorktreeManagerOptions } from '../../packages/engine/src/core/worktree-manager.js';
import { createHookRegistry } from '../../packages/engine/src/hooks/registry.js';
import type {
  HookContext,
  HookRegistry,
  PopulateWorktreeArgs,
  WorkflowHooks,
} from '../../packages/engine/src/hooks/types.js';

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/git.js', () => realGit);
  mock.module('../../packages/engine/src/core/worktree-operations.js', () => realWorktreeOperations);
  mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => realWorktreeLifecycle);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_OPTS: WorktreeManagerOptions = {
  repoRoot: '/fake/repo',
  sourceCwd: '/fake/source',
  workDir: '/run/work',
  mainBranch: 'engin/feat-x',
  mainWorktreePath: '/run/work/worktree',
  profilesDirs: ['/profiles'],
};

function makeOpts(overrides?: Partial<WorktreeManagerOptions>): WorktreeManagerOptions {
  return { ...DEFAULT_OPTS, ...overrides };
}

function makeManager(overrides?: Partial<WorktreeManagerOptions>): WorktreeManager {
  return new WorktreeManager(makeOpts(overrides));
}

/** The computed per-task worktree path: {workDir}/task-worktrees/{taskId} */
function taskWorktreePath(workDir: string, taskId: string): string {
  return join(workDir, 'task-worktrees', taskId);
}

/** A minimal Task fixture for hook-arg verification. */
function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Do thing',
    prompt: 'implement feature X',
    profile: 'coder',
    files: [],
    dependencies: [],
    status: 'active',
    phaseId: 'code',
    ...overrides,
  };
}

/**
 * Build a REAL HookRegistry with all six worktree-lifecycle hooks DECLARED
 * (so invoke* can route to them) but with NO subscribers. Tests register
 * their own spy subscribers as needed.
 */
function makeRegistry(): HookRegistry {
  const reg = createHookRegistry();
  reg.defineHook('beforeTaskWorktreeCreate', 'first-wins');
  reg.defineHook('afterTaskWorktreeCreate', 'observe');
  reg.defineHook('populateWorktree', 'pipeline');
  reg.defineHook('onTaskMerge', 'first-wins');
  reg.defineHook('onMergeConflict', 'first-wins');
  reg.defineHook('onCommitFailure', 'first-wins');
  return reg;
}

/**
 * Cast a plain hooks record through `unknown` to WorkflowHooks — the same
 * trick used in run-executor.test.ts / compose.test.ts so a `{ hookName: fn }`
 * record passes excess-property checking.
 */
function asHooks(hooks: Record<string, unknown>): WorkflowHooks {
  return hooks as unknown as WorkflowHooks;
}

// ─── Reset mocks ─────────────────────────────────────────────────────────────

function resetMocks() {
  mock.clearAllMocks();
  mockWorktreePrune.mockImplementation(() => {});
  mockCreateWorktree.mockImplementation(() => {});
  mockPopulateWorktree.mockImplementation(() => {});
  mockRemoveWorktree.mockImplementation(() => {});
  mockDeleteBranchForce.mockImplementation(() => {});
  mockStageFiles.mockImplementation(() => {});
  mockCommitChanges.mockImplementation(() => {});
  mockCheckoutBranch.mockImplementation(() => {});
  mockAbortMerge.mockImplementation(() => {});
  mockGetMainBranch.mockReturnValue('main');
  mockGetCurrentBranch.mockReturnValue('previous-branch');
  mockSquashMergeBranch.mockReturnValue({ success: true });
  mockCommitWorktreeChanges.mockResolvedValue(undefined);
  mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });
}

beforeEach(() => {
  resetMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. hookRegistry option acceptance
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorktreeManager — hookRegistry option', () => {
  it('accepts hookRegistry in WorktreeManagerOptions (compiles + constructs)', () => {
    const reg = makeRegistry();
    const wm = makeManager({ hookRegistry: reg });
    // No throw — the option is accepted. Behaviour verified in the suites below.
    expect(wm).toBeInstanceOf(WorktreeManager);
  });

  it('can be constructed WITHOUT hookRegistry (backward compat)', () => {
    const wm = makeManager();
    expect(wm).toBeInstanceOf(WorktreeManager);
  });

  it('hookRegistry is optional — omitting it yields no hook invocations on setupMainWorktree', async () => {
    // When no registry is threaded, setupMainWorktree must use the DIRECT
    // populateWorktree primitive (the backward-compat path). Verified by the
    // direct mock being called and no exception thrown.
    const wm = makeManager();
    await wm.setupMainWorktree();

    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', '/run/work/worktree');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. setupMainWorktree — populateWorktree pipeline hook
// ═══════════════════════════════════════════════════════════════════════════════

describe('setupMainWorktree — populateWorktree hook', () => {
  it('invokes the populateWorktree pipeline subscriber when a registry is threaded', async () => {
    const reg = makeRegistry();
    const seen: PopulateWorktreeArgs[] = [];
    reg.register(
      asHooks({ populateWorktree: async (_v: undefined, args: PopulateWorktreeArgs) => void seen.push(args) }),
    );

    const wm = makeManager({ hookRegistry: reg, sourceCwd: '/fake/source', mainWorktreePath: '/run/work/worktree' });
    await wm.setupMainWorktree();

    expect(seen).toHaveLength(1);
    expect(seen[0].worktreePath).toBe('/run/work/worktree');
    expect(seen[0].sourceCwd).toBe('/fake/source');
    // setupMainWorktree has no task context — task is undefined for the main worktree.
    expect(seen[0].task).toBeUndefined();
  });

  it('does NOT call the direct populateWorktree primitive when a pipeline subscriber handles it', async () => {
    // When a registry is threaded, the manager routes through the pipeline.
    // A custom subscriber that does NOT call the direct primitive must suppress
    // the direct call entirely (the manager no longer hard-codes it).
    const reg = makeRegistry();
    reg.register(asHooks({ populateWorktree: async () => undefined }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.setupMainWorktree();

    expect(mockPopulateWorktree).not.toHaveBeenCalled();
  });

  it('falls back to the direct populateWorktree primitive when NO registry is threaded (backward compat)', async () => {
    const wm = makeManager({ sourceCwd: '/fake/source', mainWorktreePath: '/run/work/worktree' });
    await wm.setupMainWorktree();

    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', '/run/work/worktree');
  });

  it('passes a HookContext carrying the registry, sourceCwd as cwd, and workDir to the subscriber', async () => {
    const reg = makeRegistry();
    let capturedCtx: HookContext | undefined;
    reg.register(
      asHooks({
        populateWorktree: async (_v: undefined, _args: PopulateWorktreeArgs, ctx: HookContext) => {
          capturedCtx = ctx;
        },
      }),
    );

    const wm = makeManager({ hookRegistry: reg, sourceCwd: '/the/source', workDir: '/the/work' });
    await wm.setupMainWorktree();

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.registry).toBe(reg);
    expect(capturedCtx!.cwd).toBe('/the/source');
    expect(capturedCtx!.workDir).toBe('/the/work');
  });

  it('still prunes and creates the worktree alongside the pipeline populate (order unchanged)', async () => {
    // The populate hook REPLACES only the populate step — prune + createWorktree
    // still run. The pipeline populate runs AFTER createWorktree (the worktree
    // must exist before it can be populated).
    const reg = makeRegistry();
    const calls: string[] = [];
    reg.register(asHooks({ populateWorktree: async () => void calls.push('populateHook') }));

    mockWorktreePrune.mockImplementation(() => calls.push('prune'));
    mockCreateWorktree.mockImplementation(() => calls.push('createWorktree'));

    const wm = makeManager({ hookRegistry: reg });
    await wm.setupMainWorktree();

    expect(calls).toEqual(['prune', 'createWorktree', 'populateHook']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. createTaskWorktree — beforeTaskWorktreeCreate (first-wins decision)
// ═══════════════════════════════════════════════════════════════════════════════

describe('createTaskWorktree — beforeTaskWorktreeCreate hook', () => {
  it('invokes beforeTaskWorktreeCreate before creating the worktree when a registry is threaded', async () => {
    const reg = makeRegistry();
    let invoked = false;
    reg.register(asHooks({ beforeTaskWorktreeCreate: async () => void (invoked = true) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));

    expect(invoked).toBe(true);
  });

  it('passes { task, worktreeManager } where worktreeManager is the manager instance', async () => {
    const reg = makeRegistry();
    let capturedArgs: { task?: Task; worktreeManager?: unknown } | undefined;
    const task = makeTask({ id: 'task-1', profile: 'coder' });
    reg.register(
      asHooks({
        beforeTaskWorktreeCreate: async (args: { task: Task; worktreeManager: unknown }) => {
          capturedArgs = args;
        },
      }),
    );

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', task);

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.task).toBe(task);
    expect(capturedArgs!.worktreeManager).toBe(wm);
  });

  it('returns the MAIN worktree path and does NOT create a task worktree when the hook returns { skip: true }', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ beforeTaskWorktreeCreate: async () => ({ skip: true }) }));

    const wm = makeManager({ hookRegistry: reg, mainWorktreePath: '/run/work/worktree' });
    const result = await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1', profile: 'scout' }));

    // The task runs against the run cwd directly (the main worktree) — no isolation.
    expect(result).toBe('/run/work/worktree');
    // No task worktree was created.
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    // No population happened for a task worktree path.
    expect(mockPopulateWorktree).not.toHaveBeenCalledWith(expect.anything(), taskWorktreePath('/run/work', 'task-1'));
  });

  it('creates the task worktree normally when the hook abstains (returns undefined)', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ beforeTaskWorktreeCreate: async () => undefined }));

    const wm = makeManager({ hookRegistry: reg, workDir: '/run/work' });
    const result = await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));

    expect(result).toBe(taskWorktreePath('/run/work', 'task-1'));
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
  });

  it('creates the task worktree normally when the hook returns { skip: false }', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ beforeTaskWorktreeCreate: async () => ({ skip: false }) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));

    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke beforeTaskWorktreeCreate when no registry is threaded (backward compat)', async () => {
    // Without a registry, the manager must NOT attempt any hook invocation —
    // it creates the worktree directly. We verify via the absence of any
    // observable hook side effect and the direct createWorktree firing.
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');

    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
    // populateWorktree direct primitive fires (no pipeline).
    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', taskWorktreePath('/run/work', 'task-1'));
  });

  it('still validates taskId BEFORE invoking the hook (assertSafeName runs first)', async () => {
    // The taskId is interpolated into a path + branch name, so validation must
    // precede hook invocation. An unsafe taskId throws before any hook fires.
    const reg = makeRegistry();
    let hookFired = false;
    reg.register(asHooks({ beforeTaskWorktreeCreate: async () => void (hookFired = true) }));

    const wm = makeManager({ hookRegistry: reg });
    await expect(wm.createTaskWorktree('../escape', 'prompt')).rejects.toThrow();

    expect(hookFired).toBe(false);
  });

  it('synthesizes a minimal Task from taskId + taskPrompt when no Task is passed (2-arg backward-compat form + registry)', async () => {
    // When a caller uses the legacy 2-arg form createTaskWorktree(taskId, prompt)
    // but a registry IS threaded, the hooks still need a Task object. The
    // manager synthesizes one from { id: taskId, prompt: taskPrompt } (with
    // sensible defaults for the other required Task fields). This keeps the
    // hooks' args type-correct without forcing every legacy caller to pass a
    // full Task. The synthesized Task will NOT carry a meaningful `profile`, so
    // the default scout-skip hook abstains (no skip) for synthesized tasks.
    const reg = makeRegistry();
    let capturedTask: Task | undefined;
    reg.register(
      asHooks({
        beforeTaskWorktreeCreate: async (args: { task: Task }) => {
          capturedTask = args.task;
        },
      }),
    );

    const wm = makeManager({ hookRegistry: reg, workDir: '/run/work' });
    // 2-arg form: no Task. The hook still fires with a synthesized Task.
    await wm.createTaskWorktree('task-42', 'build the feature');

    expect(capturedTask).toBeDefined();
    expect(capturedTask!.id).toBe('task-42');
    expect(capturedTask!.prompt).toBe('build the feature');
    // The worktree was created (no skip — synthesized Task has no scout profile).
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. createTaskWorktree — populateWorktree pipeline hook
// ═══════════════════════════════════════════════════════════════════════════════

describe('createTaskWorktree — populateWorktree hook', () => {
  it('invokes the populateWorktree pipeline subscriber with the task worktree path + sourceCwd', async () => {
    const reg = makeRegistry();
    const seen: PopulateWorktreeArgs[] = [];
    reg.register(
      asHooks({ populateWorktree: async (_v: undefined, args: PopulateWorktreeArgs) => void seen.push(args) }),
    );

    const wm = makeManager({ hookRegistry: reg, sourceCwd: '/fake/source', workDir: '/run/work' });
    const task = makeTask({ id: 'task-1' });
    await wm.createTaskWorktree('task-1', 'prompt', task);

    expect(seen).toHaveLength(1);
    expect(seen[0].worktreePath).toBe(taskWorktreePath('/run/work', 'task-1'));
    expect(seen[0].sourceCwd).toBe('/fake/source');
    // The task is forwarded so a populate hook can do task-specific work.
    expect(seen[0].task).toBe(task);
  });

  it('does NOT call the direct populateWorktree primitive when a pipeline subscriber handles it', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ populateWorktree: async () => undefined }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));

    expect(mockPopulateWorktree).not.toHaveBeenCalled();
  });

  it('falls back to the direct populateWorktree primitive when NO registry is threaded', async () => {
    const wm = makeManager({ sourceCwd: '/fake/source', workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt');

    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', taskWorktreePath('/run/work', 'task-1'));
  });

  it('a workflow-provided populateWorktree subscriber composes AFTER an earlier subscriber (pipeline order)', async () => {
    // Pipeline hooks run in registration order; each receives the value from
    // the previous. Two subscribers both fire in order.
    const reg = makeRegistry();
    const order: string[] = [];
    reg.register(
      asHooks({
        populateWorktree: [async () => void order.push('first'), async () => void order.push('second')],
      }),
    );

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));

    expect(order).toEqual(['first', 'second']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. createTaskWorktree — afterTaskWorktreeCreate (observe)
// ═══════════════════════════════════════════════════════════════════════════════

describe('createTaskWorktree — afterTaskWorktreeCreate hook', () => {
  it('invokes afterTaskWorktreeCreate after the worktree is created', async () => {
    const reg = makeRegistry();
    let invoked = false;
    reg.register(asHooks({ afterTaskWorktreeCreate: async () => void (invoked = true) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));

    expect(invoked).toBe(true);
  });

  it('passes { task, worktreePath, branch } with the created worktree path + branch', async () => {
    const reg = makeRegistry();
    let capturedArgs: { task?: Task; worktreePath?: string; branch?: string } | undefined;
    const task = makeTask({ id: 'task-1' });
    reg.register(
      asHooks({
        afterTaskWorktreeCreate: async (args: { task: Task; worktreePath: string; branch: string }) => {
          capturedArgs = args;
        },
      }),
    );

    const wm = makeManager({ hookRegistry: reg, workDir: '/run/work', mainBranch: 'engin/feat-x' });
    await wm.createTaskWorktree('task-1', 'prompt', task);

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.task).toBe(task);
    expect(capturedArgs!.worktreePath).toBe(taskWorktreePath('/run/work', 'task-1'));
    expect(capturedArgs!.branch).toBe('engin/feat-x--task-1');
  });

  it('fires AFTER createWorktree + populate (observe runs last)', async () => {
    const reg = makeRegistry();
    const order: string[] = [];
    reg.register(
      asHooks({
        populateWorktree: async () => void order.push('populate'),
        afterTaskWorktreeCreate: async () => void order.push('afterCreate'),
      }),
    );
    mockCreateWorktree.mockImplementation(() => order.push('createWorktree'));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));

    expect(order).toEqual(['createWorktree', 'populate', 'afterCreate']);
  });

  it('does NOT fire afterTaskWorktreeCreate when beforeTaskWorktreeCreate skipped isolation', async () => {
    const reg = makeRegistry();
    let afterFired = false;
    reg.register(
      asHooks({
        beforeTaskWorktreeCreate: async () => ({ skip: true }),
        afterTaskWorktreeCreate: async () => void (afterFired = true),
      }),
    );

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));

    expect(afterFired).toBe(false);
  });

  it('does NOT invoke afterTaskWorktreeCreate when no registry is threaded (backward compat)', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');

    // No registry → no observe fan-out. The worktree is created + populated directly.
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
    expect(mockPopulateWorktree).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. mergeTaskBranch — onTaskMerge (first-wins decision)
// ═══════════════════════════════════════════════════════════════════════════════

describe('mergeTaskBranch — onTaskMerge hook', () => {
  it('invokes onTaskMerge before the squash-merge when a registry is threaded', async () => {
    const reg = makeRegistry();
    let invoked = false;
    reg.register(asHooks({ onTaskMerge: async () => void (invoked = true) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    await wm.mergeTaskBranch('task-1');

    expect(invoked).toBe(true);
  });

  it('passes { task, worktreePath, branch } for the task being merged', async () => {
    const reg = makeRegistry();
    let capturedArgs: { task?: Task; worktreePath?: string; branch?: string } | undefined;
    const task = makeTask({ id: 'task-1' });
    reg.register(
      asHooks({
        onTaskMerge: async (args: { task: Task; worktreePath: string; branch: string }) => {
          capturedArgs = args;
        },
      }),
    );

    const wm = makeManager({ hookRegistry: reg, workDir: '/run/work', mainBranch: 'engin/feat-x' });
    await wm.createTaskWorktree('task-1', 'prompt', task);
    await wm.mergeTaskBranch('task-1');

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.task).toBe(task);
    expect(capturedArgs!.worktreePath).toBe(taskWorktreePath('/run/work', 'task-1'));
    expect(capturedArgs!.branch).toBe('engin/feat-x--task-1');
  });

  it('skips the merge and returns { success: false, conflictsResolved: false } when the hook returns { proceed: false }', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onTaskMerge: async () => ({ proceed: false }) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    const result = await wm.mergeTaskBranch('task-1');

    expect(result).toEqual({ success: false, conflictsResolved: false });
    // The squash-merge was NOT attempted.
    expect(mockSquashMergeBranch).not.toHaveBeenCalled();
    // No merge commit.
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('proceeds with the merge when the hook returns { proceed: true, strategy: "squash" }', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onTaskMerge: async () => ({ proceed: true, strategy: 'squash' }) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    await wm.mergeTaskBranch('task-1');

    expect(mockSquashMergeBranch).toHaveBeenCalledTimes(1);
  });

  it('proceeds with the merge when the hook abstains (returns undefined)', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onTaskMerge: async () => undefined }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    await wm.mergeTaskBranch('task-1');

    expect(mockSquashMergeBranch).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke onTaskMerge when no registry is threaded (backward compat)', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    // The merge proceeds directly (no hook gating).
    expect(mockSquashMergeBranch).toHaveBeenCalledTimes(1);
  });

  it('still commits pending changes BEFORE invoking onTaskMerge (commit precedes the merge decision)', async () => {
    // commitWorktreeChanges runs outside the serialized section, before the
    // merge. The onTaskMerge hook fires inside the serialized section.
    const reg = makeRegistry();
    const order: string[] = [];
    mockCommitWorktreeChanges.mockImplementation(async () => {
      order.push('commit');
    });
    reg.register(asHooks({ onTaskMerge: async () => void order.push('onTaskMerge') }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    await wm.mergeTaskBranch('task-1');

    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('onTaskMerge'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. mergeTaskBranch — onMergeConflict (first-wins decision)
// ═══════════════════════════════════════════════════════════════════════════════

describe('mergeTaskBranch — onMergeConflict hook', () => {
  beforeEach(() => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts', 'src/b.ts'] });
  });

  it('invokes onMergeConflict when the squash-merge conflicts and a registry is threaded', async () => {
    const reg = makeRegistry();
    let invoked = false;
    reg.register(asHooks({ onMergeConflict: async () => void (invoked = true) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    await wm.mergeTaskBranch('task-1');

    expect(invoked).toBe(true);
  });

  it('passes { task, conflicts, worktreePath, mainBranch }', async () => {
    const reg = makeRegistry();
    let capturedArgs:
      | {
          task?: Task;
          conflicts?: string[];
          worktreePath?: string;
          mainBranch?: string;
        }
      | undefined;
    const task = makeTask({ id: 'task-1' });
    reg.register(
      asHooks({
        onMergeConflict: async (args: {
          task: Task;
          conflicts: string[];
          worktreePath: string;
          mainBranch: string;
        }) => {
          capturedArgs = args;
        },
      }),
    );

    const wm = makeManager({ hookRegistry: reg, mainWorktreePath: '/run/work/worktree', mainBranch: 'engin/feat-x' });
    await wm.createTaskWorktree('task-1', 'prompt', task);
    await wm.mergeTaskBranch('task-1');

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.task).toBe(task);
    expect(capturedArgs!.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
    // mainWorktreePath is where the merge happens (the main-wt branch).
    expect(capturedArgs!.worktreePath).toBe('/run/work/worktree');
    expect(capturedArgs!.mainBranch).toBe('engin/feat-x');
  });

  it("calls resolveConflictsWithAgent when the hook returns { strategy: 'agent' }", async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: async () => ({ strategy: 'agent' }) }));

    const wm = makeManager({ hookRegistry: reg, profilesDirs: ['/profiles'] });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    await wm.mergeTaskBranch('task-1');

    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles'],
      '/run/work/worktree',
      ['src/a.ts', 'src/b.ts'],
      'prompt',
      undefined,
    );
  });

  it("does NOT call resolveConflictsWithAgent when the hook returns { strategy: 'manual' }", async () => {
    // 'manual' means the user will resolve the conflicts themselves — the
    // manager must NOT spawn the agent.
    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: async () => ({ strategy: 'manual' }) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    const result = await wm.mergeTaskBranch('task-1');

    expect(mockResolveConflictsWithAgent).not.toHaveBeenCalled();
    // The merge is not resolved.
    expect(result.success).toBe(false);
  });

  it("does NOT call resolveConflictsWithAgent when the hook returns { strategy: 'abort' }", async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: async () => ({ strategy: 'abort' }) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    const result = await wm.mergeTaskBranch('task-1');

    expect(mockResolveConflictsWithAgent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('falls back to resolveConflictsWithAgent directly when NO registry is threaded (backward compat)', async () => {
    const wm = makeManager({ profilesDirs: ['/profiles'] });
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles'],
      '/run/work/worktree',
      ['src/a.ts', 'src/b.ts'],
      'prompt',
      undefined,
    );
  });

  it('does NOT invoke onMergeConflict on a clean merge (no conflict)', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: true });
    const reg = makeRegistry();
    let invoked = false;
    reg.register(asHooks({ onMergeConflict: async () => void (invoked = true) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    await wm.mergeTaskBranch('task-1');

    expect(invoked).toBe(false);
    expect(mockResolveConflictsWithAgent).not.toHaveBeenCalled();
  });

  // ── Full result flow when strategy: 'agent' (registry path) ────────────
  //
  // These mirror the conflict-resolution result-flow tests in the original
  // worktree-manager.test.ts (no-registry path) but exercise the hook-driven
  // path: the hook returns { strategy: 'agent' }, the manager calls
  // resolveConflictsWithAgent, and the stage/commit/cull/return-value flow
  // must be IDENTICAL to the direct path.

  it('stages + commits + culls + returns { success: true, conflictsResolved: true } when agent resolution succeeds (with registry)', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: async () => ({ strategy: 'agent' }) }));
    // Default mock returns { resolved: true }.

    const wm = makeManager({
      hookRegistry: reg,
      mainWorktreePath: '/run/work/worktree',
      repoRoot: '/fake/repo',
      workDir: '/run/work',
    });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    const result = await wm.mergeTaskBranch('task-1');

    // Resolved files are staged.
    expect(mockStageFiles).toHaveBeenCalledWith('/run/work/worktree', ['src/a.ts', 'src/b.ts']);
    // Merge commit is created.
    expect(mockCommitChanges).toHaveBeenCalledWith('/run/work/worktree', 'Merge task: task-1');
    // Worktree culled on success.
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', taskWorktreePath('/run/work', 'task-1'));
    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x--task-1');
    // Return value reflects a successfully-resolved conflict.
    expect(result).toEqual({ success: true, conflictsResolved: true });
  });

  it('returns { success: false, conflictsResolved: false } and preserves the worktree when agent resolution fails (with registry)', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: async () => ({ strategy: 'agent' }) }));
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });

    const wm = makeManager({
      hookRegistry: reg,
      mainWorktreePath: '/run/work/worktree',
      repoRoot: '/fake/repo',
      workDir: '/run/work',
    });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    const result = await wm.mergeTaskBranch('task-1');

    expect(result).toEqual({ success: false, conflictsResolved: false });
    // No staging / commit when resolution fails.
    expect(mockStageFiles).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
    // Worktree PRESERVED so the user can intervene.
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockDeleteBranchForce).not.toHaveBeenCalled();
  });

  it("forwards profilesDirs + apiKeys to resolveConflictsWithAgent when strategy: 'agent' (with registry)", async () => {
    // The manager's captured profilesDirs / apiKeys must reach the agent
    // resolution primitive even when the conflict path is hook-driven — the
    // hook is a pure marker, the manager supplies the operational context.
    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: async () => ({ strategy: 'agent' }) }));

    const wm = makeManager({
      hookRegistry: reg,
      profilesDirs: ['/profiles/dir-a', '/profiles/dir-b'],
      apiKeys: { anthropic: 'sk-test' },
    });
    await wm.createTaskWorktree('task-1', 'Fix bug', makeTask({ id: 'task-1' }));
    await wm.mergeTaskBranch('task-1');

    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles/dir-a', '/profiles/dir-b'],
      '/run/work/worktree',
      ['src/a.ts', 'src/b.ts'],
      'Fix bug',
      { anthropic: 'sk-test' },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. mergeTaskBranch — onCommitFailure (first-wins decision)
// ═══════════════════════════════════════════════════════════════════════════════

describe('mergeTaskBranch — onCommitFailure hook', () => {
  beforeEach(() => {
    // commitWorktreeChanges throws to exercise the onCommitFailure seam.
    mockCommitWorktreeChanges.mockRejectedValue(new Error('lint failed: no-unused-vars'));
  });

  it('invokes onCommitFailure when commitWorktreeChanges throws and a registry is threaded', async () => {
    const reg = makeRegistry();
    let invoked = false;
    reg.register(asHooks({ onCommitFailure: async () => void (invoked = true) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    try {
      await wm.mergeTaskBranch('task-1');
    } catch {
      // The manager may re-throw after the hook; the invocation is what we assert.
    }

    expect(invoked).toBe(true);
  });

  it('passes { task, errors, worktreePath }', async () => {
    const reg = makeRegistry();
    let capturedArgs: { task?: Task; errors?: string[]; worktreePath?: string } | undefined;
    const task = makeTask({ id: 'task-1' });
    reg.register(
      asHooks({
        onCommitFailure: async (args: { task: Task; errors: string[]; worktreePath: string }) => {
          capturedArgs = args;
        },
      }),
    );

    const wm = makeManager({ hookRegistry: reg, workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt', task);
    try {
      await wm.mergeTaskBranch('task-1');
    } catch {
      // expected
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.task).toBe(task);
    expect(capturedArgs!.worktreePath).toBe(taskWorktreePath('/run/work', 'task-1'));
    // The errors carry the commit failure message.
    expect(capturedArgs!.errors).toEqual(expect.arrayContaining([expect.stringContaining('lint failed')]));
  });

  it('does NOT invoke onCommitFailure when no registry is threaded (backward compat — the error propagates)', async () => {
    // Without a registry, a commit failure propagates as today (the manager
    // does not gate it through a hook). The merge throws.
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    await expect(wm.mergeTaskBranch('task-1')).rejects.toThrow('lint failed');
  });

  it("does NOT swallow the commit failure silently when the hook returns { strategy: 'fail' }", async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onCommitFailure: async () => ({ strategy: 'fail' }) }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask({ id: 'task-1' }));
    // 'fail' → the merge fails; the task worktree is preserved.
    const result = await wm.mergeTaskBranch('task-1').catch((err) => ({ thrown: err }));

    // Either the merge returns failure OR throws — both are acceptable
    // "did not silently succeed" outcomes.
    if ('success' in (result as object)) {
      expect((result as { success: boolean }).success).toBe(false);
    } else {
      expect((result as { thrown: Error }).thrown).toBeDefined();
    }
    // No merge commit happened.
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Backward compat — no registry, all paths use direct primitives
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorktreeManager — backward compat (no hookRegistry threaded)', () => {
  it('setupMainWorktree calls populateWorktree directly', async () => {
    const wm = makeManager();
    await wm.setupMainWorktree();

    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', '/run/work/worktree');
  });

  it('createTaskWorktree calls populateWorktree directly', async () => {
    const wm = makeManager({ workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt');

    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', taskWorktreePath('/run/work', 'task-1'));
  });

  it('mergeTaskBranch calls resolveConflictsWithAgent directly on conflict', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });
    const wm = makeManager({ profilesDirs: ['/profiles'] });
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles'],
      '/run/work/worktree',
      ['src/a.ts'],
      'prompt',
      undefined,
    );
  });

  it('mergeTaskBranch propagates a commit failure directly (no onCommitFailure hook)', async () => {
    mockCommitWorktreeChanges.mockRejectedValue(new Error('commit boom'));
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    await expect(wm.mergeTaskBranch('task-1')).rejects.toThrow('commit boom');
  });

  it('a manager with NO registry behaves identically to the pre-hook implementation across the full lifecycle', async () => {
    // End-to-end: create → merge (clean) → cull. Every step uses the direct
    // primitives; no hook invocations are possible (no registry).
    const wm = makeManager({ repoRoot: '/fake/repo', workDir: '/run/work' });

    await wm.setupMainWorktree();
    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', '/run/work/worktree');

    const path = await wm.createTaskWorktree('task-1', 'do work');
    expect(path).toBe(taskWorktreePath('/run/work', 'task-1'));
    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', taskWorktreePath('/run/work', 'task-1'));

    const result = await wm.mergeTaskBranch('task-1');
    expect(result).toEqual({ success: true, conflictsResolved: false });

    await wm.cullTaskWorktree('task-1');
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', taskWorktreePath('/run/work', 'task-1'));
    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x--task-1');
  });
});
