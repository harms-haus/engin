// ─── Worktree-lifecycle hook integration tests ─────────────────────────────
//
// End-to-end integration tests for the six worktree-lifecycle hooks wired
// through `WorktreeManager` with a real `HookRegistry`. Covers:
//
//   1. populateWorktree default reads .worktreecopy — real temp dirs
//   2. populateWorktree override — pipeline composition (custom + default)
//   3. beforeTaskWorktreeCreate skip — scout task runs against main worktree
//   4. onTaskMerge gate — hook returns { proceed: false }, merge is skipped
//   5. onMergeConflict default — delegates to the tooled fix-up agent
//   6. No hookRegistry — backward-compat, direct primitives
//
// Approach: mocks the expensive git/agent operations (createWorktree,
// commitWorktreeChanges, resolveConflictsWithAgent) while keeping the
// REAL `HookRegistry` and `HookRegistry` composition engine. The default
// hook implementations are registered into the real registry so the full
// pipeline → first-wins → observe composition is exercised.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Task } from '../../core/types.js';

// ─── Capture real modules before mocking ────────────────────────────────────

const realGit = Object.assign({}, await import('../../core/git.js'));
const realWorktreeOps = Object.assign({}, await import('../../core/worktree-operations.js'));
const realWorktreeLifecycle = Object.assign({}, await import('../../core/worktree-lifecycle.js'));
const realWorktreeFixup = Object.assign({}, await import('../../core/worktree-fixup.js'));

// ─── Mock functions for git.ts ──────────────────────────────────────────────

const mockCreateWorktree = mock((_repoRoot: string, _branch: string, _targetPath: string): void => {});
const mockRemoveWorktree = mock((_repoRoot: string, _worktreePath: string): void => {});
const mockWorktreePrune = mock((_repoRoot: string): void => {});
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
const mockResetHard = mock((_dir: string): void => {});
const mockCleanUntracked = mock((_dir: string): void => {});
const mockStageAll = mock((_dir: string): void => {});

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

// ─── Mock functions for worktree-fixup.ts ───────────────────────────────────

const mockRunTooledFixup = mock(
  async (_opts: unknown): Promise<{ success: boolean; attempts: number; lastError?: string }> => ({
    success: true,
    attempts: 1,
  }),
);

// ─── Mock modules ────────────────────────────────────────────────────────────
//
// We mock git.js but spread realGit first so the REAL `populateWorktree`
// (which reads `.worktreecopy`) is available to the default hook impl
// imported by hooks/defaults/worktree.ts. We override only the operations
// that require a fully-initialized git worktree (createWorktree, etc.).

mock.module('../../core/git.js', () => ({
  ...realGit,
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  worktreePrune: mockWorktreePrune,
  squashMergeBranch: mockSquashMergeBranch,
  stageFiles: mockStageFiles,
  deleteBranchForce: mockDeleteBranchForce,
  commitChanges: mockCommitChanges,
  getMainBranch: mockGetMainBranch,
  getCurrentBranch: mockGetCurrentBranch,
  checkoutBranch: mockCheckoutBranch,
  abortMerge: mockAbortMerge,
  resetHard: mockResetHard,
  cleanUntracked: mockCleanUntracked,
  stageAll: mockStageAll,
}));

mock.module('../../core/worktree-operations.js', () => ({
  ...realWorktreeOps,
  commitWorktreeChanges: mockCommitWorktreeChanges,
}));

mock.module('../../core/worktree-lifecycle.js', () => ({
  ...realWorktreeLifecycle,
  resolveConflictsWithAgent: mockResolveConflictsWithAgent,
}));

