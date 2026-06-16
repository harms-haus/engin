import { ClientStore } from '@engin/shared/client-store';
import { EngineClient } from '@engin/shared/engine-client';
import type { ClientMessage, ServerMessage } from '@engin/shared/protocol-types';
import type { PastRunEntry, WorktreeInfo } from '@harms-haus/engin-engine';
import {
  getGlobalConfigDir,
  getServerLogPath,
  getServerPidfilePath,
  initDefaultConfig,
  isServerAlive,
  readPidfile,
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
import { interactiveSelectRun, queryActiveRuns, resolveSessionName } from './session-selector.js';
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

/** Optional async callback invoked after the run reaches a terminal state
 *  and the TUI (if any) has been stopped — e.g. the worktree post-action. */
type PostTerminalAction = (ctx: PostTerminalContext) => Promise<void>;

/**
 * The result of the async {@link DaemonClientOptions.setup} callback, as a
 * discriminated union on `mode`:
 *
 *  - `mode: 'start'`  — start a fresh (or resumed-from-disk) run by sending
 *    `start_run`. This is the historical behavior used by {@link runCommand}
 *    and the disk-resume path of {@link resumeCommand}.
 *  - `mode: 'attach'` — attach to a run that is ALREADY active on the server.
 *    No `start_run` is sent; the client only `subscribe`s + `resync`s and
 *    blocks until the run reaches a terminal state.
 *
 * If `setup` returns `null`, the command exits early (e.g. user cancelled
 * the interactive session picker).
 */
type SetupResult =
  | { mode: 'start'; startRunMessage: ClientMessage; postTerminalAction?: PostTerminalAction }
  | { mode: 'attach'; runId: string; postTerminalAction?: PostTerminalAction };

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

  /**
   * Attach the client to a run: set the local `runId`, `subscribe`, propagate
   * the runId to the TUI, and (in non-TTY mode) install the cooperative
   * SIGINT handler. When `resync` is set, also request a full snapshot (no
   * `lastSeq`) so the server replays the run's state — routed into the
   * ClientStore by the `snapshot`/`events` handlers below.
   *
   * Shared by the `run_started` handler (start mode) and the explicit
   * attach-mode entry point so the two paths behave identically. Mirrors the
   * bookkeeping the `run_started` handler used to do inline. Start mode opts
   * OUT of `resync` (the server already pushes an initial snapshot on
   * `run_started`); attach mode opts IN (there is no `start_run` to trigger
   * one, so the client must fetch the snapshot explicitly).
   */
  const attachToRun = (id: string, options: { resync?: boolean } = {}): void => {
    runId = id;
    engineClient.subscribe(id);
    // No lastSeq → the server replies with a full snapshot, which the
    // snapshot/events handlers below already route into the ClientStore.
    if (options.resync) {
      engineClient.resync(id);
    }
    // Propagate the runId to the TUI so the detach/kill prompt can display it.
    tuiInstance?.setRunId(id);
    // Non-TTY mode: wire the client-side SIGINT handler now that runId is known.
    // (TTY mode uses the TUI's onDetach/onKill instead — sigint.ts is not used there.)
    if (!useTui) {
      sigintDispose = setupNonTtySigintHandler(id, engineClient).dispose;
    }
  };

  engineClient.connect({
    onMessage: (msg: ServerMessage) => {
      switch (msg.type) {
        case 'run_started':
          if (runId !== undefined) break; // idempotent — ignore duplicate run_started (e.g. on WS reconnect)
          // T33: Capture worktree info so postTerminalAction can use it later.
          if (msg.summary?.worktree) capturedWorktree = msg.summary.worktree;
          // Start mode: the server pushes an initial snapshot on run_started,
          // so no explicit resync is needed here.
          attachToRun(msg.runId);
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
    const postTerminalAction = setupResult.postTerminalAction;

    // ── Daemon probe + auto-start ────────────────────────────────────────
    // Runs for BOTH modes. For attach mode the probe is best-effort: if the
    // server is down there is nothing active to attach to, but auto-starting
    // a fresh server is harmless (the target run simply won't be there and
    // the client will wait for a terminal that won't arrive this session).
    if (!(await isServerAlive(port))) {
      await startDaemon({ port, host });
      // Confirm readiness (best-effort — startDaemon already probes /health
      // internally with retries, but the mock in tests does not).
      if (!(await isServerAlive(port))) {
        console.warn(`${formatTime()} ⚠️ Server may not be fully ready yet.`);
      }
    }

    // ── Dispatch on mode ─────────────────────────────────────────────────
    if (setupResult.mode === 'attach') {
      // Attach to an already-active run: subscribe + resync only. Do NOT
      // send start_run (the run is already executing on the server). The
      // runId is now set, so the snapshot/events/terminal handlers below
      // route messages for this run correctly. `resync: true` requests a
      // full snapshot since there was no start_run to trigger one.
      attachToRun(setupResult.runId, { resync: true });
      // pendingStartRun stays undefined → onConnected will NOT flush a
      // start_run on a (re)connect.
    } else {
      // Start mode: queue + send start_run (guarded by socket readiness).
      // Queue the message first, then send directly only if the socket is
      // already OPEN. If it is not open yet, the onConnected callback wired
      // above will flush pendingStartRun once the handshake completes —
      // preventing an indefinite hang when EngineClient.send() would silently
      // drop the message.
      const { startRunMessage } = setupResult;
      pendingStartRun = startRunMessage;
      if (engineClient.isConnected()) {
        engineClient.send(startRunMessage);
      }
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
      return { mode: 'start', startRunMessage, postTerminalAction };
    },
  });
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

  return { mode: 'start', startRunMessage, postTerminalAction };
}

export async function resumeCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  await executeViaDaemon({
    port,
    host,
    useTui,
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
