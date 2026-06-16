import { ClientStore } from '@engin/shared/client-store';
import { EngineClient } from '@engin/shared/engine-client';
import type { ServerMessage } from '@engin/shared/protocol-types';
import type { ObserverServer, StatusCallbacks } from '@harms-haus/engin-engine';
import { createStoreCallbacks, EventStore, RunManager, StatusBridge } from '@harms-haus/engin-engine';
import { WorkflowTUI } from '@harms-haus/engin-tui';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Options for setting up the TUI and observer server.
 */
export interface TuiSetupOptions {
  /** HTTP port for the observer web server (default 3619). */
  port?: number;
  /** Ignored — the TUI is always a localhost WS client (bound to 127.0.0.1). Kept for API compatibility. */
  host?: string;
  /** Ignored — the TUI is always a localhost WS client. Kept for API compatibility. */
  lan?: boolean;
  /** Work directory used to instantiate the {@link EventStore} (canonical event log). */
  workDir: string;
  /**
   * Callback invoked when the observer server receives a terminate command.
   * Typically calls `controller.abort()` to cancel the running workflow.
   */
  onTerminate: () => void;
}

/**
 * Result of a successful TUI + observer server setup.
 */
export interface TuiSetupResult {
  /** The fully initialized WorkflowTUI instance (already started). */
  tuiInstance: WorkflowTUI;
  /** The observer web server instance. */
  observerServer: ObserverServer;
  /** The StatusBridge wired to the observer server's broadcast. */
  statusBridge: StatusBridge;
  /** The canonical EventStore for this run's work directory. */
  store: EventStore;
  /** {@link StatusCallbacks} that append every event into {@link store}. */
  storeCallbacks: StatusCallbacks;
  /** The localhost WebSocket client that feeds the ClientStore. */
  engineClient: EngineClient;
}

// ─── Setup Function ─────────────────────────────────────────────────────────

/**
 * Set up the TUI dashboard and observer web server.
 *
 * This encapsulates the shared TUI/observer setup logic used by both
 * `runCommand` and `resumeCommand` in commands.ts.
 *
 * Steps performed:
 * 1. Resolve port (always bind 127.0.0.1 — the TUI is a localhost WS client).
 * 2. Create the EventStore, a mutable broadcast holder, and StatusBridge.
 * 3. Start the observer web server via dynamic import.
 * 4. Warn if the frontend bundle (web/dist) is missing.
 * 5. Create a ClientStore and an EngineClient (localhost WS), wire the
 *    EngineClient's onMessage callback to forward snapshot/events/log
 *    messages (filtered by runId) into the ClientStore, and subscribe to the
 *    run's runId.
 * 6. Create the WorkflowTUI instance, prepare the QR code, and start it.
 * 7. Wire the real broadcast function from the observer server to the holder.
 *
 * @returns A `TuiSetupResult` with the initialized TUI, server, and bridge.
 */
export async function setupTuiAndObserver(options: TuiSetupOptions): Promise<TuiSetupResult> {
  // ── Resolve port and host ────────────────────────────────────────────────
  // The TUI is a localhost WS client: always bind 127.0.0.1 regardless of
  // --host/--lan options.
  const port = options.port ?? 3619;
  const bindHost = '127.0.0.1';

  // ── EventStore (canonical status writer) ────────────────────────────────
  // Use load() so that resumed runs replay events from a previous run's
  // events.jsonl/snapshot. For fresh runs (no files yet), load() falls back
  // to a pristine in-memory projection.
  const store = await EventStore.load(options.workDir);
  const storeCallbacks = createStoreCallbacks(store);

  // ── Broadcast holder + StatusBridge ──────────────────────────────────────
  // Create a mutable broadcast holder so StatusBridge can be instantiated
  // before the observer server starts (avoiding snapshot race).
  const broadcastHolder = {
    fn: (_msg: ServerMessage) => {
      void 0;
    },
  };
  const runId = basename(options.workDir);
  const statusBridge = new StatusBridge((msg) => broadcastHolder.fn(msg), store, runId);

  // ── Observer server ──────────────────────────────────────────────────────
  // The TUI still drives its workflow natively (in-process); the RunManager
  // is constructed here solely to satisfy the observer server's multi-run WS
  // routing contract. When the TUI is fully migrated to the RunManager model,
  // the run will be registered via startRun() and web clients will be able to
  // subscribe to it. For now, connected web clients receive an empty runs list.
  // The TUI drives its run natively (in-process) for now; this RunManager
  // only exists to satisfy the observer server's multi-run WS routing
  // contract. The onRunsChanged callback is intentionally a no-op until the
  // full migration registers the run via startRun().
  const runManager = new RunManager(() => {
    /* no-op: TUI run is native; web clients see an empty runs list */
  });
  const { startObserverServer } = await import('@harms-haus/engin-engine');
  const observerServer = await startObserverServer({
    host: bindHost,
    port,
    runManager,
    // On graceful shutdown (e.g. SIGTERM/SIGINT in the daemon, or explicit
    // stop()) cooperatively cancel every active run and flush its store before
    // the server socket closes.
    onShutdown: () => runManager.shutdownAll(),
  });
  const serverUrl = observerServer.url;

  // ── Frontend build warning ───────────────────────────────────────────────
  const webDistCandidates = [
    join(import.meta.dir, '..', '..', 'web', 'dist'),
    join(import.meta.dir, '..', '..', 'packages', 'web', 'dist'),
  ];
  // Mirror the observer server's own check so we can warn the user here.
  if (!webDistCandidates.some(existsSync)) {
    console.warn(
      'Warning: web/dist not found. The mobile UI will show a placeholder page. ' +
        'Run "cd web && npm run build" to build the frontend.',
    );
  }

  // ── ClientStore + EngineClient (localhost WS client) ─────────────────────
  // The TUI consumes a ClientStore fed via the localhost WebSocket
  // connection — NOT via the T21 transitional EventStore-forwarding bridge.
  // The EngineClient connects to the observer server's WS endpoint, subscribes
  // to this run's runId, and forwards snapshot/events/log messages (filtered
  // by runId) into the ClientStore.
  //
  // Pre-generate the QR overlay BEFORE start() so it is attached during the
  // first (scrollback-safe) render; attaching it later can cause it to flash
  // and vanish due to a pi-tui incremental-render edge case.
  const clientStore = new ClientStore();
  const engineClient = new EngineClient({ url: `ws://127.0.0.1:${port}/ws` });
  engineClient.connect({
    onMessage: (msg) => {
      // Ignore messages for other runs (multi-run multiplexing).
      switch (msg.type) {
        case 'snapshot':
          if (msg.runId === runId) clientStore.applySnapshot(msg.state, msg.seq);
          break;
        case 'events':
          if (msg.runId === runId) clientStore.applyEvents(msg.events);
          break;
        case 'log':
          if (msg.runId === runId) clientStore.appendRunLog(msg.level, msg.message, msg.timestamp);
          break;
      }
    },
  });
  engineClient.subscribe(runId);

  const tuiInstance = new WorkflowTUI({
    clientStore,
    runId,
    // Transitional in-process bridge: both detach and kill terminate the
    // in-process workflow (there is no daemon to leave a run running on).
    onDetach: () => options.onTerminate(),
    onKill: () => options.onTerminate(),
  });
  await tuiInstance.prepareQrCode(serverUrl);
  tuiInstance.start();

  // Wire the real broadcast now that the server is running.
  broadcastHolder.fn = observerServer.broadcast;

  return { tuiInstance, observerServer, statusBridge, store, storeCallbacks, engineClient };
}