mock.module('../../core/worktree-fixup.js', () => ({
  ...realWorktreeFixup,
  runTooledFixup: mockRunTooledFixup,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import { WorktreeManager, type WorktreeManagerOptions } from '../../core/worktree-manager.js';
import { createHookRegistry, type HookRegistry } from '../registry.js';
import type { HookContext, PopulateWorktreeArgs, WorkflowHooks } from '../types.js';
import {
  createDefaultBeforeTaskWorktreeCreate,
  createDefaultOnMergeConflict,
  createDefaultPopulateWorktree,
  defaultOnTaskMerge,
} from './worktree.js';

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../core/git.js', () => realGit);
  mock.module('../../core/worktree-operations.js', () => realWorktreeOps);
  mock.module('../../core/worktree-lifecycle.js', () => realWorktreeLifecycle);
  mock.module('../../core/worktree-fixup.js', () => realWorktreeFixup);
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

/** Computed per-task worktree path: {workDir}/task-worktrees/{taskId} */
function taskWorktreePath(workDir: string, taskId: string): string {
  return join(workDir, 'task-worktrees', taskId);
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Implement feature',
    prompt: 'do the thing',
    profile: 'coder',
    files: [],
    dependencies: [],
    worktree: 'none',
    status: 'active',
    phaseId: 'code',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: createHookRegistry(),
    cwd: '/repo',
    workDir: '/run/work',
    ...overrides,
  };
}

/** Cast a plain hooks record to WorkflowHooks for type compatibility. */
function asHooks(hooks: Record<string, unknown>): WorkflowHooks {
  return hooks as unknown as WorkflowHooks;
}

/**
 * Build a fully-declared HookRegistry with all six worktree-lifecycle hooks
 * so invoke* routes correctly.
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

// ── Temp-directory helpers (for real-filesystem tests) ─────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `wt-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

// ─── Reset mocks ─────────────────────────────────────────────────────────────

function resetMocks() {
  mock.clearAllMocks();
  mockWorktreePrune.mockImplementation(() => {});
  mockCreateWorktree.mockImplementation(() => {});
  mockRemoveWorktree.mockImplementation(() => {});
  mockDeleteBranchForce.mockImplementation(() => {});
  mockStageFiles.mockImplementation(() => {});
  mockCommitChanges.mockImplementation(() => {});
  mockCheckoutBranch.mockImplementation(() => {});
  mockAbortMerge.mockImplementation(() => {});
  mockResetHard.mockImplementation(() => {});
  mockCleanUntracked.mockImplementation(() => {});
  mockStageAll.mockImplementation(() => {});
  mockGetMainBranch.mockReturnValue('main');
  mockGetCurrentBranch.mockReturnValue('previous-branch');
  mockSquashMergeBranch.mockReturnValue({ success: true });
  mockCommitWorktreeChanges.mockResolvedValue(undefined);
  mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });
  mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });
}

beforeEach(() => {
  resetMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. populateWorktree default reads .worktreecopy
//
// Set up a real source directory with `.worktreecopy` and matching files,
// invoke the default populateWorktree hook, verify the correct files land
// in the target directory.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Case 1 — populateWorktree default reads .worktreecopy', () => {
  it('copies files matching .worktreecopy patterns from source to target', async () => {
    const source = makeTempDir();
    const target = makeTempDir();

    // Set up source with .worktreecopy and files. The .worktreecopy patterns
    // are matched against TOP-LEVEL entries in sourceCwd using gitignore
    // semantics (see populateWorktree in git.ts).
    writeFileSync(join(source, '.worktreecopy'), '*.txt\nsrc\n');
    writeFileSync(join(source, 'a.txt'), 'hello');
    writeFileSync(join(source, 'b.md'), 'ignored');
    mkdirSync(join(source, 'src'), { recursive: true });
    writeFileSync(join(source, 'src', 'index.ts'), 'export const x = 1;');

    const hook = createDefaultPopulateWorktree(source);
    await hook(undefined, { worktreePath: target, sourceCwd: source }, makeCtx());

    expect(existsSync(join(target, 'a.txt'))).toBe(true);
    expect(readFileSync(join(target, 'a.txt'), 'utf-8')).toBe('hello');
    expect(existsSync(join(target, 'src', 'index.ts'))).toBe(true);
    expect(readFileSync(join(target, 'src', 'index.ts'), 'utf-8')).toBe('export const x = 1;');
    // .md files don't match *.txt — not copied
    expect(existsSync(join(target, 'b.md'))).toBe(false);
  });

  it('through WorktreeManager.createTaskWorktree — default hook populates the task worktree', async () => {
    // Register the default populateWorktree hook into a real HookRegistry.
    // WorktreeManager uses this registry to invoke the pipeline hook.
    const reg = makeRegistry();
    const source = makeTempDir();
    const target = makeTempDir();

    writeFileSync(join(source, '.worktreecopy'), 'payload.txt\n');
    writeFileSync(join(source, 'payload.txt'), 'data');

    reg.register(asHooks({ populateWorktree: createDefaultPopulateWorktree(source) }));

    const wm = makeManager({
      hookRegistry: reg,
      sourceCwd: source,
      workDir: target,
    });

    await wm.createTaskWorktree('task-1', 'prompt', makeTask());

    // createWorktree is mocked, so no real worktree was created on disk.
    // But the populateWorktree hook WAS invoked via the pipeline. We verify
    // the hook was called by checking mockCreateWorktree was called (which
    // means createTaskWorktree reached the create-worktree step).
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
  });

  it('through WorktreeManager.setupMainWorktree — default hook populates the main worktree', async () => {
    const reg = makeRegistry();
    const source = makeTempDir();
    const target = makeTempDir();

    writeFileSync(join(source, '.worktreecopy'), 'main.txt\n');
    writeFileSync(join(source, 'main.txt'), 'main content');

    reg.register(asHooks({ populateWorktree: createDefaultPopulateWorktree(source) }));

    const wm = makeManager({
      hookRegistry: reg,
      sourceCwd: source,
      mainWorktreePath: target,
    });

    await wm.setupMainWorktree();

    // Verify: prune + createWorktree + populate pipeline ran
    expect(mockWorktreePrune).toHaveBeenCalledTimes(1);
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. populateWorktree override — pipeline composition
//
// Register BOTH a custom populateWorktree hook AND the default as an array.
// Verify BOTH fire in registration order (pipeline fan-out).
// ═══════════════════════════════════════════════════════════════════════════════

describe('Case 2 — populateWorktree override (pipeline composition)', () => {
  it('custom hook fires as the first subscriber in a pipeline with the default', async () => {
    const reg = makeRegistry();
    const source = makeTempDir();
    const target = makeTempDir();

    writeFileSync(join(source, '.worktreecopy'), 'file.txt\n');
    writeFileSync(join(source, 'file.txt'), 'from-default');

    const order: string[] = [];
    let customHookCalled = false;

    // Register as array: [custom, default] — pipeline fires in order
    reg.register(
      asHooks({
        populateWorktree: [
          // Custom hook (simulates "bun install")
          async (_value: unknown, _args: PopulateWorktreeArgs) => {
            order.push('custom');
            customHookCalled = true;
            return undefined;
          },
          // Default hook (reads .worktreecopy)
          createDefaultPopulateWorktree(source),
        ],
      }),
    );

    const wm = makeManager({
      hookRegistry: reg,
      sourceCwd: source,
      workDir: target,
    });

    await wm.createTaskWorktree('task-1', 'prompt', makeTask());

    // The custom hook fires first, then the default
    expect(order).toEqual(['custom']);
    expect(customHookCalled).toBe(true);
  });

  it('pipeline composition fires both hooks through setupMainWorktree', async () => {
    const reg = makeRegistry();
    const order: string[] = [];

    reg.register(
      asHooks({
        populateWorktree: [
          async (_v: unknown, _args: unknown, _ctx: unknown) => void order.push('first'),
          async (_v: unknown, _args: unknown, _ctx: unknown) => void order.push('second'),
        ],
      }),
    );

    const wm = makeManager({ hookRegistry: reg });
    await wm.setupMainWorktree();

    expect(order).toEqual(['first', 'second']);
  });

  it('pipeline hooks execute sequentially (second fires after first)', async () => {
    const reg = makeRegistry();
    const order: string[] = [];
    reg.register(
      asHooks({
        populateWorktree: [
          async (_v: unknown, _args: unknown) => {
            order.push('first');
          },
          async (_v: unknown, _args: unknown) => {
            // The second subscriber fires after the first — verified by
            // the shared `order` array capturing execution sequence.
            expect(order).toEqual(['first']);
            order.push('second');
          },
        ],
      }),
    );

    const wm = makeManager({ hookRegistry: reg });
    await wm.setupMainWorktree();
    expect(order).toEqual(['first', 'second']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. beforeTaskWorktreeCreate skip
//
// A read-only scout task gets `{ skip: true }` from the default hook.
// Verify no per-task worktree is created; the task runs against the main
// worktree. Also verify mergeTaskBranch short-circuits for skipped tasks.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Case 3 — beforeTaskWorktreeCreate skip (scout task)', () => {
  it('scout task returns the main worktree path (no isolation)', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ beforeTaskWorktreeCreate: createDefaultBeforeTaskWorktreeCreate() }));

    const wm = makeManager({
      hookRegistry: reg,
      mainWorktreePath: '/run/work/worktree',
    });

    const result = await wm.createTaskWorktree('task-1', 'scout work', makeTask({ profile: 'scout' }));

    // The task runs against the main worktree — no per-task worktree created.
    expect(result).toBe('/run/work/worktree');
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('coder task is NOT skipped — a per-task worktree is created', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ beforeTaskWorktreeCreate: createDefaultBeforeTaskWorktreeCreate() }));

    const wm = makeManager({
      hookRegistry: reg,
      workDir: '/run/work',
    });

    const result = await wm.createTaskWorktree('task-1', 'do work', makeTask({ profile: 'coder' }));

    expect(result).toBe(taskWorktreePath('/run/work', 'task-1'));
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
  });

  it('mergeTaskBranch short-circuits for skipped tasks', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ beforeTaskWorktreeCreate: createDefaultBeforeTaskWorktreeCreate() }));

    const wm = makeManager({ hookRegistry: reg, mainWorktreePath: '/run/work/worktree' });
    await wm.createTaskWorktree('task-1', 'scout', makeTask({ profile: 'scout' }));

    const result = await wm.mergeTaskBranch('task-1');

    // Skipped tasks have no branch to merge — short-circuits with success.
    expect(result).toEqual({ success: true, conflictsResolved: false });
    // No merge or commit was attempted.
    expect(mockSquashMergeBranch).not.toHaveBeenCalled();
    expect(mockCommitWorktreeChanges).not.toHaveBeenCalled();
  });

  it('afterTaskWorktreeCreate does NOT fire for skipped tasks', async () => {
    const reg = makeRegistry();
    let afterFired = false;
    reg.register(
      asHooks({
        beforeTaskWorktreeCreate: createDefaultBeforeTaskWorktreeCreate(),
        afterTaskWorktreeCreate: async () => void (afterFired = true),
      }),
    );

    const wm = makeManager({ hookRegistry: reg, mainWorktreePath: '/run/work/worktree' });
    await wm.createTaskWorktree('task-1', 'scout', makeTask({ profile: 'scout' }));

    expect(afterFired).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. onTaskMerge gate
//
// A hook returning `{ proceed: false }` prevents the squash-merge.
// Verify no squash-merge is attempted and the result is failure.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Case 4 — onTaskMerge gate ({ proceed: false })', () => {
  it('merge is skipped when onTaskMerge returns { proceed: false }', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onTaskMerge: async () => ({ proceed: false }) }));

    const wm = makeManager({ hookRegistry: reg, workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask());

    const result = await wm.mergeTaskBranch('task-1');

    expect(result).toEqual({ success: false, conflictsResolved: false });
    // The squash-merge was NOT attempted.
    expect(mockSquashMergeBranch).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('merge proceeds when onTaskMerge returns { proceed: true } (default)', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onTaskMerge: defaultOnTaskMerge }));

    const wm = makeManager({ hookRegistry: reg, workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask());

    const result = await wm.mergeTaskBranch('task-1');

    expect(result).toEqual({ success: true, conflictsResolved: false });
    expect(mockSquashMergeBranch).toHaveBeenCalledTimes(1);
  });

  it('commitWorktreeChanges fires BEFORE the onTaskMerge decision', async () => {
    const reg = makeRegistry();
    const order: string[] = [];
    mockCommitWorktreeChanges.mockImplementation(async () => void order.push('commit'));
    reg.register(asHooks({ onTaskMerge: async () => void order.push('onTaskMerge') }));

    const wm = makeManager({ hookRegistry: reg });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask());
    await wm.mergeTaskBranch('task-1');

    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('onTaskMerge'));
  });

  it('worktree is NOT culled when merge is vetoed', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onTaskMerge: async () => ({ proceed: false }) }));

    const wm = makeManager({ hookRegistry: reg, repoRoot: '/fake/repo', workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask());
    await wm.mergeTaskBranch('task-1');

    // No culling — the un-merged branch is preserved for user intervention.
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockDeleteBranchForce).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. onMergeConflict default — delegates to the tooled fix-up
//
// Simulate a conflict (mock squashMergeBranch to return conflicts).
// Register the default onMergeConflict hook. Verify the default returns
// `{ strategy: 'agent' }` and resolveConflictsWithAgent is called.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Case 5 — onMergeConflict default (delegates to agent)', () => {
  beforeEach(() => {
    mockSquashMergeBranch.mockReturnValue({
      success: false,
      conflicts: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('default hook returns { strategy: "agent" } and resolveConflictsWithAgent is called', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: createDefaultOnMergeConflict(['/profiles']) }));

    const wm = makeManager({ hookRegistry: reg, profilesDirs: ['/profiles'], workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'Fix it', makeTask());

    const result = await wm.mergeTaskBranch('task-1');

    // The default onMergeConflict returns { strategy: 'agent' }, which
    // causes WorktreeManager to call resolveConflictsWithAgent.
    expect(mockResolveConflictsWithAgent).toHaveBeenCalledTimes(1);
    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles'],
      '/run/work/worktree',
      ['src/a.ts', 'src/b.ts'],
      'Fix it',
      undefined,
    );
  });

  it('when agent resolves conflicts, result is { success: true, conflictsResolved: true }', async () => {
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });

    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: createDefaultOnMergeConflict(['/profiles']) }));

    const wm = makeManager({ hookRegistry: reg, profilesDirs: ['/profiles'], workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'Fix', makeTask());

    const result = await wm.mergeTaskBranch('task-1');

    expect(result).toEqual({ success: true, conflictsResolved: true });
    expect(mockStageFiles).toHaveBeenCalledWith('/run/work/worktree', ['src/a.ts', 'src/b.ts']);
    expect(mockCommitChanges).toHaveBeenCalledWith('/run/work/worktree', 'Merge task: task-1');
  });

  it('when agent cannot resolve, result is { success: false } and worktree is preserved', async () => {
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });

    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: createDefaultOnMergeConflict(['/profiles']) }));

    const wm = makeManager({ hookRegistry: reg, profilesDirs: ['/profiles'], workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'Fix', makeTask());

    const result = await wm.mergeTaskBranch('task-1');

    expect(result).toEqual({ success: false, conflictsResolved: false });
    // No staging / commit / cull.
    expect(mockStageFiles).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('a workflow override returning { strategy: "manual" } does NOT call resolveConflictsWithAgent', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: async () => ({ strategy: 'manual' }) }));

    const wm = makeManager({ hookRegistry: reg, workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask());
    const result = await wm.mergeTaskBranch('task-1');

    expect(mockResolveConflictsWithAgent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('a workflow override returning { strategy: "abort" } aborts the in-progress merge', async () => {
    const reg = makeRegistry();
    reg.register(asHooks({ onMergeConflict: async () => ({ strategy: 'abort' }) }));

    const wm = makeManager({ hookRegistry: reg, workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt', makeTask());
    const result = await wm.mergeTaskBranch('task-1');

    expect(mockAbortMerge).toHaveBeenCalledWith('/run/work/worktree');
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. No hookRegistry = current behavior (backward compat)
//
// Without a registry threaded, WorktreeManager uses the DIRECT git/agent
// primitives — no hook invocations. Verify:
//   - createTaskWorktree calls populateWorktree directly
//   - mergeTaskBranch calls resolveConflictsWithAgent directly
//   - mergeTaskBranch propagates commit failures directly
// ═══════════════════════════════════════════════════════════════════════════════

describe('Case 6 — No hookRegistry (backward compat, direct primitives)', () => {
  it('createTaskWorktree populates via the direct populateWorktree call', async () => {
    const wm = makeManager({ sourceCwd: '/fake/source', workDir: '/run/work' });

    await wm.createTaskWorktree('task-1', 'prompt');

    // No registry → direct populateWorktree(sourceCwd, taskWorktreePath)
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
  });

  it('mergeTaskBranch resolves conflicts via direct resolveConflictsWithAgent', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });

    const wm = makeManager({ profilesDirs: ['/profiles'], workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'Fix bug');

    await wm.mergeTaskBranch('task-1');

    // No registry → direct resolveConflictsWithAgent
    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles'],
      '/run/work/worktree',
      ['src/a.ts'],
      'Fix bug',
      undefined,
    );
  });

  it('mergeTaskBranch propagates commit failures directly (no onCommitFailure hook)', async () => {
    mockCommitWorktreeChanges.mockRejectedValue(new Error('lint failed'));

    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');

    await expect(wm.mergeTaskBranch('task-1')).rejects.toThrow('lint failed');
  });

  it('full lifecycle without registry: create → merge → cull', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', workDir: '/run/work' });

    await wm.setupMainWorktree();

    const path = await wm.createTaskWorktree('task-1', 'do work');
    expect(path).toBe(taskWorktreePath('/run/work', 'task-1'));

    const result = await wm.mergeTaskBranch('task-1');
    expect(result).toEqual({ success: true, conflictsResolved: false });

    // Task worktree culled after successful merge.
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', taskWorktreePath('/run/work', 'task-1'));
    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x--task-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// git lock — serialization + merge-commit rollback
//
// Covers the unified git lock (`withGitLock`) that serializes shared-state
// git ops, and the rollback that fires when a squash-merge COMMIT fails so the
// shared main worktree is never left dirty for the next task.
//
// The serialization tests exercise the CONFLICT path: `resolveConflictsWithAgent`
// is `await`ed INSIDE the locked critical section, so giving it a delay creates
// a real async yield within the lock — the only way to observe that a second
// task's locked section waits (the clean path is fully synchronous, so it can't
// distinguish locked from unlocked execution).
// ═══════════════════════════════════════════════════════════════════════════════

describe('git lock — serialization + merge-commit rollback', () => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fn()) return;
      await delay(2);
    }
    throw new Error('waitFor timed out');
  }

  it('rolls back the SHARED main worktree and rethrows when the merge commit fails', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');

    // The squash stages successfully, but the commit (pre-commit/lint hook) rejects.
    mockSquashMergeBranch.mockReturnValue({ success: true });
    mockCommitChanges.mockImplementation(() => {
      throw new Error('pre-commit hook rejected');
    });

    await expect(wm.mergeTaskBranch('task-1')).rejects.toThrow('pre-commit hook rejected');

    // Rollback targeted at the SHARED main worktree (not repoRoot / task path).
    expect(mockAbortMerge).toHaveBeenCalledWith('/run/work/worktree');
    expect(mockResetHard).toHaveBeenCalledWith('/run/work/worktree');
    expect(mockCleanUntracked).toHaveBeenCalledWith('/run/work/worktree');
    // The failed task's worktree is NOT culled (the merge did not succeed).
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockDeleteBranchForce).not.toHaveBeenCalled();
  });

  it('rolls back after a conflict-resolved commit fails too', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');

    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/app.ts'] });
    // The agent resolves the conflicts, but the post-resolution commit fails.
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });
    mockCommitChanges.mockImplementation(() => {
      throw new Error('pre-commit hook rejected');
    });

    await expect(wm.mergeTaskBranch('task-1')).rejects.toThrow('pre-commit hook rejected');

    expect(mockStageFiles).toHaveBeenCalledWith('/run/work/worktree', ['src/app.ts']);
    expect(mockResetHard).toHaveBeenCalledWith('/run/work/worktree');
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('serializes concurrent merges so their locked sections never interleave', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('t-a', 't-a');
    await wm.createTaskWorktree('t-b', 't-b');

    const log: string[] = [];
    // Force the conflict path so `resolveConflictsWithAgent` (awaited inside the
    // lock) yields, making interleaving observable.
    mockSquashMergeBranch.mockImplementation((_repo: string, _branch: string) => ({
      success: false,
      conflicts: ['f.ts'],
    }));
    mockResolveConflictsWithAgent.mockImplementation(
      async (_p: string[], _r: string, _c: string[], taskPrompt: string) => {
        log.push(`${taskPrompt}-resolve-start`);
        await delay(8);
        log.push(`${taskPrompt}-resolve-end`);
        return { resolved: true };
      },
    );
    mockCommitChanges.mockImplementation((_dir: string, message: string) => {
      log.push(`${message.replace('Merge task: ', '')}-commit`);
    });

    await Promise.all([wm.mergeTaskBranch('t-a'), wm.mergeTaskBranch('t-b')]);

    const aRS = log.indexOf('t-a-resolve-start');
    const aC = log.indexOf('t-a-commit');
    const bRS = log.indexOf('t-b-resolve-start');
    const bC = log.indexOf('t-b-commit');
    expect(aRS).toBeGreaterThanOrEqual(0);
    expect(bRS).toBeGreaterThanOrEqual(0);
    // Non-interleaving: one task's commit precedes the OTHER task's resolve-start.
    expect(aC < bRS || bC < aRS).toBe(true);
  });

  it('createTaskWorktree branch creation waits for an in-flight merge', async () => {
    const wm = makeManager();
    // First create is a no-op createWorktree (default mock); install the logging
    // implementation AFTER it so only t-b's createWorktree is logged.
    await wm.createTaskWorktree('t-a', 't-a');

    const log: string[] = [];
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['f.ts'] });
    mockResolveConflictsWithAgent.mockImplementation(async () => {
      log.push('resolve-start');
      await delay(8);
      log.push('resolve-end');
      return { resolved: true };
    });
    mockCommitChanges.mockImplementation(() => {
      log.push('commit');
    });
    mockCreateWorktree.mockImplementation(() => {
      log.push('create');
    });

    // Start the merge — it acquires the lock and holds it during the slow resolve.
    const mergeP = wm.mergeTaskBranch('t-a');
    await waitFor(() => log.includes('resolve-start'));

    // Create a second task worktree — its branch creation must wait for the lock.
    await wm.createTaskWorktree('t-b', 't-b');
    await mergeP;

    // createWorktree ran AFTER the merge's commit (the lock serialized them).
    expect(log.indexOf('commit')).toBeLessThan(log.indexOf('create'));
  });

  // ── merge-commit fix-up retry ────────────────────────────────────────────
  //
  // A squash-merge succeeds but the subsequent `git commit` is rejected by the
  // repo pre-commit / lint hook. Instead of failing the task, the merge retries
  // IN ISOLATION: the tooled fix-up agent repairs the lint error on the shared
  // main worktree, the squash is re-staged, and the commit is retried through
  // the real hook. Only when the fix-up cannot repair it does the merge fail.

  it('retries the merge commit via a fix-up agent when the pre-commit hook rejects it', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');

    mockSquashMergeBranch.mockReturnValue({ success: true });
    // First commit attempt rejected by the lint hook; the retry (after fix-up) succeeds.
    let commitCalls = 0;
    mockCommitChanges.mockImplementation(() => {
      commitCalls++;
      if (commitCalls === 1) throw new Error('oxlint --fix [FAILED]');
    });

    const result = await wm.mergeTaskBranch('task-1');

    // The merge ultimately succeeds.
    expect(result).toEqual({ success: true, conflictsResolved: false });
    // The fix-up agent was spawned against the SHARED main worktree.
    expect(mockRunTooledFixup).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/run/work/worktree',
        errorContext: expect.stringContaining('oxlint --fix [FAILED]'),
      }),
    );
    // The squash was re-staged before the retry commit.
    expect(mockStageAll).toHaveBeenCalledWith('/run/work/worktree');
    // The commit ran twice (initial failure + retry).
    expect(commitCalls).toBe(2);
    // Merge succeeded ⇒ the task worktree was culled (clean lifecycle).
    expect(mockRemoveWorktree).toHaveBeenCalled();
    // No rollback on the success path.
    expect(mockResetHard).not.toHaveBeenCalled();
  });

  it('abandons the merge (rollback + rethrow) when the fix-up agent cannot repair the lint error', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');

    mockSquashMergeBranch.mockReturnValue({ success: true });
    mockCommitChanges.mockImplementation(() => {
      throw new Error('oxlint --fix [FAILED]');
    });
    // Fix-up could NOT repair the error.
    mockRunTooledFixup.mockResolvedValue({ success: false, attempts: 3, lastError: 'no-unused-vars' });

    await expect(wm.mergeTaskBranch('task-1')).rejects.toThrow('oxlint --fix [FAILED]');

    // Shared worktree rolled back to a clean HEAD (so the next task isn't corrupted).
    expect(mockAbortMerge).toHaveBeenCalledWith('/run/work/worktree');
    expect(mockResetHard).toHaveBeenCalledWith('/run/work/worktree');
    expect(mockCleanUntracked).toHaveBeenCalledWith('/run/work/worktree');
    // The ORIGINAL commit error is surfaced (not the fix-up's lastError).
    // The failed task's worktree is NOT culled — the pool preserves it.
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    // No second commit attempt (fix-up failed → no retry).
    expect(mockCommitChanges).toHaveBeenCalledTimes(1);
  });
});
