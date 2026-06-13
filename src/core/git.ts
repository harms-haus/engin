// ─── Git Operations ──────────────────────────────────────────────────────────

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ─── Internal Helper ─────────────────────────────────────────────────────────

/**
 * Runs `git` with the given args in the specified working directory.
 * Returns trimmed stdout on success; throws a descriptive Error on non-zero exit.
 */
function execGit(args: string[], cwd: string): string {
  const decoder = new TextDecoder();

  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = decoder.decode(result.stdout).trim();
  const stderr = decoder.decode(result.stderr).trim();

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit code ${result.exitCode}) in ${cwd}: ${stderr}`);
  }

  return stdout;
}

// ─── Exported Functions ──────────────────────────────────────────────────────

/**
 * Returns true only when `dir` is inside a git working tree.
 */
export function isGitRepo(dir: string): boolean {
  try {
    const output = execGit(['rev-parse', '--is-inside-work-tree'], dir);
    return output === 'true';
  } catch {
    return false;
  }
}

/**
 * Returns the top-level directory of the repository containing `dir`.
 */
export function getRepoRoot(dir: string): string {
  return execGit(['rev-parse', '--show-toplevel'], dir);
}

/**
 * Returns the name of the current (checked-out) branch.
 */
export function getCurrentBranch(dir: string): string {
  return execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
}

/**
 * Returns the main branch name, detected from the remote HEAD symbolic ref,
 * falling back to verifying `main`, then `master`, and finally returning
 * `'main'` as a default.
 */
export function getMainBranch(dir: string): string {
  // Try symbolic-ref refs/remotes/origin/HEAD
  try {
    const ref = execGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], dir);
    const prefix = 'refs/remotes/origin/';
    if (ref.startsWith(prefix)) {
      return ref.slice(prefix.length);
    }
    return ref;
  } catch {
    // fall through
  }

  // Try verifying `main`
  try {
    execGit(['rev-parse', '--verify', 'main'], dir);
    return 'main';
  } catch {
    // fall through
  }

  // Try verifying `master`
  try {
    execGit(['rev-parse', '--verify', 'master'], dir);
    return 'master';
  } catch {
    // fall through
  }

  return 'main';
}

/**
 * Creates a new git worktree at `targetPath` with a new branch `branchName`.
 */
export function createWorktree(repoRoot: string, branchName: string, targetPath: string): void {
  execGit(['worktree', 'add', '-b', branchName, targetPath], repoRoot);
}

/**
 * Removes (forcefully) an existing git worktree at `worktreePath`.
 */
export function removeWorktree(repoRoot: string, worktreePath: string): void {
  execGit(['worktree', 'remove', '--force', worktreePath], repoRoot);
}

/**
 * Lists files that are in an unresolved conflict state (unmerged).
 */
export function listConflictedFiles(repoRoot: string): string[] {
  const output = execGit(['diff', '--name-only', '--diff-filter=U'], repoRoot);
  return output.split('\n').filter((line) => line.length > 0);
}

/**
 * Stages all changes (including untracked files) in `dir`.
 */
export function stageAll(dir: string): void {
  execGit(['add', '-A'], dir);
}

/**
 * Commits the staged changes with the given `message`.
 */
export function commitChanges(dir: string, message: string): void {
  execGit(['commit', '-m', message], dir);
}

/**
 * Checks out the specified `branch` in the repo at `repoRoot`.
 */
export function checkoutBranch(repoRoot: string, branch: string): void {
  execGit(['checkout', branch], repoRoot);
}

/**
 * Merges `branch` into the current branch with --no-edit.
 * Returns `{ success: true }` on clean merge, or
 * `{ success: false, conflicts: string[] }` when conflicts occur.
 */
export function mergeBranch(
  repoRoot: string,
  branch: string,
): { success: true } | { success: false; conflicts: string[] } {
  try {
    execGit(['merge', '--no-edit', branch], repoRoot);
    return { success: true };
  } catch {
    const conflicts = listConflictedFiles(repoRoot);
    return { success: false, conflicts };
  }
}

/**
 * Aborts an in-progress merge.
 */
export function abortMerge(repoRoot: string): void {
  execGit(['merge', '--abort'], repoRoot);
}

/**
 * Pushes `branch` to `remote` (default `'origin'`) and sets upstream tracking.
 */
export function pushBranch(dir: string, branch: string, remote = 'origin'): void {
  execGit(['push', '-u', remote, branch], dir);
}

/**
 * Returns the diff of the working tree against HEAD.
 * If that is empty, returns the cached (staged) diff instead.
 */
export function getDiff(dir: string): string {
  const diff = execGit(['diff', 'HEAD', '--', '.'], dir);
  if (diff.length > 0) {
    return diff;
  }
  return execGit(['diff', '--cached'], dir);
}

/**
 * Reads the `.worktreecopy` file from `cwd` and returns the list of file
 * paths to copy. Blank lines and lines starting with `#` are ignored.
 * Returns an empty array when the file does not exist.
 */
export function readWorktreeCopyList(cwd: string): string[] {
  try {
    const content = readFileSync(join(cwd, '.worktreecopy'), 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Copies each file in `files` from `sourceCwd` to the corresponding path
 * under `worktreePath`, creating any necessary intermediate directories.
 */
export function copyFilesToWorktree(sourceCwd: string, worktreePath: string, files: string[]): void {
  for (const file of files) {
    const targetPath = join(worktreePath, file);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(join(sourceCwd, file), targetPath);
  }
}
