import { ClientStore } from '@engin/shared/client-store';
import { EngineClient } from '@engin/shared/engine-client';
import type { ClientMessage, ServerMessage } from '@engin/shared/protocol-types';
import type { PastRunEntry, WorktreeInfo } from '@harms-haus/engin-engine';
import {
  getGlobalConfigDir,
  initDefaultConfig,
  isServerAlive,
  readServerToken,
  startDaemon,
  stopDaemon,
  validateWorkflowName,
} from '@harms-haus/engin-engine';
import { WorkflowTUI } from '@harms-haus/engin-tui';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { formatTime, shouldUseTui } from './console-status.js';
import type { CliOptions } from './parse-args.js';
import { promptPostWorktreeAction } from './post-worktree.js';
import type { PickerSelection } from './session-selector.js';
import { interactiveSelectRun, resolveSessionName } from './session-selector.js';
import { setupNonTtySigintHandler } from './sigint.js';

// ─── Init Command ───────────────────────────────────────────────────────────

export async function initCommand(_options: CliOptions): Promise<void> {
  await initDefaultConfig();
  const globalDir = getGlobalConfigDir();
  console.log('Initialized engin directory structure at ' + globalDir);
}

// ─── Daemon-Client Helper ───────────────────────────────────────────────────

/** Default server port when none is specified. */
const DEFAULT_SERVER_PORT = 3619;

/** Default bind host when none is specified. */
const DEFAULT_SERVER_HOST = '127.0.0.1';

/**
 * The result of the async {@link DaemonClientOptions.setup} callback.
 * If `setup` returns `null`, the command exits early (e.g. user cancelled
 * the interactive session picker).
 */
interface SetupResult {
  /** The `start_run` message to send once the daemon is reachable. */
  startRunMessage: ClientMessage;
  /** Optional async callback invoked after the run reaches a terminal state
   *  and the TUI (if any) has been stopped — e.g. the worktree post-action. */
  postTerminalAction?: (ctx: PostTerminalContext) => Promise<void>;
}

/** Context passed to {@link SetupResult.postTerminalAction}. */
interface PostTerminalContext {
  /** The runId assigned by the server (from the run_started reply). */
  runId: string;
  /** The EngineClient used to send messages to the daemon. */
  engineClient: EngineClient;
  /** T33: Worktree info captured from run_started (may be undefined when
   *  the run did not use a worktree). */
  capturedWorktree?: { worktreePath: string; branchName: string; originalCwd?: string };
}

/**
 * Options for the shared daemon-client execution helper.
 */
interface DaemonClientOptions {
  /** TCP port of the daemon's HTTP/WS server. */
  port: number;
  /** Bind host passed to `startDaemon` (the WS client always uses 127.0.0.1). */
  host: string;
  /** Whether to attach the interactive TUI dashboard. */
  useTui: boolean;
  /**
   * Async callback that resolves the `start_run` message (and optional
   * post-terminal action). Called AFTER the EngineClient is connected but
   * BEFORE the daemon probe — this guarantees that the WS `onMessage`
   * callback is installed synchronously (before any `await`), so callers
   * that deliver messages immediately after invoking the command reach the
   * handler. May return `null` to signal an early exit.
   */
  setup: (engineClient: EngineClient) => Promise<SetupResult | null>;
}

/**
 * Execute a workflow run as a **pure daemon client**.
 *
 * This encapsulates the T27 client-side lifecycle shared by `runCommand` and
 * `resumeCommand`:
 *
 * 1. Create a {@link ClientStore} and {@link EngineClient} (localhost WS) —
 *    ALL synchronous, before the first `await`.
 * 2. Wire `onMessage` to forward `snapshot`/`events`/`log` (filtered by
 *    `runId`) into the ClientStore, and resolve a terminal promise on
 *    `run_complete`/`run_failed`.
 * 3. Create a {@link WorkflowTUI} (when `useTui`) backed by the ClientStore.
 * 4. Call `setup()` to resolve the `start_run` message (may be async).
 * 5. Probe `/health`; auto-start the daemon via {@link startDaemon} if down.
 * 6. Send `start_run`.
 * 7. Start the TUI; wait for the terminal promise.
 * 8. `pauseForInspection` → stop TUI.
 * 9. Run `postTerminalAction` (if provided).
 * 10. Disconnect + cleanup (always, via `finally`).
 *
 * **Timing note**: The EngineClient is created and `connect`ed after an
 * initial `await readServerToken()` call (T35). The `onMessage` callback is
 * installed before the `setup()` await, so callers that deliver messages
 * after a microtask checkpoint reach the handler.
 */
