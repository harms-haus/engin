// ─── Tests for WorktreeManager (core/worktree-manager.ts) ──────────────────
//
// Test-first specification for `packages/engine/src/core/worktree-manager.ts`.
//
// CONTEXT: WorktreeManager is the SOLE owner of main worktree creation and the
// central orchestrator for the per-task worktree feature. It owns the main
// worktree + per-task worktree lifecycle + merge serialization.
//
// CONTRACT UNDER TEST (the new module must export):
//
//   export interface WorktreeManagerOptions {
//     repoRoot: string;
//     sourceCwd: string;
//     workDir: string;
//     mainBranch: string;
//     mainWorktreePath: string;
//     profilesDirs: string[];
//     apiKeys?: Record<string, string>;
//   }
//
//   export interface TaskWorktreeInfo {
//     path: string;
//     branch: string;
//     status: 'active' | 'merged' | 'culled';
//   }
//
//   export class WorktreeManager {
//     readonly mainBranch: string;
//     readonly mainWorktreePath: string;
//     readonly repoRoot: string;
//     readonly sourceCwd: string;
//     constructor(opts: WorktreeManagerOptions);
//     async setupMainWorktree(): Promise<void>;
//     async createTaskWorktree(taskId: string, taskPrompt?: string): Promise<string>;
//     async mergeTaskBranch(taskId: string): Promise<{ success: boolean; conflictsResolved: boolean }>;
//     async cullTaskWorktree(taskId: string): Promise<void>;
//     async prune(): Promise<void>;
//     async finalMergeToMain(): Promise<{ success: boolean; conflicts: string[]; conflictsResolved: boolean }>;
//     async resolveFinalMergeConflicts(conflicts: string[], taskPrompt: string): Promise<boolean>;
//     async abortFinalMerge(): Promise<void>;
//     async cleanup(): Promise<{ cleanupError?: string }>;
//     getWorktreeInfo(): import('./types.js').WorktreeInfo;
//   }
//
// Tests are RED (expected) because the source module is created in the
// NEXT (implement) phase.

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { join } from 'node:path';

