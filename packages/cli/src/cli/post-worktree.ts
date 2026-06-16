import {
  abortMerge,
  checkoutBranch,
  commitChanges,
  generateCommitMessage,
  getCurrentBranch,
  getDiff,
  getMainBranch,
  mergeBranch,
  pushAndCreatePR,
  removeWorktree,
  resolveConflictsWithAgent,
  stageAll,
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
  const diff = getDiff(options.worktreePath);
  if (!diff) return;

  stageAll(options.worktreePath);
  const message = await generateCommitMessage(
    profilesDirs,
    options.worktreePath,
    options.taskPrompt,
    diff,
    options.apiKeys,
  );
  commitChanges(options.worktreePath, message);
}

// ─── Private: Handle merge to main ──────────────────────────────────────────

export async function handleMergeToMain(options: PostWorktreeOptions): Promise<void> {
  const repoRoot = options.repoRoot;
  const profilesDirs = options.profilesDirs;
  if (!repoRoot || !profilesDirs) {
    throw new Error('handleMergeToMain requires options.repoRoot and options.profilesDirs to be set');
  }
  const savedBranch = getCurrentBranch(repoRoot);

  await commitInWorktree(options);

  const mainBranch = getMainBranch(repoRoot);
  checkoutBranch(repoRoot, mainBranch);

  const result = mergeBranch(repoRoot, options.branchName);

  if (!result.success) {
    const resolved = await resolveConflictsWithAgent(
      profilesDirs,
      repoRoot,
      result.conflicts,
      options.taskPrompt,
      options.apiKeys,
    );

    if (resolved) {
      commitChanges(repoRoot, `Merge resolution: ${options.branchName} into ${mainBranch}`);
    } else {
      abortMerge(repoRoot);
      console.log(
        `⚠️ Conflicts could not be resolved automatically. The worktree is preserved at ${options.worktreePath}.`,
      );
      return;
    }
  }

  // Try to restore the saved branch (ignore errors for detached HEAD)
  try {
    checkoutBranch(repoRoot, savedBranch);
  } catch {
    // Ignore - may be detached HEAD
  }

  // Try to remove the worktree
  try {
    removeWorktree(repoRoot, options.worktreePath);
  } catch {
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

  await commitInWorktree(options);

  // Derive title from task prompt (truncate at 57 chars with ellipsis if over 60)
  let title = options.taskPrompt;
  if (title.length > 60) {
    title = title.slice(0, 57) + '...';
  }

  await pushAndCreatePR(profilesDirs, repoRoot, options.branchName, options.taskPrompt, title, options.apiKeys);

  try {
    removeWorktree(repoRoot, options.worktreePath);
  } catch {
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
