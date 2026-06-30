// ─── Tests for core/git.ts — async conversion ──────────────────────────────
//
// Every exported function that shells out to git has been converted from a
// blocking synchronous implementation to an `async` one returning a `Promise`
// (the internal `execGit` now uses `Bun.spawn` + awaited `.exited` with stdout/
// stderr drained via `new Response(proc.stdout).text()`). `sanitizeBranchSlug`
// performs no git work and stays synchronous.
//
// Each test below uses `await expect(fn(...)).resolves.toBe(...)` /
// `.rejects.toThrow()` — bun's `.resolves`/`.rejects` matchers REQUIRE a real
// Promise, so these assertions FAIL on the current synchronous implementation
// (which returns plain booleans/strings/void, or throws synchronously) and
// PASS once the functions are made async. This drives + verifies the
// conversion while pinning the full observable behavior via real temp git
// repos (no mocking of execGit).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
} from '../../packages/engine/src/core/git.js';
import {
  createSymlinkWithRetry,
  populateWorktree,
  readWorktreeCopyEntries,
  type WorktreeCopyEntry,
} from '../../packages/engine/src/core/worktree-populate.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a fresh temp directory for a test, cleaned up in afterEach. */
function useTempDir(): { getDir: () => string } {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { getDir: () => dir };
}

/**
 * Initialise a real git repo in `dir` with one initial commit.
 * Optionally set the default branch name.
 */
