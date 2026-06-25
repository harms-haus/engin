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

// ─── isGitRepo ──────────────────────────────────────────────────────────────

describe('isGitRepo', () => {
  const { getDir } = useTempDir();

  it('returns true inside a git repo', () => {
    const dir = getDir();
    initRepo(dir);
    expect(isGitRepo(dir)).toBe(true);
  });

  it('returns false in a plain directory (no .git)', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    expect(isGitRepo(dir)).toBe(false);
  });

  it('returns false for a non-existent directory', () => {
    expect(isGitRepo('/no/such/directory/ever')).toBe(false);
  });
});

// ─── getRepoRoot ────────────────────────────────────────────────────────────

describe('getRepoRoot', () => {
  const { getDir } = useTempDir();

  it('returns the top-level repo directory', () => {
    const dir = getDir();
    initRepo(dir);
    const root = getRepoRoot(dir);
    expect(root).toBe(dir);
  });

  it('returns parent root when called from a subdirectory', () => {
    const dir = getDir();
    initRepo(dir);
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });
    const root = getRepoRoot(sub);
    expect(root).toBe(dir);
  });

  it('throws when not inside a git repo', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    expect(() => getRepoRoot(dir)).toThrow();
  });
});

// ─── getCurrentBranch ───────────────────────────────────────────────────────

describe('getCurrentBranch', () => {
  const { getDir } = useTempDir();

  it('returns the current branch name', () => {
    const dir = getDir();
    initRepo(dir);
    expect(getCurrentBranch(dir)).toBe('main');
  });

  it('returns a new branch after checkout -b', () => {
    const dir = getDir();
    initRepo(dir);
    rawGit(['checkout', '-b', 'feature-x'], dir);
    expect(getCurrentBranch(dir)).toBe('feature-x');
  });
});

// ─── getMainBranch ──────────────────────────────────────────────────────────

describe('getMainBranch', () => {
  const { getDir } = useTempDir();

  it('returns the local default branch when it is "main"', () => {
    const dir = getDir();
    initRepo(dir, 'main');
    // In a local-only repo, symbolic-ref for origin/HEAD usually fails.
    // The function should fall back to verifying "main" exists.
    const result = getMainBranch(dir);
    expect(result).toBe('main');
  });

  it('returns "master" when repo was initialised with master', () => {
    const dir = getDir();
    initRepo(dir, 'master');
    const result = getMainBranch(dir);
    expect(result).toBe('master');
  });

  it('falls back to "main" when no known default branch exists', () => {
    const dir = getDir();
    initRepo(dir, 'weird-branch');
    // Rename the current branch so neither "main" nor "master" exists
    rawGit(['branch', '-m', 'weird-branch'], dir);
    const result = getMainBranch(dir);
    expect(result).toBe('main');
  });
});

// ─── createWorktree / removeWorktree ────────────────────────────────────────

