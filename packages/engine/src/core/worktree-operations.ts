// ─── Shared Worktree Merge/PR Operations ─────────────────────────────────────
//
// Reusable git + agent operations for post-run worktree handling. Extracted
// from the duplicated logic that previously lived inline in both:
//   - packages/engine/src/server/run-manager.ts  (server-side handleWorktreeAction)
//   - packages/cli/src/cli/post-worktree.ts      (client-side handleMergeToMain,
//     handlePushAndPR, commitInWorktree)
//
// These functions are pure orchestrations over the git.ts primitives and the
// worktree-lifecycle.ts agent helpers. They do NOT print to the console —
// callers decide how to surface progress/results to their context (CLI vs.
// server log).
//
// Neither {@link mergeWorktreeToMain} nor {@link pushWorktreeAndCreatePR}
// throws on the final worktree removal — both perform it best-effort and
// report a cleanup failure via the optional `cleanupError` field on their
// result object (the operation itself has already succeeded by the time
// removal runs), so callers can distinguish a genuine operation failure
// (which still throws) from a leftover on-disk directory. For standalone
// best-effort cleanup that swallows errors, use {@link cleanupWorktree}.

import {
  abortMerge,
  checkoutBranch,
  commitChanges,
  getCurrentBranch,
  getDiff,
  getMainBranch,
  mergeBranch,
  removeWorktree,
  stageAll,
} from './git.js';
import { generateCommitMessage, pushAndCreatePR, resolveConflictsWithAgent } from './worktree-lifecycle.js';

// ─── Option Types ────────────────────────────────────────────────────────────

export interface CommitWorktreeOptions {
  /** Profiles directories for agent-based commit message generation. */
  profilesDirs: string[];
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** The task prompt that seeded the run. */
  taskPrompt: string;
  /** API keys for agent operations. */
  apiKeys?: Record<string, string>;
}

export interface MergeWorktreeOptions {
  /** Profiles directories for agent-based git operations. */
  profilesDirs: string[];
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Name of the branch checked out in the worktree. */
  branchName: string;
  /** The task prompt that seeded the run. */
  taskPrompt: string;
  /** API keys for agent operations. */
  apiKeys?: Record<string, string>;
}

export interface PushWorktreeOptions {
  /** Profiles directories for agent-based git operations. */
  profilesDirs: string[];
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Name of the branch checked out in the worktree. */
  branchName: string;
  /** The task prompt that seeded the run. */
  taskPrompt: string;
  /** The final PR title (truncation is the caller's responsibility). */
  title: string;
  /** API keys for agent operations. */
  apiKeys?: Record<string, string>;
}

export interface MergeResult {
  /** `true` when the branch was merged into main (cleanly or after resolution). */
  success: boolean;
  /**
   * `true` only when conflicts arose during the merge AND were successfully
   * resolved by the agent. `false` for clean merges and unresolved conflicts.
   */
  conflictsResolved: boolean;
  /**
   * Set when the merge SUCCEEDED but the final best-effort worktree removal
   * failed. The merge itself completed; only the on-disk worktree directory
   * could not be deleted. Callers should surface this as a warning, NOT as an
   * operation failure. Undefined on a clean removal and on the
   * conflict-failure path.
   */
  cleanupError?: string;
}

export interface PushWorktreeResult {
  /**
   * Set when the push + PR creation SUCCEEDED but the final best-effort
   * worktree removal failed. The push and PR themselves completed; only the
   * on-disk worktree directory could not be deleted. Callers should surface
   * this as a warning, NOT as an operation failure. Undefined on a clean
   * removal.
   */
  cleanupError?: string;
}

// ─── commitWorktreeChanges ───────────────────────────────────────────────────

/**
 * Stage and commit any uncommitted changes inside the worktree using an
 * agent-generated commit message. No-op when the working tree is clean.
 */
export async function commitWorktreeChanges(opts: CommitWorktreeOptions): Promise<void> {
  const diff = getDiff(opts.worktreePath);
  if (!diff) return;

  stageAll(opts.worktreePath);
  const message = await generateCommitMessage(
    opts.profilesDirs,
    opts.worktreePath,
    opts.taskPrompt,
    diff,
    opts.apiKeys,
  );
  commitChanges(opts.worktreePath, message);
}

// ─── mergeWorktreeToMain ─────────────────────────────────────────────────────

/**
 * Commit pending worktree changes, then check out the main branch and merge
 * the worktree branch into it. When conflicts arise, an agent attempts to
 * resolve them; on failure the merge is aborted and the worktree is
 * preserved so the user can intervene manually.
 *
 * On success (clean merge or resolved conflicts) the previously-checked-out
 * branch is restored (errors ignored for detached HEAD) and the worktree is
 * removed. Worktree-removal is best-effort: a removal failure does NOT abort
 * the successful result; instead the error message is returned via the
 * optional `cleanupError` field on {@link MergeResult} so callers can surface
 * a warning without conflating it with an operation failure.
 */