function initRepo(dir: string, defaultBranch = 'main'): void {
  const r = (args: string[]) => {
    const result = Bun.spawnSync(args, {
      cwd: dir,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    if (result.exitCode !== 0) {
      throw new Error(`git init command failed: ${args.join(' ')}\nstderr: ${new TextDecoder().decode(result.stderr)}`);
    }
  };

  // git init with explicit branch name
  Bun.spawnSync(['git', 'init', '-b', defaultBranch], {
    cwd: dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });

  // Configure local user so commits work
  r(['git', 'config', 'user.email', 'test@test.com']);
  r(['git', 'config', 'user.name', 'Test']);

  // Create an initial file and commit so HEAD exists
  writeFileSync(join(dir, 'README.md'), '# test\n');
  r(['git', 'add', '-A']);
  r(['git', 'commit', '-m', 'initial commit']);
}

/** Run a raw git command in `cwd`, throw on failure. */
function rawGit(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`rawGit failed: git ${args.join(' ')}\n${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Async-signature contract — every git-touching function returns a Promise;
// sanitizeBranchSlug does NOT.
// ═══════════════════════════════════════════════════════════════════════════════

describe('async signature — git functions return Promises', () => {
  const { getDir } = useTempDir();

  it('isGitRepo returns a Promise', () => {
    expect(isGitRepo(getDir())).toBeInstanceOf(Promise);
  });
  it('getRepoRoot returns a Promise', () => {
    initRepo(getDir());
    expect(getRepoRoot(getDir())).toBeInstanceOf(Promise);
  });
  it('getCurrentBranch returns a Promise', () => {
    initRepo(getDir());
    expect(getCurrentBranch(getDir())).toBeInstanceOf(Promise);
  });
  it('getMainBranch returns a Promise', () => {
    initRepo(getDir());
    expect(getMainBranch(getDir())).toBeInstanceOf(Promise);
  });
  it('createWorktree returns a Promise', () => {
    const dir = getDir();
    initRepo(dir);
    expect(createWorktree(dir, 'b', join(dir, 'wt'))).toBeInstanceOf(Promise);
  });
  it('removeWorktree returns a Promise', () => {
    const dir = getDir();
    initRepo(dir);
    rawGit(['worktree', 'add', '-b', 'b', join(dir, 'wt')], dir);
    expect(removeWorktree(dir, join(dir, 'wt'))).toBeInstanceOf(Promise);
  });
  it('listConflictedFiles returns a Promise', () => {
    initRepo(getDir());
    expect(listConflictedFiles(getDir())).toBeInstanceOf(Promise);
  });
  it('stageAll returns a Promise', () => {
    initRepo(getDir());
    expect(stageAll(getDir())).toBeInstanceOf(Promise);
  });
  it('commitChanges returns a Promise', () => {
    const dir = getDir();
    initRepo(dir);
    writeFileSync(join(dir, 'x.txt'), 'x');
    rawGit(['add', '-A'], dir);
    expect(commitChanges(dir, 'm')).toBeInstanceOf(Promise);
  });
  it('checkoutBranch returns a Promise', () => {
    const dir = getDir();
    initRepo(dir);
    rawGit(['branch', 'b'], dir);
    expect(checkoutBranch(dir, 'b')).toBeInstanceOf(Promise);
  });
  it('restoreSavedBranch returns a Promise', () => {
    initRepo(getDir());
    expect(restoreSavedBranch(getDir(), 'main')).toBeInstanceOf(Promise);
  });
  it('mergeBranch returns a Promise', () => {
    initRepo(getDir());
    expect(mergeBranch(getDir(), 'main')).toBeInstanceOf(Promise);
  });
  it('abortMerge returns a Promise', () => {
    initRepo(getDir());
    expect(abortMerge(getDir())).toBeInstanceOf(Promise);
  });
  it('resetHard returns a Promise', () => {
    initRepo(getDir());
    expect(resetHard(getDir())).toBeInstanceOf(Promise);
  });
  it('cleanUntracked returns a Promise', () => {
    initRepo(getDir());
    expect(cleanUntracked(getDir())).toBeInstanceOf(Promise);
  });
  it('getDiff returns a Promise', () => {
    initRepo(getDir());
    expect(getDiff(getDir())).toBeInstanceOf(Promise);
  });
  it('worktreePrune returns a Promise', () => {
    initRepo(getDir());
    expect(worktreePrune(getDir())).toBeInstanceOf(Promise);
  });
  it('squashMergeBranch returns a Promise', () => {
    initRepo(getDir());
    expect(squashMergeBranch(getDir(), 'main')).toBeInstanceOf(Promise);
  });
  it('stageFiles returns a Promise', () => {
    initRepo(getDir());
    expect(stageFiles(getDir(), ['README.md'])).toBeInstanceOf(Promise);
  });
  it('deleteBranchForce returns a Promise', () => {
    const dir = getDir();
    initRepo(dir);
    rawGit(['branch', 'b'], dir);
    expect(deleteBranchForce(dir, 'b')).toBeInstanceOf(Promise);
  });
  it('pushBranch returns a Promise (rejects without a remote)', async () => {
    initRepo(getDir());
    let result: unknown = undefined;
    try {
      result = pushBranch(getDir(), 'main');
    } catch {
      /* sync impl throws before returning — fall through to fail the assertion */
    }
    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<unknown>).rejects.toThrow();
  });

  it('sanitizeBranchSlug does NOT return a Promise (stays synchronous)', () => {
    const result = sanitizeBranchSlug('Feature Branch!');
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('string');
  });
});

// ─── isGitRepo ──────────────────────────────────────────────────────────────

describe('isGitRepo', () => {
  const { getDir } = useTempDir();

  it('returns a Promise resolving to true inside a git repo', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(isGitRepo(dir)).resolves.toBe(true);
  });

  it('returns a Promise resolving to false in a plain directory (no .git)', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    await expect(isGitRepo(dir)).resolves.toBe(false);
  });

  it('returns a Promise resolving to false for a non-existent directory', async () => {
    await expect(isGitRepo('/no/such/directory/ever')).resolves.toBe(false);
  });
});

// ─── getRepoRoot ────────────────────────────────────────────────────────────

describe('getRepoRoot', () => {
  const { getDir } = useTempDir();

  it('returns a Promise resolving to the top-level repo directory', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(getRepoRoot(dir)).resolves.toBe(dir);
  });

  it('returns parent root when called from a subdirectory', async () => {
    const dir = getDir();
    initRepo(dir);
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });
    await expect(getRepoRoot(sub)).resolves.toBe(dir);
  });

  it('rejects when not inside a git repo', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    await expect(getRepoRoot(dir)).rejects.toThrow();
  });
});

// ─── getCurrentBranch ───────────────────────────────────────────────────────

describe('getCurrentBranch', () => {
  const { getDir } = useTempDir();

  it('returns a Promise resolving to the current branch name', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(getCurrentBranch(dir)).resolves.toBe('main');
  });

  it('reflects a new branch after checkout -b', async () => {
    const dir = getDir();
    initRepo(dir);
    rawGit(['checkout', '-b', 'feature-x'], dir);
    await expect(getCurrentBranch(dir)).resolves.toBe('feature-x');
  });
});

// ─── getMainBranch ──────────────────────────────────────────────────────────

describe('getMainBranch', () => {
  const { getDir } = useTempDir();

  it('returns a Promise resolving to "main" when it is the default', async () => {
    const dir = getDir();
    initRepo(dir, 'main');
    await expect(getMainBranch(dir)).resolves.toBe('main');
  });

  it('returns a Promise resolving to "master" when initialised with master', async () => {
    const dir = getDir();
    initRepo(dir, 'master');
    await expect(getMainBranch(dir)).resolves.toBe('master');
  });

  it('falls back to "main" when no known default branch exists', async () => {
    const dir = getDir();
    initRepo(dir, 'weird-branch');
    rawGit(['branch', '-m', 'weird-branch'], dir);
    await expect(getMainBranch(dir)).resolves.toBe('main');
  });
});

// ─── createWorktree / removeWorktree ────────────────────────────────────────

describe('createWorktree and removeWorktree', () => {
  const { getDir } = useTempDir();

  it('creates a worktree and then removes it', async () => {
    const dir = getDir();
    initRepo(dir);
    const wtPath = join(dir, 'wt-test');

    await createWorktree(dir, 'wt-branch', wtPath);

    expect(existsSync(wtPath)).toBe(true);
    const branches = rawGit(['branch', '--list', 'wt-branch'], dir);
    expect(branches).toContain('wt-branch');

    await removeWorktree(dir, wtPath);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('rejects when creating a worktree that already exists', async () => {
    const dir = getDir();
    initRepo(dir);
    const wtPath = join(dir, 'wt-dup');
    await createWorktree(dir, 'wt-dup-branch', wtPath);
    await expect(createWorktree(dir, 'wt-dup-branch2', wtPath)).rejects.toThrow();
  });
});

// ─── listConflictedFiles ────────────────────────────────────────────────────

describe('listConflictedFiles', () => {
  const { getDir } = useTempDir();

  it('returns a Promise resolving to [] when there are no conflicts', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(listConflictedFiles(dir)).resolves.toEqual([]);
  });

  it('returns a Promise resolving to conflicted files after a failed merge', async () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['checkout', '-b', 'a'], dir);
    writeFileSync(join(dir, 'file.txt'), 'from-a\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'commit on a'], dir);

    rawGit(['checkout', 'main'], dir);
    writeFileSync(join(dir, 'file.txt'), 'from-main\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'commit on main'], dir);

    const result = Bun.spawnSync(['git', 'merge', 'a'], {
      cwd: dir,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(result.exitCode).not.toBe(0);

    await expect(listConflictedFiles(dir)).resolves.toContain('file.txt');
  });
});

// ─── stageAll / commitChanges ───────────────────────────────────────────────

describe('stageAll and commitChanges', () => {
  const { getDir } = useTempDir();

  it('stages a new file and commits it', async () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'new-file.txt'), 'hello');
    await stageAll(dir);
    await commitChanges(dir, 'add new file');

    const log = rawGit(['log', '--oneline', '-1'], dir);
    expect(log).toContain('add new file');
  });

  it('stages modifications and commits', async () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'README.md'), 'updated content');
    await stageAll(dir);
    await commitChanges(dir, 'update readme');

    const log = rawGit(['log', '--oneline', '-1'], dir);
    expect(log).toContain('update readme');
  });
});

// ─── checkoutBranch ─────────────────────────────────────────────────────────

describe('checkoutBranch', () => {
  const { getDir } = useTempDir();

  it('switches to an existing branch', async () => {
    const dir = getDir();
    initRepo(dir);
    rawGit(['branch', 'other'], dir);

    await checkoutBranch(dir, 'other');
    await expect(getCurrentBranch(dir)).resolves.toBe('other');
  });

  it('rejects when branch does not exist', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(checkoutBranch(dir, 'nonexistent')).rejects.toThrow();
  });
});

// ─── restoreSavedBranch ───────────────────────────────────────────────────

describe('restoreSavedBranch', () => {
  const { getDir } = useTempDir();

  it('switches to an existing branch (happy path)', async () => {
    const dir = getDir();
    initRepo(dir);
    rawGit(['checkout', '-b', 'feature-a'], dir);

    await restoreSavedBranch(dir, 'feature-a');
    await expect(getCurrentBranch(dir)).resolves.toBe('feature-a');
  });

  it('swallows errors when the branch does not exist (detached-HEAD contract)', async () => {
    const dir = getDir();
    initRepo(dir);
    // restoreSavedBranch must resolve (not reject) for a non-existent branch.
    await expect(restoreSavedBranch(dir, 'nonexistent')).resolves.toBeDefined();
  });

  it('is a no-op when called with the already-checked-out branch', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(restoreSavedBranch(dir, 'main')).resolves.toBeDefined();
    await expect(getCurrentBranch(dir)).resolves.toBe('main');
  });
});

// ─── mergeBranch ────────────────────────────────────────────────────────────

describe('mergeBranch', () => {
  const { getDir } = useTempDir();

  it('returns a Promise resolving to { success: true } on clean merge', async () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['checkout', '-b', 'feature'], dir);
    writeFileSync(join(dir, 'feature.txt'), 'feature content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'feature commit'], dir);

    rawGit(['checkout', 'main'], dir);
    await expect(mergeBranch(dir, 'feature')).resolves.toEqual({ success: true });
  });

  it('returns a Promise resolving to { success: false, conflicts } on merge conflict', async () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['checkout', '-b', 'a'], dir);
    writeFileSync(join(dir, 'conflict.txt'), 'from-a\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'commit a'], dir);

    rawGit(['checkout', 'main'], dir);
    writeFileSync(join(dir, 'conflict.txt'), 'from-main\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'commit main'], dir);

    const result = await mergeBranch(dir, 'a');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.conflicts).toContain('conflict.txt');
    }
  });
});

// ─── abortMerge ─────────────────────────────────────────────────────────────

describe('abortMerge', () => {
  const { getDir } = useTempDir();

  it('cleans up a merge conflict state', async () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['checkout', '-b', 'a'], dir);
    writeFileSync(join(dir, 'abort-test.txt'), 'from-a\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'a'], dir);

    rawGit(['checkout', 'main'], dir);
    writeFileSync(join(dir, 'abort-test.txt'), 'from-main\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'main'], dir);

    Bun.spawnSync(['git', 'merge', 'a'], {
      cwd: dir,
      stderr: 'pipe',
      stdout: 'pipe',
    });

    expect((await listConflictedFiles(dir)).length).toBeGreaterThan(0);

    await abortMerge(dir);
    await expect(listConflictedFiles(dir)).resolves.toEqual([]);
  });
});

// ─── pushBranch ─────────────────────────────────────────────────────────────

describe('pushBranch', () => {
  const { getDir } = useTempDir();

  it('rejects when no remote is configured (expected)', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(pushBranch(dir, 'main')).rejects.toThrow();
  });
});

// ─── getDiff ────────────────────────────────────────────────────────────────

describe('getDiff', () => {
  const { getDir } = useTempDir();

  it('returns a Promise resolving to "" when the working tree is clean', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(getDiff(dir)).resolves.toBe('');
  });

  it('returns the diff for unstaged changes', async () => {
    const dir = getDir();
    initRepo(dir);
    writeFileSync(join(dir, 'README.md'), 'modified content');
    const diff = await getDiff(dir);
    expect(diff).toContain('modified content');
  });

  it('returns the diff for staged changes when no unstaged changes exist', async () => {
    const dir = getDir();
    initRepo(dir);
    writeFileSync(join(dir, 'staged.txt'), 'staged content');
    rawGit(['add', '-A'], dir);
    const diff = await getDiff(dir);
    expect(diff).toContain('staged content');
  });

  it('does not throw when a tracked file named HEAD exists', async () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'HEAD'), 'HEAD file content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'add HEAD file'], dir);

    writeFileSync(join(dir, 'README.md'), 'modified content');

    const diff = await getDiff(dir);
    expect(diff).toContain('modified content');
  });

  it('returns the correct diff when an untracked file named HEAD exists', async () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'HEAD'), 'untracked HEAD content');
    writeFileSync(join(dir, 'README.md'), 'modified content');

    const diff = await getDiff(dir);
    expect(diff).toContain('modified content');
    expect(diff).not.toContain('untracked HEAD content');
  });

  it('shows both staged and unstaged changes when a file named HEAD exists', async () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'HEAD'), 'HEAD file content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'add HEAD file'], dir);

    writeFileSync(join(dir, 'staged.txt'), 'staged content');
    rawGit(['add', '-A'], dir);

    writeFileSync(join(dir, 'README.md'), 'unstaged modified');

    const diff = await getDiff(dir);
    expect(diff).toContain('unstaged modified');
    expect(diff).toContain('staged content');
  });
});

// ─── worktreePrune ──────────────────────────────────────────────────────────

describe('worktreePrune', () => {
  const { getDir } = useTempDir();

  it('runs without error in a real git repo', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(worktreePrune(dir)).resolves.toBeDefined();
  });

  it('removes orphaned worktree metadata after its directory is deleted', async () => {
    const dir = getDir();
    initRepo(dir);

    const wtPath = join(dir, '..', `wt-prune-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await createWorktree(dir, 'prune-branch', wtPath);
    expect(existsSync(wtPath)).toBe(true);

    rmSync(wtPath, { recursive: true, force: true });

    const before = rawGit(['worktree', 'list'], dir);
    expect(before).toContain('prune-branch');

    await worktreePrune(dir);

    const after = rawGit(['worktree', 'list'], dir);
    expect(after).not.toContain('prune-branch');
  });
});