async function executeViaDaemon(opts: DaemonClientOptions): Promise<void> {
  const { port, host, useTui, setup } = opts;

  // ── SIGINT handler (cooperative cancellation) ───────────────────────────
  let sigintDispose: (() => void) | undefined;

  // ── Client-side state (ALL synchronous, before any await) ───────────────
  const clientStore = new ClientStore();

  // Run-lifecycle tracking.
  let runId: string | undefined;
  let runFailedReason: string | undefined;
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  // Force-exit timer armed by the onKill callback. If the daemon never
  // sends a terminal event (crash, WS drop, routing bug) after a cancel_run,
  // this prevents an indefinite hang in TUI raw mode (where process-level
  // SIGINT is captured as \x03 data, not a signal). Cleared when the run
  // terminates normally (see the `await terminalPromise` section below).
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  // Holds the start_run message until the WS socket is OPEN. EngineClient.send()
  // is a silent no-op before readyState===OPEN, so we queue the message here and
  // flush it via the onConnected callback (or directly if already connected).
  let pendingStartRun: ClientMessage | undefined;

  // T33: Captured from the run_started message so postTerminalAction (in
  // runCommand) can build the worktree prompt after the run completes.
  let capturedWorktree: { worktreePath: string; branchName: string; originalCwd?: string } | undefined;

  // ── Read server auth token (T35) ──────────────────────────────────────
  // The token is read BEFORE creating the EngineClient so it can be passed
  // as `authToken` in the constructor options. EngineClient then sends
  // `{ type:'auth', token }` on each (re)connect.
  //
  // NOTE: This introduces an `await` before EngineClient creation. Test
  // helpers that deliver messages synchronously must yield once to allow
  // this microtask to settle before EngineClient.connect() captures callbacks.
  const serverToken = await readServerToken();

  // ── EngineClient (localhost WS client) ──────────────────────────────────
  // Always connect to 127.0.0.1 regardless of --host/--lan (the TUI is a
  // localhost client; the daemon handles external binding).
  const engineClient = new EngineClient({
    url: `ws://127.0.0.1:${port}/ws`,
    ...(serverToken !== null ? { authToken: serverToken } : {}),
  });
  engineClient.connect({
    onMessage: (msg: ServerMessage) => {
      switch (msg.type) {
        case 'run_started':
          if (runId !== undefined) break; // idempotent — ignore duplicate run_started (e.g. on WS reconnect)
          runId = msg.runId;
          // T33: Capture worktree info so postTerminalAction can use it later.
          if (msg.summary?.worktree) capturedWorktree = msg.summary.worktree;
          // Track for reconnection replay (the server also auto-subscribes
          // on start_run, but this ensures resubscribe after a WS drop).
          engineClient.subscribe(runId);
          // Propagate the runId to the TUI so the detach/kill prompt can
          // display it.
          tuiInstance?.setRunId(runId);
          // Non-TTY mode: wire the client-side SIGINT handler now that runId is known.
          // (TTY mode uses the TUI's onDetach/onKill instead — sigint.ts is not used there.)
          if (!useTui) {
            sigintDispose = setupNonTtySigintHandler(runId, engineClient).dispose;
          }
          break;
        case 'snapshot':
          if (msg.runId === runId) clientStore.applySnapshot(msg.state, msg.seq);
          break;
        case 'events':
          if (msg.runId === runId) clientStore.applyEvents(msg.events);
          break;
        case 'log':
          if (msg.runId === runId) clientStore.appendRunLog(msg.level, msg.message, msg.timestamp);
          break;
        case 'run_complete':
          if (msg.runId === runId) resolveTerminal();
          break;
        case 'run_failed':
          if (msg.runId === runId) {
            runFailedReason = msg.error;
            resolveTerminal();
          }
          break;
      }
    },
    onConnected: () => {
      // Flush the queued start_run once the socket is (re)opened. This
      // prevents a silent no-op if setup() resolves before the WS handshake
      // completes.
      if (pendingStartRun) engineClient.send(pendingStartRun);
    },
  });

  // ── Non-TUI console output ──────────────────────────────────────────────
  // In non-TUI/verbose mode, print workflow event lines to the console so the
  // user gets progress feedback.
  if (!useTui) {
    let lastPrintedSeq = 0;
    clientStore.subscribe((state) => {
      for (const entry of state.workflowEventLog) {
        if (entry.seq > lastPrintedSeq) {
          console.log(entry.line);
          lastPrintedSeq = entry.seq;
        }
      }
    });
  }

  // ── TUI (constructed synchronously so it is ready before the first await) ─
  let tuiInstance: WorkflowTUI | undefined;
  if (useTui) {
    tuiInstance = new WorkflowTUI({
      clientStore,
      // runId is populated once run_started arrives (see setRunId below).
      onDetach: () => {
        // Detach: leave the run running on the server, exit the client.
        // Restore the terminal BEFORE exiting — process.exit(0) terminates
        // immediately, so the finally block's tuiInstance?.stop() (which
        // restores raw mode / disables bracketed paste / shows cursor /
        // pauses stdin) would never run, leaving the user's terminal in raw
        // mode (no echo, broken Ctrl+C).
        tuiInstance?.stop();
        engineClient.disconnect();
        const id = runId ?? '<unknown>';
        process.stderr.write(
          `${formatTime()} 🔌 Detached. Run ${id} is still active on the server. Re-attach with: engin resume ${id}\n`,
        );
        process.exit(0);
      },
      onKill: () => {
        // Kill: send cancel_run and let the existing terminal handling
        // (run_complete / run_failed → terminalPromise) wait for the run to
        // end before stopping the TUI and exiting.
        if (runId) {
          engineClient.send({ type: 'cancel_run', runId });
        } else {
          console.warn('Cannot kill run — runId is not yet known.');
        }
        // Safety net: if the daemon never sends a terminal event within 10s,
        // force-exit so the process doesn't hang indefinitely in raw mode.
        // Clear any previously-armed timer before re-arming so multiple Kill
        // confirmations don't stack overlapping timers.
        if (killTimer) clearTimeout(killTimer);
        killTimer = setTimeout(() => {
          tuiInstance?.stop();
          process.stderr.write(`${formatTime()} ⚠️ Run did not terminate within 10s; forcing exit.\n`);
          process.exit(1);
        }, 10_000);
      },
    });
  }

  try {
    // ── Resolve the start_run message (async setup) ──────────────────────
    // This runs AFTER the EngineClient is connected, ensuring message
    // delivery works even if setup involves async work (resumeCommand).
    const setupResult = await setup(engineClient);
    if (setupResult === null) {
      // Early exit (e.g. user cancelled interactive session picker).
      return;
    }
    const { startRunMessage, postTerminalAction } = setupResult;

    // ── Daemon probe + auto-start ────────────────────────────────────────
    if (!(await isServerAlive(port))) {
      await startDaemon({ port, host });
      // Confirm readiness (best-effort — startDaemon already probes /health
      // internally with retries, but the mock in tests does not).
      if (!(await isServerAlive(port))) {
        console.warn(`${formatTime()} ⚠️ Server may not be fully ready yet.`);
      }
    }

    // ── Send start_run (guarded by socket readiness) ───────────────────
    // Queue the message first, then send directly only if the socket is
    // already OPEN. If it is not open yet, the onConnected callback wired
    // above will flush pendingStartRun once the handshake completes —
    // preventing an indefinite hang when EngineClient.send() would silently
    // drop the message.
    pendingStartRun = startRunMessage;
    if (engineClient.isConnected()) {
      engineClient.send(startRunMessage);
    }

    // ── Start TUI ───────────────────────────────────────────────────────
    if (tuiInstance) {
      await tuiInstance.prepareQrCode(`http://127.0.0.1:${port}`);
      tuiInstance.start();
    }

    // ── Wait for terminal (run_complete / run_failed) ───────────────────
    await terminalPromise;

    // The run terminated normally — cancel the onKill force-exit timer
    // (if onKill was invoked) so it doesn't fire spuriously.
    if (killTimer) clearTimeout(killTimer);

    // ── TUI inspection pause ────────────────────────────────────────────
    if (tuiInstance) {
      await tuiInstance.pauseForInspection(undefined);
      tuiInstance.stop();
      tuiInstance = undefined;
    }

    // ── Post-terminal action (e.g. worktree prompt) ─────────────────────
    if (postTerminalAction && runId) {
      await postTerminalAction({ runId, engineClient, capturedWorktree });
    }

    // ── Surface run failure as non-zero exit ────────────────────────────
    // A run_failed terminal message sets runFailedReason. We surface it
    // here (after the TUI inspection pause and post-terminal action) and
    // set process.exitCode so CI/automation can detect the failure.
    if (runFailedReason !== undefined) {
      console.error(`${formatTime()} ❌ Run failed: ${runFailedReason}`);
      process.exitCode = 1;
    }
  } finally {
    // Clear the onKill force-exit timer in case an exception arose
    // between arming and the post-await clearTimeout above.
    if (killTimer) clearTimeout(killTimer);
    engineClient.disconnect();
    tuiInstance?.stop();
    sigintDispose?.();
  }
}