describe('createWorktree and removeWorktree', () => {
  const { getDir } = useTempDir();

  it('creates a worktree and then removes it', () => {
    const dir = getDir();
    initRepo(dir);
    const wtPath = join(dir, 'wt-test');

    createWorktree(dir, 'wt-branch', wtPath);

    // Worktree directory should exist
    expect(existsSync(wtPath)).toBe(true);
    // The branch should be listed
    const branches = rawGit(['branch', '--list', 'wt-branch'], dir);
    expect(branches).toContain('wt-branch');

    // Clean up
    removeWorktree(dir, wtPath);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('throws when creating a worktree that already exists', () => {
    const dir = getDir();
    initRepo(dir);
    const wtPath = join(dir, 'wt-dup');
    createWorktree(dir, 'wt-dup-branch', wtPath);

    // Try creating a second worktree at the same path
    expect(() => createWorktree(dir, 'wt-dup-branch2', wtPath)).toThrow();
  });
});

// ─── listConflictedFiles ────────────────────────────────────────────────────

describe('listConflictedFiles', () => {
  const { getDir } = useTempDir();

  it('returns empty array when there are no conflicts', () => {
    const dir = getDir();
    initRepo(dir);
    expect(listConflictedFiles(dir)).toEqual([]);
  });

  it('returns conflicted file names after a failed merge', () => {
    const dir = getDir();
    initRepo(dir);

    // Create branch "a" with content in file.txt
    rawGit(['checkout', '-b', 'a'], dir);
    writeFileSync(join(dir, 'file.txt'), 'from-a\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'commit on a'], dir);

    // Switch back to main and create conflicting content
    rawGit(['checkout', 'main'], dir);
    writeFileSync(join(dir, 'file.txt'), 'from-main\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'commit on main'], dir);

    // Merge "a" into main → conflict
    const result = Bun.spawnSync(['git', 'merge', 'a'], {
      cwd: dir,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    // Expect non-zero exit (conflict)
    expect(result.exitCode).not.toBe(0);

    const conflicts = listConflictedFiles(dir);
    expect(conflicts).toContain('file.txt');
  });
});

// ─── stageAll / commitChanges ───────────────────────────────────────────────

describe('stageAll and commitChanges', () => {
  const { getDir } = useTempDir();

  it('stages a new file and commits it', () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'new-file.txt'), 'hello');
    stageAll(dir);
    commitChanges(dir, 'add new file');

    const log = rawGit(['log', '--oneline', '-1'], dir);
    expect(log).toContain('add new file');
  });

  it('stages modifications and commits', () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'README.md'), 'updated content');
    stageAll(dir);
    commitChanges(dir, 'update readme');

    const log = rawGit(['log', '--oneline', '-1'], dir);
    expect(log).toContain('update readme');
  });
});

// ─── checkoutBranch ─────────────────────────────────────────────────────────

describe('checkoutBranch', () => {
  const { getDir } = useTempDir();

  it('switches to an existing branch', () => {
    const dir = getDir();
    initRepo(dir);
    rawGit(['branch', 'other'], dir);

    checkoutBranch(dir, 'other');
    expect(getCurrentBranch(dir)).toBe('other');
  });

  it('throws when branch does not exist', () => {
    const dir = getDir();
    initRepo(dir);
    expect(() => checkoutBranch(dir, 'nonexistent')).toThrow();
  });
});

// ─── restoreSavedBranch ───────────────────────────────────────────────────

describe('restoreSavedBranch', () => {
  const { getDir } = useTempDir();

  it('switches to an existing branch (happy path)', () => {
    const dir = getDir();
    initRepo(dir);
    rawGit(['checkout', '-b', 'feature-a'], dir);

    restoreSavedBranch(dir, 'feature-a');
    expect(getCurrentBranch(dir)).toBe('feature-a');
  });

  it('swallows errors when the branch does not exist (detached-HEAD contract)', () => {
    const dir = getDir();
    initRepo(dir);

    // checkoutBranch would throw for a non-existent branch; restoreSavedBranch
    // must swallow the error because the repo may be in a detached-HEAD state
    // where the symbolic ref is gone.
    expect(() => restoreSavedBranch(dir, 'nonexistent')).not.toThrow();
  });

  it('is a no-op when called with the already-checked-out branch', () => {
    const dir = getDir();
    initRepo(dir);

    // Already on 'main' — calling restoreSavedBranch with 'main' should be a no-op.
    expect(() => restoreSavedBranch(dir, 'main')).not.toThrow();
    expect(getCurrentBranch(dir)).toBe('main');
  });
});

// ─── mergeBranch ────────────────────────────────────────────────────────────