// ─── sanitizeBranchSlug (stays synchronous) ────────────────────────────────

describe('sanitizeBranchSlug', () => {
  it('returns a plain string synchronously (not a Promise)', () => {
    const result = sanitizeBranchSlug('Feature: Add Login');
    expect(typeof result).toBe('string');
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toBe('feature-add-login');
  });

  it('replaces slashes and special characters with dashes', () => {
    expect(sanitizeBranchSlug('fix/bug #123')).toBe('fix-bug-123');
  });

  it('collapses consecutive dashes', () => {
    expect(sanitizeBranchSlug('a---b')).toBe('a-b');
  });

  it('replaces underscores with dashes', () => {
    expect(sanitizeBranchSlug('a___b')).toBe('a-b');
  });

  it('trims leading and trailing dashes', () => {
    expect(sanitizeBranchSlug('---leading')).toBe('leading');
    expect(sanitizeBranchSlug('trailing---')).toBe('trailing');
    expect(sanitizeBranchSlug('-foo-')).toBe('foo');
  });

  it('returns already-clean slugs unchanged', () => {
    expect(sanitizeBranchSlug('my-branch')).toBe('my-branch');
    expect(sanitizeBranchSlug('feature-123')).toBe('feature-123');
  });

  it('lowercases uppercase characters', () => {
    expect(sanitizeBranchSlug('CamelCase')).toBe('camelcase');
    expect(sanitizeBranchSlug('UPPER')).toBe('upper');
  });

  it('strips non-ASCII characters down to dashes', () => {
    expect(sanitizeBranchSlug('caf\u00e9')).toBe('caf');
  });

  it('falls back to engin-worktree-{timestamp} when the result is empty', () => {
    expect(sanitizeBranchSlug('!!!')).toMatch(/^engin-worktree-\d+$/);
  });

  it('falls back to engin-worktree-{timestamp} for an empty string', () => {
    expect(sanitizeBranchSlug('')).toMatch(/^engin-worktree-\d+$/);
  });

  it('falls back to engin-worktree-{timestamp} for a dashes-only string', () => {
    expect(sanitizeBranchSlug('---')).toMatch(/^engin-worktree-\d+$/);
  });

  it('produces a valid fallback slug on each call', () => {
    expect(sanitizeBranchSlug('!!!')).toMatch(/^engin-worktree-\d+$/);
    expect(sanitizeBranchSlug('!!!')).toMatch(/^engin-worktree-\d+$/);
  });
});

