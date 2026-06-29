// ─── Final Merge to Real Main ─────────────────────────────────────────────
//
// Standalone functions for the run-end final merge of the `engin/{mainSlug}`
// worktree branch into the REAL repo `main` branch, extracted OUT of
// `WorktreeManager` (which owns the per-task worktree lifecycle). The
// concerns are distinct: the per-task cycle (create / merge / cull) operates
// on isolated task worktrees, whereas the final merge operates on the repo
// root itself.
//
// These functions receive the shared state they need via a {@link
// FinalMergeContext} (repoRoot, mainBranch, mainWorktreePath, profilesDirs,
// apiKeys, and a `withGitLock` callback) so they can be used standalone
// without re-creating the WorktreeManager's single shared git-lock mutex.
// `WorktreeManager.finalMergeToMain` / `resolveFinalMergeConflicts` /
// `abortFinalMerge` delegate to these, passing `this`-derived context.

import {
  abortMerge,
  checkoutBranch,
  commitChanges,
  getCurrentBranch,
  getMainBranch,
  resetHard,
  restoreSavedBranch,
  squashMergeBranch,
  stageFiles,
} from './git.js';
import { resolveConflictsWithAgent } from './worktree-lifecycle.js';
import { commitWorktreeChanges } from './worktree-operations.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The shared state every final-merge function needs from the owning
 * `WorktreeManager`. `withGitLock` is supplied as a callback so the
 * extracted functions route through the SAME single shared-state git mutex
 * the WorktreeManager uses for every other shared-state git operation
 * (avoiding a duplicate lock that could race the original).
 */
