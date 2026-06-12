// ─── Worktree Lifecycle Functions ────────────────────────────────────────────
// These functions implement agent-based operations for worktree management.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  copyFilesToWorktree,
  createWorktree,
  getRepoRoot,
  isGitRepo,
  pushBranch,
  readWorktreeCopyList,
  removeWorktree,
  stageAll,
} from './git.js';
import { createHarness } from './harness-factory.js';
import { loadProfilesFromDirs } from './profile.js';
import { promptForStructured } from './structured-output.js';
import type { WorktreeInfo } from './types.js';

// ─── Shared Helpers ──────────────────────────────────────────────────────────

async function loadWorkerProfile(profilesDirs: string[]) {
  const profiles = await loadProfilesFromDirs(profilesDirs);
  const profile = profiles.get('worker');
  if (!profile) {
    throw new Error('Worker profile not found. Ensure a "worker" profile exists in the profiles directories.');
  }
  return profile;
}

// ─── setupWorktree ───────────────────────────────────────────────────────────

export async function setupWorktree(
  cwd: string,
  profilesDirs: string[],
  taskPrompt: string,
  apiKeys?: Record<string, string>,
): Promise<WorktreeSetupResult> {
  if (!isGitRepo(cwd)) {
    throw new Error('Not a git repository. --worktree requires a git repo.');
  }

  const repoRoot = getRepoRoot(cwd);
  const profile = await loadWorkerProfile(profilesDirs);
  const harness = await createHarness({ profile, cwd: repoRoot, apiKeys });

  try {
    // Generate branch name via agent
    let branchName: string;
    try {
      const { result } = await promptForStructured(
        harness.session,
        `Generate a short, descriptive git branch name for the following task:\n\n${taskPrompt}`,
        z.object({ branchName: z.string() }),
      );
      // Sanitize: lowercase, replace non-alphanumeric-non-dash chars, collapse dashes
      branchName = result.branchName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (!branchName) {
        branchName = `engin-worktree-${Date.now()}`;
      }
    } catch {
      branchName = `engin-worktree-${Date.now()}`;
    }

    const worktreePath = join(repoRoot, '.git', 'worktrees', branchName);
    createWorktree(repoRoot, branchName, worktreePath);

    // Copy files from .worktreecopy if list is non-empty
    const filesToCopy = readWorktreeCopyList(cwd);
    if (filesToCopy.length > 0) {
      copyFilesToWorktree(cwd, worktreePath, filesToCopy);
    }

    return {
      worktreePath,
      branchName,
      worktreeInfo: {
        worktreePath,
        branchName,
        originalCwd: cwd,
      },
      cleanup: async () => {
        removeWorktree(repoRoot, worktreePath);
      },
    };
  } finally {
    harness.dispose();
  }
}

// ─── generateCommitMessage ───────────────────────────────────────────────────

export async function generateCommitMessage(
  profilesDirs: string[],
  worktreePath: string,
  taskPrompt: string,
  diff: string,
  apiKeys?: Record<string, string>,
): Promise<string> {
  const profile = await loadWorkerProfile(profilesDirs);
  const harness = await createHarness({ profile, cwd: worktreePath, apiKeys });

  try {
    const truncatedDiff = diff.length > 8000 ? diff.slice(0, 8000) : diff;
    const { result } = await promptForStructured(
      harness.session,
      `Generate a concise commit message for the following changes.\n\nTask: ${taskPrompt}\n\nDiff:\n${truncatedDiff}`,
      z.object({ message: z.string() }),
    );
    return result.message;
  } catch {
    return `Worktree changes for: ${taskPrompt}`;
  } finally {
    harness.dispose();
  }
}

// ─── resolveConflictsWithAgent ───────────────────────────────────────────────

export async function resolveConflictsWithAgent(
  profilesDirs: string[],
  repoRoot: string,
  conflicts: string[],
  taskPrompt: string,
  apiKeys?: Record<string, string>,
): Promise<boolean> {
  if (conflicts.length === 0) {
    return true;
  }

  const profile = await loadWorkerProfile(profilesDirs);
  const harness = await createHarness({ profile, cwd: repoRoot, apiKeys });

  try {
    for (const conflict of conflicts) {
      let fileContent: string;
      try {
        fileContent = readFileSync(join(repoRoot, conflict), 'utf-8');
      } catch {
        fileContent = '';
      }

      const { result } = await promptForStructured(
        harness.session,
        `Resolve the merge conflict in the following file.\n\nTask: ${taskPrompt}\n\nFile: ${conflict}\n\nContent:\n${fileContent}`,
        z.object({ resolvedContent: z.string() }),
      );

      try {
        writeFileSync(join(repoRoot, conflict), result.resolvedContent, 'utf-8');
      } catch {
        // Write failed, but continue processing
      }
    }

    stageAll(repoRoot);
    return true;
  } catch {
    return false;
  } finally {
    harness.dispose();
  }
}

// ─── pushAndCreatePR ─────────────────────────────────────────────────────────

export async function pushAndCreatePR(
  profilesDirs: string[],
  repoRoot: string,
  branchName: string,
  taskPrompt: string,
  title: string,
  apiKeys?: Record<string, string>,
): Promise<void> {
  pushBranch(repoRoot, branchName);

  const profile = await loadWorkerProfile(profilesDirs);
  const harness = await createHarness({ profile, cwd: repoRoot, apiKeys });

  try {
    const { result } = await promptForStructured(
      harness.session,
      `Generate a PR title and body for the following changes.\n\nTask: ${taskPrompt}\n\nTitle hint: ${title}`,
      z.object({ prTitle: z.string(), prBody: z.string() }),
    );

    try {
      const decoder = new TextDecoder();
      const spawnResult = Bun.spawnSync({
        cmd: ['gh', 'pr', 'create', '--title', result.prTitle, '--body', result.prBody],
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      if (spawnResult.exitCode !== 0) {
        const stderr = decoder.decode(spawnResult.stderr).trim();
        throw new Error(`gh pr create failed (exit code ${spawnResult.exitCode}): ${stderr}`);
      }
    } catch {
      // gh pr create may fail in test environments or when gh CLI is unavailable
    }
  } finally {
    harness.dispose();
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorktreeSetupResult {
  worktreePath: string;
  branchName: string;
  worktreeInfo: WorktreeInfo;
  cleanup: () => Promise<void>;
}