// ─── createSymlinkWithRetry ─────────────────────────────────────────────────

describe('createSymlinkWithRetry', () => {
  const { getDir } = useTempDir();

  it('creates a symlink pointing to the target', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const target = join(dir, 'target.txt');
    writeFileSync(target, 'hello');
    const link = join(dir, 'link');

    await createSymlinkWithRetry(target, link);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(link, 'utf-8')).toBe('hello');
  });

  it('is a no-op when the symlink already exists and points to the correct target', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const target = join(dir, 'target.txt');
    writeFileSync(target, 'data');
    const link = join(dir, 'link');

    symlinkSync(target, link);
    const originalIno = lstatSync(link).ino;

    // Should not throw and should leave the existing symlink untouched
    await createSymlinkWithRetry(target, link);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(lstatSync(link).ino).toBe(originalIno);
  });

  it('throws after exhausting retries when a symlink exists pointing elsewhere', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const correctTarget = join(dir, 'correct.txt');
    const wrongTarget = join(dir, 'wrong.txt');
    const link = join(dir, 'link');

    symlinkSync(wrongTarget, link);

    // Because the existing symlink does NOT point to the requested target, the
    // function cannot treat it as a no-op; symlinkSync will fail with EEXIST on
    // every attempt and the function should throw after exhausting retries.
    await expect(createSymlinkWithRetry(correctTarget, link, 2, 5)).rejects.toThrow();
  });

  it('honours a small backoff/retry budget without hanging', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const correctTarget = join(dir, 'correct.txt');
    const wrongTarget = join(dir, 'wrong.txt');
    const link = join(dir, 'link');
    symlinkSync(wrongTarget, link);

    const start = Date.now();
    await expect(createSymlinkWithRetry(correctTarget, link, 1, 10)).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });
});

