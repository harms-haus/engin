import type { ClientMessage } from '@engin/shared/protocol-types';
import type { PastRunEntry, WorktreeInfo } from '@harms-haus/engin-engine';
import { validateWorkflowName } from '@harms-haus/engin-engine';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatTime, shouldUseTui } from '../console-status.js';
import type { CliOptions } from '../parse-args.js';
import { promptFinalMerge } from '../post-worktree.js';
import type { PostTerminalContext, SetupResult } from '../run-session-client.js';
import { RunSessionClient } from '../run-session-client.js';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from '../server-defaults.js';
import type { PickerSelection } from '../session-selector.js';
import { interactiveSelectRun, queryActiveRuns, resolveSessionName } from '../session-selector.js';

/**
 * Build a `start`-mode {@link SetupResult} for resuming a run from its on-disk
 * state file. Reads `.engin-state.json` to recover the `taskPrompt` (and
 * optional worktree info), validates the workflow name, prints a resumption
 * banner, and wires the optional worktree post-terminal action.
 *
 * Shared by the positional and interactive-picker historical paths of
 * {@link resumeCommand} so both send `start_run` against the recovered state.
 */
async function buildResumeStartResult(
  options: CliOptions,
  run: PastRunEntry,
): Promise<Extract<SetupResult, { mode: 'start' }>> {
  if (!run.hasStateFile) {
    throw new Error(
      `Run "${run.dirName}" does not have a resumable state file. It may have been manually cleaned up or interrupted before saving state.`,
    );
  }

  const statePath = join(run.fullPath, '.engin-state.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Run "${run.dirName}" has a corrupt or unreadable state file: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const state = parsed as {
    taskPrompt: string;
    currentPhase?: string;
    completedPhases?: string[];
    tasks?: {
      id: string;
      title: string;
      status: string;
      assignedAgent?: string;
      phase?: string;
    }[];
    sidebar?: { title?: string; indicator?: string; phases?: { id: string; label: string; icon: string }[] };
    worktree?: WorktreeInfo;
    spawnedAgents?: {
      agentId: string;
      profile: string;
      phase: string;
      taskId?: string;
      completedAt?: string;
    }[];
  };
  const taskPrompt = state.taskPrompt;
  const worktreeInfo = state.worktree;

  if (!taskPrompt) {
    throw new Error(`Run "${run.dirName}" has no task prompt in its state file. Cannot resume.`);
  }

  const workDir = run.fullPath;
  const workflowName = run.workflowName;

  if (worktreeInfo) {
    console.log(`${formatTime()} Resuming in worktree: ${worktreeInfo.branchName}`);
  }

  console.log(`${formatTime()} 🔄 Resuming run: ${run.dirName}`);
  console.log(`${formatTime()}    Workflow: ${workflowName}`);
  console.log(`${formatTime()}    Prompt:   ${taskPrompt}`);
  console.log();

  validateWorkflowName(workflowName);

  // `worktree` is intentionally omitted — the server detects git automatically
  // from the cwd. For resume, the worktree identity recovered from the state
  // file is used to wire the post-terminal action below.
  const startRunMessage: ClientMessage = {
    type: 'start_run',
    workflowName,
    taskPrompt,
    cwd: options.cwd,
    workDir,
    ...(Object.keys(options.apiKeys).length > 0 ? { apiKeys: options.apiKeys } : {}),
  };

  let postTerminalAction: ((ctx: PostTerminalContext) => Promise<void>) | undefined;
  if (worktreeInfo) {
    postTerminalAction = async ({ runId, engineClient, waitForResult }) => {
      await promptFinalMerge({
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        taskPrompt,
        runId,
        sendAction: async (action) => {
          engineClient.send({ type: 'worktree_action', runId, action });
        },
        waitForResult,
      });
    };
  }

  return { mode: 'start', startRunMessage, postTerminalAction };
}

export async function resumeCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  await new RunSessionClient({
    port,
    host,
    useTui,
    verbose: options.verbose,
    setup: async (engineClient) => {
      // Positional path: `engin resume <runId>`.
      if (options.sessionName) {
        // If the runId is in the server's active registry, subscribe + attach
        // to the live run instead of starting it again. Query the server
        // BEFORE falling back to the disk scan — resolveSessionName only
        // scans disk and would miss server-tracked active runs.
        const activeRuns = await queryActiveRuns(engineClient);
        const activeMatch = activeRuns.find((r) => r.runId === options.sessionName);
        if (activeMatch) {
          // Active run — attach only. Worktree post-action is intentionally
          // skipped: an attached-to-active run did not go through this
          // client's start_run, so there is no captured worktree context.
          return { mode: 'attach' as const, runId: activeMatch.runId };
        }
        // Not active — historical resume from the on-disk state file.
        const run = await resolveSessionName(options.sessionName, options.cwd);
        return buildResumeStartResult(options, run);
      }

      // Interactive picker path.
      const selected: PickerSelection | undefined = await interactiveSelectRun(options.cwd, engineClient);
      if (!selected) {
        // User cancelled the interactive picker — exit gracefully.
        return null;
      }
      if (selected.type === 'active') {
        return { mode: 'attach' as const, runId: selected.runSummary.runId };
      }
      return buildResumeStartResult(options, selected.pastRun);
    },
  }).run();
}
