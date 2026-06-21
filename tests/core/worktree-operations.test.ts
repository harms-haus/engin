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
//     SAFETY NET: when commitChanges throws (lint-staged/eslint gate fails on
//     an unfixable-on-first-pass error), spawn runTooledFixup
//     (worktree-fixup.js) with the commit error as `errorContext`, then
//     re-stage (stageAll) and retry commitChanges ONCE. If the fix-up fails
//     OR the retry commit also throws, re-throw the ORIGINAL commit error.
//     Never passes --no-verify.
//
//   export function createLintValidationGate(worktreePath: string):
//     () => Promise<{ error?: string } | undefined>
//     PRIMARY lint defence: runs `prettier --write` + a single `eslint --fix`
//     pass in the worktree (Bun.spawnSync). Returns `{ error: 'Lint errors
//     remain: ...' }` when unfixable errors remain after the auto-fix pass,
//     or `undefined` when clean. The fix-up safety net above is the fallback
//     for anything this gate (or the commit hook) misses.
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

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real modules before mocking ────────────────────────────────────

const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.js'));
const realWorktreeFixup = Object.assign({}, await import('../../packages/engine/src/core/worktree-fixup.js'));

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
  ): Promise<{ resolved: boolean; error?: string }> => ({ resolved: true }),
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

// ─── Mock functions for worktree-fixup ──────────────────────────────────────

/** Shape of the options object commitWorktreeChanges forwards to runTooledFixup. */
interface FixupCallOptions {
  profilesDirs: string[];
  worktreePath: string;
  taskPrompt: string;
  errorContext: string;
  apiKeys?: Record<string, string>;
}

