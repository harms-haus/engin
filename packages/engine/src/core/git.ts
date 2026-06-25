// ─── Git Operations ──────────────────────────────────────────────────────────

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
 * Restore the previously checked-out branch. Errors are swallowed because
 * the repo may be in a detached-HEAD state where the symbolic ref is gone.
 */
export function restoreSavedBranch(repoRoot: string, savedBranch: string): void {
  try {
    checkoutBranch(repoRoot, savedBranch);
  } catch {
    // Ignore — may be detached HEAD.
  }
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
 * Hard-resets the index AND working tree to `HEAD` (`git reset --hard HEAD`).
 *
 * Used by `WorktreeManager` to roll back a SHARED worktree after a merge-commit
 * failure (e.g. a pre-commit/lint hook rejected the squash-merge commit). After
 * a successful `git merge --squash`, the changes are staged; a failed commit
 * would otherwise leave the shared main worktree dirty and corrupt the NEXT
 * task's merge. `resetHard` discards the staged squash so the worktree is clean.
 *
 * Reverts tracked-file modifications and conflict markers back to `HEAD`. Does
 * NOT remove untracked files (the squash of tracked changes does not create
 * any) — pair with `cleanUntracked` if a resolution agent left scratch files.
 */
export function resetHard(dir: string): void {
  execGit(['reset', '--hard', 'HEAD'], dir);
}

/**
 * Removes untracked files and directories (`git clean -fd`). Best-effort scratch
 * cleanup after a failed merge/commit in a SHARED worktree. Swallow callers
 * (see `WorktreeManager.safeResetMainWorktree`) treat a throw as non-fatal.
 */
export function cleanUntracked(dir: string): void {
  execGit(['clean', '-fd'], dir);
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
