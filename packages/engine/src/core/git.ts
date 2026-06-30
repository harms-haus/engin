// ─── Git Operations ──────────────────────────────────────────────────────────

/**
 * Runs `git` with the given args in the specified working directory.
 * Returns trimmed stdout on success; rejects with a descriptive Error on
 * non-zero exit. Uses async `Bun.spawn` (awaited `.exited`) so it never
 * blocks the event loop; stdout/stderr are drained via `new Response(...).text()`.
 */
async function execGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Drain stdout/stderr in parallel with awaiting exit so the proc's pipe
  // buffers cannot fill and deadlock the spawn.
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit code ${exitCode}) in ${cwd}: ${trimmedStderr}`);
  }

  return trimmedStdout;
}

// ─── Exported Functions ──────────────────────────────────────────────────────

/**
 * Returns true only when `dir` is inside a git working tree.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const output = await execGit(['rev-parse', '--is-inside-work-tree'], dir);
    return output === 'true';
  } catch {
    return false;
  }
}

/**
 * Returns the top-level directory of the repository containing `dir`.
 */
export async function getRepoRoot(dir: string): Promise<string> {
  return execGit(['rev-parse', '--show-toplevel'], dir);
}

/**
 * Returns the name of the current (checked-out) branch.
 */
export async function getCurrentBranch(dir: string): Promise<string> {
  return execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
}

/**
 * Returns the main branch name, detected from the remote HEAD symbolic ref,
 * falling back to verifying `main`, then `master`, and finally returning
 * `'main'` as a default.
 */
export async function getMainBranch(dir: string): Promise<string> {
  // Try symbolic-ref refs/remotes/origin/HEAD
  try {
    const ref = await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], dir);
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
    await execGit(['rev-parse', '--verify', 'main'], dir);
    return 'main';
  } catch {
    // fall through
  }

  // Try verifying `master`
  try {
    await execGit(['rev-parse', '--verify', 'master'], dir);
    return 'master';
  } catch {
    // fall through
  }

  return 'main';
}

/**
 * Creates a new git worktree at `targetPath` with a new branch `branchName`.
 */
export async function createWorktree(repoRoot: string, branchName: string, targetPath: string): Promise<void> {
  await execGit(['worktree', 'add', '-b', branchName, targetPath], repoRoot);
}

/**
 * Removes (forcefully) an existing git worktree at `worktreePath`.
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await execGit(['worktree', 'remove', '--force', worktreePath], repoRoot);
}

/**
 * Lists files that are in an unresolved conflict state (unmerged).
 */
export async function listConflictedFiles(repoRoot: string): Promise<string[]> {
  const output = await execGit(['diff', '--name-only', '--diff-filter=U'], repoRoot);
  return output.split('\n').filter((line) => line.length > 0);
}

/**
 * Stages all changes (including untracked files) in `dir`.
 */
export async function stageAll(dir: string): Promise<void> {
  await execGit(['add', '-A'], dir);
}

/**
 * Commits the staged changes with the given `message`.
 */
export async function commitChanges(dir: string, message: string): Promise<void> {
  await execGit(['commit', '-m', message], dir);
}

/**
 * Checks out the specified `branch` in the repo at `repoRoot`.
 */
export async function checkoutBranch(repoRoot: string, branch: string): Promise<void> {
  await execGit(['checkout', branch], repoRoot);
}

/**
 * Restore the previously checked-out branch. Errors are swallowed because
 * the repo may be in a detached-HEAD state where the symbolic ref is gone.
 */
export async function restoreSavedBranch(repoRoot: string, savedBranch: string): Promise<void> {
  try {
    await checkoutBranch(repoRoot, savedBranch);
  } catch {
    // Ignore — may be detached HEAD.
  }
}

/**
 * Merges `branch` into the current branch with --no-edit.
 * Returns `{ success: true }` on clean merge, or
 * `{ success: false, conflicts: string[] }` when conflicts occur.
 */
export async function mergeBranch(
  repoRoot: string,
  branch: string,
): Promise<{ success: true } | { success: false; conflicts: string[] }> {
  try {
    await execGit(['merge', '--no-edit', branch], repoRoot);
    return { success: true };
  } catch {
    const conflicts = await listConflictedFiles(repoRoot);
    return { success: false, conflicts };
  }
}

/**
 * Aborts an in-progress merge.
 */
export async function abortMerge(repoRoot: string): Promise<void> {
  await execGit(['merge', '--abort'], repoRoot);
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
export async function resetHard(dir: string): Promise<void> {
  await execGit(['reset', '--hard', 'HEAD'], dir);
}

/**
 * Removes untracked files and directories (`git clean -fd`). Best-effort scratch
 * cleanup after a failed merge/commit in a SHARED worktree. Swallow callers
 * (see `WorktreeManager.safeResetMainWorktree`) treat a throw as non-fatal.
 */
export async function cleanUntracked(dir: string): Promise<void> {
  await execGit(['clean', '-fd'], dir);
}

/**
 * Pushes `branch` to `remote` (default `'origin'`) and sets upstream tracking.
 */
export async function pushBranch(dir: string, branch: string, remote = 'origin'): Promise<void> {
  await execGit(['push', '-u', remote, branch], dir);
}

/**
 * Returns the diff of the working tree against HEAD.
 * If that is empty, returns the cached (staged) diff instead.
 */
export async function getDiff(dir: string): Promise<string> {
  const diff = await execGit(['diff', 'HEAD', '--', '.'], dir);
  if (diff.length > 0) {
    return diff;
  }
  return execGit(['diff', '--cached'], dir);
}

/**
 * Runs `git worktree prune` to sweep orphaned worktree metadata left behind
 * by crashed runs (where worktree directories were deleted without telling git).
 */
export async function worktreePrune(repoRoot: string): Promise<void> {
  await execGit(['worktree', 'prune'], repoRoot);
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
export async function squashMergeBranch(
  repoRoot: string,
  branch: string,
): Promise<{ success: true } | { success: false; conflicts: string[]; error?: string }> {
  try {
    await execGit(['merge', '--squash', branch], repoRoot);
    return { success: true };
  } catch (err) {
    const conflicts = await listConflictedFiles(repoRoot);
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
export async function stageFiles(repoRoot: string, files: string[]): Promise<void> {
  if (files.length === 0) {
    return;
  }
  await execGit(['add', '--', ...files], repoRoot);
}

/**
 * Force-deletes a branch (`git branch -D`). Used during task worktree culling
 * to remove branches even when they contain unmerged commits.
 */
export async function deleteBranchForce(repoRoot: string, branch: string): Promise<void> {
  await execGit(['branch', '-D', branch], repoRoot);
}
