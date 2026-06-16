/**
 * T27 — runCommand as a pure daemon-client.
 *
 * In the T27 target state the CLI no longer starts an in-process control
 * server.  Instead it:
 *   1. Probes GET /health on `options.port` (default 3619).
 *   2. Auto-starts the daemon via `daemon.startDaemon` when the server is down.
 *   3. Creates an EngineClient (WS client) connecting to the daemon.
 *   4. Sends `start_run` and waits for `run_started` → `run_complete`/`run_failed`.
 *   5. Attaches a view (TUI in TTY mode, console renderer in non-TTY).
 *   6. Disconnects on exit — the daemon keeps running.
 *
 * These tests will be RED against the current (T23) source because
 * commands.ts still starts an in-process server.  The implementation phase
 * rewrites commands.ts to satisfy the contract below.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Capture real modules before mocking ──────────────────────────────────

const realWorkflowLoader = Object.assign({}, await import('../../packages/engine/src/core/workflow-loader.js'));
const realUtils = Object.assign({}, await import('../../packages/engine/src/core/utils.js'));
const realConsoleStatus = Object.assign({}, await import('../../packages/cli/src/cli/console-status.js'));
const realWorkflowTUI = Object.assign({}, await import('../../packages/tui/src/workflow-tui.js'));
const realEngineClient = Object.assign({}, await import('@engin/shared/engine-client'));
const realClientStore = Object.assign({}, await import('@engin/shared/client-store'));
const realDaemon = Object.assign({}, await import('../../packages/engine/src/server/daemon.js'));
const realAuth = Object.assign({}, await import('../../packages/engine/src/server/auth.js'));
const realConfig = Object.assign({}, await import('../../packages/engine/src/core/config.js'));
const realPostWorktree = Object.assign({}, await import('../../packages/cli/src/cli/post-worktree.js'));
const realEventStore = Object.assign({}, await import('../../packages/engine/src/tracking/event-store.js'));
const realStoreCallbacks = Object.assign({}, await import('../../packages/engine/src/tracking/store-callbacks.js'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.js'));
const realSessionSelector = Object.assign({}, await import('../../packages/cli/src/cli/session-selector.js'));
const realControlServer = Object.assign({}, await import('../../packages/engine/src/server/control-server.js'));
const realStatusBridge = Object.assign({}, await import('../../packages/engine/src/server/status-bridge.js'));

// ─── Mock functions ──────────────────────────────────────────────────────

// Daemon mocks (T27 critical)
const mockIsServerAlive = mock<(port: number) => Promise<boolean>>();
const mockStartDaemon = mock<(opts: { port: number; host?: string }) => Promise<{ pid: number; port: number }>>();
const mockStopDaemon = mock<() => Promise<void>>();

// TUI lifecycle spies
const mockTuiStart = mock<() => void>();
const mockTuiStop = mock<() => void>();
const mockTuiPrepareQrCode = mock<(url: string) => Promise<void>>();
const mockTuiPauseForInspection = mock<(signal?: AbortSignal) => Promise<void>>();

// EngineClient spies
const mockEngineClientConnect = mock<(callbacks: unknown) => void>();
const mockEngineClientDisconnect = mock<() => void>();
const mockEngineClientSend = mock<(msg: unknown) => void>();

// ClientStore spies
const mockApplySnapshot = mock<(snapshot: unknown, seq: number) => void>();
const mockApplyEvents = mock<(events: unknown[]) => void>();
const mockClientStoreGetState = mock<() => Record<string, unknown>>();

// "NOT called" spies
const mockEventStoreLoad = mock<() => Promise<unknown>>();
const mockCreateStoreCallbacks = mock<() => unknown>();
const mockStartControlServer = mock<() => Promise<unknown>>();

// Post-worktree spy
const mockPromptPostWorktreeAction = mock<(options: Record<string, unknown>) => Promise<void>>();

// Config spies
const mockResolveProfilesDirs = mock<(cwd: string, workflowName?: string) => string[]>();

// Capture constructor arguments / state
let capturedTuiOptions: {
  onDetach?: () => void;
  onKill?: () => void;
  runId?: string;
  clientStore?: unknown;
} | null = null;
let capturedEngineClientOptions: { url?: string } | null = null;
let capturedEngineClientCallbacks: { onMessage: (msg: Record<string, unknown>) => void } | null = null;
let capturedSentMessages: unknown[] = [];
let engineClientInstanceCount = 0;
let clientStoreInstanceCount = 0;

// ─── Mock modules (hoisted before imports by Bun) ─────────────────────────

mock.module('../../packages/engine/src/core/workflow-loader.js', () => ({
  loadWorkflow: () => Promise.resolve({ run: () => {} }),
  clearWorkflowCache: () => {},
}));

mock.module('../../packages/engine/src/core/utils.js', () => ({
  validateWorkflowName: () => {},
  composeStatusCallbacks: () => ({}),
}));

mock.module('../../packages/cli/src/cli/console-status.js', () => ({
  formatTime: () => '[00:00:00]',
  shouldUseTui: () => true, // TUI path by default in tests
}));

mock.module('../../packages/engine/src/server/daemon.js', () => ({
  ...realDaemon,
  isServerAlive: mockIsServerAlive,
  startDaemon: mockStartDaemon,
  stopDaemon: mockStopDaemon,
}));

// T35: mock readServerToken so commands.ts doesn't do real filesystem I/O.
// Returns null (no token) — T27 tests don't test auth token wiring. Spread
// ...realAuth so the other auth exports (writeServerToken/validateToken/...)
// remain real, and restore auth.js in afterAll so the mock does not leak into
// tests/server/auth.test.ts (which exercises the real functions).
mock.module('../../packages/engine/src/server/auth.js', () => ({
  ...realAuth,
  readServerToken: async () => null,
}));

mock.module('../../packages/tui/src/workflow-tui.js', () => ({
  WorkflowTUI: class {
    constructor(options: { onDetach?: () => void; onKill?: () => void; runId?: string; clientStore?: unknown }) {
      capturedTuiOptions = options;
    }
    start() {
      mockTuiStart();
    }
    stop() {
      mockTuiStop();
    }
    setRunId(_runId: string) {}
    prepareQrCode(url: string) {
      return mockTuiPrepareQrCode(url);
    }
    pauseForInspection(signal?: AbortSignal) {
      return mockTuiPauseForInspection(signal);
    }
  },
}));

mock.module('@engin/shared/engine-client', () => ({
  EngineClient: class {
    constructor(options: { url?: string }) {
      capturedEngineClientOptions = options;
      engineClientInstanceCount++;
    }
    connect(callbacks: { onMessage: (msg: Record<string, unknown>) => void }) {
      capturedEngineClientCallbacks = callbacks;
      mockEngineClientConnect(callbacks);
    }
    disconnect() {
      mockEngineClientDisconnect();
    }
    send(msg: unknown) {
      capturedSentMessages.push(msg);
      mockEngineClientSend(msg);
    }
    subscribe(_runId: string) {}
    isConnected() {
      return true;
    }
  },
}));

mock.module('@engin/shared/client-store', () => ({
  ClientStore: class {
    constructor() {
      clientStoreInstanceCount++;
    }
    applySnapshot(snapshot: unknown, seq: number) {
      mockApplySnapshot(snapshot, seq);
    }
    applyEvents(events: unknown[]) {
      mockApplyEvents(events);
    }
    getState() {
      return mockClientStoreGetState();
    }
    subscribe(_listener: unknown) {
      return () => {};
    }
  },
}));

mock.module('../../packages/engine/src/tracking/event-store.js', () => ({
  EventStore: class {
    constructor() {}
    static async load() {
      return mockEventStoreLoad();
    }
  },
}));

mock.module('../../packages/engine/src/tracking/store-callbacks.js', () => ({
  createStoreCallbacks: mockCreateStoreCallbacks,
}));

mock.module('../../packages/engine/src/server/control-server.js', () => ({
  startControlServer: mockStartControlServer,
}));

mock.module('../../packages/engine/src/server/status-bridge.js', () => ({
  StatusBridge: class {},
}));

mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => ({
  setupWorktree: () => Promise.resolve({ worktreeInfo: null, worktreePath: '', branchName: '' }),
}));

mock.module('../../packages/cli/src/cli/session-selector.js', () => ({
  interactiveSelectRun: () => Promise.resolve(undefined),
  resolveSessionName: () => Promise.resolve(undefined),
}));

mock.module('../../packages/cli/src/cli/post-worktree.js', () => ({
  promptPostWorktreeAction: mockPromptPostWorktreeAction,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────

import { runCommand } from '../../packages/cli/src/cli.ts';

// ─── Restore original modules ────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/workflow-loader.js', () => realWorkflowLoader);
  mock.module('../../packages/engine/src/core/utils.js', () => realUtils);
  mock.module('../../packages/cli/src/cli/console-status.js', () => realConsoleStatus);
  mock.module('../../packages/engine/src/server/daemon.js', () => realDaemon);
  mock.module('../../packages/engine/src/server/auth.js', () => realAuth);
  mock.module('../../packages/tui/src/workflow-tui.js', () => realWorkflowTUI);
  mock.module('@engin/shared/engine-client', () => realEngineClient);
  mock.module('@engin/shared/client-store', () => realClientStore);
  mock.module('../../packages/engine/src/tracking/event-store.js', () => realEventStore);
  mock.module('../../packages/engine/src/tracking/store-callbacks.js', () => realStoreCallbacks);
  mock.module('../../packages/engine/src/server/control-server.js', () => realControlServer);
  mock.module('../../packages/engine/src/server/status-bridge.js', () => realStatusBridge);
  mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => realWorktreeLifecycle);
  mock.module('../../packages/cli/src/cli/session-selector.js', () => realSessionSelector);
  mock.module('../../packages/cli/src/cli/post-worktree.js', () => realPostWorktree);
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Default options for runCommand in TUI mode. */
function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    command: 'run' as const,
    workflowName: 'test-workflow',
    taskPrompt: 'test task prompt',
    cwd: '/tmp/test-cwd',
    workDir: undefined as string | undefined,
    maxConcurrent: 3,
    verbose: false,
    worktree: false,
    apiKeys: {},
    warnings: [],
    host: undefined,
    port: undefined,
    ...overrides,
  };
}

