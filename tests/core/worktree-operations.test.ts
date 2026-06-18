// ─── Shared worktree merge/PR operations module ──────────────────────────────
//
// Test-first specification for `packages/engine/src/core/worktree-operations.ts`.
//
// CONTEXT: The worktree merge/PR/commit logic is currently duplicated between:
//   - packages/engine/src/server/run-manager.ts  (server-side handleWorktreeAction)
//   - packages/cli/src/cli/post-worktree.ts      (client-side handleMergeToMain,
//     handlePushAndPR, commitInWorktree)
//
// Both call the same sequence of git.ts primitives and worktree-lifecycle.ts
// agent functions. This task extracts the shared operations into a reusable
// module so both call sites can delegate to it.
//
// CONTRACT UNDER TEST (the new module must export exactly these functions):
//
//   export async function commitWorktreeChanges(opts: {
//     profilesDirs: string[];
//     worktreePath: string;
//     taskPrompt: string;
//     apiKeys?: Record<string, string>;
//   }): Promise<void>
//
//   export async function mergeWorktreeToMain(opts: {
//     profilesDirs: string[];
//     repoRoot: string;
//     worktreePath: string;
//     branchName: string;
//     taskPrompt: string;
//     apiKeys?: Record<string, string>;
//   }): Promise<{ success: boolean; conflictsResolved: boolean }>
//
//   export async function pushWorktreeAndCreatePR(opts: {
//     profilesDirs: string[];
//     repoRoot: string;
//     worktreePath: string;
//     branchName: string;
//     taskPrompt: string;
//     title: string;
//     apiKeys?: Record<string, string>;
//   }): Promise<{ cleanupError?: string }>
//
//   export async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void>
//
// These functions must be built from the existing git.ts primitives
// (checkoutBranch, mergeBranch, abortMerge, removeWorktree, stageAll,
// commitChanges, getDiff, getCurrentBranch, getMainBranch) and the
// worktree-lifecycle.ts agent functions (generateCommitMessage,
// resolveConflictsWithAgent, pushAndCreatePR).
//
// RETURN-VALUE SEMANTICS for mergeWorktreeToMain:
//   • Clean merge (no conflicts)            → { success: true,  conflictsResolved: false }
//   • Merge with agent-resolved conflicts   → { success: true,  conflictsResolved: true  }
//   • Conflicts that could NOT be resolved  → { success: false, conflictsResolved: false }
//
// Tests are RED (expected) because the source module is created in the
// NEXT (implement) phase.

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real modules before mocking ────────────────────────────────────

const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.js'));

// ─── Mock functions for git ─────────────────────────────────────────────────

const mockGetMainBranch = mock((_dir: string): string => 'main');
const mockGetCurrentBranch = mock((_dir: string): string => 'feature-branch');
const mockCheckoutBranch = mock((_repoRoot: string, _branch: string): void => {});
const mockMergeBranch = mock(
  (_repoRoot: string, _branch: string): { success: true } | { success: false; conflicts: string[] } => ({
    success: true,
  }),
);
const mockAbortMerge = mock((_repoRoot: string): void => {});
const mockRemoveWorktree = mock((_repoRoot: string, _worktreePath: string): void => {});
const mockStageAll = mock((_dir: string): void => {});
const mockCommitChanges = mock((_dir: string, _message: string): void => {});
const mockGetDiff = mock((_dir: string): string => 'diff content');

// ─── Mock functions for worktree-lifecycle ──────────────────────────────────

