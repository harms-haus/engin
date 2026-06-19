// ─── Git Operations ──────────────────────────────────────────────────────────

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import ignore from 'ignore';

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

// ─── Worktree Utility Functions (additive) ──────────────────────────────────

/**
 * Describes one parsed entry from a `.worktreecopy` file.
 */
export interface WorktreeCopyEntry {
  pattern: string;
  mode: 'copy' | 'symlink';
  negated: boolean;
}

/**
 * Runs `git worktree prune` to sweep orphaned worktree metadata left behind
 * by crashed runs (where worktree directories were deleted without telling git).
 */
export function worktreePrune(repoRoot: string): void {
  execGit(['worktree', 'prune'], repoRoot);
}

/**
 * Sanitises arbitrary text into a safe git branch slug.
 *
 * Lowercases the input, replaces every non-alphanumeric-non-dash character
 * with `-`, collapses consecutive dashes, and trims leading/trailing dashes.
 * Falls back to `engin-worktree-{Date.now()}` when the result would be empty.
 */
export function sanitizeBranchSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.length > 0 ? slug : `engin-worktree-${Date.now()}`;
}

/**
 * Creates a symlink at `linkPath` pointing to `target`, retrying on transient
 * errors (EEXIST, EPERM, etc.) with a synchronous backoff between attempts.
 *
 * If a symlink already exists at `linkPath` and points to the correct target,
 * this is a no-op.
 */
export function createSymlinkWithRetry(target: string, linkPath: string, maxRetries = 3, backoffMs = 75): void {
  // No-op when an existing symlink already points to the correct target
  try {
    if (existsSync(linkPath) && readlinkSync(linkPath) === target) {
      return;
    }
  } catch {
    // linkPath is not a symlink or does not exist — proceed to creation
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      symlinkSync(target, linkPath);
      return;
    } catch (err) {
      if (attempt < maxRetries) {
        Bun.sleepSync(backoffMs);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Parses `.worktreecopy` from `cwd` into structured {@link WorktreeCopyEntry}s.
 *
 * - Lines starting with `@symlink ` become symlink-mode entries (prefix stripped).
 * - Lines starting with `!` become negated entries (prefix stripped).
 * - `#` comments and blank lines are skipped.
 *
 * Returns an empty array when the file does not exist.
 */
export function readWorktreeCopyEntries(cwd: string): WorktreeCopyEntry[] {
  try {
    const content = readFileSync(join(cwd, '.worktreecopy'), 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line): WorktreeCopyEntry => {
        let pattern = line;
        let mode: 'copy' | 'symlink' = 'copy';
        let negated = false;

        if (pattern.startsWith('@symlink ')) {
          mode = 'symlink';
          pattern = pattern.slice('@symlink '.length);
        }

        if (pattern.startsWith('!')) {
          negated = true;
          pattern = pattern.slice(1);
        }

        return { pattern, mode, negated };
      });
  } catch {
    return [];
  }
}

/**
 * Populates `worktreePath` from `sourceCwd` according to `.worktreecopy` rules.
 *
 * Copy-mode entries are matched with gitignore semantics and copied (files via
 * `copyFileSync`, directories recursively via `cpSync`). Symlink-mode entries
 * are matched similarly and replaced with symlinks via {@link createSymlinkWithRetry}.
 *
 * Only the top-level entries of `sourceCwd` are considered for matching — there
 * is no recursive descent. The `.git` and `.engin` directories are always skipped.
 */
export function populateWorktree(sourceCwd: string, worktreePath: string, entries?: WorktreeCopyEntry[]): void {
  const resolvedEntries = entries ?? readWorktreeCopyEntries(sourceCwd);
  if (resolvedEntries.length === 0) {
    return;
  }

  const copyEntries = resolvedEntries.filter((entry) => entry.mode === 'copy');
  const symlinkEntries = resolvedEntries.filter((entry) => entry.mode === 'symlink');

  const copyIgnore = ignore().add(copyEntries.map((entry) => (entry.negated ? `!${entry.pattern}` : entry.pattern)));
  const symlinkIgnore = ignore().add(
    symlinkEntries.map((entry) => (entry.negated ? `!${entry.pattern}` : entry.pattern)),
  );

  for (const name of readdirSync(sourceCwd)) {
    if (name === '.git' || name === '.engin') {
      continue;
    }

    const sourceFullPath = join(sourceCwd, name);
    const targetFullPath = join(worktreePath, name);

    // Symlink mode takes precedence: matched entries become symlinks
    if (symlinkIgnore.ignores(name)) {
      mkdirSync(dirname(targetFullPath), { recursive: true });
      createSymlinkWithRetry(sourceFullPath, targetFullPath);
      continue;
    }

    // Copy mode: matched files/directories are copied (no recursive matching)
    if (copyIgnore.ignores(name)) {
      if (statSync(sourceFullPath).isDirectory()) {
        cpSync(sourceFullPath, targetFullPath, { recursive: true });
      } else {
        mkdirSync(dirname(targetFullPath), { recursive: true });
        copyFileSync(sourceFullPath, targetFullPath);
      }
    }
  }
}

/**
 * Runs `git merge --squash {branch}` in `repoRoot`.
 *
 * On success (exit 0), stages changes but does NOT auto-commit — the caller
 * must invoke {@link commitChanges} afterwards. On failure, returns the list
 * of conflicted files.
 */
export function squashMergeBranch(
  repoRoot: string,
  branch: string,
): { success: true } | { success: false; conflicts: string[]; error?: string } {
  try {
    execGit(['merge', '--squash', branch], repoRoot);
    return { success: true };
  } catch (err) {
    const conflicts = listConflictedFiles(repoRoot);
    // Only surface the underlying git message when this is NOT a conflict
    // failure — conflict failures are represented by the `conflicts` list
    // and handled separately by callers.
    return {
      success: false,
      conflicts,
      ...(conflicts.length === 0 && err instanceof Error ? { error: err.message } : {}),
    };
  }
}

/**
 * Stages only the specified files (NOT `git add -A`). Ensures only the
 * intended (e.g. conflict-resolved) files are staged, not the agent's scratch
 * or untracked files.
 */
export function stageFiles(repoRoot: string, files: string[]): void {
  if (files.length === 0) {
    return;
  }
  execGit(['add', '--', ...files], repoRoot);
}

/**
 * Force-deletes a branch (`git branch -D`). Used during task worktree culling
 * to remove branches even when they contain unmerged commits.
 */
export function deleteBranchForce(repoRoot: string, branch: string): void {
  execGit(['branch', '-D', branch], repoRoot);
}