// ─── readWorktreeCopyEntries ────────────────────────────────────────────────

describe('readWorktreeCopyEntries', () => {
  const { getDir } = useTempDir();

  it('returns an empty array when .worktreecopy does not exist', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    expect(readWorktreeCopyEntries(dir)).toEqual([]);
  });

  it('parses plain patterns as copy-mode, non-negated entries', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.worktreecopy'), 'file1.txt\n*.md\n');
    expect(readWorktreeCopyEntries(dir)).toEqual([
      { pattern: 'file1.txt', mode: 'copy', negated: false },
      { pattern: '*.md', mode: 'copy', negated: false },
    ]);
  });

  it('parses @symlink prefix into symlink-mode entries', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.worktreecopy'), '@symlink node_modules\n');
    expect(readWorktreeCopyEntries(dir)).toEqual([{ pattern: 'node_modules', mode: 'symlink', negated: false }]);
  });

  it('parses ! prefix into negated copy-mode entries', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.worktreecopy'), '!.env.example\n');
    expect(readWorktreeCopyEntries(dir)).toEqual([{ pattern: '.env.example', mode: 'copy', negated: true }]);
  });

  it('skips comment lines and blank lines', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.worktreecopy'), '# a comment\n\n   \nkeep.txt\n# trailing\n');
    expect(readWorktreeCopyEntries(dir)).toEqual([{ pattern: 'keep.txt', mode: 'copy', negated: false }]);
  });

  it('parses a mixed .worktreecopy file correctly', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.worktreecopy'),
      ['# copy everything by default', '*', '# except secrets', '!.env', '', '@symlink node_modules', ''].join('\n'),
    );
    expect(readWorktreeCopyEntries(dir)).toEqual([
      { pattern: '*', mode: 'copy', negated: false },
      { pattern: '.env', mode: 'copy', negated: true },
      { pattern: 'node_modules', mode: 'symlink', negated: false },
    ]);
  });

  it('trims whitespace around each entry', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.worktreecopy'), '   spaced.txt   \n');
    expect(readWorktreeCopyEntries(dir)).toEqual([{ pattern: 'spaced.txt', mode: 'copy', negated: false }]);
  });
});

