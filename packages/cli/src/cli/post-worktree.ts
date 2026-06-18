import {
  commitWorktreeChanges,
  getMainBranch,
  mergeWorktreeToMain,
  pushWorktreeAndCreatePR,
} from '@harms-haus/engin-engine';
import readline from 'node:readline';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PostWorktreeAction = 'nothing' | 'merge' | 'pr';

/** The worktree action chosen by the user (T33 server-side decision). */
export type WorktreeDecision = 'keep' | 'discard' | 'merge' | 'pr';

export interface PostWorktreeOptions {
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Name of the branch checked out in the worktree. */
  branchName: string;
  /** The task prompt that seeded the run. */
  taskPrompt: string;
  /** Profiles directories for agent-based git operations (local fallback path). */
  profilesDirs?: string[];
  /** Repository root path (local fallback path). */
  repoRoot?: string;
  /** The original working directory before switching to the worktree. */
  originalCwd?: string;
  /** API keys for agent operations (local fallback path). */
  apiKeys?: Record<string, string>;
  /**
   * T33: When provided, the chosen action is sent to the server via this
   * callback instead of performing local git operations. When omitted, the
   * prompt falls back to performing git operations directly (legacy path).
   */
  sendDecision?: (action: WorktreeDecision) => Promise<void>;
  /** T33: The run ID associated with this worktree. */
  runId?: string;
}

// ─── Private: Commit in worktree ─────────────────────────────────────────────

export async function commitInWorktree(options: PostWorktreeOptions): Promise<void> {
  const profilesDirs = options.profilesDirs;
  if (!profilesDirs) {
    throw new Error('commitInWorktree requires options.profilesDirs to be set');
  }
  await commitWorktreeChanges({
    profilesDirs,
    worktreePath: options.worktreePath,
    taskPrompt: options.taskPrompt,
    apiKeys: options.apiKeys,
  });
}

// ─── Private: Handle merge to main ──────────────────────────────────────────

export async function handleMergeToMain(options: PostWorktreeOptions): Promise<void> {
  const repoRoot = options.repoRoot;
  const profilesDirs = options.profilesDirs;
  if (!repoRoot || !profilesDirs) {
    throw new Error('handleMergeToMain requires options.repoRoot and options.profilesDirs to be set');
  }

  // Resolved eagerly so the success message can name the target branch.
  const mainBranch = getMainBranch(repoRoot);

  let result;
  try {
    result = await mergeWorktreeToMain({
      profilesDirs,
      repoRoot,
      worktreePath: options.worktreePath,
      branchName: options.branchName,
      taskPrompt: options.taskPrompt,
      apiKeys: options.apiKeys,
    });
  } catch (err) {
    // A thrown error means the operation itself failed (commit, checkout,
    // merge, conflict resolution, or branch restore) — the merge did NOT
    // complete, so we must NOT print the success line. Surface the real
    // error instead. (The shared module only surfaces worktree-removal
    // failures via `cleanupError`, never via a throw.)
    console.log(`❌ Merge of ${options.branchName} failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!result.success) {
    console.log(
      `⚠️ Conflicts could not be resolved automatically. The worktree is preserved at ${options.worktreePath}.`,
    );
    return;
  }

  // The merge succeeded. Worktree removal is best-effort: when the shared
  // module could not delete the on-disk directory it reports the failure via
  // `cleanupError`. We warn the user that the worktree is still on disk while
  // still reporting the successful merge.
  if (result.cleanupError) {
    console.log(`⚠️ Warning: Could not remove worktree at ${options.worktreePath}`);
  }

  console.log(`✅ Merged ${options.branchName} into ${mainBranch}`);
}

// ─── Private: Handle push and PR ─────────────────────────────────────────────

export async function handlePushAndPR(options: PostWorktreeOptions): Promise<void> {
  const repoRoot = options.repoRoot;
  const profilesDirs = options.profilesDirs;
  if (!repoRoot || !profilesDirs) {
    throw new Error('handlePushAndPR requires options.repoRoot and options.profilesDirs to be set');
  }

  // Derive title from task prompt (truncate at 57 chars with ellipsis if over 60).
  // Truncation lives in the caller — the shared pushWorktreeAndCreatePR
  // forwards the title verbatim.
  let title = options.taskPrompt;
  if (title.length > 60) {
    title = title.slice(0, 57) + '...';
  }

  // Only real push/PR (or commit) failures throw from the shared module —
  // worktree-removal failures are surfaced via the return value so we can warn
  // the user without misreporting the push/PR itself as failed.
  let result;
  try {
    result = await pushWorktreeAndCreatePR({
      profilesDirs,
      repoRoot,
      worktreePath: options.worktreePath,
      branchName: options.branchName,
      taskPrompt: options.taskPrompt,
      title,
      apiKeys: options.apiKeys,
    });
  } catch (err) {
    console.log(`❌ Push/PR for ${options.branchName} failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // The push + PR creation succeeded. Warn (but still report success) when the
  // worktree directory could not be removed.
  if (result.cleanupError) {
    console.log(`⚠️ Warning: Could not remove worktree at ${options.worktreePath}`);
  }

  console.log(`✅ Successfully pushed and created PR for ${options.branchName}`);
}

// ─── Readline interface for testing ──────────────────────────────────────────

export interface ReadlineQuestioner {
  question(prompt: string, callback: (answer: string) => void): void;
  close(): void;
}

function createReadlineInterface(): ReadlineQuestioner {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// ─── Main prompt ─────────────────────────────────────────────────────────────

export async function promptPostWorktreeAction(
  options: PostWorktreeOptions,
  createRl: () => ReadlineQuestioner = createReadlineInterface,
): Promise<void> {
  console.log('');
  console.log('Workflow completed in worktree. What would you like to do?');
  console.log('  1. Do nothing (keep worktree)');
  console.log('  2. Merge to main');
  console.log('  3. Push and create pull request');
  console.log('');

  const rl = createRl();
  const sendDecision = options.sendDecision;

  return new Promise<void>((resolve) => {
    const sigintHandler = () => {
      rl.close();
      console.log(`📂 Worktree preserved at ${options.worktreePath}`);
      resolve();
    };

    process.once('SIGINT', sigintHandler);

    const ask = () => {
      rl.question('Choose (1-3): ', (answer) => {
        const trimmed = answer.trim();

        if (trimmed === '1') {
          process.removeListener('SIGINT', sigintHandler);
          rl.close();
          if (sendDecision) {
            sendDecision('keep').then(() => {
              console.log(`📂 Worktree preserved at ${options.worktreePath}`);
              resolve();
            });
          } else {
            console.log(`📂 Worktree preserved at ${options.worktreePath}`);
            resolve();
          }
        } else if (trimmed === '2') {
          process.removeListener('SIGINT', sigintHandler);
          rl.close();
          if (sendDecision) {
            sendDecision('merge').then(resolve);
          } else {
            handleMergeToMain(options).then(resolve);
          }
        } else if (trimmed === '3') {
          process.removeListener('SIGINT', sigintHandler);
          rl.close();
          if (sendDecision) {
            sendDecision('pr').then(resolve);
          } else {
            handlePushAndPR(options).then(resolve);
          }
        } else {
          console.log('Invalid choice. Please enter 1, 2, or 3.');
          ask();
        }
      });
    };

    ask();
  });
}
