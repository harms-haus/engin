#!/usr/bin/env bun

import { getDefaultWorkDir, getGlobalConfigDir, loadEnvFiles } from './core/config.js';
import type { StatusCallbacks } from './core/types.js';
import { loadWorkflow } from './core/workflow-loader.js';
import { initDefaultConfig } from './setup.js';

// ─── CLI Options ────────────────────────────────────────────────────────────

export interface CliOptions {
  command: 'run' | 'init' | 'help' | 'version';
  workflowName?: string;
  taskPrompt?: string;
  cwd: string;
  workDir?: string;
  maxConcurrent: number;
  verbose: boolean;
  apiKeys: Record<string, string>;
}

// ─── Argument Parsing ───────────────────────────────────────────────────────

const VERSION = '0.1.0';

const USAGE = `Usage: engin <command> [options]

Commands:
  run    <workflow-name> <task-prompt> [options]   Run a workflow
  init                                              Create config directory structure

Options:
  --cwd <path>            Working directory (default: process.cwd())
  --work-dir <path>       Workflow working directory (run only)
  --max-concurrent <n>    Max concurrent tasks (default: 3, run only)
  --verbose               Enable verbose logging
  --api-key <provider=key>  API key (repeatable)
  --help, -h              Show this help message
  --version, -v           Show version`;

export function parseArgs(argv: string[]): CliOptions {
  // 1. Check for --help / -h anywhere (before positional parsing)
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      command: 'help' as const,
      cwd: process.cwd(),
      maxConcurrent: 3,
      verbose: false,
      apiKeys: {},
    };
  }

  // 2. Check for --version / -v anywhere (before positional parsing)
  if (argv.includes('--version') || argv.includes('-v')) {
    return {
      command: 'version' as const,
      cwd: process.cwd(),
      maxConcurrent: 3,
      verbose: false,
      apiKeys: {},
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
    } else if (arg === '--api-key') {
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

  if (positionals.length === 0) {
    throw new Error(`Missing command\n${USAGE}`);
  }

  const command = positionals[0];

  // 4. Parse common flags
  let cwd = process.cwd();
  let verbose = false;
  const apiKeys: Record<string, string> = {};
  let apiKeyWarningIssued = false;
  let workDir: string | undefined;
  let maxConcurrent = 3;

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
        process.stderr.write(
          'Warning: API keys passed via --api-key are visible in process listings. Consider using environment variables instead.\n',
        );
        apiKeyWarningIssued = true;
      }
    }
  }

  if (command === 'init') {
    if (positionals.length > 1) {
      throw new Error(`Unexpected argument: "${positionals[1]}"\n${USAGE}`);
    }
    return { command: 'init', cwd, verbose, maxConcurrent, apiKeys };
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
    apiKeys,
  };
}

// ─── Time Formatting ────────────────────────────────────────────────────────

export function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `[${h}:${m}:${s}]`;
}

// ─── Status Callbacks ───────────────────────────────────────────────────────

export function createStatusCallbacks(verbose: boolean): StatusCallbacks {
  const callbacks: StatusCallbacks = {
    onWorkflowStart: (info) => {
      console.log(`${formatTime()} 🚀 Workflow started: "${info.taskPrompt}" (resumed: ${info.resumed})`);
    },
    onWorkflowComplete: (info) => {
      console.log(
        `${formatTime()} 🎉 Workflow complete in ${info.totalDurationMs / 1000}s (${info.agentCount} agents)`,
      );
    },
    onWorkflowFailed: (info) => {
      console.log(`${formatTime()} 💥 Workflow failed at phase ${info.phase}: ${info.error.message}`);
    },
    onPhaseStart: (info) => {
      console.log(`${formatTime()} 📦 Phase started: ${info.phase} (round ${info.round})`);
    },
    onPhaseComplete: (info) => {
      console.log(`${formatTime()} ✅ Phase completed: ${info.phase} (${info.durationMs / 1000}s)`);
    },
    onAgentSpawn: (info) => {
      console.log(`${formatTime()} ⏳ Agent spawned: ${info.agentId} (profile: ${info.profile})`);
    },
    onAgentComplete: (info) => {
      console.log(`${formatTime()} ✅ Agent complete: ${info.agentId}`);
    },
    onTaskStart: (info) => {
      console.log(`${formatTime()} 📋 Task started: ${info.taskId} - "${info.title}"`);
    },
    onTaskComplete: (info) => {
      console.log(`${formatTime()} ✅ Task complete: ${info.taskId}`);
    },
    onTaskRejected: (info) => {
      console.log(`${formatTime()} ❌ Task rejected: ${info.taskId} - ${info.reason}`);
    },
    onDecision: (info) => {
      console.log(`${formatTime()} 🤝 Decision by ${info.agentId}: ${info.decision}`);
    },
    onError: (info) => {
      console.log(`${formatTime()} ⚠️ Error in ${info.agentId}: ${info.error} (phase: ${info.phase})`);
    },
  };

  if (verbose) {
    callbacks.onTurnStart = (info) => {
      console.log(`${formatTime()} 🔄 Turn ${info.turn} started (agent: ${info.agentId})`);
    };
    callbacks.onTurnEnd = (info) => {
      const tokensPart = info.tokens ? `, tokens: ${info.tokens.input} in / ${info.tokens.output} out` : '';
      console.log(`${formatTime()} 🔄 Turn ${info.turn} ended (agent: ${info.agentId}${tokensPart})`);
    };
    callbacks.onToolCallStart = (info) => {
      console.log(`${formatTime()} 🔧 Tool call: ${info.toolName} (agent: ${info.agentId})`);
    };
    callbacks.onToolCallEnd = (info) => {
      const icon = info.isError ? '❌' : '✅';
      const label = info.isError ? 'Tool error' : 'Tool result';
      console.log(`${formatTime()} ${icon} ${label}: ${info.toolName} (agent: ${info.agentId})`);
    };
  }

  return callbacks;
}

// ─── Commands ───────────────────────────────────────────────────────────────

export async function initCommand(_options: CliOptions): Promise<void> {
  await initDefaultConfig();
  const globalDir = getGlobalConfigDir();
  console.log('Initialized engin directory structure at ' + globalDir);
}

export async function runCommand(options: CliOptions): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const workflowName = options.workflowName!;

  // Validate workflow name before using it in path construction
  if (workflowName.includes('/') || workflowName.includes('\\') || workflowName.includes('..')) {
    throw new Error(`Invalid workflow name: "${workflowName}"`);
  }

  const workDir = options.workDir ?? getDefaultWorkDir(options.cwd, workflowName);
  const workflow = await loadWorkflow(workflowName, options.cwd);

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  await workflow.run(options.taskPrompt!, {
    cwd: options.cwd,
    workDir,
    maxConcurrentTasks: options.maxConcurrent,
    apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
    onStatus: createStatusCallbacks(options.verbose),
  });
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

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
  await runCommand(options);
}

const isDirectRun = process.argv[1] && (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('cli.js'));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