// ─── populateWorktree ───────────────────────────────────────────────────────

describe('populateWorktree', () => {
  const { getDir } = useTempDir();

  it('copies top-level files matched by copy-mode entries', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'a.txt'), 'aaa');
    writeFileSync(join(source, 'b.txt'), 'bbb');
    writeFileSync(join(source, 'c.md'), 'ccc');
    mkdirSync(target, { recursive: true });

    const entries: WorktreeCopyEntry[] = [{ pattern: '*.txt', mode: 'copy', negated: false }];
    await populateWorktree(source, target, entries);

    expect(readFileSync(join(target, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(readFileSync(join(target, 'b.txt'), 'utf-8')).toBe('bbb');
    expect(existsSync(join(target, 'c.md'))).toBe(false);
  });

  it('recursively copies a directory matched by a copy-mode entry', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(join(source, 'mydir', 'deep'), { recursive: true });
    writeFileSync(join(source, 'mydir', 'inner.txt'), 'inner');
    writeFileSync(join(source, 'mydir', 'deep', 'nested.txt'), 'nested');
    mkdirSync(target, { recursive: true });

    const entries: WorktreeCopyEntry[] = [{ pattern: 'mydir', mode: 'copy', negated: false }];
    await populateWorktree(source, target, entries);

    expect(readFileSync(join(target, 'mydir', 'inner.txt'), 'utf-8')).toBe('inner');
    expect(readFileSync(join(target, 'mydir', 'deep', 'nested.txt'), 'utf-8')).toBe('nested');
  });

  it('creates symlinks for symlink-mode entries', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(join(source, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1');
    mkdirSync(target, { recursive: true });

    const entries: WorktreeCopyEntry[] = [{ pattern: 'node_modules', mode: 'symlink', negated: false }];
    await populateWorktree(source, target, entries);

    const linkPath = join(target, 'node_modules');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linkPath, 'pkg', 'index.js'), 'utf-8')).toBe('module.exports = 1');
  });

  it('honours negated copy entries to exclude otherwise-matched files', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'keep.txt'), 'keep');
    writeFileSync(join(source, '.env.example'), 'secret');
    mkdirSync(target, { recursive: true });

    const entries: WorktreeCopyEntry[] = [
      { pattern: '*', mode: 'copy', negated: false },
      { pattern: '.env.example', mode: 'copy', negated: true },
    ];
    await populateWorktree(source, target, entries);

    expect(readFileSync(join(target, 'keep.txt'), 'utf-8')).toBe('keep');
    expect(existsSync(join(target, '.env.example'))).toBe(false);
  });

  it('does not walk into or copy .git and .engin directories', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(join(source, '.git'), { recursive: true });
    writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/main');
    mkdirSync(join(source, '.engin'), { recursive: true });
    writeFileSync(join(source, '.engin', 'state.json'), '{}');
    writeFileSync(join(source, 'keep.txt'), 'keep');
    mkdirSync(target, { recursive: true });

    const entries: WorktreeCopyEntry[] = [{ pattern: '*', mode: 'copy', negated: false }];
    await populateWorktree(source, target, entries);

    expect(readFileSync(join(target, 'keep.txt'), 'utf-8')).toBe('keep');
    expect(existsSync(join(target, '.git'))).toBe(false);
    expect(existsSync(join(target, '.engin'))).toBe(false);
  });

  it('supports mixed copy and symlink entries in a single call', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'config.json'), '{}');
    mkdirSync(join(source, 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'pkg.js'), '1');
    mkdirSync(target, { recursive: true });

    const entries: WorktreeCopyEntry[] = [
      { pattern: 'config.json', mode: 'copy', negated: false },
      { pattern: 'node_modules', mode: 'symlink', negated: false },
    ];
    await populateWorktree(source, target, entries);

    expect(lstatSync(join(target, 'config.json')).isFile()).toBe(true);
    expect(readFileSync(join(target, 'config.json'), 'utf-8')).toBe('{}');
    expect(lstatSync(join(target, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('is a no-op when entries is an empty array', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'a.txt'), 'a');
    mkdirSync(target, { recursive: true });

    await populateWorktree(source, target, []);

    expect(existsSync(join(target, 'a.txt'))).toBe(false);
  });

  it('reads entries from .worktreecopy when entries is omitted', async () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, '.worktreecopy'), '*.txt\n');
    writeFileSync(join(source, 'a.txt'), 'a');
    writeFileSync(join(source, 'b.md'), 'b');
    mkdirSync(target, { recursive: true });

    await populateWorktree(source, target);

    expect(readFileSync(join(target, 'a.txt'), 'utf-8')).toBe('a');
    expect(existsSync(join(target, 'b.md'))).toBe(false);
    expect(existsSync(join(target, '.worktreecopy'))).toBe(false);
  });
});

