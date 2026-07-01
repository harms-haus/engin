// ─── Tests for core/git.ts — async conversion contract ─────────────────────
//
// TARGET BEHAVIOR (RED for the current synchronous implementation):
//
// The internal `execGit` helper has been converted from a blocking
// `Bun.spawnSync` to an async `Bun.spawn` (awaited `.exited`, stdout/stderr
// drained via `new Response(proc.stdout).text()` / `.stderr`). Consequently
// EVERY exported function that shells out to git is now `async` and returns a
// `Promise` of its former synchronous value. `sanitizeBranchSlug` performs no
// git work, so it remains synchronous (returns a plain string).
//
// Each test asserts BOTH the async SIGNATURE (the return value is a Promise —
// `toBeInstanceOf(Promise)`) and the PRESERVED observable behavior (awaiting
// yields the same value/effect as before). The signature assertion is what
// drives the conversion: it FAILS on the current synchronous code (which
// returns plain booleans/strings/void) and PASSES once the functions are made
// async. `sanitizeBranchSlug` is asserted to NOT return a Promise.
//
// Approach: uses a REAL temp git repo (via `git init`) so every function
// actually invokes git — verifying real-world behavior end-to-end with no
// mocking of execGit.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  abortMerge,
  checkoutBranch,
  cleanUntracked,
  commitChanges,
  createWorktree,
  deleteBranchForce,
  getCurrentBranch,
  getDiff,
  getMainBranch,
  getRepoRoot,
  isGitRepo,
  listConflictedFiles,
  mergeBranch,
  pushBranch,
  removeWorktree,
  resetHard,
  restoreSavedBranch,
  sanitizeBranchSlug,
  squashMergeBranch,
  stageAll,
  stageFiles,
  worktreePrune,
} from './git.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let repoDir: string;

/**
 * Run a raw git command in `cwd`; throws on non-zero exit. Returns trimmed
 * stdout. Used purely for fixture setup/verification (NOT the function under
 * test).
 */
function git(args: string[], cwd: string = repoDir): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args.join(' ')} failed (exit ${result.exitCode}) in ${cwd}: ${stderr}`);
  }
  return stdout;
}

/** Run a raw git command that is EXPECTED to fail; returns the exit code. */
function gitAllowFail(args: string[], cwd: string = repoDir): number {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode;
}

/**
 * Creates a temp git repo with an initial commit on `main` (local git identity
 * configured). Returns the repo path and sets `repoDir`.
 */
function createTempGitRepo(defaultBranch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'engin-git-async-'));
  git(['init', '-q', '-b', defaultBranch], dir);
  git(['config', 'user.email', 'engin-test@example.com'], dir);
  git(['config', 'user.name', 'Engin Test'], dir);
  writeFileSync(join(dir, 'README.md'), '# init\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  repoDir = dir;
  return dir;
}

/** Create a REGULAR merge that conflicts on `file`, leaving it unmerged. */
function seedConflict(file: string): void {
  git(['checkout', '-b', 'side'], repoDir);
  writeFileSync(join(repoDir, file), 'side\n');
  git(['add', '-A'], repoDir);
  git(['commit', '-q', '-m', 'side'], repoDir);
  git(['checkout', '-q', 'main'], repoDir);
  writeFileSync(join(repoDir, file), 'main\n');
  git(['add', '-A'], repoDir);
  git(['commit', '-q', '-m', 'main'], repoDir);
  gitAllowFail(['merge', 'side'], repoDir);
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

// ═══════════════════════════════════════════════════════════════════════════════
// Each function: assert it returns a Promise (drives the async conversion) AND
// that awaiting it preserves the prior behavior. The first `expect(...).
// toBeInstanceOf(Promise)` is the RED assertion that fails on today's sync code.
// ═══════════════════════════════════════════════════════════════════════════════

describe('isGitRepo', () => {
  it('returns a Promise that resolves to true inside a git repo', async () => {
    const result = isGitRepo(repoDir);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(true);
  });

  it('returns a Promise that resolves to false in a plain directory', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'engin-git-async-plain-'));
    try {
      const result = isGitRepo(plain);
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('returns a Promise that resolves to false (swallows the error) for a missing dir', async () => {
    const result = isGitRepo('/no/such/dir/ever');
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(false);
  });
});