// ─── Run Command ────────────────────────────────────────────────────────────

export async function runCommand(options: CliOptions): Promise<void> {
  if (!options.workflowName) throw new Error('workflow name is required for run command');
  if (!options.taskPrompt) throw new Error('task prompt is required for run command');
  const workflowName = options.workflowName;

  // Validate workflow name before sending it to the daemon.
  validateWorkflowName(workflowName);

  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  // Build the start_run message.
  const startRunMessage: ClientMessage = {
    type: 'start_run',
    workflowName,
    taskPrompt: options.taskPrompt as string,
    cwd: options.cwd,
    maxConcurrent: options.maxConcurrent,
    ...(Object.keys(options.apiKeys).length > 0 ? { apiKeys: options.apiKeys } : {}),
    ...(options.worktree ? { worktree: true } : {}),
    ...(options.workDir ? { workDir: options.workDir } : {}),
  };

  await executeViaDaemon({
    port,
    host,
    useTui,
    setup: async (_engineClient) => {
      // T33: When --worktree is set, wire the postTerminalAction so the
      // post-run worktree prompt sends the decision to the server instead
      // of performing local git operations.
      let postTerminalAction: ((ctx: PostTerminalContext) => Promise<void>) | undefined;
      if (options.worktree) {
        postTerminalAction = async (ctx) => {
          await promptPostWorktreeAction({
            worktreePath: ctx.capturedWorktree?.worktreePath ?? '',
            branchName: ctx.capturedWorktree?.branchName ?? '',
            taskPrompt: options.taskPrompt as string,
            runId: ctx.runId,
            sendDecision: async (action) => {
              ctx.engineClient.send({ type: 'worktree_action', runId: ctx.runId, action });
            },
          });
        };
      }
      return { startRunMessage, postTerminalAction };
    },
  });
}