// ─── squashMergeBranch ──────────────────────────────────────────────────────

describe('squashMergeBranch', () => {
  const { getDir } = useTempDir();

  it('returns a Promise resolving to { success: true } on a clean squash merge', async () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['checkout', '-b', 'feature'], dir);
    writeFileSync(join(dir, 'feature.txt'), 'feature content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'feature commit'], dir);

    rawGit(['checkout', 'main'], dir);
    await expect(squashMergeBranch(dir, 'feature')).resolves.toEqual({ success: true });
  });

  it('stages but does not auto-commit changes after a successful squash merge', async () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['checkout', '-b', 'feature'], dir);
    writeFileSync(join(dir, 'feature.txt'), 'feature content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'feature commit'], dir);

    rawGit(['checkout', 'main'], dir);
    await squashMergeBranch(dir, 'feature');

    const staged = rawGit(['diff', '--cached', '--name-only'], dir);
    expect(staged).toContain('feature.txt');
    const log = rawGit(['log', '--oneline'], dir);
    expect(log).not.toContain('feature commit');
    expect(log.split('\n').length).toBe(1);
  });

  it('returns { success: false, conflicts } on a conflicting squash merge', async () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['checkout', '-b', 'feature'], dir);
    writeFileSync(join(dir, 'conflict.txt'), 'from-feature\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'feature commit'], dir);

    rawGit(['checkout', 'main'], dir);
    writeFileSync(join(dir, 'conflict.txt'), 'from-main\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'main commit'], dir);

    const result = await squashMergeBranch(dir, 'feature');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.conflicts).toContain('conflict.txt');
    }
  });
});

