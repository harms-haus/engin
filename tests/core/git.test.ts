import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  abortMerge,
  checkoutBranch,
  commitChanges,
  copyFilesToWorktree,
  createWorktree,
  getCurrentBranch,
  getDiff,
  getMainBranch,
  getRepoRoot,
  isGitRepo,
  listConflictedFiles,
  mergeBranch,
  pushBranch,
  readWorktreeCopyList,
  removeWorktree,
  stageAll,
} from '../../packages/engine/src/core/git.js';

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

// ─── readWorktreeCopyList ───────────────────────────────────────────────────

describe('readWorktreeCopyList', () => {
  const { getDir } = useTempDir();

  it('returns empty array when .worktreecopy does not exist', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    expect(readWorktreeCopyList(dir)).toEqual([]);
  });

  it('returns file paths listed in .worktreecopy', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.worktreecopy'), 'file1.txt\nfile2.txt\n');
    expect(readWorktreeCopyList(dir)).toEqual(['file1.txt', 'file2.txt']);
  });

  it('filters out empty lines and comments', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.worktreecopy'), '# comment\nfile1.txt\n\n  file2.txt  \n# another comment\n');
    const result = readWorktreeCopyList(dir);
    expect(result).toEqual(['file1.txt', 'file2.txt']);
  });

  it('trims whitespace from each line', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.worktreecopy'), '  spaced.txt  \n');
    expect(readWorktreeCopyList(dir)).toEqual(['spaced.txt']);
  });
});

// ─── copyFilesToWorktree ────────────────────────────────────────────────────

describe('copyFilesToWorktree', () => {
  const { getDir } = useTempDir();

  it('copies listed files into the worktree path, creating dirs as needed', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    // Create source files
    writeFileSync(join(dir, 'top.txt'), 'top');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'nested.txt'), 'nested');

    // Create target (worktree) dir
    const target = join(dir, 'worktree');
    mkdirSync(target, { recursive: true });

    copyFilesToWorktree(dir, target, ['top.txt', 'sub/nested.txt']);

    expect(readFileSync(join(target, 'top.txt'), 'utf-8')).toBe('top');
    expect(readFileSync(join(target, 'sub', 'nested.txt'), 'utf-8')).toBe('nested');
  });

  it('overwrites existing files in the worktree', () => {
    const dir = getDir();
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, 'data.txt'), 'source-content');

    const target = join(dir, 'worktree');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'data.txt'), 'old-content');

    copyFilesToWorktree(dir, target, ['data.txt']);
    expect(readFileSync(join(target, 'data.txt'), 'utf-8')).toBe('source-content');
  });
});