const mockRunTooledFixup = mock(
  async (_opts: FixupCallOptions): Promise<{ success: boolean; attempts: number; lastError?: string }> => ({
    success: true,
    attempts: 1,
  }),
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

mock.module('../../packages/engine/src/core/worktree-fixup.js', () => ({
  runTooledFixup: mockRunTooledFixup,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import {
  cleanupWorktree,
  commitWorktreeChanges,
  mergeWorktreeToMain,
  pushWorktreeAndCreatePR,
} from '../../packages/engine/src/core/worktree-operations.js';

// `createLintValidationGate` is added to the module in the implement phase. It
// is imported via a namespace binding rather than a named import so that, until
// it is implemented, the missing export does NOT break module linking — a named
// import of a non-existent export raises a SyntaxError that would fail the
// ENTIRE file (and every existing test with it). Accessed through the
// namespace, the property is simply `undefined` until then, which leaves the
// createLintValidationGate tests RED (as expected for test-first) while every
// existing test continues to load and pass.
import * as WorktreeOperations from '../../packages/engine/src/core/worktree-operations.js';

const createLintValidationGate = (
  WorktreeOperations as unknown as {
    createLintValidationGate: (worktreePath: string) => () => Promise<{ error?: string } | undefined>;
  }
).createLintValidationGate;

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/git.js', () => realGit);
  mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => realWorktreeLifecycle);
  mock.module('../../packages/engine/src/core/worktree-fixup.js', () => realWorktreeFixup);
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
  mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });
  mockPushAndCreatePR.mockResolvedValue(undefined);
  // Bun's clearAllMocks() only clears call history — implementations set via
  // mockImplementation/mockReturnValue persist. Re-establish safe defaults so
  // a throwing implementation set by one test cannot leak into the next.
  mockCheckoutBranch.mockImplementation(() => {});
  mockMergeBranch.mockReturnValue({ success: true });
  mockRemoveWorktree.mockImplementation(() => {});
  // commitWorktreeChanges now wraps commitChanges in a fix-up safety net.
  // Reset the commit + staging primitives to their non-throwing defaults so a
  // throwing implementation set by one commit-failure test cannot leak into
  // the merge/PR tests (which rely on the commit succeeding first try) nor
  // trigger the fix-up agent unexpectedly.
  mockStageAll.mockImplementation(() => {});
  mockCommitChanges.mockImplementation(() => {});
  mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });
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

  it('does not commit when the diff is empty AFTER staging', async () => {
    mockGetDiff.mockReturnValue('');

    await commitWorktreeChanges(makeCommitOpts());

    // stageAll runs FIRST now (before the diff guard) so untracked files are
    // captured — it is a no-op when the tree is clean, but it IS invoked.
    expect(mockStageAll).toHaveBeenCalled();
    expect(mockGetDiff).toHaveBeenCalled();
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

  // ─── Commit-failure fix-up safety net ────────────────────────────────────
  //
  // When the pre-commit hook (lint-staged/eslint gate) rejects the commit on
  // the first pass, commitWorktreeChanges must spawn the tooled fix-up agent
  // to repair the lint errors, re-stage, and retry the commit exactly once.
  // The fix-up primitive retries internally (up to 3 times); commitWorktreeChanges
  // itself only retries the COMMIT once.

  it('succeeds on the first commit attempt without invoking the fix-up agent', async () => {
    mockGetDiff.mockReturnValue('diff content');
    mockCommitChanges.mockImplementation(() => {}); // first attempt succeeds

    await expect(commitWorktreeChanges(makeCommitOpts())).resolves.toBeUndefined();

    expect(mockCommitChanges).toHaveBeenCalledTimes(1);
    expect(mockRunTooledFixup).not.toHaveBeenCalled();
  });

  it('runs the tooled fix-up and retries the commit when the first commit throws', async () => {
    mockGetDiff.mockReturnValue('diff content');
    mockGenerateCommitMessage.mockResolvedValue('feat: retry me');
    // First commit attempt throws (lint-staged gate failure); retry succeeds.
    // A counter-driven persistent implementation is used instead of
    // mockImplementationOnce: Bun's clearAllMocks()/mockImplementation() do NOT
    // clear the once-queue, so a queued-but-unconsumed once-impl would leak
    // into later tests (this test is RED until the retry exists, so only one
    // call is consumed today). A persistent impl is cleanly replaced by
    // resetMocks() in the next test.
    let commitAttempts = 0;
    mockCommitChanges.mockImplementation(() => {
      commitAttempts++;
      if (commitAttempts === 1) {
        throw new Error('lint-staged: eslint reported 2 errors');
      }
      // subsequent attempts succeed
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await expect(commitWorktreeChanges(makeCommitOpts())).resolves.toBeUndefined();

    // The fix-up was spawned exactly once, scoped to the worktree, carrying the
    // commit error as context.
    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    const fixupArgs = mockRunTooledFixup.mock.calls[0]![0];
    expect(fixupArgs.errorContext).toContain('lint-staged');
    expect(fixupArgs.errorContext).toContain('eslint');
    expect(fixupArgs.worktreePath).toBe('/fake/repo/.engin-worktree-feature-branch');
    expect(fixupArgs.profilesDirs).toEqual(['/profiles']);
    expect(fixupArgs.taskPrompt).toBe('Implement the login feature');

    // Re-staged after the fix, then retried the commit once.
    expect(mockStageAll).toHaveBeenCalledTimes(2);
    expect(mockCommitChanges).toHaveBeenCalledTimes(2);
    // Both commit attempts use the SAME generated message.
    expect(mockCommitChanges).toHaveBeenNthCalledWith(1, '/fake/repo/.engin-worktree-feature-branch', 'feat: retry me');
    expect(mockCommitChanges).toHaveBeenNthCalledWith(2, '/fake/repo/.engin-worktree-feature-branch', 'feat: retry me');
  });

  it('re-throws the ORIGINAL commit error when the fix-up agent fails', async () => {
    mockGetDiff.mockReturnValue('diff content');
    const originalError = new Error('eslint: unfixable type error');
    mockCommitChanges.mockImplementation(() => {
      throw originalError;
    });
    mockRunTooledFixup.mockResolvedValue({ success: false, attempts: 3, lastError: 'could not fix' });

    // The ORIGINAL commit error is propagated (not the fix-up lastError).
    await expect(commitWorktreeChanges(makeCommitOpts())).rejects.toBe(originalError);

    // The fix-up ran but did not succeed → no re-stage, no retry commit.
    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    expect(mockStageAll).toHaveBeenCalledTimes(1);
    expect(mockCommitChanges).toHaveBeenCalledTimes(1);
  });

  it('re-throws the original commit error when the fix-up succeeds but the retry commit still throws', async () => {
    mockGetDiff.mockReturnValue('diff content');
    const originalError = new Error('original lint gate failure');
    // First call throws the original error (triggers the safety net); the
    // retry call throws a different error. Per the contract the ORIGINAL error
    // is re-thrown. Counter-driven persistent impl (see note above) avoids
    // once-queue leakage while this test is RED.
    let commitAttempts = 0;
    mockCommitChanges.mockImplementation(() => {
      commitAttempts++;
      if (commitAttempts === 1) throw originalError;
      throw new Error('retry also failed');
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    // Per the safety-net contract the ORIGINAL error is re-thrown, not the
    // retry's error.
    await expect(commitWorktreeChanges(makeCommitOpts())).rejects.toBe(originalError);

    // Fix-up ran, was re-staged, and the retry commit was attempted (and threw).
    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    expect(mockStageAll).toHaveBeenCalledTimes(2);
    expect(mockCommitChanges).toHaveBeenCalledTimes(2);
  });

  it('forwards apiKeys to the fix-up agent', async () => {
    mockGetDiff.mockReturnValue('diff content');
    let commitAttempts = 0;
    mockCommitChanges.mockImplementation(() => {
      commitAttempts++;
      if (commitAttempts === 1) throw new Error('gate failed');
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await commitWorktreeChanges(makeCommitOpts({ apiKeys: { openai: 'sk-net' } }));

    expect(mockRunTooledFixup.mock.calls[0]![0].apiKeys).toEqual({ openai: 'sk-net' });
  });

  it('never passes --no-verify to commitChanges (always exactly dir + message)', async () => {
    // Constraint: "Do not --no-verify; that hides real problems." The fix-up
    // safety net must fix the lint errors and retry through the REAL hook, not
    // bypass it. commitChanges(dir, message) takes exactly two positional
    // string args — no flags.
    mockGetDiff.mockReturnValue('diff content');
    let commitAttempts = 0;
    mockCommitChanges.mockImplementation(() => {
      commitAttempts++;
      if (commitAttempts === 1) throw new Error('gate failed');
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await commitWorktreeChanges(makeCommitOpts());

    expect(mockCommitChanges.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockCommitChanges.mock.calls) {
      expect(call).toHaveLength(2);
      expect(typeof call[0]).toBe('string');
      expect(typeof call[1]).toBe('string');
    }
  });

  it('does not run the fix-up agent when the diff is empty (nothing to commit)', async () => {
    mockGetDiff.mockReturnValue('');

    await commitWorktreeChanges(makeCommitOpts());

    expect(mockCommitChanges).not.toHaveBeenCalled();
    expect(mockRunTooledFixup).not.toHaveBeenCalled();
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

    // stageAll runs FIRST (before the diff guard) — invoked even when the
    // diff is empty (a clean-tree no-op).
    expect(mockStageAll).toHaveBeenCalled();
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
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });

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
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });

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
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });

    const result = await mergeWorktreeToMain(makeMergeOpts());

    expect(result).toEqual({ success: true, conflictsResolved: true });
  });

  it('removes the worktree after successfully resolved conflicts', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });

    await mergeWorktreeToMain(makeMergeOpts({ worktreePath: '/path/to/wt' }));

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/path/to/wt');
  });

  it('does not abort the merge when conflicts are resolved', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });

    await mergeWorktreeToMain(makeMergeOpts());

    expect(mockAbortMerge).not.toHaveBeenCalled();
  });

  it('passes apiKeys to resolveConflictsWithAgent', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });

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
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });

    await mergeWorktreeToMain(makeMergeOpts());

    expect(mockAbortMerge).toHaveBeenCalledWith('/fake/repo');
  });

  it('returns { success: false, conflictsResolved: false } when conflicts cannot be resolved', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });

    const result = await mergeWorktreeToMain(makeMergeOpts());

    expect(result).toEqual({ success: false, conflictsResolved: false });
  });

  it('preserves the worktree when conflicts cannot be resolved', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });

    await mergeWorktreeToMain(makeMergeOpts());

    // The worktree must NOT be removed so the user can resolve manually.
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('does not commit a merge-resolution message when conflict resolution fails', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: false });

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
    mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });
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

    // stageAll runs FIRST (before the diff guard) — invoked even when the
    // diff is empty (a clean-tree no-op).
    expect(mockStageAll).toHaveBeenCalled();
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
// createLintValidationGate
// ═══════════════════════════════════════════════════════════════════════════════
//
// `createLintValidationGate(worktreePath)` returns a `validateOutput` callback
// suitable for runStepTask's validateOutput option. It is the PRIMARY lint
// defence: it runs `prettier --write` + a single `eslint --fix` pass in the
// worktree (format, then auto-fix + report). Returns `{ error: 'Lint errors
// remain: ...' }` when unfixable errors remain after the auto-fix pass, or
// `undefined` when clean. The commit-failure fix-up safety net above is the
// fallback for anything this gate misses.
//
// These tests mock `Bun.spawn` (scoped to this describe block) so the gate
// never shells out to a real eslint/prettier. The gate uses async `Bun.spawn`
// (not `Bun.spawnSync`) so it does not block the server event loop, mirroring
// `verifyWorktree` in worktree-fixup.ts.

