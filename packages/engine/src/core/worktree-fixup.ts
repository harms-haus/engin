// ─── Worktree Fix-Up Primitive ──────────────────────────────────────────────
//
// `runTooledFixup` is a shared, self-verifying, tooled agent fix-up primitive
// reused for BOTH the hardened conflict resolver and the commit/lint-failure
// safety net.
//
// Unlike the structured-output / validation-retry paths (which re-prompt within
// an existing session and validate text/file output), this primitive:
//   - Spawns its OWN tool-using agent session (write/edit/bash enabled) scoped
//     to a single worktree.
//   - Drives the agent with free-form `session.prompt()` — NOT
//     `promptForStructured` — so the agent can freely edit files and run shell
//     commands to repair the error.
//   - Self-verifies by running `tsc --noEmit` then `eslint` directly in the
//     worktree (NOT `bun test`, which is too slow / too noisy for a fix-up
//     turn) and retries up to `maxAttempts` times, surfacing the previous
//     verification error on each retry.

import type { AgentLifecycleHandle } from './agent-lifecycle.js';
import { spawnAgent } from './agent-lifecycle.js';
import { loadProfilesFromDirs } from './profile.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FixupOptions {
  /** Directories to search for agent profile .md files */
  profilesDirs: string[];
  /** Worktree directory to operate in (agent cwd) */
  worktreePath: string;
  /** The original task prompt for context */
  taskPrompt: string;
  /** Error context: the error message, stderr, or conflict diff to fix */
  errorContext: string;
  /** Additional context (e.g. the other side's task prompt in a merge conflict) */
  additionalContext?: string;
  /** API keys for agent operations */
  apiKeys?: Record<string, string>;
  /** Profile ID to use (default: 'implementer') */
  profileId?: string;
  /** Max retry attempts (default: 3) */
  maxAttempts?: number;
}

export interface FixupResult {
  success: boolean;
  attempts: number;
  lastError?: string;
}

// ─── Prompt builder ─────────────────────────────────────────────────────────

/**
 * Build the base fix-up prompt describing the task and the error to repair.
 * The same base prompt is reused on every attempt; retry attempts append the
 * previous verification error (see {@link runTooledFixup}).
 */
function buildFixupPrompt(opts: FixupOptions): string {
  const lines: string[] = [
    'You are fixing errors in a git worktree.',
    '',
    `Task context: ${opts.taskPrompt}`,
    '',
    'Error to fix:',
    opts.errorContext,
  ];

  if (opts.additionalContext) {
    lines.push('', opts.additionalContext);
  }

  lines.push(
    '',
    'Fix the errors using your tools (edit files, run commands). After fixing, verify your fix compiles and passes linting.',
  );

  return lines.join('\n');
}

// ─── Self-verification ─────────────────────────────────────────────────────

/**
 * Run the self-verification commands in the worktree.
 *
 * Runs `tsc --noEmit` first; only when tsc passes does it run `eslint` over the
 * worktree. Returns the trimmed stderr of the first failing command, or
 * `undefined` when both pass.
 *
 * `bun test` is intentionally NOT run — the full suite is too slow and may fail
 * for reasons unrelated to the fix-up.
 */
async function verifyWorktree(worktreePath: string): Promise<string | undefined> {
  const tscProc = Bun.spawn({
    cmd: ['bunx', 'tsc', '--noEmit'],
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [tscExitCode, tscStderr] = await Promise.all([tscProc.exited, new Response(tscProc.stderr).text()]);
  if (tscExitCode !== 0) {
    return tscStderr.trim();
  }

  const eslintProc = Bun.spawn({
    cmd: ['bunx', 'eslint', '--no-error-on-unmatched-pattern', '.'],
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [eslintExitCode, eslintStderr] = await Promise.all([eslintProc.exited, new Response(eslintProc.stderr).text()]);
  if (eslintExitCode !== 0) {
    return eslintStderr.trim();
  }

  return undefined;
}

// ─── runTooledFixup ─────────────────────────────────────────────────────────

/**
 * Spawn a tool-using agent in `opts.worktreePath`, hand it the error/task
 * context, and let it repair the issue using its write/edit/bash tools. After
 * each agent turn the worktree is self-verified (`tsc` then `eslint`); on
 * failure the previous verification error is appended to the next retry prompt.
 *
 * The session is ALWAYS disposed in a `finally` block — on success, on
 * verification exhaustion, and when the agent turn itself throws.
 *
 * @returns a {@link FixupResult} indicating success and the number of attempts.
 */
export async function runTooledFixup(opts: FixupOptions): Promise<FixupResult> {
  const profileId = opts.profileId ?? 'implementer';
  const maxAttempts = opts.maxAttempts ?? 3;
  const basePrompt = buildFixupPrompt(opts);

  let handle: AgentLifecycleHandle | undefined;
  try {
    const profiles = await loadProfilesFromDirs(opts.profilesDirs);

    handle = await spawnAgent(
      {
        profileId,
        agentId: 'worktree-fixup',
        cwd: opts.worktreePath,
        isReadOnly: false,
        allowedWriteDirs: [opts.worktreePath],
        phaseId: 'worktree-fixup',
        taskId: 'fixup',
        stepIndex: 0,
        stepName: 'fixup',
        apiKeys: opts.apiKeys,
      },
      profiles,
    );

    let verificationError: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const promptText =
        attempt === 0 || verificationError === undefined
          ? basePrompt
          : `${basePrompt}\n\nPrevious verification failed with:\n${verificationError}\n\nPlease correct the error above and verify again.`;

      await handle.session.prompt(promptText);

      verificationError = await verifyWorktree(opts.worktreePath);
      if (!verificationError) {
        return { success: true, attempts: attempt + 1 };
      }
    }

    return { success: false, attempts: maxAttempts, lastError: verificationError };
  } finally {
    handle?.dispose();
  }
}
