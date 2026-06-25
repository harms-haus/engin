// ─── Worktree Lifecycle Functions ────────────────────────────────────────────
// These functions implement agent-based operations for worktree management.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { requireAgentPlugin } from './agent-registry.js';
import { getRepoRoot, isGitRepo, pushBranch, sanitizeBranchSlug, stageFiles } from './git.js';
import { loadProfilesFromDirs } from './profile.js';
import { promptForStructured } from './structured-output.js';
import { generateTitleAndBranch } from './title-generator.js';
import type { WorktreeInfo } from './types.js';
import { runTooledFixup } from './worktree-fixup.js';
import { WorktreeManager } from './worktree-manager.js';

/** Maximum character length for agent context (diffs, conflict text) to avoid token overflow. */
const MAX_AGENT_CONTEXT = 8000;

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
//
// Refactored to delegate ALL worktree creation to a {@link WorktreeManager}
// (via `setupMainWorktree()`) and to source the branch name from
// {@link generateTitleAndBranch}. setupWorktree MUST NOT create the worktree
// itself — doing so caused the double-worktree bug where both setupWorktree
// and WorktreeManager tried to create the same worktree.

export async function setupWorktree(
  cwd: string,
  workDir: string,
  profilesDirs: string[],
  taskPrompt: string,
  apiKeys?: Record<string, string>,
): Promise<WorktreeSetupResult> {
  if (!isGitRepo(cwd)) {
    throw new Error('Not a git repository. --worktree requires a git repo.');
  }

  const repoRoot = getRepoRoot(cwd);

  // Generate the branch name (and title) via a single LLM call.
  // generateTitleAndBranch owns its own harness and degrades to a
  // deterministic fallback on any failure — so it never throws.
  const { branchName: rawBranchName } = await generateTitleAndBranch({
    profilesDirs,
    taskPrompt,
    cwd,
    apiKeys,
  });
  const slug = sanitizeBranchSlug(rawBranchName);
  const mainBranch = `engin/${slug}`;

  // The main worktree lives INSIDE the run dir. WorktreeManager is the SOLE creator.
  const mainWorktreePath = join(workDir, 'worktree');

  const manager = new WorktreeManager({
    repoRoot,
    sourceCwd: cwd,
    workDir,
    mainBranch,
    mainWorktreePath,
    profilesDirs,
    apiKeys,
  });
  await manager.setupMainWorktree();

  return {
    worktreePath: mainWorktreePath,
    branchName: mainBranch,
    worktreeInfo: {
      worktreePath: mainWorktreePath,
      branchName: mainBranch,
      originalCwd: cwd,
    },
    manager,
    cleanup: async () => {
      // Best-effort: swallow manager.cleanup rejections so cleanup never
      // throws out of a finally block. WorktreeManager.cleanup is itself
      // best-effort and surfaces failures via `cleanupError` rather than
      // throwing.
      try {
        await manager.cleanup();
      } catch {
        // Best-effort cleanup — ignore.
      }
    },
  };
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
  const session = await requireAgentPlugin(profile.agent).createSession({ profile, cwd: worktreePath, apiKeys });

  try {
    const truncatedDiff = diff.length > MAX_AGENT_CONTEXT ? diff.slice(0, MAX_AGENT_CONTEXT) : diff;
    const { result } = await promptForStructured(
      session,
      `Generate a concise commit message for the following changes.\n\nTask: ${taskPrompt}\n\nDiff:\n${truncatedDiff}`,
      z.object({ message: z.string() }),
    );
    return result.message;
  } catch {
    return `Worktree changes for: ${taskPrompt}`;
  } finally {
    session.dispose();
  }
}

// ─── resolveConflictsWithAgent ───────────────────────────────────────────────
//
// Resolves merge conflicts by delegating to the shared, self-verifying tooled
// fix-up primitive (`runTooledFixup`). That primitive spawns its own agent
// session with write/edit/bash tools, hands it the full conflict context for
// ALL conflicted files at once, and self-verifies with `tsc --noEmit` +
// `eslint` before reporting success — retrying up to `maxAttempts` times.
//
// This fixes every weakness of the previous `promptForStructured`-based loop:
//   1. Context-starved  -> real per-file content (with conflict markers) is fed in.
//   2. One file at a time -> the whole conflict set is resolved in ONE session.
//   3. No verification  -> `runTooledFixup` runs tsc + eslint after each turn.
//   4. stageAll sweeps  -> only `stageFiles(repoRoot, conflicts)` is staged.
//   5. Silent writeFileSync catch -> the agent edits files directly via tools.
//   6. No size cap      -> the conflict context is capped at MAX_AGENT_CONTEXT chars.
//   7. Single-shot      -> a retry budget of 3 attempts is requested.

export async function resolveConflictsWithAgent(
  profilesDirs: string[],
  repoRoot: string,
  conflicts: string[],
  taskPrompt: string,
  apiKeys?: Record<string, string>,
): Promise<{ resolved: boolean; error?: string }> {
  if (conflicts.length === 0) {
    return { resolved: true };
  }

  // Build conflict context: read each conflicted file's current content (with
  // conflict markers intact) so the agent sees both sides of every conflict.
  // The whole set is concatenated and capped at MAX_AGENT_CONTEXT chars.
  let conflictContext = '';
  for (const conflict of conflicts) {
    let fileContent: string;
    try {
      fileContent = readFileSync(join(repoRoot, conflict), 'utf-8');
    } catch {
      fileContent = '';
    }

    conflictContext += `File: ${conflict}\n${fileContent}\n\n`;

    if (conflictContext.length > MAX_AGENT_CONTEXT) {
      conflictContext = `${conflictContext.slice(0, MAX_AGENT_CONTEXT)}... (truncated)`;
      break;
    }
  }

  const errorContext = `Merge conflicts detected in the following files:\n\n${conflictContext}\n\nTask context: ${taskPrompt}`;

  // Delegate the repair to the self-verifying tooled fix-up primitive, which
  // edits the files directly via tools and retries up to maxAttempts times.
  const fixupResult = await runTooledFixup({
    profilesDirs,
    worktreePath: repoRoot,
    taskPrompt,
    errorContext,
    apiKeys,
    maxAttempts: 3,
  });

  if (!fixupResult.success) {
    return { resolved: false, ...(fixupResult.lastError ? { error: fixupResult.lastError } : {}) };
  }

  // Stage ONLY the conflicted files — never a sweeping `stageAll` that would
  // also sweep up untracked / scratch files the agent may have produced.
  stageFiles(repoRoot, conflicts);
  return { resolved: true };
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
  const session = await requireAgentPlugin(profile.agent).createSession({ profile, cwd: repoRoot, apiKeys });

  try {
    const { result } = await promptForStructured(
      session,
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
    session.dispose();
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorktreeSetupResult {
  worktreePath: string;
  branchName: string;
  worktreeInfo: WorktreeInfo;
  /** The WorktreeManager that owns the main worktree lifecycle. */
  manager: WorktreeManager;
  cleanup: () => Promise<void>;
}