const mockGenerateCommitMessage = mock(
  async (
    _profilesDirs: string[],
    _worktreePath: string,
    _taskPrompt: string,
    _diff: string,
    _apiKeys?: Record<string, string>,
  ): Promise<string> => 'feat: implement feature',
);
const mockResolveConflictsWithAgent = mock(
  async (
    _profilesDirs: string[],
    _repoRoot: string,
    _conflicts: string[],
    _taskPrompt: string,
    _apiKeys?: Record<string, string>,
  ): Promise<boolean> => true,
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
  getRepoRoot: mock((_dir: string): string => '/fake/repo'),
  getMainBranch: mockGetMainBranch,
  getCurrentBranch: mockGetCurrentBranch,
  checkoutBranch: mockCheckoutBranch,
  mergeBranch: mockMergeBranch,
  abortMerge: mockAbortMerge,
  removeWorktree: mockRemoveWorktree,
  stageAll: mockStageAll,
  commitChanges: mockCommitChanges,
  getDiff: mockGetDiff,
}));

mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => ({
  generateCommitMessage: mockGenerateCommitMessage,
  resolveConflictsWithAgent: mockResolveConflictsWithAgent,
  pushAndCreatePR: mockPushAndCreatePR,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import {
  cleanupWorktree,
  commitWorktreeChanges,
  mergeWorktreeToMain,
  pushWorktreeAndCreatePR,
} from '../../packages/engine/src/core/worktree-operations.js';

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/git.js', () => realGit);
  mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => realWorktreeLifecycle);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CommitOpts {
  profilesDirs: string[];
  worktreePath: string;
  taskPrompt: string;
  apiKeys?: Record<string, string>;
}

interface MergeOpts {
  profilesDirs: string[];
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  taskPrompt: string;
  apiKeys?: Record<string, string>;
}

interface PushOpts {
  profilesDirs: string[];
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  taskPrompt: string;
  title: string;
  apiKeys?: Record<string, string>;
}

function makeCommitOpts(overrides?: Partial<CommitOpts>): CommitOpts {
  return {
    profilesDirs: ['/profiles'],
    worktreePath: '/fake/repo/.engin-worktree-feature-branch',
    taskPrompt: 'Implement the login feature',
    ...overrides,
  };
}

function makeMergeOpts(overrides?: Partial<MergeOpts>): MergeOpts {
  return {
    profilesDirs: ['/profiles'],
    repoRoot: '/fake/repo',
    worktreePath: '/fake/repo/.engin-worktree-feature-branch',
    branchName: 'feature-branch',
    taskPrompt: 'Implement the login feature',
    ...overrides,
  };
}

function makePushOpts(overrides?: Partial<PushOpts>): PushOpts {
  return {
    profilesDirs: ['/profiles'],
    repoRoot: '/fake/repo',
    worktreePath: '/fake/repo/.engin-worktree-feature-branch',
    branchName: 'feature-branch',
    taskPrompt: 'Implement the login feature',
    title: 'Implement the login feature',
    ...overrides,
  };
}

// ─── Reset mocks ─────────────────────────────────────────────────────────────

function resetMocks() {
  mock.clearAllMocks();
  mockGetMainBranch.mockReturnValue('main');
  mockGetCurrentBranch.mockReturnValue('feature-branch');
  mockGetDiff.mockReturnValue('diff content');
  mockGenerateCommitMessage.mockResolvedValue('feat: implement feature');
  mockResolveConflictsWithAgent.mockResolvedValue(true);
  mockPushAndCreatePR.mockResolvedValue(undefined);
  // Bun's clearAllMocks() only clears call history — implementations set via
  // mockImplementation/mockReturnValue persist. Re-establish safe defaults so
  // a throwing implementation set by one test cannot leak into the next.
  mockCheckoutBranch.mockImplementation(() => {});
  mockMergeBranch.mockReturnValue({ success: true });
  mockRemoveWorktree.mockImplementation(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// commitWorktreeChanges
// ═══════════════════════════════════════════════════════════════════════════════

describe('commitWorktreeChanges', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('commits when diff is non-empty', async () => {
    mockGetDiff.mockReturnValue('some diff content');
    mockGenerateCommitMessage.mockResolvedValue('fix: resolve bug');

    await commitWorktreeChanges(makeCommitOpts());

    expect(mockGetDiff).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch');
    expect(mockStageAll).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch');
    expect(mockGenerateCommitMessage).toHaveBeenCalledWith(
      ['/profiles'],
      '/fake/repo/.engin-worktree-feature-branch',
      'Implement the login feature',
      'some diff content',
      undefined,
    );
    expect(mockCommitChanges).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch', 'fix: resolve bug');
  });

  it('does nothing when diff is empty', async () => {
    mockGetDiff.mockReturnValue('');

    await commitWorktreeChanges(makeCommitOpts());

    expect(mockGetDiff).toHaveBeenCalled();
    expect(mockStageAll).not.toHaveBeenCalled();
    expect(mockGenerateCommitMessage).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('resolves with void', async () => {
    mockGetDiff.mockReturnValue('diff');
    await expect(commitWorktreeChanges(makeCommitOpts())).resolves.toBeUndefined();
  });

  it('passes apiKeys to generateCommitMessage', async () => {
    mockGetDiff.mockReturnValue('diff');
    mockGenerateCommitMessage.mockResolvedValue('msg');

    await commitWorktreeChanges(makeCommitOpts({ apiKeys: { openai: 'sk-test' } }));

    expect(mockGenerateCommitMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { openai: 'sk-test' },
    );
  });

  it('passes undefined apiKeys when not provided', async () => {
    mockGetDiff.mockReturnValue('diff');

    await commitWorktreeChanges(makeCommitOpts());

    const callArgs = mockGenerateCommitMessage.mock.calls[0];
    expect(callArgs[4]).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// mergeWorktreeToMain
// ═══════════════════════════════════════════════════════════════════════════════

describe('mergeWorktreeToMain', () => {
  beforeEach(() => {
    resetMocks();
  });

  // ─── Commit-in-worktree step ─────────────────────────────────────────────

  it('commits changes in the worktree before merging (clean merge)', async () => {
    mockGetDiff.mockReturnValue('diff content');
    mockMergeBranch.mockReturnValue({ success: true });

    await mergeWorktreeToMain(makeMergeOpts());

    expect(mockGetDiff).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch');
    expect(mockStageAll).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch');
    expect(mockGenerateCommitMessage).toHaveBeenCalled();
    expect(mockCommitChanges).toHaveBeenCalledWith(
      '/fake/repo/.engin-worktree-feature-branch',
      'feat: implement feature',
    );
  });

  it('still proceeds to merge when worktree diff is empty (nothing to commit)', async () => {
    mockGetDiff.mockReturnValue('');
    mockMergeBranch.mockReturnValue({ success: true });

    await mergeWorktreeToMain(makeMergeOpts());

    expect(mockStageAll).not.toHaveBeenCalled();
    // But the merge itself still happens:
    expect(mockGetMainBranch).toHaveBeenCalledWith('/fake/repo');
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'main');
    expect(mockMergeBranch).toHaveBeenCalledWith('/fake/repo', 'feature-branch');
  });

  // ─── Clean merge path ────────────────────────────────────────────────────

  it('saves the current branch before checking out main', async () => {
    mockGetCurrentBranch.mockReturnValue('previous-branch');
    mockMergeBranch.mockReturnValue({ success: true });

    await mergeWorktreeToMain(makeMergeOpts());

    expect(mockGetCurrentBranch).toHaveBeenCalledWith('/fake/repo');
  });

  it('checks out the main branch and merges the feature branch', async () => {
    mockGetMainBranch.mockReturnValue('main');

    await mergeWorktreeToMain(makeMergeOpts({ branchName: 'my-feature' }));

    expect(mockGetMainBranch).toHaveBeenCalledWith('/fake/repo');
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'main');
    expect(mockMergeBranch).toHaveBeenCalledWith('/fake/repo', 'my-feature');
  });

  it('returns { success: true, conflictsResolved: false } on a clean merge', async () => {
    mockMergeBranch.mockReturnValue({ success: true });

    const result = await mergeWorktreeToMain(makeMergeOpts());

    expect(result).toEqual({ success: true, conflictsResolved: false });
  });

  it('restores the saved branch after a successful merge', async () => {
    mockGetCurrentBranch.mockReturnValue('previous-branch');
    mockMergeBranch.mockReturnValue({ success: true });

    await mergeWorktreeToMain(makeMergeOpts());

    // checkoutBranch should be called for main AND for restoring the saved branch
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'main');
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'previous-branch');
  });

  it('ignores errors when restoring the saved branch (detached HEAD)', async () => {
    mockGetCurrentBranch.mockReturnValue('previous-branch');
    mockMergeBranch.mockReturnValue({ success: true });
    // checkout main succeeds, restore previous branch throws
    mockCheckoutBranch
      .mockImplementationOnce(() => {}) // checkout main
      .mockImplementationOnce(() => {
        throw new Error('detached HEAD');
      }); // restore previous branch

    await expect(mergeWorktreeToMain(makeMergeOpts())).resolves.toEqual({
      success: true,
      conflictsResolved: false,
    });
  });

  it('removes the worktree after a successful merge', async () => {
    mockMergeBranch.mockReturnValue({ success: true });

    await mergeWorktreeToMain(makeMergeOpts({ worktreePath: '/path/to/wt' }));

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/path/to/wt');
  });

  it('does not abort the merge on a clean merge', async () => {
    mockMergeBranch.mockReturnValue({ success: true });

    await mergeWorktreeToMain(makeMergeOpts());

    expect(mockAbortMerge).not.toHaveBeenCalled();
  });

  // ─── Conflict resolution path (success) ──────────────────────────────────

  it('calls resolveConflictsWithAgent when the merge has conflicts', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts', 'file2.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);

    await mergeWorktreeToMain(makeMergeOpts());

    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles'],
      '/fake/repo',
      ['file1.ts', 'file2.ts'],
      'Implement the login feature',
      undefined,
    );
  });

  it('commits a merge-resolution message after successful conflict resolution', async () => {
    mockGetMainBranch.mockReturnValue('main');
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);

    await mergeWorktreeToMain(makeMergeOpts({ branchName: 'feat-x' }));

    // The merge-resolution commit is made in repoRoot (not the worktree).
    const mergeCommit = mockCommitChanges.mock.calls.find((c) => (c[1] as string).includes('Merge resolution'));
    expect(mergeCommit).toBeDefined();
    expect(mergeCommit![0]).toBe('/fake/repo');
    expect(mergeCommit![1]).toContain('feat-x');
    expect(mergeCommit![1]).toContain('main');
  });

  it('returns { success: true, conflictsResolved: true } when conflicts are resolved', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);

    const result = await mergeWorktreeToMain(makeMergeOpts());

    expect(result).toEqual({ success: true, conflictsResolved: true });
  });

  it('removes the worktree after successfully resolved conflicts', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);

    await mergeWorktreeToMain(makeMergeOpts({ worktreePath: '/path/to/wt' }));

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/path/to/wt');
  });

  it('does not abort the merge when conflicts are resolved', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);

    await mergeWorktreeToMain(makeMergeOpts());

    expect(mockAbortMerge).not.toHaveBeenCalled();
  });

  it('passes apiKeys to resolveConflictsWithAgent', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);

    await mergeWorktreeToMain(makeMergeOpts({ apiKeys: { anthropic: 'sk-ant' } }));

    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { anthropic: 'sk-ant' },
    );
  });

  // ─── Conflict resolution path (failure) ──────────────────────────────────

  it('aborts the merge when conflict resolution fails', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(false);

    await mergeWorktreeToMain(makeMergeOpts());

    expect(mockAbortMerge).toHaveBeenCalledWith('/fake/repo');
  });

  it('returns { success: false, conflictsResolved: false } when conflicts cannot be resolved', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(false);

    const result = await mergeWorktreeToMain(makeMergeOpts());

    expect(result).toEqual({ success: false, conflictsResolved: false });
  });

  it('preserves the worktree when conflicts cannot be resolved', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(false);

    await mergeWorktreeToMain(makeMergeOpts());

    // The worktree must NOT be removed so the user can resolve manually.
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('does not commit a merge-resolution message when conflict resolution fails', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(false);

    await mergeWorktreeToMain(makeMergeOpts());

    const mergeCommit = mockCommitChanges.mock.calls.find((c) => (c[1] as string).includes('Merge resolution'));
    expect(mergeCommit).toBeUndefined();
  });

  // ─── Worktree-removal failures are surfaced via cleanupError ──────────────

  it('surfaces a worktree-removal failure via cleanupError on a clean merge', async () => {
    // The merge succeeded; only the final cleanup failed. This must NOT throw
    // — it must return a successful result carrying the cleanup error.
    mockMergeBranch.mockReturnValue({ success: true });
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('worktree busy');
    });

    const result = await mergeWorktreeToMain(makeMergeOpts());

    expect(result.success).toBe(true);
    expect(result.cleanupError).toBe('worktree busy');
  });

  it('surfaces a worktree-removal failure via cleanupError after resolved conflicts', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('locked');
    });

    const result = await mergeWorktreeToMain(makeMergeOpts());

    expect(result).toEqual({ success: true, conflictsResolved: true, cleanupError: 'locked' });
  });

  it('does NOT throw when worktree removal fails', async () => {
    mockMergeBranch.mockReturnValue({ success: true });
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('busy');
    });

    // A cleanup failure is surfaced, never thrown — the merge succeeded.
    await expect(mergeWorktreeToMain(makeMergeOpts())).resolves.toMatchObject({
      success: true,
      cleanupError: 'busy',
    });
  });

  it('leaves cleanupError undefined when removal succeeds', async () => {
    mockMergeBranch.mockReturnValue({ success: true });

    const result = await mergeWorktreeToMain(makeMergeOpts());

    expect(result.cleanupError).toBeUndefined();
    expect(result).toEqual({ success: true, conflictsResolved: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// pushWorktreeAndCreatePR
// ═══════════════════════════════════════════════════════════════════════════════

describe('pushWorktreeAndCreatePR', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('commits changes in the worktree before pushing', async () => {
    mockGetDiff.mockReturnValue('diff content');

    await pushWorktreeAndCreatePR(makePushOpts());

    expect(mockGetDiff).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch');
    expect(mockStageAll).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch');
    expect(mockGenerateCommitMessage).toHaveBeenCalled();
    expect(mockCommitChanges).toHaveBeenCalled();
  });

  it('skips the commit when diff is empty but still pushes', async () => {
    mockGetDiff.mockReturnValue('');

    await pushWorktreeAndCreatePR(makePushOpts());

    expect(mockStageAll).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
    // Push must still happen:
    expect(mockPushAndCreatePR).toHaveBeenCalledTimes(1);
  });

  it('calls pushAndCreatePR with the provided arguments', async () => {
    await pushWorktreeAndCreatePR(
      makePushOpts({
        profilesDirs: ['/profiles'],
        repoRoot: '/fake/repo',
        branchName: 'feature-branch',
        taskPrompt: 'Add login page',
        title: 'Add login page',
      }),
    );

    expect(mockPushAndCreatePR).toHaveBeenCalledWith(
      ['/profiles'],
      '/fake/repo',
      'feature-branch',
      'Add login page',
      'Add login page',
      undefined,
    );
  });

  it('passes the title through unchanged (no truncation)', async () => {
    // The shared function receives the FINAL title; truncation is the
    // caller's responsibility. A long title must be forwarded verbatim.
    const longTitle = 'A'.repeat(120);
    await pushWorktreeAndCreatePR(makePushOpts({ title: longTitle }));

    const callArgs = mockPushAndCreatePR.mock.calls[0];
    expect(callArgs[4]).toBe(longTitle);
  });

  it('passes the taskPrompt separately from the title', async () => {
    await pushWorktreeAndCreatePR(
      makePushOpts({
        taskPrompt: 'the full task prompt',
        title: 'short title',
      }),
    );

    const callArgs = mockPushAndCreatePR.mock.calls[0];
    expect(callArgs[3]).toBe('the full task prompt');
    expect(callArgs[4]).toBe('short title');
  });

  it('passes apiKeys to pushAndCreatePR', async () => {
    await pushWorktreeAndCreatePR(makePushOpts({ apiKeys: { openai: 'sk-test' } }));

    expect(mockPushAndCreatePR).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { openai: 'sk-test' },
    );
  });

  it('passes undefined apiKeys when not provided', async () => {
    await pushWorktreeAndCreatePR(makePushOpts());

    const callArgs = mockPushAndCreatePR.mock.calls[0];
    expect(callArgs[5]).toBeUndefined();
  });

  it('removes the worktree after PR creation', async () => {
    await pushWorktreeAndCreatePR(makePushOpts({ worktreePath: '/path/to/wt' }));

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/path/to/wt');
  });

  it('still removes the worktree when diff was empty', async () => {
    mockGetDiff.mockReturnValue('');

    await pushWorktreeAndCreatePR(makePushOpts({ worktreePath: '/path/to/wt' }));

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/path/to/wt');
  });

  it('leaves cleanupError undefined when removal succeeds', async () => {
    const result = await pushWorktreeAndCreatePR(makePushOpts());
    expect(result.cleanupError).toBeUndefined();
  });

  it('surfaces a worktree-removal failure via cleanupError without throwing', async () => {
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('worktree busy');
    });

    const result = await pushWorktreeAndCreatePR(makePushOpts());
    expect(result.cleanupError).toBe('worktree busy');

    // The push + PR creation still happened; only cleanup failed.
    expect(mockPushAndCreatePR).toHaveBeenCalledTimes(1);
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
  });

  it('throws on push/PR failure and does not run cleanup', async () => {
    mockPushAndCreatePR.mockImplementation(async () => {
      throw new Error('push rejected');
    });

    await expect(pushWorktreeAndCreatePR(makePushOpts())).rejects.toThrow('push rejected');

    // Cleanup must NOT run after a real push/PR failure.
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cleanupWorktree
// ═══════════════════════════════════════════════════════════════════════════════

describe('cleanupWorktree', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('removes the worktree via removeWorktree', async () => {
    await cleanupWorktree('/fake/repo', '/fake/repo/.engin-worktree-feature');

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/fake/repo/.engin-worktree-feature');
  });

  it('passes repoRoot and worktreePath in the correct order', async () => {
    await cleanupWorktree('/the/repo/root', '/the/worktree/path');

    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
    expect(mockRemoveWorktree.mock.calls[0][0]).toBe('/the/repo/root');
    expect(mockRemoveWorktree.mock.calls[0][1]).toBe('/the/worktree/path');
  });

  it('swallows errors from removeWorktree (best-effort cleanup)', async () => {
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('worktree busy');
    });

    // Must NOT throw — cleanup is best-effort.
    await expect(cleanupWorktree('/fake/repo', '/fake/repo/wt')).resolves.toBeUndefined();
  });

  it('resolves with void on success', async () => {
    await expect(cleanupWorktree('/fake/repo', '/fake/repo/wt')).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Module surface: exported function signatures
// ═══════════════════════════════════════════════════════════════════════════════

describe('worktree-operations module surface', () => {
  it('exports commitWorktreeChanges as a function', () => {
    expect(typeof commitWorktreeChanges).toBe('function');
  });

  it('exports mergeWorktreeToMain as a function', () => {
    expect(typeof mergeWorktreeToMain).toBe('function');
  });

  it('exports pushWorktreeAndCreatePR as a function', () => {
    expect(typeof pushWorktreeAndCreatePR).toBe('function');
  });

  it('exports cleanupWorktree as a function', () => {
    expect(typeof cleanupWorktree).toBe('function');
  });
});