// ─── Capture real modules before mocking ────────────────────────────────────
// Without the restore, these relative-path mock.module() registrations leak
// into sibling test files under CI's parallel scheduling (mirrors the pattern
// in tests/core/worktree-operations.test.ts and worktree-lifecycle.test.ts).
const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realWorktreeOperations = Object.assign({}, await import('../../packages/engine/src/core/worktree-operations.js'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.js'));

// ─── Mock functions for git.ts ──────────────────────────────────────────────

const mockCreateWorktree = mock((_repoRoot: string, _branch: string, _targetPath: string): void => {});
const mockRemoveWorktree = mock((_repoRoot: string, _worktreePath: string): void => {});
const mockWorktreePrune = mock((_repoRoot: string): void => {});
const mockPopulateWorktree = mock((_sourceCwd: string, _worktreePath: string, _entries?: unknown): void => {});
const mockSanitizeBranchSlug = mock((text: string): string => text);
const mockSquashMergeBranch = mock(
  (
    _repoRoot: string,
    _branch: string,
  ): { success: true } | { success: false; conflicts: string[]; error?: string } => ({
    success: true,
  }),
);
const mockStageFiles = mock((_repoRoot: string, _files: string[]): void => {});
const mockDeleteBranchForce = mock((_repoRoot: string, _branch: string): void => {});
const mockCommitChanges = mock((_dir: string, _message: string): void => {});
const mockGetDiff = mock((_dir: string): string => 'diff content');
const mockStageAll = mock((_dir: string): void => {});
const mockGetMainBranch = mock((_dir: string): string => 'main');
const mockGetCurrentBranch = mock((_dir: string): string => 'previous-branch');
const mockCheckoutBranch = mock((_repoRoot: string, _branch: string): void => {});
const mockListConflictedFiles = mock((_repoRoot: string): string[] => []);
const mockAbortMerge = mock((_repoRoot: string): void => {});

// ─── Mock functions for worktree-operations.ts ──────────────────────────────

const mockCommitWorktreeChanges = mock(async (_opts: unknown): Promise<void> => {});
const mockMergeWorktreeToMain = mock(
  async (_opts: unknown): Promise<{ success: boolean; conflictsResolved: boolean; cleanupError?: string }> => ({
    success: true,
    conflictsResolved: false,
  }),
);

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
const mockGenerateCommitMessage = mock(
  async (
    _profilesDirs: string[],
    _worktreePath: string,
    _taskPrompt: string,
    _diff: string,
    _apiKeys?: Record<string, string>,
  ): Promise<string> => 'feat: implement feature',
);
const mockPushAndCreatePR = mock(
  async (
    _profilesDirs: string[],
    _repoRoot: string,
    _branchName: string,
    _taskPrompt: string,
    _title: string,
    _apiKeys?: Record<string, string>,
  ): Promise<void> => {},
);

// ─── Mock modules ────────────────────────────────────────────────────────────

mock.module('../../packages/engine/src/core/git.js', () => ({
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  worktreePrune: mockWorktreePrune,
  populateWorktree: mockPopulateWorktree,
  sanitizeBranchSlug: mockSanitizeBranchSlug,
  squashMergeBranch: mockSquashMergeBranch,
  stageFiles: mockStageFiles,
  deleteBranchForce: mockDeleteBranchForce,
  commitChanges: mockCommitChanges,
  getDiff: mockGetDiff,
  stageAll: mockStageAll,
  getMainBranch: mockGetMainBranch,
  getCurrentBranch: mockGetCurrentBranch,
  checkoutBranch: mockCheckoutBranch,
  listConflictedFiles: mockListConflictedFiles,
  abortMerge: mockAbortMerge,
}));

mock.module('../../packages/engine/src/core/worktree-operations.js', () => ({
  commitWorktreeChanges: mockCommitWorktreeChanges,
  mergeWorktreeToMain: mockMergeWorktreeToMain,
}));

mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => ({
  resolveConflictsWithAgent: mockResolveConflictsWithAgent,
  generateCommitMessage: mockGenerateCommitMessage,
  pushAndCreatePR: mockPushAndCreatePR,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import { WorktreeManager, type WorktreeManagerOptions } from '../../packages/engine/src/core/worktree-manager.js';

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

/** Drain the microtask queue so async chains settle before assertions. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Reset mocks ─────────────────────────────────────────────────────────────

function resetMocks() {
  mock.clearAllMocks();
  // Bun's clearAllMocks() only clears call history — implementations set via
  // mockImplementation/mockReturnValue persist. Re-establish safe defaults so
  // a throwing implementation set by one test cannot leak into the next.
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
// Constructor
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorktreeManager constructor', () => {
  it('exposes mainBranch from options', () => {
    const wm = makeManager({ mainBranch: 'engin/my-branch' });
    expect(wm.mainBranch).toBe('engin/my-branch');
  });

  it('exposes mainWorktreePath from options', () => {
    const wm = makeManager({ mainWorktreePath: '/run/work/wt' });
    expect(wm.mainWorktreePath).toBe('/run/work/wt');
  });

  it('exposes repoRoot from options', () => {
    const wm = makeManager({ repoRoot: '/the/repo' });
    expect(wm.repoRoot).toBe('/the/repo');
  });

  it('exposes sourceCwd from options', () => {
    const wm = makeManager({ sourceCwd: '/the/source' });
    expect(wm.sourceCwd).toBe('/the/source');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// setupMainWorktree — THE SOLE CREATOR of the main worktree
// ═══════════════════════════════════════════════════════════════════════════════

describe('setupMainWorktree', () => {
  it('prunes orphaned worktrees before creating the main worktree', async () => {
    const wm = makeManager();
    await wm.setupMainWorktree();

    expect(mockWorktreePrune).toHaveBeenCalledWith('/fake/repo');
  });

  it('creates the main worktree at mainWorktreePath on mainBranch', async () => {
    const wm = makeManager();
    await wm.setupMainWorktree();

    expect(mockCreateWorktree).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x', '/run/work/worktree');
  });

  it('populates the main worktree from the source cwd (.worktreecopy)', async () => {
    const wm = makeManager({ sourceCwd: '/fake/source', mainWorktreePath: '/run/work/worktree' });
    await wm.setupMainWorktree();

    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', '/run/work/worktree');
  });

  it('calls prune, createWorktree, populateWorktree in that order', async () => {
    const calls: string[] = [];
    mockWorktreePrune.mockImplementation(() => calls.push('prune'));
    mockCreateWorktree.mockImplementation(() => calls.push('createWorktree'));
    mockPopulateWorktree.mockImplementation(() => calls.push('populateWorktree'));

    const wm = makeManager();
    await wm.setupMainWorktree();

    expect(calls).toEqual(['prune', 'createWorktree', 'populateWorktree']);
  });

  it('does NOT generate the branch name — uses the constructor-provided mainBranch', async () => {
    const wm = makeManager({ mainBranch: 'engin/custom-provided-branch' });
    await wm.setupMainWorktree();

    expect(mockCreateWorktree).toHaveBeenCalledWith(
      expect.anything(),
      'engin/custom-provided-branch',
      expect.anything(),
    );
  });

  it('resolves with void', async () => {
    const wm = makeManager();
    await expect(wm.setupMainWorktree()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createTaskWorktree
// ═══════════════════════════════════════════════════════════════════════════════

describe('createTaskWorktree', () => {
  it('creates the worktree off the MAIN worktree path (not repoRoot)', async () => {
    const wm = makeManager({ mainWorktreePath: '/run/work/worktree' });
    await wm.createTaskWorktree('task-1');

    // First arg must be mainWorktreePath so the task branch inherits merged work.
    expect(mockCreateWorktree.mock.calls[0][0]).toBe('/run/work/worktree');
    expect(mockCreateWorktree.mock.calls[0][0]).not.toBe('/fake/repo');
  });

  it('creates the worktree at {workDir}/task-worktrees/{taskId}', async () => {
    const wm = makeManager({ workDir: '/run/work' });
    await wm.createTaskWorktree('task-1');

    expect(mockCreateWorktree).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      taskWorktreePath('/run/work', 'task-1'),
    );
  });

  it('uses a flat -- separator between mainSlug and taskId (never /)', async () => {
    // mainBranch 'engin/feat-x' → mainSlug 'feat-x' → branch 'engin/feat-x--task-1'
    const wm = makeManager({ mainBranch: 'engin/feat-x' });
    await wm.createTaskWorktree('task-1');

    const branch = mockCreateWorktree.mock.calls[0][1] as string;
    expect(branch).toBe('engin/feat-x--task-1');
    // The separator between slug and taskId must be '--', never a slash that
    // would collide with the engin/{mainSlug} ref/file duality.
    expect(branch).not.toContain('feat-x/task');
    expect(branch).toContain('--task-1');
  });

  it('extracts the mainSlug by stripping the engin/ prefix', async () => {
    const wm = makeManager({ mainBranch: 'engin/some-feature-name' });
    await wm.createTaskWorktree('task-9');

    expect(mockCreateWorktree.mock.calls[0][1]).toBe('engin/some-feature-name--task-9');
  });

  it('keeps distinct task worktrees for distinct taskIds', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1');
    await wm.createTaskWorktree('task-2');

    expect(mockCreateWorktree).toHaveBeenCalledTimes(2);
    expect(mockCreateWorktree.mock.calls[0][1]).toBe('engin/feat-x--task-1');
    expect(mockCreateWorktree.mock.calls[1][1]).toBe('engin/feat-x--task-2');
  });

  it('populates the task worktree from the source cwd', async () => {
    const wm = makeManager({ sourceCwd: '/fake/source', workDir: '/run/work' });
    await wm.createTaskWorktree('task-1');

    expect(mockPopulateWorktree).toHaveBeenCalledWith('/fake/source', taskWorktreePath('/run/work', 'task-1'));
  });

  it('returns the task worktree path', async () => {
    const wm = makeManager({ workDir: '/run/work' });
    const path = await wm.createTaskWorktree('task-1');

    expect(path).toBe(taskWorktreePath('/run/work', 'task-1'));
  });

  it('stores the taskPrompt for later use in mergeTaskBranch', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'Implement the login feature');

    // Committing during merge must receive the stored prompt — verify indirectly.
    await wm.mergeTaskBranch('task-1');

    expect(mockCommitWorktreeChanges).toHaveBeenCalledWith(
      expect.objectContaining({ taskPrompt: 'Implement the login feature' }),
    );
  });

  it('uses an empty taskPrompt when none was provided', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1'); // no prompt
    await wm.mergeTaskBranch('task-1');

    expect(mockCommitWorktreeChanges).toHaveBeenCalledWith(expect.objectContaining({ taskPrompt: '' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// mergeTaskBranch
// ═══════════════════════════════════════════════════════════════════════════════

describe('mergeTaskBranch', () => {
  it('throws when the task worktree is unknown', async () => {
    const wm = makeManager();
    await expect(wm.mergeTaskBranch('nonexistent')).rejects.toThrow();
  });

  it('throws when the task worktree is no longer active', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.cullTaskWorktree('task-1'); // status → 'culled'

    await expect(wm.mergeTaskBranch('task-1')).rejects.toThrow();
  });

  it('commits pending changes in the task worktree before merging', async () => {
    const wm = makeManager({ workDir: '/run/work', profilesDirs: ['/profiles'] });
    await wm.createTaskWorktree('task-1', 'do the thing');
    await wm.mergeTaskBranch('task-1');

    expect(mockCommitWorktreeChanges).toHaveBeenCalledWith({
      profilesDirs: ['/profiles'],
      worktreePath: taskWorktreePath('/run/work', 'task-1'),
      taskPrompt: 'do the thing',
      apiKeys: undefined,
    });
  });

  it('forwards apiKeys to commitWorktreeChanges', async () => {
    const wm = makeManager({ apiKeys: { openai: 'sk-test' } });
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockCommitWorktreeChanges).toHaveBeenCalledWith(expect.objectContaining({ apiKeys: { openai: 'sk-test' } }));
  });

  it('squash-merges the task branch into the main worktree path', async () => {
    const wm = makeManager({ mainWorktreePath: '/run/work/worktree' });
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockSquashMergeBranch).toHaveBeenCalledWith('/run/work/worktree', 'engin/feat-x--task-1');
  });

  // ─── Clean merge path ────────────────────────────────────────────────────

  it('commits the squash merge on a clean merge', async () => {
    const wm = makeManager({ mainWorktreePath: '/run/work/worktree' });
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockCommitChanges).toHaveBeenCalledWith('/run/work/worktree', 'Merge task: task-1');
  });

  it('culls the task worktree after a successful clean merge', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', taskWorktreePath('/run/work', 'task-1'));
    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x--task-1');
  });

  it('returns { success: true, conflictsResolved: false } on a clean merge', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    const result = await wm.mergeTaskBranch('task-1');

    expect(result).toEqual({ success: true, conflictsResolved: false });
  });

  it('does not attempt conflict resolution on a clean merge', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockResolveConflictsWithAgent).not.toHaveBeenCalled();
    expect(mockStageFiles).not.toHaveBeenCalled();
  });

  // ─── Conflict resolution path (success) ──────────────────────────────────

  it('invokes resolveConflictsWithAgent when the squash merge conflicts', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts', 'src/b.ts'] });
    const wm = makeManager({ profilesDirs: ['/profiles'], apiKeys: { anthropic: 'sk-ant' } });
    await wm.createTaskWorktree('task-1', 'Fix the bug');
    await wm.mergeTaskBranch('task-1');

    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles'],
      '/run/work/worktree',
      ['src/a.ts', 'src/b.ts'],
      'Fix the bug',
      { anthropic: 'sk-ant' },
    );
  });

  it('stages only the conflicted files after a successful resolution', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });
    const wm = makeManager({ mainWorktreePath: '/run/work/worktree' });
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockStageFiles).toHaveBeenCalledWith('/run/work/worktree', ['src/a.ts']);
  });

  it('commits the merge after a successful resolution', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });
    const wm = makeManager({ mainWorktreePath: '/run/work/worktree' });
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockCommitChanges).toHaveBeenCalledWith('/run/work/worktree', 'Merge task: task-1');
  });

  it('culls the task worktree after a successfully resolved conflict', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });
    const wm = makeManager({ repoRoot: '/fake/repo', workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', taskWorktreePath('/run/work', 'task-1'));
    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x--task-1');
  });

  it('returns { success: true, conflictsResolved: true } when conflicts are resolved', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    const result = await wm.mergeTaskBranch('task-1');

    expect(result).toEqual({ success: true, conflictsResolved: true });
  });

  // ─── Conflict resolution path (failure) ──────────────────────────────────

  it('returns { success: false, conflictsResolved: false } when conflicts cannot be resolved', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    const result = await wm.mergeTaskBranch('task-1');

    expect(result).toEqual({ success: false, conflictsResolved: false });
  });

  it('preserves the task worktree when conflict resolution fails', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockDeleteBranchForce).not.toHaveBeenCalled();
  });

  it('does not commit a merge message when conflict resolution fails', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.mergeTaskBranch('task-1');

    expect(mockCommitChanges).not.toHaveBeenCalled();
    expect(mockStageFiles).not.toHaveBeenCalled();
  });

  // ─── Merge serialization ─────────────────────────────────────────────────

  it('serializes concurrent merges so the second waits for the first', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', mainWorktreePath: '/run/work/worktree' });
    await wm.createTaskWorktree('task-a', 'prompt a');
    await wm.createTaskWorktree('task-b', 'prompt b');

    // task-a hits a conflict and blocks inside resolveConflictsWithAgent;
    // task-b is a clean merge that must NOT begin until task-a finishes.
    let releaseA!: () => void;
    const blockedA = new Promise<{ resolved: boolean; error?: string }>((resolve) => {
      releaseA = () => resolve({ resolved: true });
    });
    mockSquashMergeBranch.mockImplementation((_root, branch) =>
      branch.endsWith('--task-a') ? { success: false, conflicts: ['conflict.ts'] } : { success: true },
    );
    mockResolveConflictsWithAgent.mockReturnValue(blockedA);

    const pA = wm.mergeTaskBranch('task-a');
    await flush(); // let task-a progress until it blocks on conflict resolution

    // task-a has entered its serialized section and called squashMergeBranch once.
    expect(mockSquashMergeBranch).toHaveBeenCalledTimes(1);

    const pB = wm.mergeTaskBranch('task-b');
    await flush();

    // KEY: task-b's squash-merge must NOT have started while task-a is blocked.
    expect(mockSquashMergeBranch).toHaveBeenCalledTimes(1);

    releaseA(); // unblock task-a's conflict resolution
    await Promise.all([pA, pB]);

    // Now both serialized sections have completed.
    expect(mockSquashMergeBranch).toHaveBeenCalledTimes(2);
  });

  it('does not interleave commits between concurrent merges', async () => {
    const wm = makeManager({ mainWorktreePath: '/run/work/worktree' });
    await wm.createTaskWorktree('task-a', 'prompt a');
    await wm.createTaskWorktree('task-b', 'prompt b');

    await Promise.all([wm.mergeTaskBranch('task-a'), wm.mergeTaskBranch('task-b')]);

    // Both should complete; commits for each task present.
    const messages = mockCommitChanges.mock.calls.map((c) => c[1] as string);
    expect(messages).toEqual(expect.arrayContaining(['Merge task: task-a', 'Merge task: task-b']));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cullTaskWorktree
// ═══════════════════════════════════════════════════════════════════════════════

describe('cullTaskWorktree', () => {
  it('force-removes the task worktree', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', workDir: '/run/work' });
    await wm.createTaskWorktree('task-1');
    await wm.cullTaskWorktree('task-1');

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', taskWorktreePath('/run/work', 'task-1'));
  });

  it('force-deletes the task branch', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo' });
    await wm.createTaskWorktree('task-1');
    await wm.cullTaskWorktree('task-1');

    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x--task-1');
  });

  it('is idempotent — unknown taskId is a no-op', async () => {
    const wm = makeManager();
    await expect(wm.cullTaskWorktree('never-existed')).resolves.toBeUndefined();

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockDeleteBranchForce).not.toHaveBeenCalled();
  });

  it('is idempotent — calling twice does not remove twice', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1');
    await wm.cullTaskWorktree('task-1');

    mockRemoveWorktree.mockClear();
    mockDeleteBranchForce.mockClear();

    await wm.cullTaskWorktree('task-1'); // already culled

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockDeleteBranchForce).not.toHaveBeenCalled();
  });

  it('swallows errors from removeWorktree (best-effort)', async () => {
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('worktree busy');
    });
    const wm = makeManager();
    await wm.createTaskWorktree('task-1');

    await expect(wm.cullTaskWorktree('task-1')).resolves.toBeUndefined();
  });

  it('swallows errors from deleteBranchForce (best-effort)', async () => {
    mockDeleteBranchForce.mockImplementation(() => {
      throw new Error('branch not found');
    });
    const wm = makeManager();
    await wm.createTaskWorktree('task-1');

    await expect(wm.cullTaskWorktree('task-1')).resolves.toBeUndefined();
  });

  it('marks the task as no longer active so a subsequent merge throws', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1', 'prompt');
    await wm.cullTaskWorktree('task-1');

    await expect(wm.mergeTaskBranch('task-1')).rejects.toThrow();
  });

  it('resolves with void', async () => {
    const wm = makeManager();
    await wm.createTaskWorktree('task-1');
    await expect(wm.cullTaskWorktree('task-1')).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// prune
// ═══════════════════════════════════════════════════════════════════════════════

describe('prune', () => {
  it('calls worktreePrune on the repo root', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo' });
    await wm.prune();

    expect(mockWorktreePrune).toHaveBeenCalledWith('/fake/repo');
  });

  it('resolves with void', async () => {
    const wm = makeManager();
    await expect(wm.prune()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// finalMergeToMain
// ═══════════════════════════════════════════════════════════════════════════════

describe('finalMergeToMain', () => {
  it('commits pending changes in the main worktree with a "Final merge" prompt', async () => {
    const wm = makeManager({ profilesDirs: ['/profiles'], mainWorktreePath: '/run/work/worktree' });
    await wm.finalMergeToMain();

    expect(mockCommitWorktreeChanges).toHaveBeenCalledWith({
      profilesDirs: ['/profiles'],
      worktreePath: '/run/work/worktree',
      taskPrompt: 'Final merge',
      apiKeys: undefined,
    });
  });

  it('checks out the real main branch before merging', async () => {
    mockGetMainBranch.mockReturnValue('main');
    const wm = makeManager({ repoRoot: '/fake/repo' });
    await wm.finalMergeToMain();

    expect(mockGetMainBranch).toHaveBeenCalledWith('/fake/repo');
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'main');
  });

  it('squash-merges the main-wt branch into real main', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', mainBranch: 'engin/feat-x' });
    await wm.finalMergeToMain();

    expect(mockSquashMergeBranch).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x');
  });

  it('commits the merge on success', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', mainBranch: 'engin/feat-x' });
    await wm.finalMergeToMain();

    expect(mockCommitChanges).toHaveBeenCalledWith('/fake/repo', 'Merge engin run: engin/feat-x');
  });

  it('restores the previously checked-out branch on success', async () => {
    mockGetCurrentBranch.mockReturnValue('previous-branch');
    const wm = makeManager({ repoRoot: '/fake/repo' });
    await wm.finalMergeToMain();

    // checkout main, then restore saved branch
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'main');
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'previous-branch');
  });

  it('returns { success: true, conflicts: [], conflictsResolved: false } on a clean merge', async () => {
    const wm = makeManager();
    const result = await wm.finalMergeToMain();

    expect(result).toEqual({ success: true, conflicts: [], conflictsResolved: false });
  });

  it('returns the conflict list and does NOT abort when the merge conflicts', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts', 'src/b.ts'] });
    const wm = makeManager();
    const result = await wm.finalMergeToMain();

    expect(result).toEqual({ success: false, conflicts: ['src/a.ts', 'src/b.ts'], conflictsResolved: false });
    expect(mockAbortMerge).not.toHaveBeenCalled();
  });

  it('does not commit a merge message when the final merge conflicts', async () => {
    mockSquashMergeBranch.mockReturnValue({ success: false, conflicts: ['src/a.ts'] });
    const wm = makeManager();
    await wm.finalMergeToMain();

    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('surfaces the squash-merge error reason on a non-conflict failure', async () => {
    mockSquashMergeBranch.mockReturnValue({
      success: false,
      conflicts: [],
      error: 'git merge --squash failed: already up to date',
    });
    const wm = makeManager();
    const result = await wm.finalMergeToMain();

    expect(result.success).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(result.error).toBe('git merge --squash failed: already up to date');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveFinalMergeConflicts
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveFinalMergeConflicts', () => {
  it('calls resolveConflictsWithAgent against the repo root', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', profilesDirs: ['/profiles'], apiKeys: { openai: 'sk-x' } });
    await wm.resolveFinalMergeConflicts(['src/a.ts'], 'Fix the conflicts');

    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles'],
      '/fake/repo',
      ['src/a.ts'],
      'Fix the conflicts',
      { openai: 'sk-x' },
    );
  });

  it('stages resolved files and commits when conflicts are resolved', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', mainBranch: 'engin/feat-x' });
    const ok = await wm.resolveFinalMergeConflicts(['src/a.ts', 'src/b.ts'], 'prompt');

    expect(ok).toEqual({ resolved: true });
    expect(mockStageFiles).toHaveBeenCalledWith('/fake/repo', ['src/a.ts', 'src/b.ts']);
    expect(mockCommitChanges).toHaveBeenCalledWith('/fake/repo', 'Merge resolution: engin/feat-x');
  });

  it('returns true when all conflicts are resolved', async () => {
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });
    const wm = makeManager();
    await expect(wm.resolveFinalMergeConflicts(['a.ts'], 'prompt')).resolves.toEqual({ resolved: true });
  });

  it('returns false when conflicts cannot be resolved', async () => {
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });
    const wm = makeManager();
    const ok = await wm.resolveFinalMergeConflicts(['a.ts'], 'prompt');

    expect(ok).toEqual({ resolved: false });
  });

  it('does not stage or commit when conflict resolution fails', async () => {
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });
    const wm = makeManager();
    await wm.resolveFinalMergeConflicts(['a.ts'], 'prompt');

    expect(mockStageFiles).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('threads the agent failure reason in the returned error field', async () => {
    mockResolveConflictsWithAgent.mockResolvedValue({
      resolved: false,
      error: 'tsc --noEmit failed: type error in src/a.ts',
    });
    const wm = makeManager();
    const result = await wm.resolveFinalMergeConflicts(['a.ts'], 'prompt');

    expect(result.resolved).toBe(false);
    expect(result.error).toBe('tsc --noEmit failed: type error in src/a.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// abortFinalMerge
// ═══════════════════════════════════════════════════════════════════════════════

describe('abortFinalMerge', () => {
  it('aborts an in-progress merge on the repo root', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo' });
    await wm.abortFinalMerge();

    expect(mockAbortMerge).toHaveBeenCalledWith('/fake/repo');
  });

  it('resolves with void', async () => {
    const wm = makeManager();
    await expect(wm.abortFinalMerge()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cleanup
// ═══════════════════════════════════════════════════════════════════════════════

describe('cleanup', () => {
  it('removes the main worktree', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', mainWorktreePath: '/run/work/worktree' });
    await wm.cleanup();

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/run/work/worktree');
  });

  it('force-deletes the main-wt branch', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', mainBranch: 'engin/feat-x' });
    await wm.cleanup();

    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x');
  });

  it('culls any remaining active task worktrees', async () => {
    const wm = makeManager({ repoRoot: '/fake/repo', workDir: '/run/work' });
    await wm.createTaskWorktree('task-1', 'p1');
    await wm.createTaskWorktree('task-2', 'p2');
    await wm.cleanup();

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', taskWorktreePath('/run/work', 'task-1'));
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', taskWorktreePath('/run/work', 'task-2'));
    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x--task-1');
    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x--task-2');
  });

  it('is best-effort — does not throw when main worktree removal fails', async () => {
    mockRemoveWorktree.mockImplementation((_root, path) => {
      if (path === '/run/work/worktree') throw new Error('worktree busy');
    });
    const wm = makeManager({ mainWorktreePath: '/run/work/worktree' });

    await expect(wm.cleanup()).resolves.toBeDefined();
  });

  it('surfaces a removal failure via cleanupError', async () => {
    mockRemoveWorktree.mockImplementation((_root, path) => {
      if (path === '/run/work/worktree') throw new Error('worktree busy');
    });
    const wm = makeManager({ mainWorktreePath: '/run/work/worktree' });
    const result = await wm.cleanup();

    expect(result.cleanupError).toBeDefined();
    expect(result.cleanupError).toContain('worktree busy');
  });

  it('leaves cleanupError undefined when everything succeeds', async () => {
    const wm = makeManager();
    const result = await wm.cleanup();

    expect(result.cleanupError).toBeUndefined();
  });

  it('is best-effort — does not throw when main branch deletion fails', async () => {
    mockDeleteBranchForce.mockImplementation(() => {
      throw new Error('branch locked');
    });
    const wm = makeManager();

    await expect(wm.cleanup()).resolves.toBeDefined();
  });

  it('still attempts to remove the branch when worktree removal fails', async () => {
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('busy');
    });
    const wm = makeManager({ repoRoot: '/fake/repo', mainBranch: 'engin/feat-x' });
    await wm.cleanup();

    expect(mockDeleteBranchForce).toHaveBeenCalledWith('/fake/repo', 'engin/feat-x');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getWorktreeInfo
// ═══════════════════════════════════════════════════════════════════════════════

describe('getWorktreeInfo', () => {
  it('returns the main worktree info', () => {
    const wm = makeManager({
      mainWorktreePath: '/run/work/worktree',
      mainBranch: 'engin/feat-x',
      sourceCwd: '/fake/source',
    });

    const info = wm.getWorktreeInfo();

    expect(info).toEqual({
      worktreePath: '/run/work/worktree',
      branchName: 'engin/feat-x',
      originalCwd: '/fake/source',
    });
  });

  it('exposes worktreePath, branchName, and originalCwd', () => {
    const wm = makeManager();
    const info = wm.getWorktreeInfo();

    expect(typeof info.worktreePath).toBe('string');
    expect(typeof info.branchName).toBe('string');
    expect(typeof info.originalCwd).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Module surface
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorktreeManager module surface', () => {
  it('exports the WorktreeManager class', () => {
    expect(typeof WorktreeManager).toBe('function');
  });

  it('constructs an instance with the expected public methods', () => {
    const wm = makeManager();
    expect(typeof wm.setupMainWorktree).toBe('function');
    expect(typeof wm.createTaskWorktree).toBe('function');
    expect(typeof wm.mergeTaskBranch).toBe('function');
    expect(typeof wm.cullTaskWorktree).toBe('function');
    expect(typeof wm.prune).toBe('function');
    expect(typeof wm.finalMergeToMain).toBe('function');
    expect(typeof wm.resolveFinalMergeConflicts).toBe('function');
    expect(typeof wm.abortFinalMerge).toBe('function');
    expect(typeof wm.cleanup).toBe('function');
    expect(typeof wm.getWorktreeInfo).toBe('function');
  });
});