export interface FinalMergeContext {
  /** Absolute path to the real git repository root. */
  repoRoot: string;
  /** The main-wt branch name (`engin/{mainSlug}`). */
  mainBranch: string;
  /** Absolute path to the main worktree (`{workDir}/worktree`). */
  mainWorktreePath: string;
  /** Profile directories for agent-based commit / conflict operations. */
  profilesDirs: string[];
  /** API keys for agent operations. */
  apiKeys?: Record<string, string>;
  /** Serializes a shared-state git operation (see WorktreeManager.withGitLock). */
  withGitLock: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Mutable holder for the `savedBranch` field, so {@link finalMergeToMain} can
 * capture the branch checked out at repoRoot when the merge began and
 * {@link resolveFinalMergeConflicts} / the WorktreeManager's `cleanup()` can
 * read / restore it across the separate calls of the conflict → resolve flow.
 * Mirrors the `savedBranch` instance field on `WorktreeManager`.
 */
export interface SavedBranchHolder {
  savedBranch?: string;
}

/** Result of {@link finalMergeToMain}. */
export interface FinalMergeResult {
  success: boolean;
  conflicts: string[];
  conflictsResolved: boolean;
  error?: string;
}

/** Result of {@link resolveFinalMergeConflicts}. */
export interface ResolveFinalMergeResult {
  resolved: boolean;
  error?: string;
}

// ─── Functions ──────────────────────────────────────────────────────────────

/**
 * Squash-merges the main-wt branch (`ctx.mainBranch`) into the REAL `main`
 * branch at `ctx.repoRoot`. Used by the run-end final merge UX.
 *
 * On conflict, does NOT abort — the caller decides whether to resolve (via
 * {@link resolveFinalMergeConflicts}) or abort (via {@link abortFinalMerge}).
 * The repo is left on real `main` with the merge in progress.
 *
 * On a clean merge, the previously-checked-out branch (captured into
 * `holder.savedBranch`) is restored. On a commit failure, the staged squash
 * is rolled back (abort + resetHard) and the saved branch is restored before
 * re-throwing.
 *
 * Returns `{ success, conflicts, conflictsResolved, error? }`. On a clean
 * merge, `conflicts` is empty and `conflictsResolved` is false.
 */
export async function finalMergeToMain(ctx: FinalMergeContext, holder: SavedBranchHolder): Promise<FinalMergeResult> {
  return ctx.withGitLock(async () => {
    // 1. Commit any pending changes in the main worktree.
    await commitWorktreeChanges({
      profilesDirs: ctx.profilesDirs,
      worktreePath: ctx.mainWorktreePath,
      taskPrompt: 'Final merge',
      apiKeys: ctx.apiKeys,
    });

    // 2. Save the currently-checked-out branch so it can be restored after.
    //    Stored on the holder (not a local) so it survives across the
    //    conflict → resolve flow, where `resolveFinalMergeConflicts` runs in a
    //    separate call and `WorktreeManager.cleanup()` performs the actual
    //    restore.
    holder.savedBranch = getCurrentBranch(ctx.repoRoot);

    // 3. Check out the real main branch.
    const realMain = getMainBranch(ctx.repoRoot);
    checkoutBranch(ctx.repoRoot, realMain);

    // 4. Squash-merge the main-wt branch into real main.
    const result = squashMergeBranch(ctx.repoRoot, ctx.mainBranch);

    if (result.success) {
      try {
        commitChanges(ctx.repoRoot, `Merge engin run: ${ctx.mainBranch}`);
      } catch (commitErr) {
        // Roll back the staged squash so real main is left clean for a
        // caller retry / manual intervention (mirrors the per-task merge).
        try {
          abortMerge(ctx.repoRoot);
        } catch {
          /* no merge in progress */
        }
        try {
          resetHard(ctx.repoRoot);
        } catch {
          /* best-effort */
        }
        restoreSavedBranch(ctx.repoRoot, holder.savedBranch);
        throw commitErr;
      }
      restoreSavedBranch(ctx.repoRoot, holder.savedBranch);
      return { success: true, conflicts: [], conflictsResolved: false };
    }

    // On conflict, leave the repo on real main with the merge in progress so
    // the caller can resolve or abort. Do NOT restore the saved branch — the
    // caller's next action operates on the conflicted merge state.
    return {
      success: false,
      conflicts: result.conflicts,
      conflictsResolved: false,
      ...(result.error ? { error: result.error } : {}),
    };
  });
}

/**
 * Resolves conflicts from a failed {@link finalMergeToMain} via the agent.
 * On success, stages the resolved files and commits the merge. Returns
 * `{ resolved: true }` when all conflicts were resolved, or
 * `{ resolved: false, error? }` when the agent could not resolve them
 * (carrying a short diagnostic for the client).
 */
export async function resolveFinalMergeConflicts(
  ctx: FinalMergeContext,
  conflicts: string[],
  taskPrompt: string,
): Promise<ResolveFinalMergeResult> {
  return ctx.withGitLock(async () => {
    const resolveResult = await resolveConflictsWithAgent(
      ctx.profilesDirs,
      ctx.repoRoot,
      conflicts,
      taskPrompt,
      ctx.apiKeys,
    );

    if (!resolveResult.resolved) {
      return { resolved: false, ...(resolveResult.error ? { error: resolveResult.error } : {}) };
    }

    stageFiles(ctx.repoRoot, conflicts);
    try {
      commitChanges(ctx.repoRoot, `Merge resolution: ${ctx.mainBranch}`);
    } catch (commitErr) {
      try {
        abortMerge(ctx.repoRoot);
      } catch {
        /* no merge in progress */
      }
      try {
        resetHard(ctx.repoRoot);
      } catch {
        /* best-effort */
      }
      throw commitErr;
    }
    return { resolved: true };
  });
}

/**
 * Aborts an in-progress final merge on the repo root. Used when the caller
 * decides not to resolve conflicts from {@link finalMergeToMain}.
 */
export async function abortFinalMerge(ctx: FinalMergeContext): Promise<void> {
  await ctx.withGitLock(() => Promise.resolve(abortMerge(ctx.repoRoot)));
}