describe('mergeBranch', () => {
  const { getDir } = useTempDir();

  it('returns { success: true } on clean merge', () => {
    const dir = getDir();
    initRepo(dir);

    // Create branch with a different file (no conflict)
    rawGit(['checkout', '-b', 'feature'], dir);
    writeFileSync(join(dir, 'feature.txt'), 'feature content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'feature commit'], dir);

    rawGit(['checkout', 'main'], dir);
    const result = mergeBranch(dir, 'feature');
    expect(result).toEqual({ success: true });
  });

  it('returns { success: false, conflicts } on merge conflict', () => {
    const dir = getDir();
    initRepo(dir);

    // Create branch "a" with conflicting content
    rawGit(['checkout', '-b', 'a'], dir);
    writeFileSync(join(dir, 'conflict.txt'), 'from-a\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'commit a'], dir);

    // Create conflicting content on main
    rawGit(['checkout', 'main'], dir);
    writeFileSync(join(dir, 'conflict.txt'), 'from-main\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'commit main'], dir);

    const result = mergeBranch(dir, 'a');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.conflicts).toContain('conflict.txt');
    }
  });
});

// ─── abortMerge ─────────────────────────────────────────────────────────────

describe('abortMerge', () => {
  const { getDir } = useTempDir();

  it('cleans up a merge conflict state', () => {
    const dir = getDir();
    initRepo(dir);

    // Create conflicting branches
    rawGit(['checkout', '-b', 'a'], dir);
    writeFileSync(join(dir, 'abort-test.txt'), 'from-a\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'a'], dir);

    rawGit(['checkout', 'main'], dir);
    writeFileSync(join(dir, 'abort-test.txt'), 'from-main\n');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'main'], dir);

    // Trigger conflict
    Bun.spawnSync(['git', 'merge', 'a'], {
      cwd: dir,
      stderr: 'pipe',
      stdout: 'pipe',
    });

    // There should be conflicts now
    expect(listConflictedFiles(dir).length).toBeGreaterThan(0);

    // Abort
    abortMerge(dir);
    expect(listConflictedFiles(dir)).toEqual([]);
  });
});

// ─── pushBranch ─────────────────────────────────────────────────────────────

describe('pushBranch', () => {
  const { getDir } = useTempDir();

  it('throws when no remote is configured (expected)', () => {
    const dir = getDir();
    initRepo(dir);
    // No remote exists, so push will fail
    expect(() => pushBranch(dir, 'main')).toThrow();
  });
});

// ─── getDiff ────────────────────────────────────────────────────────────────

