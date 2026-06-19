import type { ClientMessage } from '@engin/shared/protocol-types';
import type { PastRunEntry, WorktreeInfo } from '@harms-haus/engin-engine';
import {
  getGlobalConfigDir,
  getServerLogPath,
  getServerPidfilePath,
  initDefaultConfig,
  isGitRepo,
  isServerAlive,
  readPidfile,
  startDaemon,
  stopDaemon,
  validateWorkflowName,
} from '@harms-haus/engin-engine';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { formatTime, shouldUseTui } from './console-status.js';
import type { CliOptions } from './parse-args.js';
import { promptFinalMerge } from './post-worktree.js';
import type { PostTerminalContext, SetupResult } from './run-session-client.js';
import { RunSessionClient } from './run-session-client.js';
import type { PickerSelection } from './session-selector.js';
import { interactiveSelectRun, queryActiveRuns, resolveSessionName } from './session-selector.js';

// ─── Init Command ───────────────────────────────────────────────────────────

export async function initCommand(_options: CliOptions): Promise<void> {
  await initDefaultConfig();
  const globalDir = getGlobalConfigDir();
  console.log('Initialized engin directory structure at ' + globalDir);
}

// ─── Run/Resume Daemon-Client Options ───────────────────────────────

/** Default server port when none is specified. */
const DEFAULT_SERVER_PORT = 3619;

/** Default bind host when none is specified. */
const DEFAULT_SERVER_HOST = '127.0.0.1';

// ─── Non-git Fallback Prompt ────────────────────────────────────────────────

/**
 * Ask a yes/No question on stdin/stdout, defaulting to `defaultValue` when the
 * user presses return (or stdin closes).
 *
 * Used by {@link runCommand} to confirm proceeding in a non-git directory.
 * Accepts `y`/`yes` (case-insensitive) as affirmative; anything else —
 * including empty input — follows `defaultValue`.
 */
async function promptYesNo(prompt: string, defaultValue: boolean): Promise<boolean> {
  const hint = defaultValue ? '[Y/n]' : '[y/N]';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<boolean>((resolve) => {
      rl.question(`${prompt} ${hint} `, (answer) => {
        const normalized = answer.trim().toLowerCase();
        if (normalized === '') {
          resolve(defaultValue);
          return;
        }
        resolve(normalized === 'y' || normalized === 'yes');
      });
      // Guard against stdin closing without input (EOF, piped input, CI):
      // resolve the default so the process never deadlocks.
      rl.on('close', () => resolve(defaultValue));
    });
  } finally {
    rl.close();
  }
}

// ─── Run Command ────────────────────────────────────────────────────────────