// ─── Resume Command ─────────────────────────────────────────────────────────

export async function resumeCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  await executeViaDaemon({
    port,
    host,
    useTui,
    setup: async (engineClient) => {
      // ── Session resolution ─────────────────────────────────────────────
      let run: PastRunEntry;

      if (options.sessionName) {
        run = await resolveSessionName(options.sessionName, options.cwd);
      } else {
        const selected: PickerSelection | undefined = await interactiveSelectRun(options.cwd, engineClient);
        if (!selected) {
          // User cancelled the interactive picker — exit gracefully.
          return null;
        }
        if (selected.type === 'active') {
          // User selected an active (server-tracked) run.  Subscribe + attach
          // to the existing run rather than starting a new one.
          // TODO: wire attach-to-active-run flow (subscribe only).
          // For now, fall through to the historical resume path by constructing
          // a minimal PastRunEntry from the RunSummary.
          run = {
            dirName: selected.runSummary.runId,
            fullPath: '',
            workflowName: selected.runSummary.workflowName,
            timestamp: new Date(selected.runSummary.startedAt).getTime(),
            hasStateFile: false,
          };
        } else {
          run = selected.pastRun;
        }
      }

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
      const startRunMessage: ClientMessage = {
        type: 'start_run',
        workflowName,
        taskPrompt,
        cwd: options.cwd,
        workDir,
        maxConcurrent: options.maxConcurrent,
        ...(Object.keys(options.apiKeys).length > 0 ? { apiKeys: options.apiKeys } : {}),
        ...(worktreeInfo ? { worktree: true } : {}),
      };

      // ── Post-terminal worktree action ──────────────────────────────────
      let postTerminalAction: ((ctx: PostTerminalContext) => Promise<void>) | undefined;
      if (worktreeInfo) {
        postTerminalAction = async ({ runId, engineClient }) => {
          await promptPostWorktreeAction({
            worktreePath: worktreeInfo.worktreePath,
            branchName: worktreeInfo.branchName,
            taskPrompt,
            runId,
            sendDecision: async (action) => {
              engineClient.send({ type: 'worktree_action', runId, action });
            },
          });
        };
      }

      return { startRunMessage, postTerminalAction };
    },
  });
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
 * Shows the engine server status.
 *
 * Probes `/health` via `isServerAlive` and prints whether the server is
 * running.
 */
export async function serverStatusCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const alive = await isServerAlive(port);
  if (alive) {
    console.log(`Server is running on port ${port}.`);
  } else {
    console.log('Server is not running.');
  }
}
