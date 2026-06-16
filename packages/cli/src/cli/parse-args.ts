import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── CLI Options ────────────────────────────────────────────────────────────

export interface CliOptions {
  command: 'run' | 'init' | 'help' | 'version' | 'resume' | 'server';
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
  /** Subcommand for the `server` command (up, down, or status). */
  serverAction?: 'up' | 'down' | 'status';
  /** Force flag for `server down` (--force / -y). Skips the active-runs confirmation prompt. */
  force?: boolean;
  /** Web server bind host. Defaults to '127.0.0.1' (localhost only). */
  host?: string;
  /** When true, binds to 0.0.0.0 and auto-detects the LAN IP for QR code display. */
  lan?: boolean;
  /** Web server port (default: 3619) */
  port?: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * The CLI's own version, read once at module load from the nearest
 * `package.json` (the `cli` package manifest, two directories up from this
 * file). This keeps `engin --version` in lockstep with the published package
 * instead of being a hardcoded string that drifts. Falls back to a sentinel
 * if the file is missing/unreadable so `--version` never throws.
 */
export const VERSION: string = (() => {
  try {
    const pkgPath = join(import.meta.dir, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Missing/unreadable package.json — fall through to the sentinel.
  }
  return '0.0.0-unknown';
})();

export const USAGE = `Usage: engin <command> [options]

Commands:
  run    <workflow-name> <task-prompt> [options]   Run a workflow
  resume [session-name] [options]                  Resume a past workflow run
  init                                              Create config directory structure
  server up    [options]                            Start the engine server daemon
  server down  [--force|-y]                         Stop the engine server daemon
  server status                                    Show engine server status

Options:
  --cwd <path>            Working directory (default: process.cwd())
  --work-dir <path>       Workflow working directory (run only)
  --max-concurrent <n>    Max concurrent tasks (default: 5, run only)
  --verbose               Enable verbose logging
  --worktree              Run workflow in a git worktree
  --api-key <provider=key>  API key (repeatable)
  --host <host>           Web server bind host (default: 127.0.0.1)
  --lan                   Bind on all interfaces for LAN/QR access (default: localhost only)
  --port <port>           Web server port (default: 3619)
  --force, -y             Skip confirmation for 'server down'
  --help, -h              Show this help message
  --version, -v           Show version`;

/**
 * Deprecation warning emitted when --host/--lan are passed to run/resume
 * instead of `engin server up`.
 */
const HOST_LAN_DEPRECATION_WARNING = "Server binding options (--host, --lan) are now configured via 'engin server up'.";

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
      lan: undefined,
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
      lan: undefined,
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
    } else if (arg === '--lan') {
      flags.push(arg);
    } else if (arg === '--force' || arg === '-y') {
      flags.push(arg);
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
  let lan: boolean | undefined;
  let port: number | undefined;
  let force = false;
  let hostProvided = false;
  let lanProvided = false;

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
      hostProvided = true;
    } else if (flag === '--lan') {
      lan = true;
      lanProvided = true;
    } else if (flag === '--force' || flag === '-y') {
      force = true;
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
      lan,
      port,
    };
  }

  const command = positionals[0];

  // `engin help` / `engin version` (bare subcommands) behave exactly like
  // `--help` / `--version`. Without this they fall through to the implicit
  // `run` path and wrongly report "Missing required <task-prompt>".
  if (command === 'help' || command === 'version') {
    return {
      command,
      cwd,
      maxConcurrent,
      verbose,
      worktree,
      apiKeys,
      warnings,
      host,
      lan,
      port,
    };
  }

  if (command === 'init') {
    if (positionals.length > 1) {
      throw new Error(`Unexpected argument: "${positionals[1]}"\n${USAGE}`);
    }
    return { command: 'init', cwd, verbose, worktree, maxConcurrent, apiKeys, warnings, host, lan, port };
  }

  if (command === 'resume') {
    const sessionName = positionals[1];
    if (positionals.length > 2) {
      throw new Error(`Unexpected argument: "${positionals[2]}"\n${USAGE}`);
    }
    if (hostProvided || lanProvided) {
      warnings.push(HOST_LAN_DEPRECATION_WARNING);
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
      lan,
      port,
    };
  }

  if (command === 'server') {
    const serverAction = positionals[1];
    if (!serverAction) {
      throw new Error(`Missing server subcommand (up, down, or status)\n${USAGE}`);
    }
    if (serverAction !== 'up' && serverAction !== 'down' && serverAction !== 'status') {
      throw new Error(`Unknown server subcommand: "${serverAction}"\n${USAGE}`);
    }
    return {
      command: 'server',
      serverAction,
      cwd,
      verbose,
      worktree,
      maxConcurrent,
      apiKeys,
      warnings,
      force,
      host,
      lan,
      port,
    };
  }

  // Any non-init positional is treated as "run" with the first positional as the workflow name.
  const workflowName = command; // first positional is workflow name when implicit run
  const taskPrompt = positionals[1];

  if (!taskPrompt) {
    throw new Error(`Missing required <task-prompt> for run command\n${USAGE}`);
  }

  if (hostProvided || lanProvided) {
    warnings.push(HOST_LAN_DEPRECATION_WARNING);
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
    lan,
    port,
  };
}
