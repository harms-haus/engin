#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStatusCallbacks, formatTime, shouldUseTui } from './cli/console-status.js';
import { promptPostWorktreeAction } from './cli/post-worktree.js';
import { interactiveSelectRun, resolveSessionName } from './cli/session-selector.js';
import type { PastRunEntry } from './core/config.js';
import { getDefaultWorkDir, getGlobalConfigDir, loadEnvFiles, resolveProfilesDirs } from './core/config.js';
import type { WorktreeInfo } from './core/types.js';
import { validateWorkflowName } from './core/utils.js';
import { loadWorkflow } from './core/workflow-loader.js';
import { setupWorktree } from './core/worktree-lifecycle.js';
import { initDefaultConfig } from './setup.js';

// ─── CLI Options ────────────────────────────────────────────────────────────

export interface CliOptions {
  command: 'run' | 'init' | 'help' | 'version' | 'web' | 'resume';
  workflowName?: string;
  taskPrompt?: string;
  cwd: string;
  workDir?: string;
  maxConcurrent: number;
  verbose: boolean;
  worktree: boolean;
  apiKeys: Record<string, string>;
  warnings: string[];
  host?: string;
  port?: number;
  /** Session name for the resume command (the directory name under .engin/work/) */
  sessionName?: string;
}

// ─── Argument Parsing ───────────────────────────────────────────────────────

const VERSION = '0.1.0';

const USAGE = `Usage: engin <command> [options]

Commands:
  run    <workflow-name> <task-prompt> [options]   Run a workflow
  resume [session-name] [options]                  Resume a past workflow run
  init                                              Create config directory structure
  web    [options]                                   Start web UI server

Options:
  --cwd <path>            Working directory (default: process.cwd())
  --work-dir <path>       Workflow working directory (run only)
  --max-concurrent <n>    Max concurrent tasks (default: 5, run only)
  --verbose               Enable verbose logging
  --worktree              Run workflow in a git worktree
  --api-key <provider=key>  API key (repeatable)
  --host <host>           Web server host (default: 127.0.0.1, web only)
  --port <port>           Web server port (default: 3619, web only)
  --help, -h              Show this help message
  --version, -v           Show version`;

