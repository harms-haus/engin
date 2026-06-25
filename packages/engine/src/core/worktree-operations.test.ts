// ─── Tests for worktree-operations.ts — unaffected by restoreSavedBranch removal ──
//
// Characterization tests verifying that deleting the dead `restoreSavedBranch`
// helper from this module (consolidated into git.ts) does not change its
// observable behavior. `restoreSavedBranch` was private dead code whose only
// caller (`mergeWorktreeToMain`) was already removed by task-3.
//
// These tests verify:
//   1. The module's two exported functions (`commitWorktreeChanges`,
//      `createLintValidationGate`) remain importable and functional.
//   2. `commitWorktreeChanges` does NOT call `checkoutBranch` — that primitive
//      was only consumed by the now-deleted `restoreSavedBranch`, so no code
//      path in this module should trigger it.
//   3. `commitWorktreeChanges` is a no-op when there are no changes (clean tree).

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real modules before mocking ──────────────────────────────────

const realGit = Object.assign({}, await import('./git.js'));
const realWorktreeFixup = Object.assign({}, await import('./worktree-fixup.js'));
const realWorktreeLifecycle = Object.assign({}, await import('./worktree-lifecycle.js'));

// ─── Mock functions ─────────────────────────────────────────────────────────

const mockStageAll = mock((_dir: string): void => {});
const mockGetDiff = mock((_dir: string): string => '');
const mockCommitChanges = mock((_dir: string, _message: string): void => {});
const mockCheckoutBranch = mock((_repoRoot: string, _branch: string): void => {});
const mockGenerateCommitMessage = mock(async (): Promise<string> => 'chore: update');
const mockRunTooledFixup = mock(
  async (): Promise<{ success: boolean; attempts: number; lastError?: string }> => ({
    success: true,
    attempts: 1,
  }),
);

// ─── Mock modules ──────────────────────────────────────────────────────────

mock.module('./git.js', () => ({
  ...realGit,
  stageAll: mockStageAll,
  getDiff: mockGetDiff,
  commitChanges: mockCommitChanges,
  checkoutBranch: mockCheckoutBranch,
}));

mock.module('./worktree-lifecycle.js', () => ({
  ...realWorktreeLifecycle,
  generateCommitMessage: mockGenerateCommitMessage,
}));

mock.module('./worktree-fixup.js', () => ({
  ...realWorktreeFixup,
  runTooledFixup: mockRunTooledFixup,
}));

// ─── Import SUT after mocks ─────────────────────────────────────────────────

import * as WorktreeOperations from './worktree-operations.js';

// ─── Restore original modules ──────────────────────────────────────────────

afterAll(() => {
  mock.module('./git.js', () => realGit);
  mock.module('./worktree-lifecycle.js', () => realWorktreeLifecycle);
  mock.module('./worktree-fixup.js', () => realWorktreeFixup);
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockStageAll.mockReset();
  mockGetDiff.mockReset();
  mockCommitChanges.mockReset();
  mockCheckoutBranch.mockReset();
  mockGenerateCommitMessage.mockReset();
  mockRunTooledFixup.mockReset();
});

// ─── Tests: module exports ──────────────────────────────────────────────────

describe('worktree-operations module exports', () => {
  it('exports commitWorktreeChanges', () => {
    expect(typeof WorktreeOperations.commitWorktreeChanges).toBe('function');
  });

  it('exports createLintValidationGate', () => {
    expect(typeof WorktreeOperations.createLintValidationGate).toBe('function');
  });
});

// ─── Tests: commitWorktreeChanges — clean-tree no-op ───────────────────────

describe('commitWorktreeChanges — clean tree (no-op)', () => {
  it('stages all then returns early when diff is empty', async () => {
    mockGetDiff.mockReturnValue('');

    await WorktreeOperations.commitWorktreeChanges({
      profilesDirs: ['/profiles'],
      worktreePath: '/worktree',
      taskPrompt: 'Do things',
    });

    // stageAll is called unconditionally (even for untracked-only changes).
    expect(mockStageAll).toHaveBeenCalledWith('/worktree');
    // No commit message generated, no commit made.
    expect(mockGenerateCommitMessage).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('does NOT invoke checkoutBranch (restoreSavedBranch was the only caller)', async () => {
    // restoreSavedBranch — the ONLY consumer of checkoutBranch in this module —
    // is being deleted as dead code. No code path in commitWorktreeChanges
    // should ever call checkoutBranch. This test would FAIL if a future change
    // accidentally wired branch switching into the commit flow.
    mockGetDiff.mockReturnValue('some diff');
    mockGenerateCommitMessage.mockResolvedValue('msg');

    await WorktreeOperations.commitWorktreeChanges({
      profilesDirs: ['/profiles'],
      worktreePath: '/worktree',
      taskPrompt: 'Do things',
    });

    // checkoutBranch was imported solely for the dead restoreSavedBranch.
    // It must never be called by the live code.
    expect(mockCheckoutBranch).not.toHaveBeenCalled();
  });
});