export async function mergeWorktreeToMain(opts: MergeWorktreeOptions): Promise<MergeResult> {
  await commitWorktreeChanges({
    profilesDirs: opts.profilesDirs,
    worktreePath: opts.worktreePath,
    taskPrompt: opts.taskPrompt,
    apiKeys: opts.apiKeys,
  });

  const mainBranch = getMainBranch(opts.repoRoot);
  const savedBranch = getCurrentBranch(opts.repoRoot);
  checkoutBranch(opts.repoRoot, mainBranch);

  const result = mergeBranch(opts.repoRoot, opts.branchName);

  let conflictsResolved = false;

  if (!result.success) {
    const resolved = await resolveConflictsWithAgent(
      opts.profilesDirs,
      opts.repoRoot,
      result.conflicts,
      opts.taskPrompt,
      opts.apiKeys,
    );

    if (!resolved) {
      abortMerge(opts.repoRoot);
      restoreSavedBranch(opts.repoRoot, savedBranch);
      return { success: false, conflictsResolved: false };
    }

    commitChanges(opts.repoRoot, `Merge resolution: ${opts.branchName} into ${mainBranch}`);
    conflictsResolved = true;
  }

  // Restore the previously checked-out branch. Errors are swallowed because
  // the repo may be in a detached-HEAD state where the symbolic ref is gone.
  restoreSavedBranch(opts.repoRoot, savedBranch);

  // The merge has already succeeded by this point. Worktree removal is
  // best-effort: a failure means the on-disk directory is still present, NOT
  // that the merge failed. We therefore surface the failure via
  // `cleanupError` instead of letting it abort the successful MergeResult —
  // otherwise callers cannot distinguish a cleanup failure from a genuine
  // operation failure (and would print misleading success/failure messages).
  const mergeResult: MergeResult = { success: true, conflictsResolved };
  try {
    removeWorktree(opts.repoRoot, opts.worktreePath);
  } catch (err) {
    mergeResult.cleanupError = err instanceof Error ? err.message : String(err);
  }
  return mergeResult;
}

// ─── pushWorktreeAndCreatePR ─────────────────────────────────────────────────

/**
 * Commit pending worktree changes, push the branch to the remote, and create
 * a pull request via the agent-driven `pushAndCreatePR` helper. The worktree
 * is removed after the PR is created.
 *
 * Error handling: real push/PR (or commit) failures THROW so callers can
 * surface them as genuine failures. The final worktree removal is best-effort
 * — it runs after the PR was already created, so a removal failure is reported
 * via {@link PushWorktreeResult.cleanupError} instead of throwing, letting
 * callers warn the user while still reporting success (mirroring
 * {@link mergeWorktreeToMain}). For standalone best-effort cleanup that
 * swallows errors, use {@link cleanupWorktree}.
 *
 * The `title` is forwarded verbatim — callers are responsible for any
 * truncation.
 */
export async function pushWorktreeAndCreatePR(opts: PushWorktreeOptions): Promise<PushWorktreeResult> {
  await commitWorktreeChanges({
    profilesDirs: opts.profilesDirs,
    worktreePath: opts.worktreePath,
    taskPrompt: opts.taskPrompt,
    apiKeys: opts.apiKeys,
  });

  await pushAndCreatePR(opts.profilesDirs, opts.repoRoot, opts.branchName, opts.taskPrompt, opts.title, opts.apiKeys);

  // The push + PR creation has already succeeded by this point. Worktree
  // removal is best-effort: a failure means the on-disk directory is still
  // present, NOT that the push/PR failed. Surface it via `cleanupError`
  // instead of throwing, mirroring mergeWorktreeToMain.
  const result: PushWorktreeResult = {};
  try {
    removeWorktree(opts.repoRoot, opts.worktreePath);
  } catch (err) {
    result.cleanupError = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ─── cleanupWorktree ─────────────────────────────────────────────────────────

/**
 * Best-effort removal of a worktree directory. Errors are swallowed so that
 * cleanup never breaks the calling flow. Used when the caller wants silent
 * cleanup semantics (e.g. the `'discard'` worktree action). For the merge/PR
 * flows that need to surface cleanup failures, use
 * {@link mergeWorktreeToMain} / {@link pushWorktreeAndCreatePR} instead.
 */
export async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    removeWorktree(repoRoot, worktreePath);
  } catch {
    // Best-effort: ignore removal failures.
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Restore the previously checked-out branch. Errors are swallowed because
 * the repo may be in a detached-HEAD state where the symbolic ref is gone.
 * Used by {@link mergeWorktreeToMain} on the success path.
 */
function restoreSavedBranch(repoRoot: string, savedBranch: string): void {
  try {
    checkoutBranch(repoRoot, savedBranch);
  } catch {
    // Ignore - may be detached HEAD.
  }
}
