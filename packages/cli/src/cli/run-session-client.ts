// ─── RunSessionClient — extracted daemon-client execution lifecycle ────────
//
// Encapsulates the T27 client-side lifecycle formerly implemented inline as
// `executeViaDaemon` in commands.ts. `runCommand` and `resumeCommand` are now
// thin wrappers that construct a {@link RunSessionClient} with a `setup`
// callback (which resolves the `start_run` message — or the attach target)
// and call `.run()`.

import { ClientStore } from '@engin/shared/client-store';
import { EngineClient } from '@engin/shared/engine-client';
import type { ClientMessage, ServerMessage } from '@engin/shared/protocol-types';
import { isServerAlive, readServerToken, startDaemon } from '@harms-haus/engin-engine';
import { WorkflowTUI } from '@harms-haus/engin-tui';
import { formatTime } from './console-status.js';
import type { WorktreeMergeResult } from './post-worktree.js';
import { setupNonTtySigintHandler } from './sigint.js';
import { type StdoutRenderer, createStdoutRenderer } from './stdout-renderer.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Optional async callback invoked after the run reaches a terminal state
 *  and the TUI (if any) has been stopped — e.g. the worktree post-action. */
export type PostTerminalAction = (ctx: PostTerminalContext) => Promise<void>;

/**
 * The result of the async {@link DaemonClientOptions.setup} callback, as a
 * discriminated union on `mode`:
 *
 *  - `mode: 'start'`  — start a fresh (or resumed-from-disk) run by sending
 *    `start_run`. This is the historical behavior used by `runCommand`
 *    and the disk-resume path of `resumeCommand`.
 *  - `mode: 'attach'` — attach to a run that is ALREADY active on the server.
 *    No `start_run` is sent; the client only `subscribe`s + `resync`s and
 *    blocks until the run reaches a terminal state.
 *
 * If `setup` returns `null`, the command exits early (e.g. user cancelled
 * the interactive session picker).
 */
export type SetupResult =
  | { mode: 'start'; startRunMessage: ClientMessage; postTerminalAction?: PostTerminalAction }
  | { mode: 'attach'; runId: string; postTerminalAction?: PostTerminalAction };

/** Context passed to {@link SetupResult.postTerminalAction}. */
export interface PostTerminalContext {
  /** The runId assigned by the server (from the run_started reply). */
  runId: string;
  /** The EngineClient used to send messages to the daemon. */
  engineClient: EngineClient;
  /** T33: Worktree info captured from run_started (may be undefined when
   *  the run did not use a worktree). */
  capturedWorktree?: { worktreePath: string; branchName: string; originalCwd?: string };
  /**
   * Waits for the next `worktree_merge_result` ServerMessage for this run.
   *
   * Used by the post-terminal final-merge prompt to await the outcome of a
   * `worktree_action { action: 'merge' | 'resolve' }` sent through
   * {@link engineClient}. Resolves with the result payload (outcome +
   * optional cleanupError / worktreePath / branchName).
   */
  waitForResult: () => Promise<WorktreeMergeResult>;
}

/**
 * Options for the shared daemon-client execution helper ({@link RunSessionClient}).
 */
export interface DaemonClientOptions {
  /** TCP port of the daemon's HTTP/WS server. */
  port: number;
  /** Bind host passed to `startDaemon` (the WS client always uses 127.0.0.1). */
  host: string;
  /** Whether to attach the interactive TUI dashboard. */
  useTui: boolean;
  /** Whether to produce verbose agent-log output in non-TUI mode. */
  verbose: boolean;
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

// ─── Daemon Probe + Auto-Start ──────────────────────────────────────────────

/**
 * Ensure the engine daemon is reachable on `port`.
 *
 * Probes {@link isServerAlive}; if the server is down, auto-starts it via
 * {@link startDaemon} with the given `host`, then probes again to confirm
 * readiness. Best-effort: if the server is still not ready after the start
 * attempt, a warning is printed but no error is thrown — the run path is
 * tolerant of a not-yet-ready server (e.g. attach mode, where the target run
 * may simply not be present yet).
 */
export async function ensureDaemonRunning(port: number, host: string): Promise<void> {
  if (await isServerAlive(port)) {
    return;
  }
  await startDaemon({ port, host });
  // Confirm readiness (best-effort — startDaemon already probes /health
  // internally with retries, but the mock in tests does not).
  if (!(await isServerAlive(port))) {
    console.warn(`${formatTime()} ⚠️ Server may not be fully ready yet.`);
  }
}

// ─── RunSessionClient ───────────────────────────────────────────────────────

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
 * 5. Probe `/health`; auto-start the daemon via {@link ensureDaemonRunning}
 *    if down.
 * 6. Send `start_run` (start mode) or `subscribe` + `resync` (attach mode).
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
export class RunSessionClient {
  private readonly opts: DaemonClientOptions;