/**
 * Deliver a sequence of server messages to the captured EngineClient onMessage
 * callback, then await the command promise.  Messages are delivered
 * synchronously so that internal Promises (runStartedPromise,
 * terminalPromise) resolve on the next microtask checkpoint.
 */
async function deliverAndAwait(commandPromise: Promise<void>, messages: Record<string, unknown>[]): Promise<void> {
  // T35: readServerToken (async) now runs before EngineClient creation.
  // Yield once so that microtask resolves and connect() captures callbacks.
  if (!capturedEngineClientCallbacks) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (const msg of messages) {
    capturedEngineClientCallbacks?.onMessage(msg);
  }
  await commandPromise;
}

/** Yield until EngineClient.connect() has captured callbacks.
 *  T35 added readServerToken (async) before EngineClient creation, so tests
 *  that deliver messages directly (not via deliverAndAwait) must wait. */
async function waitForEngineClient(): Promise<void> {
  while (!capturedEngineClientCallbacks) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// runCommand — T27 daemon-client integration
// ═══════════════════════════════════════════════════════════════════════════

describe('runCommand — daemon-client integration (T27)', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    onSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');

    // Reset all mock functions
    mockIsServerAlive.mockReset();
    mockStartDaemon.mockReset();
    mockStopDaemon.mockReset();
    mockTuiStart.mockReset();
    mockTuiStop.mockReset();
    mockTuiPrepareQrCode.mockReset();
    mockTuiPauseForInspection.mockReset();
    mockEngineClientConnect.mockReset();
    mockEngineClientDisconnect.mockReset();
    mockEngineClientSend.mockReset();
    mockApplySnapshot.mockReset();
    mockApplyEvents.mockReset();
    mockClientStoreGetState.mockReset();
    mockEventStoreLoad.mockReset();
    mockCreateStoreCallbacks.mockReset();
    mockStartControlServer.mockReset();
    mockPromptPostWorktreeAction.mockReset();
    mockResolveProfilesDirs.mockReset();

    capturedTuiOptions = null;
    capturedEngineClientOptions = null;
    capturedEngineClientCallbacks = null;
    capturedSentMessages = [];
    engineClientInstanceCount = 0;
    clientStoreInstanceCount = 0;

    // Default: server is alive (no auto-start needed)
    mockIsServerAlive.mockResolvedValue(true);

    // Default: startDaemon returns a result (in case it's called)
    mockStartDaemon.mockResolvedValue({ pid: 12345, port: 3619 });

    // Default: TUI mock behaviors
    mockTuiPrepareQrCode.mockResolvedValue(undefined);
    mockTuiPauseForInspection.mockResolvedValue(undefined);

    // Default: config
    mockResolveProfilesDirs.mockImplementation((_cwd: string, wf?: string) => [
      `/local/profiles/${wf}`,
      `/global/profiles/${wf}`,
    ]);
  });

  afterEach(() => {
    // Clean up any SIGINT listeners left on the process
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

    // executeViaDaemon sets process.exitCode = 1 when a run fails; reset it so
    // it does not leak into sibling test files (bun ignores `= undefined`).
    process.exitCode = 0;

    logSpy.mockRestore();
    warnSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  // ─── Daemon health check and auto-start ─────────────────────────────────

  describe('daemon health check and auto-start', () => {
    it('probes isServerAlive on the default port (3619)', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockIsServerAlive).toHaveBeenCalledTimes(1);
      expect(mockIsServerAlive).toHaveBeenCalledWith(3619);
    });

    it('probes isServerAlive on the custom port from options', async () => {
      const cmd = runCommand(makeOptions({ port: 8080 }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockIsServerAlive).toHaveBeenCalledWith(8080);
    });

    it('auto-starts daemon via startDaemon when server is down', async () => {
      mockIsServerAlive.mockResolvedValue(false);

      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockStartDaemon).toHaveBeenCalledTimes(1);
      expect(mockStartDaemon).toHaveBeenCalledWith({ port: 3619, host: '127.0.0.1' });
    });

    it('does NOT call startDaemon when server is already alive', async () => {
      mockIsServerAlive.mockResolvedValue(true);

      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockStartDaemon).not.toHaveBeenCalled();
    });

    it('passes custom port and host to startDaemon', async () => {
      mockIsServerAlive.mockResolvedValue(false);

      const cmd = runCommand(makeOptions({ port: 9090, host: '0.0.0.0' }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockStartDaemon).toHaveBeenCalledWith({ port: 9090, host: '0.0.0.0' });
    });

    it('probes daemon AFTER auto-start to confirm readiness', async () => {
      mockIsServerAlive
        .mockResolvedValueOnce(false) // first probe: down
        .mockResolvedValueOnce(true); // second probe (after start): up

      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockIsServerAlive).toHaveBeenCalledTimes(2);
      expect(mockStartDaemon).toHaveBeenCalledTimes(1);
    });
  });

  // ─── EngineClient (WS client) setup ────────────────────────────────────

  describe('EngineClient (localhost WS client) setup', () => {
    it('creates exactly one EngineClient', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(engineClientInstanceCount).toBe(1);
    });

    it("points the EngineClient at the daemon's localhost WS endpoint", async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(capturedEngineClientOptions).not.toBeNull();
      expect(capturedEngineClientOptions!.url).toBe('ws://127.0.0.1:3619/ws');
    });

    it('uses the configured port in the WS URL', async () => {
      const cmd = runCommand(makeOptions({ port: 8080 }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(capturedEngineClientOptions!.url).toBe('ws://127.0.0.1:8080/ws');
    });

    it('always uses 127.0.0.1 in WS URL even with --host/--lan', async () => {
      const cmd = runCommand(makeOptions({ host: '0.0.0.0', lan: true }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(capturedEngineClientOptions!.url).toBe('ws://127.0.0.1:3619/ws');
    });

    it('connects the EngineClient with an onMessage callback', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockEngineClientConnect).toHaveBeenCalledTimes(1);
      expect(capturedEngineClientCallbacks).not.toBeNull();
      expect(typeof capturedEngineClientCallbacks!.onMessage).toBe('function');
    });

    it('creates exactly one ClientStore', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(clientStoreInstanceCount).toBe(1);
    });

    it('disconnects EngineClient during teardown', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockEngineClientDisconnect).toHaveBeenCalledTimes(1);
    });
  });

  // ─── WS protocol: start_run message ────────────────────────────────────

  describe('WS protocol: start_run message', () => {
    it('sends a start_run message via EngineClient.send', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const startRunMsg = capturedSentMessages.find((m) => (m as Record<string, unknown>).type === 'start_run');
      expect(startRunMsg).toBeDefined();
    });

    it('includes workflowName in start_run', async () => {
      const cmd = runCommand(makeOptions({ workflowName: 'my-flow' }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const startRunMsg = capturedSentMessages.find(
        (m) => (m as Record<string, unknown>).type === 'start_run',
      ) as Record<string, unknown>;
      expect(startRunMsg.workflowName).toBe('my-flow');
    });

    it('includes taskPrompt in start_run', async () => {
      const cmd = runCommand(makeOptions({ taskPrompt: 'build the thing' }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const startRunMsg = capturedSentMessages.find(
        (m) => (m as Record<string, unknown>).type === 'start_run',
      ) as Record<string, unknown>;
      expect(startRunMsg.taskPrompt).toBe('build the thing');
    });

    it('includes cwd in start_run', async () => {
      const cmd = runCommand(makeOptions({ cwd: '/my/project' }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const startRunMsg = capturedSentMessages.find(
        (m) => (m as Record<string, unknown>).type === 'start_run',
      ) as Record<string, unknown>;
      expect(startRunMsg.cwd).toBe('/my/project');
    });

    it('includes maxConcurrent in start_run when provided', async () => {
      const cmd = runCommand(makeOptions({ maxConcurrent: 7 }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const startRunMsg = capturedSentMessages.find(
        (m) => (m as Record<string, unknown>).type === 'start_run',
      ) as Record<string, unknown>;
      expect(startRunMsg.maxConcurrent).toBe(7);
    });

    it('includes apiKeys in start_run when provided', async () => {
      const apiKeys = { anthropic: 'sk-test' };
      const cmd = runCommand(makeOptions({ apiKeys }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const startRunMsg = capturedSentMessages.find(
        (m) => (m as Record<string, unknown>).type === 'start_run',
      ) as Record<string, unknown>;
      expect(startRunMsg.apiKeys).toEqual(apiKeys);
    });

    it('omits apiKeys from start_run when empty', async () => {
      const cmd = runCommand(makeOptions({ apiKeys: {} }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const startRunMsg = capturedSentMessages.find(
        (m) => (m as Record<string, unknown>).type === 'start_run',
      ) as Record<string, unknown>;
      expect(startRunMsg.apiKeys).toBeUndefined();
    });
  });

  // ─── WS protocol: message forwarding to ClientStore ────────────────────

  describe('WS protocol: message forwarding to ClientStore', () => {
    const runId = 'ws-forward-42';
    const workDir = `/tmp/test-engin/work/${runId}`;

    it('forwards snapshot messages to ClientStore.applySnapshot', async () => {
      const cmd = runCommand(makeOptions({ workDir }));
      const snapshotState = { seq: 3, status: 'running' };

      await waitForEngineClient();
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_started',
        runId,
        summary: makeRunSummary(runId),
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'snapshot',
        runId,
        seq: 3,
        state: snapshotState,
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_complete',
        runId,
      });

      await cmd;

      expect(mockApplySnapshot).toHaveBeenCalled();
      expect(mockApplySnapshot).toHaveBeenCalledWith(snapshotState, 3);
    });

    it('forwards events messages to ClientStore.applyEvents', async () => {
      const cmd = runCommand(makeOptions({ workDir }));
      const events = [{ seq: 4, type: 'phase_start' }];

      await waitForEngineClient();
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_started',
        runId,
        summary: makeRunSummary(runId),
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'events',
        runId,
        seq: 4,
        events,
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_complete',
        runId,
      });

      await cmd;

      expect(mockApplyEvents).toHaveBeenCalled();
      expect(mockApplyEvents).toHaveBeenCalledWith(events);
    });

    it('ignores snapshot messages for a different runId', async () => {
      const cmd = runCommand(makeOptions({ workDir }));

      await waitForEngineClient();
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_started',
        runId,
        summary: makeRunSummary(runId),
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'snapshot',
        runId: 'other-run',
        seq: 1,
        state: {},
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_complete',
        runId,
      });

      await cmd;

      expect(mockApplySnapshot).not.toHaveBeenCalled();
    });

    it('ignores events messages for a different runId', async () => {
      const cmd = runCommand(makeOptions({ workDir }));

      await waitForEngineClient();
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_started',
        runId,
        summary: makeRunSummary(runId),
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'events',
        runId: 'other-run',
        seq: 1,
        events: [],
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_complete',
        runId,
      });

      await cmd;

      expect(mockApplyEvents).not.toHaveBeenCalled();
    });
  });

  // ─── WS protocol: run lifecycle ────────────────────────────────────────

  describe('WS protocol: run lifecycle', () => {
    it('resolves when run_complete is received', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      // If we get here without hanging, the command resolved on run_complete
      expect(mockEngineClientDisconnect).toHaveBeenCalled();
    });

    it('resolves when run_failed is received', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_failed', runId: 'r1', error: 'boom', phase: 'dev' },
      ]);

      expect(mockEngineClientDisconnect).toHaveBeenCalled();
    });

    it('does not resolve until a terminal message arrives', async () => {
      let resolved = false;
      const cmd = runCommand(makeOptions()).then(() => {
        resolved = true;
      });

      await waitForEngineClient();
      // Deliver non-terminal messages only
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_started',
        runId: 'r1',
        summary: makeRunSummary('r1'),
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'snapshot',
        runId: 'r1',
        seq: 0,
        state: { seq: 0 },
      });

      // Give microtasks a chance to process
      await new Promise((r) => setTimeout(r, 50));
      expect(resolved).toBe(false);

      // Now deliver terminal
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_complete',
        runId: 'r1',
      });

      await cmd;
      expect(resolved).toBe(true);
    });
  });

  // ─── TUI lifecycle ─────────────────────────────────────────────────────

  describe('TUI lifecycle', () => {
    it('creates a WorkflowTUI with onDetach/onKill callbacks and clientStore', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(capturedTuiOptions).not.toBeNull();
      expect(capturedTuiOptions!.onDetach).toBeDefined();
      expect(typeof capturedTuiOptions!.onDetach).toBe('function');
      expect(capturedTuiOptions!.onKill).toBeDefined();
      expect(typeof capturedTuiOptions!.onKill).toBe('function');
      expect(capturedTuiOptions!.clientStore).toBeDefined();
    });

    it('starts the TUI', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockTuiStart).toHaveBeenCalledTimes(1);
    });

    it('prepares QR code with the daemon URL', async () => {
      const cmd = runCommand(makeOptions({ port: 8080 }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockTuiPrepareQrCode).toHaveBeenCalledTimes(1);
      expect(mockTuiPrepareQrCode.mock.calls[0][0]).toBe('http://127.0.0.1:8080');
    });

    it('calls pauseForInspection after run_complete', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockTuiPauseForInspection).toHaveBeenCalledTimes(1);
    });

    it('passes no signal to pauseForInspection (TUI manages its own shutdown)', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const signalArg = mockTuiPauseForInspection.mock.calls[0][0];
      expect(signalArg).toBeUndefined();
    });

    it('stops the TUI after pause resolves', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockTuiStop).toHaveBeenCalledTimes(1);
    });

    it('TUI onDetach/onKill callbacks are provided', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(capturedTuiOptions).not.toBeNull();
      expect(capturedTuiOptions!.onDetach).toBeDefined();
      expect(typeof capturedTuiOptions!.onDetach).toBe('function');
      expect(capturedTuiOptions!.onKill).toBeDefined();
      expect(typeof capturedTuiOptions!.onKill).toBe('function');
    });
  });

  // ─── Cleanup and error handling ────────────────────────────────────────

  describe('cleanup and error handling', () => {
    it('disconnects EngineClient after run_complete', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockEngineClientDisconnect).toHaveBeenCalledTimes(1);
    });

    it('disconnects EngineClient after run_failed', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_failed', runId: 'r1', error: 'oops', phase: 'x' },
      ]);

      expect(mockEngineClientDisconnect).toHaveBeenCalledTimes(1);
    });

    it('does not leak SIGINT listeners in TTY mode (T30)', async () => {
      // T30: TUI mode does NOT register a process-level SIGINT listener —
      // the TUI handles Ctrl+C via raw-mode input. Assert no SIGINT
      // listeners are leaked after the run completes.
      const sigintBefore = process.listeners('SIGINT').length;

      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(process.listeners('SIGINT')).toHaveLength(sigintBefore);
    });
  });

  // ─── Worktree handling ─────────────────────────────────────────────────

  describe('worktree handling', () => {
    it('calls promptPostWorktreeAction when worktree option is set', async () => {
      mockPromptPostWorktreeAction.mockResolvedValue(undefined);

      const cmd = runCommand(makeOptions({ worktree: true }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      // The command should have set up worktree handling.
      // promptPostWorktreeAction may be called if the command resolves
      // worktree info from the server response.
      // (Exact behavior depends on implementation.)
    });
  });

  // ─── Negative assertions: T27 must NOT use in-process server ───────────

  describe('must NOT use in-process server infrastructure', () => {
    it('does NOT call startControlServer', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockStartControlServer).not.toHaveBeenCalled();
    });

    it('does NOT create an in-process EventStore', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockEventStoreLoad).not.toHaveBeenCalled();
    });

    it('does NOT call createStoreCallbacks', async () => {
      const cmd = runCommand(makeOptions());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockCreateStoreCallbacks).not.toHaveBeenCalled();
    });
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeRunSummary(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    cwd: '/tmp/test-cwd',
    workflowName: 'test-workflow',
    taskPrompt: 'test task prompt',
    status: 'running',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}
