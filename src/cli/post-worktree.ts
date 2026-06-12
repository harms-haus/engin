import readline from 'node:readline';
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
} from '../core/git.js';
import { generateCommitMessage, pushAndCreatePR, resolveConflictsWithAgent } from '../core/worktree-lifecycle.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PostWorktreeAction = 'nothing' | 'merge' | 'pr';

export interface PostWorktreeOptions {
  profilesDirs: string[];
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  originalCwd: string;
  taskPrompt: string;
  apiKeys?: Record<string, string>;
}

// ─── Private: Commit in worktree ─────────────────────────────────────────────

export async function commitInWorktree(options: PostWorktreeOptions): Promise<void> {
  const diff = getDiff(options.worktreePath);
  if (!diff) return;

  stageAll(options.worktreePath);
  const message = await generateCommitMessage(
    options.profilesDirs,
    options.worktreePath,
    options.taskPrompt,
    diff,
    options.apiKeys,
  );
  commitChanges(options.worktreePath, message);
}

// ─── Private: Handle merge to main ──────────────────────────────────────────

export async function handleMergeToMain(options: PostWorktreeOptions): Promise<void> {
  const savedBranch = getCurrentBranch(options.repoRoot);

  await commitInWorktree(options);

  const mainBranch = getMainBranch(options.repoRoot);
  checkoutBranch(options.repoRoot, mainBranch);

  const result = mergeBranch(options.repoRoot, options.branchName);

  if (!result.success) {
    const resolved = await resolveConflictsWithAgent(
      options.profilesDirs,
      options.repoRoot,
      result.conflicts,
      options.taskPrompt,
      options.apiKeys,
    );

    if (resolved) {
      commitChanges(options.repoRoot, `Merge resolution: ${options.branchName} into ${mainBranch}`);
    } else {
      abortMerge(options.repoRoot);
      console.log(
        `⚠️ Conflicts could not be resolved automatically. The worktree is preserved at ${options.worktreePath}.`,
      );
      return;
    }
  }

  // Try to restore the saved branch (ignore errors for detached HEAD)
  try {
    checkoutBranch(options.repoRoot, savedBranch);
  } catch {
    // Ignore - may be detached HEAD
  }

  // Try to remove the worktree
  try {
    removeWorktree(options.repoRoot, options.worktreePath);
  } catch {
    console.log(`⚠️ Warning: Could not remove worktree at ${options.worktreePath}`);
  }

  console.log(`✅ Merged ${options.branchName} into ${mainBranch}`);
}

// ─── Private: Handle push and PR ─────────────────────────────────────────────

export async function handlePushAndPR(options: PostWorktreeOptions): Promise<void> {
  await commitInWorktree(options);

  // Derive title from task prompt (truncate at 57 chars with ellipsis if over 60)
  let title = options.taskPrompt;
  if (title.length > 60) {
    title = title.slice(0, 57) + '...';
  }

  await pushAndCreatePR(
    options.profilesDirs,
    options.repoRoot,
    options.branchName,
    options.taskPrompt,
    title,
    options.apiKeys,
  );

  try {
    removeWorktree(options.repoRoot, options.worktreePath);
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
          console.log(`📂 Worktree preserved at ${options.worktreePath}`);
          resolve();
        } else if (trimmed === '2') {
          process.removeListener('SIGINT', sigintHandler);
          rl.close();
          handleMergeToMain(options).then(resolve);
        } else if (trimmed === '3') {
          process.removeListener('SIGINT', sigintHandler);
          rl.close();
          handlePushAndPR(options).then(resolve);
        } else {
          console.log('Invalid choice. Please enter 1, 2, or 3.');
          ask();
        }
      });
    };

    ask();
  });
}