describe('getRepoRoot', () => {
  it('returns a Promise resolving to the repo top-level directory', async () => {
    const result = getRepoRoot(repoDir);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(repoDir);
  });
});

describe('getCurrentBranch', () => {
  it('returns a Promise resolving to the checked-out branch name', async () => {
    const result = getCurrentBranch(repoDir);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe('main');
  });
});

describe('getMainBranch', () => {
  it('returns a Promise resolving to "main" when a main branch exists', async () => {
    const result = getMainBranch(repoDir);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe('main');
  });

  it('returns a Promise resolving to "master" when the default branch is master', async () => {
    const masterRepo = mkdtempSync(join(tmpdir(), 'engin-git-async-master-'));
    try {
      git(['init', '-q', '-b', 'master'], masterRepo);
      git(['config', 'user.email', 'engin-test@example.com'], masterRepo);
      git(['config', 'user.name', 'Engin Test'], masterRepo);
      writeFileSync(join(masterRepo, 'README.md'), 'm\n');
      git(['add', '-A'], masterRepo);
      git(['commit', '-q', '-m', 'init'], masterRepo);
      const result = getMainBranch(masterRepo);
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBe('master');
    } finally {
      rmSync(masterRepo, { recursive: true, force: true });
    }
  });

  it('falls back to "main" when neither main nor master exists', async () => {
    git(['branch', '-m', 'weird'], repoDir); // rename current branch away
    const result = getMainBranch(repoDir);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe('main');
  });
});

describe('createWorktree / removeWorktree', () => {
  it('createWorktree returns a Promise and creates the worktree on disk', async () => {
    const wtPath = join(repoDir, 'wt-async');
    const p = createWorktree(repoDir, 'wt-async-branch', wtPath);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(existsSync(wtPath)).toBe(true);
    expect(git(['branch', '--list', 'wt-async-branch'])).toContain('wt-async-branch');
  });

  it('removeWorktree returns a Promise and removes the worktree', async () => {
    const wtPath = join(repoDir, 'wt-rm');
    git(['worktree', 'add', '-b', 'wt-rm-branch', wtPath], repoDir);
    const p = removeWorktree(repoDir, wtPath);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(existsSync(wtPath)).toBe(false);
  });
});

describe('listConflictedFiles', () => {
  it('returns a Promise resolving to [] when there are no conflicts', async () => {
    const result = listConflictedFiles(repoDir);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual([]);
  });

  it('returns a Promise resolving to the conflicted files after a failed merge', async () => {
    seedConflict('f.txt');
    const result = listConflictedFiles(repoDir);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual(['f.txt']);
  });
});

describe('stageAll / commitChanges', () => {
  it('stageAll returns a Promise and stages a new file', async () => {
    writeFileSync(join(repoDir, 'new.txt'), 'hi');
    const p = stageAll(repoDir);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(git(['diff', '--cached', '--name-only'])).toContain('new.txt');
  });

  it('commitChanges returns a Promise and commits staged changes', async () => {
    writeFileSync(join(repoDir, 'new.txt'), 'hi');
    git(['add', '-A'], repoDir);
    const p = commitChanges(repoDir, 'add new file');
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(git(['log', '--oneline', '-1'], repoDir)).toContain('add new file');
  });
});

describe('checkoutBranch', () => {
  it('returns a Promise and switches to an existing branch', async () => {
    git(['branch', 'other'], repoDir);
    const p = checkoutBranch(repoDir, 'other');
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('other');
  });
});

describe('restoreSavedBranch', () => {
  it('returns a Promise and checks out the given branch when it exists', async () => {
    git(['branch', 'feature'], repoDir);
    const p = restoreSavedBranch(repoDir, 'feature');
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBeUndefined();
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature');
  });

  it('returns a Promise that resolves (swallows error) for a non-existent branch', async () => {
    const p = restoreSavedBranch(repoDir, 'no-such-branch-xyz');
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBeUndefined();
    // The current branch is left unchanged.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('is exported as a function', () => {
    expect(typeof restoreSavedBranch).toBe('function');
  });
});