// ─── stageFiles ─────────────────────────────────────────────────────────────

describe('stageFiles', () => {
  const { getDir } = useTempDir();

  it('stages only the specified files, leaving untracked files untouched', async () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'stage-me.txt'), 'stage me');
    writeFileSync(join(dir, 'skip-me.txt'), 'skip me');
    writeFileSync(join(dir, 'also-skip.txt'), 'also skip');

    await stageFiles(dir, ['stage-me.txt']);

    const staged = rawGit(['diff', '--cached', '--name-only'], dir);
    expect(staged).toContain('stage-me.txt');
    expect(staged).not.toContain('skip-me.txt');
    expect(staged).not.toContain('also-skip.txt');
  });

  it('does not stage modifications to files that were not listed', async () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'README.md'), 'changed');
    writeFileSync(join(dir, 'new.txt'), 'new');

    await stageFiles(dir, ['new.txt']);

    const staged = rawGit(['diff', '--cached', '--name-only'], dir);
    expect(staged).toContain('new.txt');
    expect(staged).not.toContain('README.md');
  });

  it('stages multiple specified files at once', async () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'one.txt'), '1');
    writeFileSync(join(dir, 'two.txt'), '2');
    writeFileSync(join(dir, 'three.txt'), '3');

    await stageFiles(dir, ['one.txt', 'two.txt']);

    const staged = rawGit(['diff', '--cached', '--name-only'], dir);
    expect(staged).toContain('one.txt');
    expect(staged).toContain('two.txt');
    expect(staged).not.toContain('three.txt');
  });
});

// ─── deleteBranchForce ──────────────────────────────────────────────────────

describe('deleteBranchForce', () => {
  const { getDir } = useTempDir();

  it('force-deletes a branch even when it has unmerged commits', async () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['checkout', '-b', 'feature'], dir);
    writeFileSync(join(dir, 'feature.txt'), 'feature');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'unmerged feature commit'], dir);

    rawGit(['checkout', 'main'], dir);

    await deleteBranchForce(dir, 'feature');

    const branches = rawGit(['branch', '--list'], dir);
    expect(branches).not.toContain('feature');
  });

  it('deletes a fully-merged branch', async () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['branch', 'merged-branch'], dir);
    await deleteBranchForce(dir, 'merged-branch');

    const branches = rawGit(['branch', '--list'], dir);
    expect(branches).not.toContain('merged-branch');
  });

  it('rejects when the branch does not exist', async () => {
    const dir = getDir();
    initRepo(dir);
    await expect(deleteBranchForce(dir, 'no-such-branch')).rejects.toThrow();
  });
});
