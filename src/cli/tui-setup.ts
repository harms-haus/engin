import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getLocalNetworkIP } from '../core/network.js';
import type { StatusCallbacks } from '../core/types.js';
import { EventStore } from '../tracking/event-store.js';
import { createStoreCallbacks } from '../tracking/store-callbacks.js';
import { WorkflowTUI } from '../tui/workflow-tui.js';
import type { ObserverServer } from '../web/observer-server.js';
import type { ServerMessage } from '../web/protocol-types.js';
import { StatusBridge } from '../web/status-bridge.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Options for setting up the TUI and observer server.
 */
export interface TuiSetupOptions {
  /** HTTP port for the observer web server (default 3619). */
  port?: number;
  /** Bind host for the observer web server. If not set, binds to 0.0.0.0 and auto-detects LAN IP for display. */
  host?: string;
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
}

// ─── Setup Function ─────────────────────────────────────────────────────────

/**
 * Set up the TUI dashboard and observer web server.
 *
 * This encapsulates the shared TUI/observer setup logic used by both
 * `runCommand` and `resumeCommand` in commands.ts.
 *
 * Steps performed:
 * 1. Resolve port and host (auto-detect LAN IP when no host is specified).
 * 2. Create the EventStore, a mutable broadcast holder, and StatusBridge.
 * 3. Start the observer web server via dynamic import.
 * 4. Warn if the frontend bundle (web/dist) is missing.
 * 5. Create the WorkflowTUI instance, prepare the QR code, and start it.
 * 6. Wire the real broadcast function from the observer server to the holder.
 *
 * @returns A `TuiSetupResult` with the initialized TUI, server, and bridge.
 */
export async function setupTuiAndObserver(options: TuiSetupOptions): Promise<TuiSetupResult> {
  // ── Resolve port and host ────────────────────────────────────────────────
  const port = options.port ?? 3619;
  let bindHost: string;
  let displayHost: string | undefined;

  if (options.host) {
    // User specified a host — use it for both bind and display
    bindHost = options.host;
    displayHost = undefined; // startObserverServer will use server.hostname
  } else {
    // Auto-detect: bind to all interfaces, display the LAN IP
    bindHost = '0.0.0.0';
    displayHost = getLocalNetworkIP() ?? '127.0.0.1';
  }

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
  const statusBridge = new StatusBridge((msg: ServerMessage) => broadcastHolder.fn(msg), store);

  // ── Observer server ──────────────────────────────────────────────────────
  const bridge = statusBridge;
  const snapshotFn = (): ServerMessage => bridge.getSnapshot();
  const { startObserverServer } = await import('../web/observer-server.js');
  const observerServer = await startObserverServer({
    host: bindHost,
    port,
    ...(displayHost ? { displayHost } : {}),
    onTerminate: () => options.onTerminate(),
    getSnapshot: snapshotFn,
    handleResync: (ws, lastSeq) => {
      const msg = bridge.handleResync(lastSeq);
      ws.send(JSON.stringify(msg));
    },
  });
  const serverUrl = observerServer.url;

  // ── Frontend build warning ───────────────────────────────────────────────
  const distDir = join(import.meta.dir, '..', '..', 'web', 'dist');
  if (!existsSync(distDir)) {
    console.warn(
      'Warning: web/dist not found. The mobile UI will show a placeholder page. ' +
        'Run "cd web && npm run build" to build the frontend.',
    );
  }

  // ── WorkflowTUI ──────────────────────────────────────────────────────────
  // Create TUI. Pass the store so the TUI subscribes to projection updates.
  // Pre-generate the QR overlay BEFORE start() so it is attached during the
  // first (scrollback-safe) render; attaching it later can cause it to flash
  // and vanish due to a pi-tui incremental-render edge case.
  const tuiInstance = new WorkflowTUI({
    abort: () => options.onTerminate(),
    store,
  });
  await tuiInstance.prepareQrCode(serverUrl);
  tuiInstance.start();

  // Wire the real broadcast now that the server is running.
  broadcastHolder.fn = observerServer.broadcast;

  return { tuiInstance, observerServer, statusBridge, store, storeCallbacks };
}
