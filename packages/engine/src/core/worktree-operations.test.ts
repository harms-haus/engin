// ─── Tests for worktree-operations.ts ──────────────────────────────────────
//
// Unit tests for the two exported functions of this module:
//   1. `commitWorktreeChanges` — verifies its clean-tree no-op behavior
//      (stage-all then early return when the diff is empty, with no commit
//      message generated and no commit made).
//   2. `createLintValidationGate` — export smoke test confirming the function
//      remains importable.

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real modules before mocking ──────────────────────────────────

const realGit = Object.assign({}, await import('./git.js'));
const realWorktreeFixup = Object.assign({}, await import('./worktree-fixup.js'));
const realWorktreeLifecycle = Object.assign({}, await import('./worktree-lifecycle.js'));

// ─── Mock functions ─────────────────────────────────────────────────────────

const mockStageAll = mock((_dir: string): void => {});
const mockGetDiff = mock((_dir: string): string => '');
const mockCommitChanges = mock((_dir: string, _message: string): void => {});
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
});