describe('getDiff', () => {
  const { getDir } = useTempDir();

  it('returns empty string when working tree is clean', () => {
    const dir = getDir();
    initRepo(dir);
    const diff = getDiff(dir);
    // After initial commit with nothing changed, diff should be empty
    expect(diff).toBe('');
  });

  it('returns diff for unstaged changes', () => {
    const dir = getDir();
    initRepo(dir);
    writeFileSync(join(dir, 'README.md'), 'modified content');
    const diff = getDiff(dir);
    expect(diff).toContain('modified content');
  });

  it('returns diff for staged changes when no unstaged changes exist', () => {
    const dir = getDir();
    initRepo(dir);
    writeFileSync(join(dir, 'staged.txt'), 'staged content');
    rawGit(['add', '-A'], dir);
    const diff = getDiff(dir);
    expect(diff).toContain('staged content');
  });

  it('does not throw when a tracked file named HEAD exists', () => {
    const dir = getDir();
    initRepo(dir);

    // Create a file literally named 'HEAD' and commit it
    writeFileSync(join(dir, 'HEAD'), 'HEAD file content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'add HEAD file'], dir);

    // Modify a tracked (non-HEAD) file to create unstaged changes
    writeFileSync(join(dir, 'README.md'), 'modified content');

    // getDiff must not throw — the trailing '.' pathspec after '--' ensures
    // git treats HEAD as a revision, not a filename.
    let diff: string;
    expect(() => {
      diff = getDiff(dir);
    }).not.toThrow();

    expect(diff!).toContain('modified content');
  });

  it('returns correct diff when an untracked file named HEAD exists', () => {
    const dir = getDir();
    initRepo(dir);

    // Create an untracked file named HEAD (not committed)
    writeFileSync(join(dir, 'HEAD'), 'untracked HEAD content');

    // Modify a tracked file
    writeFileSync(join(dir, 'README.md'), 'modified content');

    // This must work: the untracked HEAD file should not interfere
    const diff = getDiff(dir);
    expect(diff).toContain('modified content');
    // Untracked HEAD file should NOT appear in the diff
    expect(diff).not.toContain('untracked HEAD content');
  });

  it('shows both staged and unstaged changes when a file named HEAD exists', () => {
    const dir = getDir();
    initRepo(dir);

    // Create and commit a file named HEAD
    writeFileSync(join(dir, 'HEAD'), 'HEAD file content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'add HEAD file'], dir);

    // Stage a change (staged.txt is only in the index, not yet committed)
    writeFileSync(join(dir, 'staged.txt'), 'staged content');
    rawGit(['add', '-A'], dir);

    // Also have an unstaged change (modify README)
    writeFileSync(join(dir, 'README.md'), 'unstaged modified');

    // getDiff compares working tree against HEAD, so BOTH staged (staged.txt added)
    // and unstaged (README.md modified) changes appear in the diff
    const diff = getDiff(dir);
    expect(diff).toContain('unstaged modified');
    expect(diff).toContain('staged content');
  });
});

// ─── worktreePrune ──────────────────────────────────────────────────────────

describe('worktreePrune', () => {
  const { getDir } = useTempDir();

  it('runs without error in a real git repo', () => {
    const dir = getDir();
    initRepo(dir);
    expect(() => worktreePrune(dir)).not.toThrow();
  });

  it('removes orphaned worktree metadata after its directory is deleted', () => {
    const dir = getDir();
    initRepo(dir);

    // Create a real worktree in a sibling directory
    const wtPath = join(dir, '..', `wt-prune-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    createWorktree(dir, 'prune-branch', wtPath);
    expect(existsSync(wtPath)).toBe(true);

    // Simulate a crashed run: delete the worktree directory without telling git
    rmSync(wtPath, { recursive: true, force: true });

    // Before pruning, git still tracks the orphaned worktree
    const before = rawGit(['worktree', 'list'], dir);
    expect(before).toContain('prune-branch');

    // Prune sweeps the orphaned metadata
    worktreePrune(dir);

    const after = rawGit(['worktree', 'list'], dir);
    expect(after).not.toContain('prune-branch');
  });
});

// ─── sanitizeBranchSlug ─────────────────────────────────────────────────────

describe('sanitizeBranchSlug', () => {
  it('lowercases and replaces spaces/punctuation with dashes', () => {
    expect(sanitizeBranchSlug('Feature: Add Login')).toBe('feature-add-login');
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
    const result = sanitizeBranchSlug('!!!');
    expect(result).toMatch(/^engin-worktree-\d+$/);
  });

  it('falls back to engin-worktree-{timestamp} for an empty string', () => {
    const result = sanitizeBranchSlug('');
    expect(result).toMatch(/^engin-worktree-\d+$/);
  });

  it('falls back to engin-worktree-{timestamp} for a dashes-only string', () => {
    const result = sanitizeBranchSlug('---');
    expect(result).toMatch(/^engin-worktree-\d+$/);
  });

  it('produces a unique-ish timestamp suffix on each fallback call', () => {
    const a = sanitizeBranchSlug('!!!');
    const b = sanitizeBranchSlug('!!!');
    // The timestamps may collide if called within the same millisecond, but
    // both must still be valid fallback slugs.
    expect(a).toMatch(/^engin-worktree-\d+$/);
    expect(b).toMatch(/^engin-worktree-\d+$/);
  });
});

// ─── createSymlinkWithRetry ─────────────────────────────────────────────────

describe('createSymlinkWithRetry', () => {
  const { getDir } = useTempDir();

  it('creates a symlink pointing to the target', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const target = join(dir, 'target.txt');
    writeFileSync(target, 'hello');
    const link = join(dir, 'link');

    createSymlinkWithRetry(target, link);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    // Reading through the symlink resolves to the target contents
    expect(readFileSync(link, 'utf-8')).toBe('hello');
  });

  it('is a no-op when the symlink already exists and points to the correct target', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const target = join(dir, 'target.txt');
    writeFileSync(target, 'data');
    const link = join(dir, 'link');

    // Pre-create the correct symlink
    symlinkSync(target, link);
    const originalIno = lstatSync(link).ino;

    // Should not throw and should leave the existing symlink untouched
    expect(() => createSymlinkWithRetry(target, link)).not.toThrow();

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    // The symlink node itself was not replaced
    expect(lstatSync(link).ino).toBe(originalIno);
  });

  it('throws after exhausting retries when a symlink exists pointing elsewhere', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const correctTarget = join(dir, 'correct.txt');
    const wrongTarget = join(dir, 'wrong.txt');
    const link = join(dir, 'link');

    // Pre-create a symlink pointing to the wrong target
    symlinkSync(wrongTarget, link);

    // Because the existing symlink does NOT point to the requested target, the
    // function cannot treat it as a no-op; symlinkSync will fail with EEXIST on
    // every attempt and the function should throw after exhausting retries.
    expect(() => createSymlinkWithRetry(correctTarget, link, 2, 5)).toThrow();
  });

  it('honours a small backoff/retry budget without hanging', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const correctTarget = join(dir, 'correct.txt');
    const wrongTarget = join(dir, 'wrong.txt');
    const link = join(dir, 'link');
    symlinkSync(wrongTarget, link);

    const start = Date.now();
    expect(() => createSymlinkWithRetry(correctTarget, link, 1, 10)).toThrow();
    const elapsed = Date.now() - start;

    // With 1 retry and a 10ms backoff, it should complete well under a second.
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

  it('copies top-level files matched by copy-mode entries', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    // Source layout
    writeFileSync(join(dir, 'a.txt'), 'aaa');
    writeFileSync(join(dir, 'b.txt'), 'bbb');
    writeFileSync(join(dir, 'c.md'), 'ccc');

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    // Move created files into a dedicated source dir
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'a.txt'), 'aaa');
    writeFileSync(join(source, 'b.txt'), 'bbb');
    writeFileSync(join(source, 'c.md'), 'ccc');
    mkdirSync(target, { recursive: true });

    const entries: WorktreeCopyEntry[] = [{ pattern: '*.txt', mode: 'copy', negated: false }];
    populateWorktree(source, target, entries);

    expect(readFileSync(join(target, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(readFileSync(join(target, 'b.txt'), 'utf-8')).toBe('bbb');
    // c.md does not match *.txt and must not be copied
    expect(existsSync(join(target, 'c.md'))).toBe(false);
  });

  it('recursively copies a directory matched by a copy-mode entry', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(join(source, 'mydir', 'deep'), { recursive: true });
    writeFileSync(join(source, 'mydir', 'inner.txt'), 'inner');
    writeFileSync(join(source, 'mydir', 'deep', 'nested.txt'), 'nested');
    mkdirSync(target, { recursive: true });

    const entries: WorktreeCopyEntry[] = [{ pattern: 'mydir', mode: 'copy', negated: false }];
    populateWorktree(source, target, entries);

    expect(readFileSync(join(target, 'mydir', 'inner.txt'), 'utf-8')).toBe('inner');
    expect(readFileSync(join(target, 'mydir', 'deep', 'nested.txt'), 'utf-8')).toBe('nested');
  });

  it('creates symlinks for symlink-mode entries', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(join(source, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1');
    mkdirSync(target, { recursive: true });

    const entries: WorktreeCopyEntry[] = [{ pattern: 'node_modules', mode: 'symlink', negated: false }];
    populateWorktree(source, target, entries);

    const linkPath = join(target, 'node_modules');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // Reading through the symlink resolves into the source directory
    expect(readFileSync(join(linkPath, 'pkg', 'index.js'), 'utf-8')).toBe('module.exports = 1');
  });

  it('honours negated copy entries to exclude otherwise-matched files', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'keep.txt'), 'keep');
    writeFileSync(join(source, '.env.example'), 'secret');
    mkdirSync(target, { recursive: true });

    // Copy everything (*), but exclude .env.example
    const entries: WorktreeCopyEntry[] = [
      { pattern: '*', mode: 'copy', negated: false },
      { pattern: '.env.example', mode: 'copy', negated: true },
    ];
    populateWorktree(source, target, entries);

    expect(readFileSync(join(target, 'keep.txt'), 'utf-8')).toBe('keep');
    // .env.example is excluded by the negation and must not be copied
    expect(existsSync(join(target, '.env.example'))).toBe(false);
  });

  it('does not walk into or copy .git and .engin directories', () => {
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

    // * would match .git and .engin, but they must be skipped entirely
    const entries: WorktreeCopyEntry[] = [{ pattern: '*', mode: 'copy', negated: false }];
    populateWorktree(source, target, entries);

    expect(readFileSync(join(target, 'keep.txt'), 'utf-8')).toBe('keep');
    expect(existsSync(join(target, '.git'))).toBe(false);
    expect(existsSync(join(target, '.engin'))).toBe(false);
  });

  it('supports mixed copy and symlink entries in a single call', () => {
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
    populateWorktree(source, target, entries);

    // config.json was copied as a real file
    expect(lstatSync(join(target, 'config.json')).isFile()).toBe(true);
    expect(readFileSync(join(target, 'config.json'), 'utf-8')).toBe('{}');
    // node_modules is a symlink
    expect(lstatSync(join(target, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('is a no-op when entries is an empty array', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'a.txt'), 'a');
    mkdirSync(target, { recursive: true });

    populateWorktree(source, target, []);

    expect(existsSync(join(target, 'a.txt'))).toBe(false);
  });

  it('reads entries from .worktreecopy when entries is omitted', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, '.worktreecopy'), '*.txt\n');
    writeFileSync(join(source, 'a.txt'), 'a');
    writeFileSync(join(source, 'b.md'), 'b');
    mkdirSync(target, { recursive: true });

    populateWorktree(source, target);

    expect(readFileSync(join(target, 'a.txt'), 'utf-8')).toBe('a');
    expect(existsSync(join(target, 'b.md'))).toBe(false);
    // The .worktreecopy file itself is not matched by *.txt
    expect(existsSync(join(target, '.worktreecopy'))).toBe(false);
  });
});

// ─── squashMergeBranch ──────────────────────────────────────────────────────

describe('squashMergeBranch', () => {
  const { getDir } = useTempDir();

  it('returns { success: true } on a clean squash merge', () => {
    const dir = getDir();
    initRepo(dir);

    // Create a branch that adds a new file (no conflict with main)
    rawGit(['checkout', '-b', 'feature'], dir);
    writeFileSync(join(dir, 'feature.txt'), 'feature content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'feature commit'], dir);

    rawGit(['checkout', 'main'], dir);
    const result = squashMergeBranch(dir, 'feature');
    expect(result).toEqual({ success: true });
  });

  it('stages but does not auto-commit changes after a successful squash merge', () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['checkout', '-b', 'feature'], dir);
    writeFileSync(join(dir, 'feature.txt'), 'feature content');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'feature commit'], dir);

    rawGit(['checkout', 'main'], dir);
    squashMergeBranch(dir, 'feature');

    // The merged change is staged...
    const staged = rawGit(['diff', '--cached', '--name-only'], dir);
    expect(staged).toContain('feature.txt');
    // ...but no new commit was created (only the initial commit remains)
    const log = rawGit(['log', '--oneline'], dir);
    expect(log).not.toContain('feature commit');
    expect(log.split('\n').length).toBe(1);
  });

  it('returns { success: false, conflicts } on a conflicting squash merge', () => {
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

    const result = squashMergeBranch(dir, 'feature');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.conflicts).toContain('conflict.txt');
    }
  });
});

// ─── stageFiles ─────────────────────────────────────────────────────────────

describe('stageFiles', () => {
  const { getDir } = useTempDir();

  it('stages only the specified files, leaving untracked files untouched', () => {
    const dir = getDir();
    initRepo(dir);

    // Create several untracked files
    writeFileSync(join(dir, 'stage-me.txt'), 'stage me');
    writeFileSync(join(dir, 'skip-me.txt'), 'skip me');
    writeFileSync(join(dir, 'also-skip.txt'), 'also skip');

    stageFiles(dir, ['stage-me.txt']);

    const staged = rawGit(['diff', '--cached', '--name-only'], dir);
    expect(staged).toContain('stage-me.txt');
    expect(staged).not.toContain('skip-me.txt');
    expect(staged).not.toContain('also-skip.txt');
  });

  it('does not stage modifications to files that were not listed', () => {
    const dir = getDir();
    initRepo(dir);

    // README.md is tracked (committed in initRepo); modify it
    writeFileSync(join(dir, 'README.md'), 'changed');
    // Also add a new file to stage explicitly
    writeFileSync(join(dir, 'new.txt'), 'new');

    stageFiles(dir, ['new.txt']);

    const staged = rawGit(['diff', '--cached', '--name-only'], dir);
    expect(staged).toContain('new.txt');
    // README.md modification must NOT be staged because it was not listed
    expect(staged).not.toContain('README.md');
  });

  it('stages multiple specified files at once', () => {
    const dir = getDir();
    initRepo(dir);

    writeFileSync(join(dir, 'one.txt'), '1');
    writeFileSync(join(dir, 'two.txt'), '2');
    writeFileSync(join(dir, 'three.txt'), '3');

    stageFiles(dir, ['one.txt', 'two.txt']);

    const staged = rawGit(['diff', '--cached', '--name-only'], dir);
    expect(staged).toContain('one.txt');
    expect(staged).toContain('two.txt');
    expect(staged).not.toContain('three.txt');
  });
});

// ─── deleteBranchForce ──────────────────────────────────────────────────────

describe('deleteBranchForce', () => {
  const { getDir } = useTempDir();

  it('force-deletes a branch even when it has unmerged commits', () => {
    const dir = getDir();
    initRepo(dir);

    // Create a branch with a commit that is NOT merged into main
    rawGit(['checkout', '-b', 'feature'], dir);
    writeFileSync(join(dir, 'feature.txt'), 'feature');
    rawGit(['add', '-A'], dir);
    rawGit(['commit', '-m', 'unmerged feature commit'], dir);

    rawGit(['checkout', 'main'], dir);

    // A plain `git branch -d` would refuse to delete an unmerged branch;
    // `git branch -D` (force) must succeed.
    deleteBranchForce(dir, 'feature');

    const branches = rawGit(['branch', '--list'], dir);
    expect(branches).not.toContain('feature');
  });

  it('deletes a fully-merged branch', () => {
    const dir = getDir();
    initRepo(dir);

    rawGit(['branch', 'merged-branch'], dir);
    deleteBranchForce(dir, 'merged-branch');

    const branches = rawGit(['branch', '--list'], dir);
    expect(branches).not.toContain('merged-branch');
  });

  it('throws when the branch does not exist', () => {
    const dir = getDir();
    initRepo(dir);
    expect(() => deleteBranchForce(dir, 'no-such-branch')).toThrow();
  });
});
