// ─── CLI Options ────────────────────────────────────────────────────────────

export interface CliOptions {
  command: 'run' | 'init' | 'help' | 'version' | 'resume';
  workflowName?: string;
  taskPrompt?: string;
  cwd: string;
  workDir?: string;
  maxConcurrent: number;
  verbose: boolean;
  worktree: boolean;
  apiKeys: Record<string, string>;
  warnings: string[];
  /** Session name for the resume command (the directory name under .engin/work/) */
  sessionName?: string;
  /** Web server host (default: 127.0.0.1) */
  host?: string;
  /** Web server port (default: 3619) */
  port?: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const VERSION = '0.1.0';

export const USAGE = `Usage: engin <command> [options]

Commands:
  run    <workflow-name> <task-prompt> [options]   Run a workflow
  resume [session-name] [options]                  Resume a past workflow run
  init                                              Create config directory structure

Options:
  --cwd <path>            Working directory (default: process.cwd())
  --work-dir <path>       Workflow working directory (run only)
  --max-concurrent <n>    Max concurrent tasks (default: 5, run only)
  --verbose               Enable verbose logging
  --worktree              Run workflow in a git worktree
  --api-key <provider=key>  API key (repeatable)
  --host <host>           Web server host (default: 127.0.0.1)
  --port <port>           Web server port (default: 3619)
  --help, -h              Show this help message
  --version, -v           Show version`;

// ─── Argument Parsing ───────────────────────────────────────────────────────

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
      host: undefined,
      port: undefined,
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
      host: undefined,
      port: undefined,
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
    } else if (flag === '--host') {
      host = flags[++j];
    } else if (flag === '--port') {
      const raw = flags[++j];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`--port must be an integer between 1 and 65535, got "${raw}"\n${USAGE}`);
      }
      port = parsed;
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
      host,
      port,
    };
  }

  const command = positionals[0];

  if (command === 'init') {
    if (positionals.length > 1) {
      throw new Error(`Unexpected argument: "${positionals[1]}"\n${USAGE}`);
    }
    return { command: 'init', cwd, verbose, worktree, maxConcurrent, apiKeys, warnings, host, port };
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
      host,
      port,
    };
  }

  // Any non-init positional is treated as "run" with the first positional as the workflow name.
  const workflowName = command; // first positional is workflow name when implicit run
  const taskPrompt = positionals[1];

  if (!taskPrompt) {
    throw new Error(`Missing required <task-prompt> for run command\n${USAGE}`);
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
    host,
    port,
  };
}