describe('mergeBranch', () => {
  it('returns a Promise resolving to { success: true } on a clean merge', async () => {
    git(['checkout', '-b', 'feature'], repoDir);
    writeFileSync(join(repoDir, 'feature.txt'), 'f\n');
    git(['add', '-A'], repoDir);
    git(['commit', '-q', '-m', 'feature'], repoDir);
    git(['checkout', '-q', 'main'], repoDir);

    const result = mergeBranch(repoDir, 'feature');
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({ success: true });
  });

  it('returns a Promise resolving to { success: false, conflicts } on conflict', async () => {
    seedConflict('c.txt');
    // seedConflict leaves a conflict in progress; mergeBranch will attempt the
    // merge again (already conflicted) and surface the conflicts.
    const result = mergeBranch(repoDir, 'side');
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(resolved.success).toBe(false);
    if (!resolved.success) {
      expect(resolved.conflicts).toContain('c.txt');
    }
  });
});

describe('abortMerge', () => {
  it('returns a Promise and clears an in-progress merge conflict state', async () => {
    seedConflict('a.txt');
    expect(git(['diff', '--name-only', '--diff-filter=U'])).toContain('a.txt');

    const p = abortMerge(repoDir);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(git(['diff', '--name-only', '--diff-filter=U'])).toBe('');
  });
});

describe('resetHard', () => {
  it('returns a Promise and discards tracked modifications back to HEAD', async () => {
    writeFileSync(join(repoDir, 'README.md'), 'dirty\n');
    expect(git(['status', '--porcelain'])).toContain('README.md');

    const p = resetHard(repoDir);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(git(['status', '--porcelain'])).toBe('');
  });
});

describe('cleanUntracked', () => {
  it('returns a Promise and removes untracked files', async () => {
    writeFileSync(join(repoDir, 'scratch.txt'), 'x');
    const p = cleanUntracked(repoDir);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(existsSync(join(repoDir, 'scratch.txt'))).toBe(false);
  });
});

describe('pushBranch', () => {
  it('returns a Promise that rejects when no remote is configured', async () => {
    // pushBranch performs real git work (no remote → failure). The async
    // version must return a REJECTING Promise. We guard the call so a
    // synchronous throw (today) produces a clean assertion failure rather than
    // an uncaught error.
    let result: unknown = undefined;
    try {
      result = pushBranch(repoDir, 'main');
    } catch {
      // sync implementation throws before returning — fall through so the
      // toBeInstanceOf assertion fails clearly.
    }
    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<unknown>).rejects.toThrow();
  });
});

describe('getDiff', () => {
  it('returns a Promise resolving to "" when the tree is clean', async () => {
    const result = getDiff(repoDir);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe('');
  });

  it('returns a Promise resolving to the diff text for unstaged modifications', async () => {
    writeFileSync(join(repoDir, 'README.md'), 'modified\n');
    const result = getDiff(repoDir);
    expect(result).toBeInstanceOf(Promise);
    const diff = await result;
    expect(diff).toContain('modified');
  });
});

describe('worktreePrune', () => {
  it('returns a Promise and sweeps orphaned worktree metadata', async () => {
    const wtPath = join(repoDir, '..', `wt-prune-${Date.now()}`);
    git(['worktree', 'add', '-b', 'prune-branch', wtPath], repoDir);
    rmSync(wtPath, { recursive: true, force: true });
    expect(git(['worktree', 'list'])).toContain('prune-branch');

    const p = worktreePrune(repoDir);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(git(['worktree', 'list'])).not.toContain('prune-branch');
  });
});

describe('squashMergeBranch', () => {
  it('returns a Promise resolving to { success: true } on a clean squash merge', async () => {
    git(['checkout', '-b', 'feature'], repoDir);
    writeFileSync(join(repoDir, 'feature.txt'), 'f\n');
    git(['add', '-A'], repoDir);
    git(['commit', '-q', '-m', 'feature'], repoDir);
    git(['checkout', '-q', 'main'], repoDir);

    const result = squashMergeBranch(repoDir, 'feature');
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({ success: true });
  });

  it('stages but does NOT auto-commit after a successful squash', async () => {
    git(['checkout', '-b', 'feature'], repoDir);
    writeFileSync(join(repoDir, 'feature.txt'), 'f\n');
    git(['add', '-A'], repoDir);
    git(['commit', '-q', '-m', 'feature'], repoDir);
    git(['checkout', '-q', 'main'], repoDir);

    const p = squashMergeBranch(repoDir, 'feature');
    expect(p).toBeInstanceOf(Promise);
    await p;

    expect(git(['diff', '--cached', '--name-only'])).toContain('feature.txt');
    // Only the initial commit exists — no squash commit was auto-created.
    expect(git(['log', '--oneline'])).not.toContain('feature');
  });

  it('returns a Promise resolving to { success: false, conflicts } on conflict', async () => {
    seedConflict('q.txt');
    const result = squashMergeBranch(repoDir, 'side');
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(resolved.success).toBe(false);
    if (!resolved.success) {
      expect(resolved.conflicts).toContain('q.txt');
    }
  });
});

