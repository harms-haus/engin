// ─── Tests for core/git.ts — restoreSavedBranch ─────────────────────────────
//
// Direct unit tests for `restoreSavedBranch`, the helper that wraps
// `checkoutBranch` with error-swallowing semantics (detached-HEAD tolerance).
// After the consolidation refactor this function lives in git.ts and is
// imported by worktree-manager.ts. These tests pin its contract at the
// function level so regressions are caught regardless of callers.
//
// Approach: uses a REAL temp git repo (via `git init`) so that checkoutBranch
// actually invokes git — no mocking of execGit needed. This verifies the
// real-world behavior: a valid branch is restored, and a non-existent branch
// (simulating detached HEAD where the symbolic ref is gone) does NOT throw.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkoutBranch, getCurrentBranch, restoreSavedBranch } from './git.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let repoDir: string;

function git(args: string[]): void {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: repoDir, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

/**
 * Creates a temp git repo with an initial commit on `main` and an additional
 * branch `feature` pointing at the same commit. Returns the repo path.
 */
function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engin-git-test-'));
  const cmds: string[][] = [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'engin-test@example.com'],
    ['config', 'user.name', 'Engin Test'],
    ['commit', '-q', '--allow-empty', '-m', 'init'],
    ['branch', 'feature'],
  ];
  repoDir = dir;
  for (const cmd of cmds) {
    git(cmd);
  }
  return dir;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeEach(() => {
  createTempGitRepo();
});

afterEach(() => {
  if (repoDir && existsSync(repoDir)) {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ─── checkoutBranch (baseline — restoreSavedBranch wraps this) ──────────────

describe('checkoutBranch (primitive used by restoreSavedBranch)', () => {
  it('switches to the named branch', () => {
    expect(getCurrentBranch(repoDir)).toBe('main');
    checkoutBranch(repoDir, 'feature');
    expect(getCurrentBranch(repoDir)).toBe('feature');
  });

  it('throws when the branch does not exist', () => {
    expect(() => checkoutBranch(repoDir, 'nonexistent')).toThrow();
  });
});

// ─── restoreSavedBranch ─────────────────────────────────────────────────────

describe('restoreSavedBranch', () => {
  it('checks out the given branch when it exists', () => {
    expect(getCurrentBranch(repoDir)).toBe('main');

    restoreSavedBranch(repoDir, 'feature');

    expect(getCurrentBranch(repoDir)).toBe('feature');
  });

  it('does NOT throw when the branch does not exist (swallows error)', () => {
    // A non-existent branch simulates the detached-HEAD scenario where the
    // symbolic ref is gone. restoreSavedBranch must swallow the checkout error.
    expect(() => {
      restoreSavedBranch(repoDir, 'nonexistent-branch-xyz');
    }).not.toThrow();
  });

  it('leaves the current branch unchanged when checkout fails', () => {
    expect(getCurrentBranch(repoDir)).toBe('main');

    restoreSavedBranch(repoDir, 'nonexistent-branch-xyz');

    // The current branch must still be main (the failed checkout changed nothing).
    expect(getCurrentBranch(repoDir)).toBe('main');
  });

  it('is exported from git.ts', () => {
    expect(typeof restoreSavedBranch).toBe('function');
  });

  it('returns undefined on the success path (void contract)', () => {
    // restoreSavedBranch is a fire-and-forget helper; callers must not rely on
    // a meaningful return value.
    expect(restoreSavedBranch(repoDir, 'feature')).toBeUndefined();
  });

  it('returns undefined on the failure path (void contract)', () => {
    expect(restoreSavedBranch(repoDir, 'nonexistent-branch-xyz')).toBeUndefined();
  });

  it('is a no-op that does not throw when restoring the already-current branch', () => {
    expect(getCurrentBranch(repoDir)).toBe('main');

    expect(() => restoreSavedBranch(repoDir, 'main')).not.toThrow();

    expect(getCurrentBranch(repoDir)).toBe('main');
  });
});
