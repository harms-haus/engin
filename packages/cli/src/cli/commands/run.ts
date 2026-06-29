import type { ClientMessage } from '@engin/shared/protocol-types';
import { isGitRepo, validateWorkflowName } from '@harms-haus/engin-engine';

import { shouldUseTui } from '../console-status.js';
import type { CliOptions } from '../parse-args.js';
import { promptFinalMerge } from '../post-worktree.js';
import { promptYesNo } from '../prompt.js';
import type { PostTerminalContext } from '../run-session-client.js';
import { RunSessionClient } from '../run-session-client.js';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from '../server-defaults.js';

export async function runCommand(options: CliOptions): Promise<void> {
  if (!options.workflowName) throw new Error('workflow name is required for run command');
  if (!options.taskPrompt) throw new Error('task prompt is required for run command');
  const workflowName = options.workflowName;

  // Validate workflow name before sending it to the daemon.
  validateWorkflowName(workflowName);

  // Worktrees are automatic for git repos. When the cwd is NOT a git
  // repository, prompt before proceeding — the run will execute in-place
  // with no worktree (the server detects non-git and skips the worktree
  // setup). Default is No so accidental Enter aborts safely.
  if (!isGitRepo(options.cwd)) {
    const confirmed = await promptYesNo(
      `Warning: '${options.cwd}' is not a git repository. Continue without git and worktrees?`,
      false,
    );
    if (!confirmed) {
      console.log('Aborted. Run `git init` to initialize a repository first.');
      process.exit(1);
    }
  }

  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  // Build the start_run message. `worktree` is intentionally omitted — the
  // server decides whether to use a worktree based on whether the cwd is a
  // git repository. The client learns the worktree identity (if any) from
  // the `run_started` summary's `worktree` field.
  const startRunMessage: ClientMessage = {
    type: 'start_run',
    workflowName,
    taskPrompt: options.taskPrompt as string,
    cwd: options.cwd,
    ...(Object.keys(options.apiKeys).length > 0 ? { apiKeys: options.apiKeys } : {}),
    ...(options.workDir ? { workDir: options.workDir } : {}),
  };

  await new RunSessionClient({
    port,
    host,
    useTui,
    verbose: options.verbose,
    setup: async (_engineClient) => {
      const postTerminalAction: (ctx: PostTerminalContext) => Promise<void> = async (ctx) => {
        // No worktree captured (non-git run) — skip the prompt entirely.
        if (!ctx.capturedWorktree) return;
        await promptFinalMerge({
          worktreePath: ctx.capturedWorktree.worktreePath,
          branchName: ctx.capturedWorktree.branchName,
          taskPrompt: options.taskPrompt as string,
          runId: ctx.runId,
          sendAction: async (action) => {
            ctx.engineClient.send({ type: 'worktree_action', runId: ctx.runId, action });
          },
          waitForResult: ctx.waitForResult,
        });
      };
      return { mode: 'start', startRunMessage, postTerminalAction };
    },
  }).run();
}