describe('stageFiles', () => {
  it('returns a Promise and stages only the listed files', async () => {
    writeFileSync(join(repoDir, 'keep.txt'), 'k');
    writeFileSync(join(repoDir, 'skip.txt'), 's');

    const p = stageFiles(repoDir, ['keep.txt']);
    expect(p).toBeInstanceOf(Promise);
    await p;

    expect(git(['diff', '--cached', '--name-only'])).toContain('keep.txt');
    expect(git(['diff', '--cached', '--name-only'])).not.toContain('skip.txt');
  });

  it('returns a Promise and is a no-op for an empty files list', async () => {
    const p = stageFiles(repoDir, []);
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBeUndefined();
  });
});

describe('deleteBranchForce', () => {
  it('returns a Promise and force-deletes a branch with unmerged commits', async () => {
    git(['checkout', '-b', 'feature'], repoDir);
    writeFileSync(join(repoDir, 'feature.txt'), 'f');
    git(['add', '-A'], repoDir);
    git(['commit', '-q', '-m', 'unmerged'], repoDir);
    git(['checkout', '-q', 'main'], repoDir);

    const p = deleteBranchForce(repoDir, 'feature');
    expect(p).toBeInstanceOf(Promise);
    await p;

    expect(git(['branch', '--list'])).not.toContain('feature');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error-path contract — a failing git invocation must now REJECT the returned
// Promise (formerly it threw synchronously). `await expect(fn()).rejects.
// toThrow()` FAILS on today's sync code (the function throws before expect can
// wrap the value) and PASSES once the function is async.
// ═══════════════════════════════════════════════════════════════════════════════

describe('error paths — failures reject the returned Promise', () => {
  it('checkoutBranch rejects when the branch does not exist', async () => {
    await expect(checkoutBranch(repoDir, 'nonexistent')).rejects.toThrow();
  });

  it('getRepoRoot rejects when not inside a git repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'engin-git-async-nogit-'));
    try {
      await expect(getRepoRoot(plain)).rejects.toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('createWorktree rejects when the target path already exists', async () => {
    const wtPath = join(repoDir, 'wt-dup');
    await createWorktree(repoDir, 'first', wtPath);
    // A second worktree at the same path must reject.
    await expect(createWorktree(repoDir, 'second', wtPath)).rejects.toThrow();
  });

  it('deleteBranchForce rejects when the branch does not exist', async () => {
    await expect(deleteBranchForce(repoDir, 'no-such-branch')).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sanitizeBranchSlug — must remain SYNCHRONOUS (no git work). It must NOT
// return a Promise.
// ═══════════════════════════════════════════════════════════════════════════════

describe('sanitizeBranchSlug (stays synchronous)', () => {
  it('returns a plain string synchronously (not a Promise)', () => {
    const result = sanitizeBranchSlug('Feature: Add Login');
    expect(typeof result).toBe('string');
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toBe('feature-add-login');
  });

  it('falls back to a timestamped slug synchronously for empty input', () => {
    const result = sanitizeBranchSlug('');
    expect(typeof result).toBe('string');
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatch(/^engin-worktree-\d+$/);
  });

  it('lowercases, collapses dashes, and trims (full behavior preserved)', () => {
    expect(sanitizeBranchSlug('fix/bug #123')).toBe('fix-bug-123');
    expect(sanitizeBranchSlug('a---b')).toBe('a-b');
    expect(sanitizeBranchSlug('---leading')).toBe('leading');
  });
});