export function parseArgs(argv: string[]): CliOptions {
  // 1. Check for --help / -h anywhere (before positional parsing)
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      command: 'help' as const,
      cwd: process.cwd(),
      maxConcurrent: 5,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
    };
  }

  // 2. Check for --version / -v anywhere (before positional parsing)
  if (argv.includes('--version') || argv.includes('-v')) {
    return {
      command: 'version' as const,
      cwd: process.cwd(),
      maxConcurrent: 5,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
    };
  }

  // 3. Separate positionals from flags
  const positionals: string[] = [];
  const flags: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--cwd') {
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for ${arg}\n${USAGE}`);
      }
      flags.push(arg, val);
    } else if (arg === '--work-dir') {
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for ${arg}\n${USAGE}`);
      }
      flags.push(arg, val);
    } else if (arg === '--max-concurrent') {
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for ${arg}\n${USAGE}`);
      }
      flags.push(arg, val);
    } else if (arg === '--verbose') {
      flags.push(arg);
    } else if (arg === '--worktree') {
      flags.push(arg);
    } else if (arg === '--api-key') {
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for ${arg}\n${USAGE}`);
      }
      flags.push(arg, val);
    } else if (arg === '--host') {
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for ${arg}\n${USAGE}`);
      }
      flags.push(arg, val);
    } else if (arg === '--port') {
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for ${arg}\n${USAGE}`);
      }
      flags.push(arg, val);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: "${arg}"\n${USAGE}`);
    } else {
      positionals.push(arg);
    }
    i++;
  }

  // 4. Parse common flags
  let cwd = process.cwd();
  let verbose = false;
  let worktree = false;
  const apiKeys: Record<string, string> = {};
  const warnings: string[] = [];
  let apiKeyWarningIssued = false;
  let workDir: string | undefined;
  let maxConcurrent = 5;

  let host: string | undefined;
  let port: number | undefined;

  for (let j = 0; j < flags.length; j++) {
    const flag = flags[j];
    if (flag === '--cwd') {
      cwd = flags[++j];
    } else if (flag === '--work-dir') {
      workDir = flags[++j];
    } else if (flag === '--max-concurrent') {
      const raw = flags[++j];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
        throw new Error(`--max-concurrent must be a positive integer, got "${raw}"\n${USAGE}`);
      }
      maxConcurrent = parsed;
    } else if (flag === '--verbose') {
      verbose = true;
    } else if (flag === '--worktree') {
      worktree = true;
    } else if (flag === '--api-key') {
      const pair = flags[++j];
      const eqIdx = pair.indexOf('=');
      if (eqIdx < 0) {
        throw new Error(`Invalid --api-key format: expected provider=key, got "${pair}"\n${USAGE}`);
      }
      const provider = pair.slice(0, eqIdx);
      const key = pair.slice(eqIdx + 1);
      apiKeys[provider] = key;
      if (!apiKeyWarningIssued) {
        warnings.push(
          'API keys passed via --api-key are visible in process listings. Consider using environment variables instead.',
        );
        apiKeyWarningIssued = true;
      }
    } else if (flag === '--host') {
      host = flags[++j];
    } else if (flag === '--port') {
      const raw = flags[++j];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535 || !Number.isInteger(parsed)) {
        throw new Error(`--port must be an integer between 1 and 65535, got "${raw}"\n${USAGE}`);
      }
      port = parsed;
    }
  }

  if (positionals.length === 0) {
    // Interactive mode: no command given, default to 'run'
    return {
      command: 'run',
      cwd,
      maxConcurrent,
      verbose,
      worktree,
      apiKeys,
      warnings,
    };
  }

  const command = positionals[0];

  if (command === 'web') {
    if (positionals.length > 1) {
      throw new Error(`Unexpected argument: "${positionals[1]}"\n${USAGE}`);
    }
    return { command: 'web', cwd, verbose, worktree, maxConcurrent, apiKeys, warnings, host, port };
  }

  if (command === 'init') {
    if (positionals.length > 1) {
      throw new Error(`Unexpected argument: "${positionals[1]}"\n${USAGE}`);
    }
    return { command: 'init', cwd, verbose, worktree, maxConcurrent, apiKeys, warnings };
  }

  if (command === 'resume') {
    const sessionName = positionals[1];
    if (positionals.length > 2) {
      throw new Error(`Unexpected argument: "${positionals[2]}"\n${USAGE}`);
    }
    return {
      command: 'resume',
      cwd,
      workDir,
      maxConcurrent,
      verbose,
      worktree,
      apiKeys,
      warnings,
      sessionName,
    };
  }

  // Any non-init positional is treated as "run" with the first positional as the workflow name.
  const workflowName = command; // first positional is workflow name when implicit run
  const taskPrompt = positionals[1];

  if (!taskPrompt) {
    throw new Error(`Missing required <task-prompt> for run command\n${USAGE}`);
  }

  if (positionals.length > 2) {
    throw new Error(`Unexpected argument: "${positionals[2]}"\n${USAGE}`);
  }

  return {
    command: 'run',
    workflowName,
    taskPrompt,
    cwd,
    workDir,
    maxConcurrent,
    verbose,
    worktree,
    apiKeys,
    warnings,
  };
}

// formatTime, createStatusCallbacks, and shouldUseTui are imported from ./cli/console-status.js

// ─── SIGINT Handler Helper ──────────────────────────────────────────────────

function setupSigintHandler(useTui: boolean): {
  handler: () => void;
  cleanup: () => void;
  controller: AbortController;
} {
  const controller = new AbortController();
  let sigintCount = 0;
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;

  const handler = () => {
    sigintCount++;
    if (sigintCount === 1) {
      if (!useTui) {
        console.log(
          `\n${formatTime()} ⏹️  Interrupt received, stopping workflow gracefully... (Ctrl+C again to force quit)`,
        );
      }
      controller.abort();
      // Safety net: if graceful shutdown hasn't completed in 5s, force exit
      forceExitTimer = setTimeout(() => {
        if (!useTui) {
          console.log(`${formatTime()} ⏹️  Graceful shutdown timed out, forcing exit.`);
        }
        process.exit(1);
      }, 5000);
    } else {
      if (forceExitTimer) clearTimeout(forceExitTimer);
      if (!useTui) {
        console.log(`\n${formatTime()} ⏹️  Force quit.`);
      }
      process.exit(1);
    }
  };

  const cleanup = () => {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    process.removeListener('SIGINT', handler);
  };

  return { handler, cleanup, controller };
}

// ─── Commands ───────────────────────────────────────────────────────────────

export async function initCommand(_options: CliOptions): Promise<void> {
  await initDefaultConfig();
  const globalDir = getGlobalConfigDir();
  console.log('Initialized engin directory structure at ' + globalDir);
}

export async function webCommand(options: CliOptions): Promise<void> {
  const { startWebServer } = await import('./web/server.js');
  const _server = await startWebServer({
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 3619,
    cwd: options.cwd,
  });

  const { handler } = setupSigintHandler(false);
  process.on('SIGINT', handler);
}

export async function runCommand(options: CliOptions): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const workflowName = options.workflowName!;

  // Validate workflow name before using it in path construction
  validateWorkflowName(workflowName);

  const workDir = options.workDir ?? getDefaultWorkDir(options.cwd, workflowName);
  const workflow = await loadWorkflow(workflowName, options.cwd);
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  // Worktree setup
  let worktreeInfo: WorktreeInfo | undefined;
  let effectiveCwd = options.cwd;
  if (options.worktree) {
    const profilesDirs = resolveProfilesDirs(options.cwd, workflowName);
    const setup = await setupWorktree(
      options.cwd,
      profilesDirs,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      options.taskPrompt!,
      Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
    );
    worktreeInfo = setup.worktreeInfo;
    effectiveCwd = setup.worktreePath;
    console.log('Worktree created at ' + setup.worktreePath + ' on branch ' + setup.branchName);
  }

  // Set up SIGINT handler for cooperative cancellation
  const { handler, cleanup, controller } = setupSigintHandler(useTui);

  process.on('SIGINT', handler);
  try {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await workflow.run(options.taskPrompt!, {
      cwd: effectiveCwd,
      workDir,
      maxConcurrentTasks: options.maxConcurrent,
      apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
      ...(useTui ? { verbose: false } : { verbose: true, onStatus: createStatusCallbacks(options.verbose) }),
      signal: controller.signal,
      ...(worktreeInfo ? { worktree: worktreeInfo } : {}),
    });
    if (worktreeInfo) {
      const profilesDirs = resolveProfilesDirs(worktreeInfo.originalCwd, workflowName);
      await promptPostWorktreeAction({
        profilesDirs,
        repoRoot: worktreeInfo.originalCwd,
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        originalCwd: worktreeInfo.originalCwd,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        taskPrompt: options.taskPrompt!,
        apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
      });
    }
  } finally {
    cleanup();
  }
}

// Session selector functions are imported from ./cli/session-selector.js

// ─── Resume Command ──────────────────────────────────────────────────────────

export async function resumeCommand(options: CliOptions): Promise<void> {
  let run: PastRunEntry;

  if (options.sessionName) {
    run = await resolveSessionName(options.sessionName, options.cwd);
  } else {
    const selected = await interactiveSelectRun(options.cwd);
    if (!selected) {
      process.exit(0);
    }
    run = selected;
  }

  if (!run.hasStateFile) {
    throw new Error(
      `Run "${run.dirName}" does not have a resumable state file. It may have been manually cleaned up or interrupted before saving state.`,
    );
  }

  // Read the state file to get the task prompt
  const statePath = join(run.fullPath, '.engin-state.json');
  const stateRaw = readFileSync(statePath, 'utf-8');
  const state = JSON.parse(stateRaw) as {
    taskPrompt: string;
    worktree?: { worktreePath: string; branchName: string; originalCwd: string };
  };
  const taskPrompt = state.taskPrompt;
  const worktreeInfo = state.worktree;

  if (!taskPrompt) {
    throw new Error(`Run "${run.dirName}" has no task prompt in its state file. Cannot resume.`);
  }

  const workDir = run.fullPath;
  const workflowName = run.workflowName;

  if (worktreeInfo) {
    options = { ...options, cwd: worktreeInfo.worktreePath };
    console.log(`${formatTime()} Resuming in worktree: ${worktreeInfo.branchName}`);
  }

  console.log(`${formatTime()} 🔄 Resuming run: ${run.dirName}`);
  console.log(`${formatTime()}    Workflow: ${workflowName}`);
  console.log(`${formatTime()}    Prompt:   ${taskPrompt}`);
  console.log();

  validateWorkflowName(workflowName);
  const workflow = await loadWorkflow(workflowName, options.cwd);
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  // Set up SIGINT handler for cooperative cancellation
  const { handler, cleanup, controller } = setupSigintHandler(useTui);

  process.on('SIGINT', handler);
  try {
    await workflow.run(taskPrompt, {
      cwd: options.cwd,
      workDir,
      maxConcurrentTasks: options.maxConcurrent,
      apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
      ...(useTui ? { verbose: false } : { verbose: true, onStatus: createStatusCallbacks(options.verbose) }),
      signal: controller.signal,
      ...(worktreeInfo ? { worktree: worktreeInfo } : {}),
    });
    if (worktreeInfo) {
      const profilesDirs = resolveProfilesDirs(worktreeInfo.originalCwd, workflowName);
      await promptPostWorktreeAction({
        profilesDirs,
        repoRoot: worktreeInfo.originalCwd,
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        originalCwd: worktreeInfo.originalCwd,
        taskPrompt,
        apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
      });
    }
  } finally {
    cleanup();
  }
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

let cliOptions: CliOptions | undefined;

export async function main(): Promise<void> {
  cliOptions = parseArgs(process.argv.slice(2));
  const options = cliOptions;

  // Print any warnings from argument parsing
  for (const warning of options.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }

  // Load .env files for commands that need them (skip for help/version)
  if (options.command !== 'help' && options.command !== 'version') {
    const envResult = loadEnvFiles(options.cwd);
    if (options.verbose && envResult.loadedFiles.length > 0) {
      for (const file of envResult.loadedFiles) {
        console.log(`${formatTime()} 📄 Loaded .env: ${file}`);
      }
    }
  }

  if (options.command === 'help') {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  if (options.command === 'version') {
    process.stdout.write(`engin v${VERSION}\n`);
    process.exit(0);
  }
  if (options.command === 'init') {
    await initCommand(options);
    return;
  }
  if (options.command === 'web') {
    await webCommand(options);
    return;
  }
  if (options.command === 'resume') {
    await resumeCommand(options);
    return;
  }
  if (options.command === 'run' && !options.workflowName) {
    // Interactive mode: no workflow name or task prompt — launch the TUI composer
    const { runComposer } = await import('./tui/composer.js');
    const result = await runComposer(options.cwd);
    if (!result || !result.ok) {
      process.exit(0);
    }
    const interactiveOptions: CliOptions = {
      ...options,
      workflowName: result.workflowName,
      taskPrompt: result.taskPrompt,
      verbose: result.verbose,
      worktree: result.worktree,
      maxConcurrent: result.maxConcurrent,
    };
    await runCommand(interactiveOptions);
    return;
  }
  await runCommand(options);
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  main().catch((err) => {
    const msg = err instanceof Error ? (cliOptions?.verbose ? err.stack : err.message) : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  });
}