  constructor(opts: DaemonClientOptions) {
    this.opts = opts;
  }

  /**
   * Run the daemon-client lifecycle described in the class doc.
   *
   * Construction is side-effect free; all work (token read, WS connect,
   * daemon probe, message exchange, TUI) happens here.
   */
  async run(): Promise<void> {
    const { port, host, useTui, verbose, setup } = this.opts;

    // ── SIGINT handler (cooperative cancellation) ───────────────────────
    let sigintDispose: (() => void) | undefined;

    // ── Client-side state (ALL synchronous, before any await) ───────────
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

    // T33: Pending one-shot resolver for the next `worktree_merge_result`
    // message. Set by `waitForResult` (below) and drained by the
    // `worktree_merge_result` case in the onMessage handler. At most one
    // resolver is pending at a time — the final-merge prompt awaits each
    // result serially before issuing the next action.
    let pendingWorktreeResultResolver: ((result: WorktreeMergeResult) => void) | null = null;

    // ── Read server auth token (T35) ──────────────────────────────────
    // The token is read BEFORE creating the EngineClient so it can be passed
    // as `authToken` in the constructor options. EngineClient then sends
    // `{ type:'auth', token }` on each (re)connect.
    //
    // NOTE: This introduces an `await` before EngineClient creation. Test
    // helpers that deliver messages synchronously must yield once to allow
    // this microtask to settle before EngineClient.connect() captures callbacks.
    const serverToken = await readServerToken();

    // ── EngineClient (localhost WS client) ──────────────────────────────
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
            // A start-time failure is signaled by the server sending run_failed
            // with an empty runId (it has none yet). In the CLI/TUI there is
            // exactly one run per socket, so a run_failed arriving before we
            // attached (runId still undefined) is unambiguously our own start
            // failure. Accepting it here resolves terminalPromise so the run
            // path no longer hangs forever when the workflow fails to load/start.
            if (msg.runId === runId || (runId === undefined && msg.runId === '')) {
              runFailedReason = msg.error;
              resolveTerminal();
            }
            break;
          case 'worktree_merge_result':
            // T33: Forward the merge outcome to the pending final-merge prompt
            // (if any). Only results for our run are delivered; others are
            // ignored. The resolver is drained and cleared so a later result
            // does not re-resolve an already-settled promise.
            if (msg.runId === runId && pendingWorktreeResultResolver !== null) {
              const resolver = pendingWorktreeResultResolver;
              pendingWorktreeResultResolver = null;
              resolver({
                outcome: msg.outcome,
                ...(msg.cleanupError !== undefined ? { cleanupError: msg.cleanupError } : {}),
                ...(msg.worktreePath !== undefined ? { worktreePath: msg.worktreePath } : {}),
                ...(msg.branchName !== undefined ? { branchName: msg.branchName } : {}),
                ...(msg.error !== undefined ? { error: msg.error } : {}),
              });
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

    // ── Non-TUI console output (StdoutRenderer) ─────────────────────────
    // In non-TUI mode, wire the StdoutRenderer which handles lifecycle
    // events, verbose agent-log formatting, token deltas, and runLog.
    let stdoutRenderer: StdoutRenderer | undefined;
    if (!useTui) {
      stdoutRenderer = createStdoutRenderer({ clientStore, verbose, formatTime });
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
      await ensureDaemonRunning(port, host);

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
        if (runId !== undefined) {
          await tuiInstance.pauseForInspection(undefined);
        }
        tuiInstance.stop();
        tuiInstance = undefined;
      }

      // ── Post-terminal action (e.g. worktree prompt) ─────────────────────
      if (postTerminalAction && runId) {
        // T33: `waitForResult` lets the final-merge prompt await the next
        // `worktree_merge_result` for this run (resolved by the onMessage
        // handler above). Each call arms a fresh one-shot resolver.
        const waitForResult = (): Promise<WorktreeMergeResult> =>
          new Promise<WorktreeMergeResult>((resolve) => {
            pendingWorktreeResultResolver = resolve;
          });
        await postTerminalAction({ runId, engineClient, capturedWorktree, waitForResult });
      }

      // ── Surface run failure as non-zero exit ────────────────────────────
      // A run_failed terminal message sets runFailedReason. We surface it
      // here (after the TUI inspection pause and post-terminal action) and
      // set process.exitCode so CI/automation can detect the failure.
      if (runFailedReason !== undefined) {
        const label = runId === undefined ? '❌ Failed to start workflow' : '❌ Run failed';
        console.error(`${formatTime()} ${label}: ${runFailedReason}`);
        process.exitCode = 1;
      }
    } finally {
      // Clear the onKill force-exit timer in case an exception arose
      // between arming and the post-await clearTimeout above.
      if (killTimer) clearTimeout(killTimer);
      stdoutRenderer?.dispose();
      engineClient.disconnect();
      tuiInstance?.stop();
      sigintDispose?.();
    }
  }
}
