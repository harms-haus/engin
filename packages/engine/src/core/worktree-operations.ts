// ─── Shared Worktree Operations ──────────────────────────────────────────────
//
// Reusable git + agent operations for worktree handling. These functions are
// pure orchestrations over the git.ts primitives and the worktree-lifecycle.ts
// / worktree-fixup.ts agent helpers. They do NOT print to the console — callers
// decide how to surface progress/results to their context (CLI vs. server log).
//
// The module exports:
//
//   - `commitWorktreeChanges` — stage + commit pending changes (with a lint
//     fix-up safety net).
//   - `commitWithFixupRetry` —  shared retry-with-fixup helper used by both
//     `commitWorktreeChanges` and `WorktreeManager.commitMergeWithRetry`.
//   - `createLintValidationGate` — the PRIMARY lint defence used by oneStepTask
//     validation.

import { commitChanges, getDiff, stageAll } from './git.js';
import { runTooledFixup } from './worktree-fixup.js';
import { generateCommitMessage } from './worktree-lifecycle.js';

// ─── commitWithFixupRetry ────────────────────────────────────────────────────

export interface CommitWithFixupRetryOptions {
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Commit message to use for both the initial attempt and the retry. */
  message: string;
  /** Profiles directories for the tooled fix-up agent. */
  profilesDirs: string[];
  /** The task prompt that seeded the run (forwarded to the fix-up agent). */
  taskPrompt: string;
  /** API keys for agent operations. */
  apiKeys?: Record<string, string>;
}

/**
 * Attempt a git commit, and on pre-commit/lint-hook rejection spawn the tooled
 * fix-up agent, re-stage, and retry the commit exactly once through the REAL
 * hook (never `--no-verify`). On exhaustion (fix-up fails OR the retry commit
 * also throws) the ORIGINAL commit error is re-thrown so callers see the real
 * gate failure. The fix-up primitive retries internally; this helper only
 * retries the COMMIT once.
 */
export async function commitWithFixupRetry(opts: CommitWithFixupRetryOptions): Promise<void> {
  try {
    await commitChanges(opts.worktreePath, opts.message);
    return;
  } catch (commitError) {
    const errorContext = commitError instanceof Error ? commitError.message : String(commitError);

    const fixupResult = await runTooledFixup({
      profilesDirs: opts.profilesDirs,
      worktreePath: opts.worktreePath,
      taskPrompt: opts.taskPrompt,
      errorContext,
      apiKeys: opts.apiKeys,
    });

    if (!fixupResult.success) {
      throw commitError;
    }

    await stageAll(opts.worktreePath);
    try {
      await commitChanges(opts.worktreePath, opts.message);
    } catch {
      throw commitError;
    }
  }
}

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

// ─── commitWorktreeChanges ───────────────────────────────────────────────────

/**
 * Stage and commit any uncommitted changes inside the worktree using an
 * agent-generated commit message. No-op when the working tree is clean.
 *
 * Delegates the retry-with-fixup safety net to {@link commitWithFixupRetry}.
 * For the PRIMARY lint defence (run before the commit), see
 * {@link createLintValidationGate}.
 */
export async function commitWorktreeChanges(opts: CommitWorktreeOptions): Promise<void> {
  // Stage FIRST (before the diff guard) so UNTRACKED files are included.
  // `getDiff` reads only tracked modifications + the staged set; an untracked-
  // only change (e.g. a workflow that creates new files) would otherwise make
  // `getDiff` return empty and trigger an early no-op return — leaving the
  // worktree branch with no new commit. That in turn makes the run-end squash
  // merge a fast-forward no-op, so `git commit` fails with "nothing to commit"
  // and the worktree is left unmerged. Staging up front (a no-op when clean)
  // ensures the diff reflects every change before the guard runs.
  await stageAll(opts.worktreePath);
  const diff = await getDiff(opts.worktreePath);
  if (!diff) return;

  const message = await generateCommitMessage(
    opts.profilesDirs,
    opts.worktreePath,
    opts.taskPrompt,
    diff,
    opts.apiKeys,
  );

  await commitWithFixupRetry({
    worktreePath: opts.worktreePath,
    message,
    profilesDirs: opts.profilesDirs,
    taskPrompt: opts.taskPrompt,
    apiKeys: opts.apiKeys,
  });
}

// ─── createLintValidationGate ────────────────────────────────────────────────

/**
 * Create a `validateOutput` callback suitable for `oneStepTask`'s
 * `validateOutput` option. This is the PRIMARY lint defence: it runs
 * `prettier --write` + a single `eslint --fix` pass in the worktree
 * (format, then auto-fix + report). Returns `{ error: 'Lint errors
 * remain: ...' }` when unfixable errors remain after the auto-fix pass, or
 * `undefined` when clean.
 *
 * The `eslint --fix` exit code is authoritative: `eslint --fix` exits
 * non-zero and emits the remaining (unfixable) errors in its report when
 * any errors survive the auto-fix pass, so a separate check-only invocation
 * is unnecessary. The commit-failure fix-up safety net in
 * {@link commitWorktreeChanges} is the fallback for anything this gate (or
 * the commit hook) misses.
 *
 * The returned callback is stateless: each invocation re-runs the full
 * format + auto-fix sequence.
 */
export function createLintValidationGate(worktreePath: string): () => Promise<{ error?: string } | undefined> {
  return async () => {
    // Format the code first (awaited so the subsequent lint pass sees
    // prettier-formatted output), then run a single eslint --fix pass whose
    // exit code is authoritative: a non-zero exit means unfixable lint errors
    // remain. Both spawns use async `Bun.spawn` with awaited `.exited`
    // (NOT `Bun.spawnSync`) so they do not block the server event loop — this
    // gate runs on every task validation iteration, so a blocking spawn would
    // stall all concurrent run traffic. Mirrors the conversion already
    // applied to `verifyWorktree` in worktree-fixup.ts. The two spawns handle
    // stdio differently: prettier's stdout/stderr are set to 'ignore' (its
    // output is discarded, and piping without draining would fill the OS pipe
    // buffer and deadlock the spawn), while eslint's are piped AND drained in
    // parallel below (its report is the authoritative error surface).
    const prettierProc = Bun.spawn({
      cmd: ['bunx', 'prettier', '--write', '.'],
      cwd: worktreePath,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    // prettier --write is fire-and-forget (its exit code is ignored and its
    // output discarded), but we still await its completion so eslint sees the
    // formatted output.
    await prettierProc.exited;

    const eslintProc = Bun.spawn({
      cmd: ['bunx', 'eslint', '--fix', '.'],
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Drain stdout/stderr in parallel with awaiting exit so the proc's pipe
    // buffers cannot fill and deadlock the spawn.
    const [exitCode, stdout, stderr] = await Promise.all([
      eslintProc.exited,
      new Response(eslintProc.stdout).text(),
      new Response(eslintProc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return { error: `Lint errors remain: ${output}` };
    }

    return undefined;
  };
}