export async function runCommand(options: CliOptions): Promise<void> {
  if (!options.workflowName) throw new Error('workflow name is required for run command');
  if (!options.taskPrompt) throw new Error('task prompt is required for run command');
  const workflowName = options.workflowName;

  // Validate workflow name before sending it to the daemon.
  validateWorkflowName(workflowName);

  // ── Non-git fallback prompt ──────────────────────────────────────────
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
    // User confirmed — proceed without worktrees. The server will detect
    // non-git and run in-place.
  }

  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  // Build the start_run message.
  // NOTE: `worktree` is intentionally omitted — the server now decides
  // whether to use a worktree based on whether the cwd is a git repository.
  // The client learns the worktree identity (if any) from the `run_started`
  // summary's `worktree` field.
  const startRunMessage: ClientMessage = {
    type: 'start_run',
    workflowName,
    taskPrompt: options.taskPrompt as string,
    cwd: options.cwd,
    maxConcurrent: options.maxConcurrent,
    ...(Object.keys(options.apiKeys).length > 0 ? { apiKeys: options.apiKeys } : {}),
    ...(options.workDir ? { workDir: options.workDir } : {}),
  };

  await new RunSessionClient({
    port,
    host,
    useTui,
    verbose: options.verbose,
    setup: async (_engineClient) => {
      // Always wire the post-terminal action. The action itself no-ops
      // when no worktree was captured (non-git run) — server-side worktree
      // detection decides, and the client learns the worktree identity
      // from the `run_started` summary's `worktree` field.
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

// ─── Resume Command ─────────────────────────────────────────────────────────

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

  // ── Read the state file to recover taskPrompt + optional worktree ──
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

  // ── Build the start_run message ────────────────────────────────────
  // NOTE: `worktree` is intentionally omitted — the server detects git
  // automatically from the cwd. For resume, the worktree identity recovered
  // from the state file is used to wire the post-terminal action below.
  const startRunMessage: ClientMessage = {
    type: 'start_run',
    workflowName,
    taskPrompt,
    cwd: options.cwd,
    workDir,
    maxConcurrent: options.maxConcurrent,
    ...(Object.keys(options.apiKeys).length > 0 ? { apiKeys: options.apiKeys } : {}),
  };

  // ── Post-terminal worktree action ──────────────────────────────────
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
      // ── Positional path: `engin resume <runId>` ─────────────────────────
      if (options.sessionName) {
        // §9: if the runId is in the server's active registry, subscribe +
        // attach to the live run instead of starting it again. Query the
        // server BEFORE falling back to the disk scan — resolveSessionName
        // only scans disk and would miss server-tracked active runs.
        const activeRuns = await queryActiveRuns(engineClient);
        const activeMatch = activeRuns.find((r) => r.runId === options.sessionName);
        if (activeMatch) {
          // Active run — attach only (subscribe + resync). Worktree
          // post-action is intentionally skipped: an attached-to-active run
          // did not go through this client's start_run, so we have no
          // captured worktree context to act on.
          return { mode: 'attach' as const, runId: activeMatch.runId };
        }
        // Not active — historical resume from the on-disk state file.
        const run = await resolveSessionName(options.sessionName, options.cwd);
        return buildResumeStartResult(options, run);
      }

      // ── Interactive picker path ─────────────────────────────────────────
      const selected: PickerSelection | undefined = await interactiveSelectRun(options.cwd, engineClient);
      if (!selected) {
        // User cancelled the interactive picker — exit gracefully.
        return null;
      }
      if (selected.type === 'active') {
        // §9: an active (server-tracked) run — subscribe + attach only.
        // (interactiveSelectRun already de-dupes active vs. disk runs, so an
        // active run appears only in the active section.)
        return { mode: 'attach' as const, runId: selected.runSummary.runId };
      }
      // Historical (disk) run — resume from its state file via start_run.
      return buildResumeStartResult(options, selected.pastRun);
    },
  }).run();
}

// ─── Server Commands ────────────────────────────────────────────────────────

/**
 * Starts the engine server daemon.
 *
 * Calls `startDaemon({ port, host })` with sensible defaults (port 3619,
 * host 127.0.0.1). Refuses LAN bindings (`--lan` or `--host 0.0.0.0`) since
 * authentication is not yet supported — these bind to all interfaces and
 * would expose the server to the network without auth. Prints the server URL
 * on success.
 */
export async function serverUpCommand(options: CliOptions): Promise<void> {
  // T35: Hard gate against wildcard/LAN bindings without authentication.
  // --lan and any wildcard host (IPv4 0.0.0.0, IPv6 ::, etc.) all bind to
  // all network interfaces, which requires authentication that is not yet
  // supported. Refuse with a non-zero exit code and a clear message — printed
  // once to stderr (NOT also thrown), so main().catch does not duplicate it.
  const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '::0', '*']);
  if (options.lan || (options.host !== undefined && WILDCARD_HOSTS.has(options.host))) {
    const message =
      'LAN binding (0.0.0.0 / --lan) requires authentication, which is not yet supported. The server is limited to localhost (127.0.0.1) bindings until auth is available.';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
    return;
  }

  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;

  const result = await startDaemon({ port, host });
  console.log(`Server running at http://${host}:${result.port} (pid ${result.pid})`);
}

/**
 * Prompts the user to confirm stopping the server when active runs exist.
 *
 * Returns `true` only when the user answers `y` or `yes` (case-insensitive).
 */