describe('createLintValidationGate', () => {
  // Capture the real Bun.spawn so we can restore it after each test in this
  // block. The gate uses async Bun.spawn (not spawnSync) so it does not block
  // the server event loop, mirroring verifyWorktree in worktree-fixup.ts.
  const realBunSpawn = Bun.spawn;

  interface CapturedCall {
    cmd: string[];
    cwd?: string;
  }
  const spawnCalls: CapturedCall[] = [];

  /** Scripted result for the authoritative eslint invocation (eslint --fix). */
  let eslintCheckResult: { exitCode: number; stderr: string };

  /** Build a fake Bun.spawn Subprocess result: an `exited` promise plus piped
   *  stdout/stderr ReadableStreams that the gate drains via
   *  `new Response(proc.stderr).text()` / `new Response(proc.stdout).text()`. */
  function spawnResult(exitCode: number, stderr = '', stdout = '') {
    const enc = new TextEncoder();
    const toStream = (s: string): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(s));
          controller.close();
        },
      });
    return {
      exited: Promise.resolve(exitCode),
      stdout: toStream(stdout),
      stderr: toStream(stderr),
    };
  }

  /** Identify the authoritative eslint invocation: the single eslint call
   *  that carries `--fix` (prettier --write is fire-and-forget). */
  function isLintCheck(cmd: string[]): boolean {
    return cmd.includes('eslint') && cmd.includes('--fix');
  }

  const mockSpawn = mock((options: { cmd?: string[]; cwd?: string }) => {
    const cmd = options.cmd ?? [];
    const cwd = options.cwd;
    spawnCalls.push({ cmd, cwd });

    if (isLintCheck(cmd)) {
      return spawnResult(eslintCheckResult.exitCode, eslintCheckResult.stderr);
    }
    // prettier --write (format) is fire-and-forget; its exit code does not
    // influence the return value.
    return spawnResult(0);
  });

  beforeEach(() => {
    resetMocks();
    spawnCalls.length = 0;
    eslintCheckResult = { exitCode: 0, stderr: '' };
    Bun.spawn = mockSpawn as unknown as typeof Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = realBunSpawn;
  });

  it('returns a validateOutput function', () => {
    const validate = createLintValidationGate('/wt/abc');
    expect(typeof validate).toBe('function');
  });

  it('returns undefined when no lint errors remain after the check', async () => {
    eslintCheckResult = { exitCode: 0, stderr: '' };
    const validate = createLintValidationGate('/wt/clean');

    await expect(validate()).resolves.toBeUndefined();

    // The check was an eslint invocation scoped to the worktree.
    const eslintCalls = spawnCalls.filter((c) => c.cmd.includes('eslint'));
    expect(eslintCalls.length).toBeGreaterThan(0);
    for (const c of eslintCalls) {
      expect(c.cwd).toBe('/wt/clean');
    }
  });

  it('returns { error } describing the remaining lint errors when the check fails', async () => {
    eslintCheckResult = { exitCode: 1, stderr: '  src/foo.ts:3:1  error  no-unused-vars\n' };
    const validate = createLintValidationGate('/wt/dirty');

    const result = await validate();

    expect(result).toBeDefined();
    expect(result!.error).toContain('Lint errors remain');
    expect(result!.error).toContain('no-unused-vars');
  });

  it('runs eslint --fix to autofix before checking', async () => {
    const validate = createLintValidationGate('/wt/fix');
    await validate();

    const autofix = spawnCalls.find((c) => c.cmd.includes('eslint') && c.cmd.includes('--fix'));
    expect(autofix).toBeDefined();
    expect(autofix!.cwd).toBe('/wt/fix');
  });

  it('runs prettier --write to format before checking', async () => {
    const validate = createLintValidationGate('/wt/fmt');
    await validate();

    const prettier = spawnCalls.find((c) => c.cmd.includes('prettier') && c.cmd.includes('--write'));
    expect(prettier).toBeDefined();
    expect(prettier!.cwd).toBe('/wt/fmt');
  });

  it('runs every command with cwd set to the worktree path', async () => {
    const validate = createLintValidationGate('/wt/cwd');
    await validate();

    expect(spawnCalls.length).toBeGreaterThan(0);
    for (const c of spawnCalls) {
      expect(c.cwd).toBe('/wt/cwd');
    }
  });

  it('re-runs the full validation on each invocation (stateless callback)', async () => {
    eslintCheckResult = { exitCode: 0, stderr: '' };
    const validate = createLintValidationGate('/wt/multi');

    await validate();
    await validate();

    // At least two full lint-check passes ran.
    const lintChecks = spawnCalls.filter((c) => isLintCheck(c.cmd));
    expect(lintChecks.length).toBeGreaterThanOrEqual(2);
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

  it('exports createLintValidationGate as a function', () => {
    expect(typeof createLintValidationGate).toBe('function');
  });
});
