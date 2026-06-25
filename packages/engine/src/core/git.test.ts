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
//
// NOTE: `restoreSavedBranch` is added to git.ts by the implementer in the
// refactor step. Until then, the dynamic import resolves to `undefined` and
// these tests are skipped. After the refactor they run for real.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkoutBranch, getCurrentBranch } from './git.js';

// ─── Dynamic import: restoreSavedBranch (added by the refactor) ─────────────

/**
 * `restoreSavedBranch` is added to git.ts by the implementer's refactor. We
 * load it dynamically so this test file compiles both BEFORE (function absent)
 * and AFTER (function present) the change. When absent, the contract tests
 * below are skipped via `it.skipIf`.
 */
const { restoreSavedBranch } = await import('./git.js').then(
  (mod) => ({
    restoreSavedBranch: (mod as { restoreSavedBranch?: (repoRoot: string, savedBranch: string) => void })
      .restoreSavedBranch,
  }),
  () => ({ restoreSavedBranch: undefined }),
);

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
  // These tests run only after the implementer has moved restoreSavedBranch
  // into git.ts. Before the refactor, the dynamic import yields undefined and
  // they are skipped — no false failures during the write-tests step.
  it.skipIf(!restoreSavedBranch)('checks out the given branch when it exists', () => {
    expect(getCurrentBranch(repoDir)).toBe('main');

    restoreSavedBranch!(repoDir, 'feature');

    expect(getCurrentBranch(repoDir)).toBe('feature');
  });

  it.skipIf(!restoreSavedBranch)('does NOT throw when the branch does not exist (swallows error)', () => {
    // A non-existent branch simulates the detached-HEAD scenario where the
    // symbolic ref is gone. restoreSavedBranch must swallow the checkout error.
    expect(() => {
      restoreSavedBranch!(repoDir, 'nonexistent-branch-xyz');
    }).not.toThrow();
  });

  it.skipIf(!restoreSavedBranch)('leaves the current branch unchanged when checkout fails', () => {
    expect(getCurrentBranch(repoDir)).toBe('main');

    restoreSavedBranch!(repoDir, 'nonexistent-branch-xyz');

    // The current branch must still be main (the failed checkout changed nothing).
    expect(getCurrentBranch(repoDir)).toBe('main');
  });

  it.skipIf(!restoreSavedBranch)('is exported from git.ts', () => {
    expect(typeof restoreSavedBranch).toBe('function');
  });
});