async function confirmStop(activeRuns: number): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<boolean>((resolve) => {
      rl.question(`${activeRuns} active run(s) in progress. Stop the server anyway? [y/N] `, (answer) => {
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === 'y' || normalized === 'yes');
      });
      // Guard against stdin closing without input (EOF, piped input, CI):
      // resolve false so the process never deadlocks.
      rl.on('close', () => resolve(false));
    });
  } finally {
    rl.close();
  }
}

/**
 * Stops the engine server daemon.
 *
 * If `--force` is not set and the server is alive with active runs, prompts
 * the user for confirmation. With `--force`, the prompt is skipped.
 */
export async function serverDownCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? DEFAULT_SERVER_PORT;

  if (!options.force) {
    const alive = await isServerAlive(port);
    if (alive) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`);
        if (resp.ok) {
          const health = (await resp.json()) as { activeRuns?: number };
          if (health.activeRuns && health.activeRuns > 0) {
            const confirmed = await confirmStop(health.activeRuns);
            if (!confirmed) {
              console.log('Server not stopped.');
              return;
            }
          }
        }
      } catch {
        // Health endpoint unreachable — proceed with shutdown.
      }
    }
  }

  await stopDaemon();
  console.log('Server stopped.');
}

/**
 * Shape of the daemon's `/health` JSON response.
 *
 * Defined loosely (all-optional) so a partial/legacy payload still type-checks
 * when {@link serverStatusCommand} reads it defensively.
 */
interface HealthResponse {
  pid?: number;
  port?: number;
  activeRuns?: number;
}

/**
 * Fetches `/health` from the running daemon and parses its JSON body.
 *
 * Tolerant of every failure mode: a network error, a non-200 status, or a
 * body that is not valid JSON all resolve to `undefined` so the caller can
 * still report "running" with the details it already knows.
 */
async function fetchHealth(host: string, port: number): Promise<HealthResponse | undefined> {
  try {
    const response = await fetch(`http://${host}:${port}/health`);
    if (!response.ok) return undefined;
    return (await response.json()) as HealthResponse;
  } catch {
    // Connection refused, abort, DNS failure, or non-JSON body — treat as
    // "health unavailable" rather than crashing the status command.
    return undefined;
  }
}

/**
 * Shows the engine server status.
 *
 * Probes the daemon via {@link isServerAlive}. When it is up, fetches
 * `/health` for runtime details and prints a multi-line report covering the
 * DoD §18 fields: status, pid, port, bind host, active-run count, log path,
 * and web URL. Tolerant of `/health` being unreachable or non-JSON — it still
 * reports "running" with whatever it knows plus a note. When down, notes a
 * stale pidfile if one is present (never crashes on a missing/unreadable
 * pidfile).
 */
export async function serverStatusCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const logPath = getServerLogPath();

  const alive = await isServerAlive(port);
  if (!alive) {
    console.log(`${formatTime()} 🔴 Server is not running.`);
    // Best-effort stale-pidfile notice. readPidfile() never throws — it
    // resolves `null` when the pidfile is absent, empty, or malformed.
    const pidfile = await readPidfile();
    if (pidfile) {
      console.log(
        `${formatTime()}    ⚠️ A pidfile exists at ${getServerPidfilePath()} (pid ${pidfile.pid}) — it may be stale.`,
      );
    }
    return;
  }

  // Server is alive — enrich with /health details when available.
  const health = await fetchHealth(host, port);

  console.log(`${formatTime()} 🟢 Server is running`);
  console.log(`${formatTime()}    PID:          ${health?.pid ?? 'unknown'}`);
  console.log(`${formatTime()}    Port:         ${port}`);
  console.log(`${formatTime()}    Host:         ${host}`);
  console.log(`${formatTime()}    Active runs:  ${health?.activeRuns ?? 'unknown'}`);
  console.log(`${formatTime()}    Log:          ${logPath}`);
  console.log(`${formatTime()}    Web URL:      http://${host}:${port}/`);
  if (!health) {
    console.log(`${formatTime()}    ⚠️ Health endpoint unavailable; some details are unknown.`);
  }
}
