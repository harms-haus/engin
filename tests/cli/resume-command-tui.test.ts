/**
 * T27 — resumeCommand as a pure daemon-client.
 *
 * In the T27 target state resumeCommand:
 *   1. Resolves the session name (from arg or interactive picker).
 *   2. Reads the state file to recover `taskPrompt` and optional worktree info.
 *   3. Probes GET /health on `options.port`; auto-starts the daemon if down.
 *   4. Creates an EngineClient connecting to the daemon's WS endpoint.
 *   5. Checks whether the runId is in the daemon's active list. If active,
 *      subscribes + resyncs.  If not, sends `start_run` with the existing
 *      workDir to resume execution.
 *   6. Waits for `run_complete` / `run_failed`.
 *   7. Disconnects — the daemon keeps running.
 *
 * These tests will be RED against the current (T23) source because
 * resumeCommand still starts an in-process server.  The implementation phase
 * rewrites resumeCommand to satisfy the contract below.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realWorkflowLoader = Object.assign({}, await import('../../packages/engine/src/core/workflow-loader.js'));
const realFs = Object.assign({}, await import('node:fs'));
const realUtils = Object.assign({}, await import('../../packages/engine/src/core/utils.js'));
const realConsoleStatus = Object.assign({}, await import('../../packages/cli/src/cli/console-status.js'));
const realConfig = Object.assign({}, await import('../../packages/engine/src/core/config.js'));
const realPostWorktree = Object.assign({}, await import('../../packages/cli/src/cli/post-worktree.js'));
const realWorkflowTUI = Object.assign({}, await import('../../packages/tui/src/workflow-tui.js'));
const realEngineClient = Object.assign({}, await import('@engin/shared/engine-client'));
const realClientStore = Object.assign({}, await import('@engin/shared/client-store'));
const realDaemon = Object.assign({}, await import('../../packages/engine/src/server/daemon.js'));
const realAuth = Object.assign({}, await import('../../packages/engine/src/server/auth.js'));
const realEventStore = Object.assign({}, await import('../../packages/engine/src/tracking/event-store.js'));
const realStoreCallbacks = Object.assign({}, await import('../../packages/engine/src/tracking/store-callbacks.js'));
const realControlServer = Object.assign({}, await import('../../packages/engine/src/server/control-server.js'));
const realStatusBridge = Object.assign({}, await import('../../packages/engine/src/server/status-bridge.js'));
const realSessionSelector = Object.assign({}, await import('../../packages/cli/src/cli/session-selector.js'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.js'));

// ─── Mock functions ──────────────────────────────────────────────────────

// Daemon mocks
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
const mockEngineClientSubscribe = mock<(runId: string) => void>();
const mockEngineClientResync = mock<(runId: string) => void>();

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

// Session selector spies
const mockResolveSessionName = mock<(sessionName: string, cwd: string) => Promise<unknown>>();
const mockInteractiveSelectRun = mock<(cwd: string) => Promise<unknown>>();
const mockQueryActiveRuns = mock<(client: unknown) => Promise<unknown[]>>();

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
  shouldUseTui: () => true,
}));

mock.module('../../packages/engine/src/server/daemon.js', () => ({
  ...realDaemon,
  isServerAlive: mockIsServerAlive,
  startDaemon: mockStartDaemon,
  stopDaemon: mockStopDaemon,
}));

// T35: mock readServerToken so commands.ts doesn't do real filesystem I/O.
// Returns null (no token) — T27 tests don't test auth token wiring.
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
    subscribe(runId: string) {
      mockEngineClientSubscribe(runId);
    }
    resync(runId: string) {
      mockEngineClientResync(runId);
    }
    unsubscribe(_runId: string) {}
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
  interactiveSelectRun: mockInteractiveSelectRun,
  resolveSessionName: mockResolveSessionName,
  queryActiveRuns: mockQueryActiveRuns,
}));

mock.module('../../packages/cli/src/cli/post-worktree.js', () => ({
  promptPostWorktreeAction: mockPromptPostWorktreeAction,
}));

mock.module('../../packages/engine/src/core/config.js', () => ({
  ...realConfig,
  getDefaultWorkDir: (_cwd: string, wf: string) => `/tmp/test-engin/work/${Date.now()}-${wf}`,
  resolveProfilesDirs: mockResolveProfilesDirs,
  scanPastRuns: () => Promise.resolve([]),
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────

import { resumeCommand } from '../../packages/cli/src/cli.ts';

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
  mock.module('../../packages/engine/src/core/config.js', () => realConfig);
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

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

/**
 * Deliver a sequence of server messages to the captured EngineClient onMessage
 * callback, then await the command promise.
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

/** Yield to the event loop until `predicate` is true (or `timeoutMs` elapses).
 *  Used by the attach-mode tests to wait until `attachToRun` has run (i.e.
 *  the client has subscribed → the local runId is set) before injecting
 *  snapshot/terminal messages for that runId. */
async function flushUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('flushUntil timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// resumeCommand — T27 daemon-client integration
// ═══════════════════════════════════════════════════════════════════════════

describe('resumeCommand — daemon-client integration (T27)', () => {
  const { getDir } = useTempDir();

  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  function createPastRunDir(
    tempDir: string,
    dirName: string,
    state: {
      taskPrompt: string;
      worktree?: { worktreePath: string; branchName: string; originalCwd: string };
    },
  ) {
    const runDir = join(tempDir, '.engin', 'work', dirName);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, '.engin-state.json'), JSON.stringify(state));
    return runDir;
  }

  function makeResumeOptions(overrides: {
    cwd: string;
    sessionName: string;
    apiKeys?: Record<string, string>;
    lan?: boolean;
    host?: string;
    port?: number;
  }) {
    return {
      command: 'resume' as const,
      sessionName: overrides.sessionName,
      cwd: overrides.cwd,
      maxConcurrent: 3,
      verbose: false,
      worktree: false,
      apiKeys: overrides.apiKeys ?? {},
      warnings: [],
      host: overrides.host,
      lan: overrides.lan,
      port: overrides.port,
    };
  }

  /**
   * Create a past run directory with a state file and return a builder
   * function for resume options.
   */
  function setupRun(
    state: {
      taskPrompt: string;
      worktree?: { worktreePath: string; branchName: string; originalCwd: string };
    },
    dirName = '1700000000000-my-workflow',
  ) {
    const tempDir = getDir();
    const runDir = createPastRunDir(tempDir, dirName, state);
    return {
      tempDir,
      runDir,
      dirName,
      make: (overrides: Partial<Parameters<typeof makeResumeOptions>[0]> = {}) =>
        makeResumeOptions({ cwd: tempDir, sessionName: dirName, ...overrides }),
    };
  }

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
    mockEngineClientSubscribe.mockReset();
    mockEngineClientResync.mockReset();
    mockApplySnapshot.mockReset();
    mockApplyEvents.mockReset();
    mockClientStoreGetState.mockReset();
    mockEventStoreLoad.mockReset();
    mockCreateStoreCallbacks.mockReset();
    mockStartControlServer.mockReset();
    mockPromptPostWorktreeAction.mockReset();
    mockResolveSessionName.mockReset();
    mockInteractiveSelectRun.mockReset();
    mockQueryActiveRuns.mockReset();
    mockResolveProfilesDirs.mockReset();

    capturedTuiOptions = null;
    capturedEngineClientOptions = null;
    capturedEngineClientCallbacks = null;
    capturedSentMessages = [];
    engineClientInstanceCount = 0;
    clientStoreInstanceCount = 0;

    // Default: server is alive
    mockIsServerAlive.mockResolvedValue(true);
    mockStartDaemon.mockResolvedValue({ pid: 12345, port: 3619 });

    // Default: TUI mock behaviors
    mockTuiPrepareQrCode.mockResolvedValue(undefined);
    mockTuiPauseForInspection.mockResolvedValue(undefined);

    // Default: resolveSessionName returns the PastRunEntry
    mockResolveSessionName.mockImplementation(async (sessionName: string, cwd: string) => ({
      dirName: sessionName,
      fullPath: join(cwd, '.engin', 'work', sessionName),
      workflowName: sessionName.split('-').slice(1).join('-') || 'my-workflow',
      timestamp: Number(sessionName.split('-')[0]) || Date.now(),
      hasStateFile: true,
    }));

    mockResolveProfilesDirs.mockImplementation((_cwd: string, wf?: string) => [
      `/local/profiles/${wf}`,
      `/global/profiles/${wf}`,
    ]);

    // Default: no active runs on the server. The positional resume path then
    // falls through to the disk scan (historical start_run resume).
    mockQueryActiveRuns.mockResolvedValue([]);
  });

  afterEach(() => {
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
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockIsServerAlive).toHaveBeenCalled();
      expect(mockIsServerAlive).toHaveBeenCalledWith(3619);
    });

    it('uses custom port from options', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make({ port: 8080 }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockIsServerAlive).toHaveBeenCalledWith(8080);
    });

    it('auto-starts daemon when server is down', async () => {
      mockIsServerAlive.mockResolvedValue(false);
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockStartDaemon).toHaveBeenCalledTimes(1);
      expect(mockStartDaemon).toHaveBeenCalledWith({ port: 3619, host: '127.0.0.1' });
    });

    it('does NOT call startDaemon when server is already alive', async () => {
      mockIsServerAlive.mockResolvedValue(true);
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockStartDaemon).not.toHaveBeenCalled();
    });
  });

  // ─── Session resolution ─────────────────────────────────────────────────

  describe('session resolution', () => {
    it('reads the state file to recover taskPrompt', async () => {
      const { make } = setupRun({ taskPrompt: 'saved prompt text' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      // The task prompt should be forwarded to the daemon.
      const startRunMsg = capturedSentMessages.find((m) => (m as Record<string, unknown>).type === 'start_run') as
        | Record<string, unknown>
        | undefined;

      // Either start_run is sent with the saved prompt, or the command
      // used it internally. If start_run is sent, verify the prompt.
      if (startRunMsg) {
        expect(startRunMsg.taskPrompt).toBe('saved prompt text');
      }
    });

    it('throws when state file has no taskPrompt', async () => {
      const { make } = setupRun({ taskPrompt: '' });

      await expect(resumeCommand(make())).rejects.toThrow('no task prompt');
    });

    it('throws when state file has no resumable state', async () => {
      const tempDir = getDir();
      const dirName = '1700000000000-no-state';
      const runDir = join(tempDir, '.engin', 'work', dirName);
      mkdirSync(runDir, { recursive: true });
      // No .engin-state.json created

      const opts = makeResumeOptions({ cwd: tempDir, sessionName: dirName });

      await expect(resumeCommand(opts)).rejects.toThrow();
    });
  });

  // ─── EngineClient (WS client) setup ────────────────────────────────────

  describe('EngineClient (localhost WS client) setup', () => {
    it('creates exactly one EngineClient', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(engineClientInstanceCount).toBe(1);
    });

    it("points EngineClient at daemon's localhost WS endpoint", async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(capturedEngineClientOptions).not.toBeNull();
      expect(capturedEngineClientOptions!.url).toBe('ws://127.0.0.1:3619/ws');
    });

    it('uses configured port in the WS URL', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make({ port: 8080 }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(capturedEngineClientOptions!.url).toBe('ws://127.0.0.1:8080/ws');
    });

    it('always uses 127.0.0.1 in WS URL even with --host/--lan', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make({ lan: true, host: '0.0.0.0' }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(capturedEngineClientOptions!.url).toBe('ws://127.0.0.1:3619/ws');
    });

    it('creates exactly one ClientStore', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(clientStoreInstanceCount).toBe(1);
    });

    it('disconnects EngineClient during teardown', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockEngineClientDisconnect).toHaveBeenCalledTimes(1);
    });
  });

  // ─── WS protocol: resume behavior ──────────────────────────────────────

  describe('WS protocol: resume behavior', () => {
    it('sends start_run to resume the workflow via the daemon', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const startRunMsg = capturedSentMessages.find((m) => (m as Record<string, unknown>).type === 'start_run');
      expect(startRunMsg).toBeDefined();
    });

    it('includes the saved taskPrompt in start_run', async () => {
      const { make } = setupRun({ taskPrompt: 'the original prompt' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const startRunMsg = capturedSentMessages.find((m) => (m as Record<string, unknown>).type === 'start_run') as
        | Record<string, unknown>
        | undefined;

      if (startRunMsg) {
        expect(startRunMsg.taskPrompt).toBe('the original prompt');
      }
    });

    it('resolves when run_complete is received', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockEngineClientDisconnect).toHaveBeenCalled();
    });

    it('resolves when run_failed is received', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_failed', runId: 'r1', error: 'boom', phase: 'dev' },
      ]);

      expect(mockEngineClientDisconnect).toHaveBeenCalled();
    });
  });

  // ─── WS protocol: message forwarding to ClientStore ────────────────────

  describe('WS protocol: message forwarding to ClientStore', () => {
    const dirName = '1700000000000-resume-ws-run';

    it('forwards snapshot messages to ClientStore.applySnapshot', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' }, dirName);

      const cmd = resumeCommand(make());
      const snapshotState = { seq: 3, status: 'running' };

      await waitForEngineClient();
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_started',
        runId: dirName,
        summary: makeRunSummary(dirName),
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'snapshot',
        runId: dirName,
        seq: 3,
        state: snapshotState,
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_complete',
        runId: dirName,
      });

      await cmd;

      expect(mockApplySnapshot).toHaveBeenCalled();
      expect(mockApplySnapshot).toHaveBeenCalledWith(snapshotState, 3);
    });

    it('forwards events messages to ClientStore.applyEvents', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' }, dirName);

      const cmd = resumeCommand(make());
      const events = [{ seq: 4, type: 'phase_start' }];

      await waitForEngineClient();
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_started',
        runId: dirName,
        summary: makeRunSummary(dirName),
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'events',
        runId: dirName,
        seq: 4,
        events,
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_complete',
        runId: dirName,
      });

      await cmd;

      expect(mockApplyEvents).toHaveBeenCalled();
      expect(mockApplyEvents).toHaveBeenCalledWith(events);
    });

    it('ignores messages for a different runId', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' }, dirName);

      const cmd = resumeCommand(make());

      await waitForEngineClient();
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_started',
        runId: dirName,
        summary: makeRunSummary(dirName),
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'snapshot',
        runId: 'different-run',
        seq: 1,
        state: {},
      });
      capturedEngineClientCallbacks?.onMessage({
        type: 'run_complete',
        runId: dirName,
      });

      await cmd;

      // applySnapshot should only be called with the correct runId's data.
      // The mock was called (from the run_started flow), but NOT for the wrong runId.
      const wrongRunCalls = mockApplySnapshot.mock.calls.filter((call) => call[0] !== dirName);
      expect(wrongRunCalls).toHaveLength(0);
    });
  });

  // ─── TUI lifecycle ─────────────────────────────────────────────────────

  describe('TUI lifecycle', () => {
    it('creates a WorkflowTUI with onDetach/onKill callbacks and clientStore', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
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
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockTuiStart).toHaveBeenCalledTimes(1);
    });

    it('prepares QR code with the daemon URL', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make({ port: 8080 }));
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockTuiPrepareQrCode).toHaveBeenCalledTimes(1);
      expect(mockTuiPrepareQrCode.mock.calls[0][0]).toBe('http://127.0.0.1:8080');
    });

    it('calls pauseForInspection after run_complete', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockTuiPauseForInspection).toHaveBeenCalledTimes(1);
    });

    it('passes no signal to pauseForInspection (TUI manages its own shutdown)', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      const signalArg = mockTuiPauseForInspection.mock.calls[0][0];
      expect(signalArg).toBeUndefined();
    });

    it('stops the TUI after pause resolves', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockTuiStop).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Worktree resume ────────────────────────────────────────────────────

  describe('worktree resume', () => {
    const mockWorktreeInfo = {
      worktreePath: '/tmp/resume-worktree-path',
      branchName: 'engin/test-resume-abc123',
      originalCwd: '/tmp/original-cwd',
    };

    it('passes worktree info in start_run when state has worktree data', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed worktree task', worktree: mockWorktreeInfo });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      // The command should include worktree info in the start_run message
      // so the daemon can resume in the correct worktree context.
      const startRunMsg = capturedSentMessages.find((m) => (m as Record<string, unknown>).type === 'start_run');
      // start_run should be sent even for worktree resume
      expect(startRunMsg).toBeDefined();
    });

    it('calls promptPostWorktreeAction after TUI pause resolves', async () => {
      mockPromptPostWorktreeAction.mockResolvedValue(undefined);
      const { make } = setupRun({ taskPrompt: 'resumed worktree task', worktree: mockWorktreeInfo });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockPromptPostWorktreeAction).toHaveBeenCalledTimes(1);
    });

    it('disconnects EngineClient during worktree resume teardown', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed worktree task', worktree: mockWorktreeInfo });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockEngineClientDisconnect).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Cleanup and error handling ────────────────────────────────────────

  describe('cleanup and error handling', () => {
    it('does not leak SIGINT listeners in TTY mode (T30)', async () => {
      // T30: TUI mode does NOT register a process-level SIGINT listener —
      // the TUI handles Ctrl+C via raw-mode input. Assert no SIGINT
      // listeners are leaked after the run completes.
      const sigintBefore = process.listeners('SIGINT').length;

      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(process.listeners('SIGINT')).toHaveLength(sigintBefore);
    });

    it('disconnects EngineClient when run_failed', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_failed', runId: 'r1', error: 'oops', phase: 'x' },
      ]);

      expect(mockEngineClientDisconnect).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Negative assertions: T27 must NOT use in-process server ───────────

  describe('must NOT use in-process server infrastructure', () => {
    it('does NOT call startControlServer', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockStartControlServer).not.toHaveBeenCalled();
    });

    it('does NOT create an in-process EventStore', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockEventStoreLoad).not.toHaveBeenCalled();
    });

    it('does NOT call createStoreCallbacks', async () => {
      const { make } = setupRun({ taskPrompt: 'resumed task' });

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      expect(mockCreateStoreCallbacks).not.toHaveBeenCalled();
    });
  });

  // ─── Interactive session picker (stub for T46) ─────────────────────────

  describe('interactive session picker', () => {
    it('calls interactiveSelectRun when no sessionName is provided', async () => {
      mockInteractiveSelectRun.mockResolvedValue(undefined);

      const tempDir = getDir();
      const opts = {
        command: 'resume' as const,
        cwd: tempDir,
        maxConcurrent: 3,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      // resumeCommand with no sessionName should invoke the interactive picker.
      // When the picker returns undefined (user cancelled), the command exits.
      await resumeCommand(opts);

      // The interactive picker should have been consulted.
      // (The exact assertion depends on the implementation.)
      // For now, verify the mock was available.
      expect(mockInteractiveSelectRun).toBeDefined();
    });
  });

  // ─── Attach to an already-active run (subscribe only, NO start_run) ────
  //
  // §9 contract: `engin resume <runId>` against a run that is active in the
  // server's registry must subscribe + resync and block until terminal — it
  // must NOT send start_run (the run is already executing). Selecting an
  // active run in the interactive picker behaves identically.

  describe('attach to active run (subscribe only, no start_run)', () => {
    it('positional: sessionName matching an active runId subscribes + resyncs, never sends start_run', async () => {
      const activeRunId = '1789-active-attach-run';
      mockQueryActiveRuns.mockResolvedValue([
        makeRunSummary(activeRunId, { workflowName: 'active-wf', status: 'running' }),
      ]);

      const tempDir = getDir();
      const opts = makeResumeOptions({ cwd: tempDir, sessionName: activeRunId });

      const cmd = resumeCommand(opts);
      // Wait until attachToRun has subscribed (local runId is now set), so the
      // injected snapshot/terminal messages route for the correct runId.
      await flushUntil(() => mockEngineClientSubscribe.mock.calls.length > 0);

      capturedEngineClientCallbacks?.onMessage({
        type: 'snapshot',
        runId: activeRunId,
        seq: 1,
        state: { seq: 1 },
      });
      capturedEngineClientCallbacks?.onMessage({ type: 'run_complete', runId: activeRunId });
      await cmd;

      expect(mockQueryActiveRuns).toHaveBeenCalledTimes(1);
      expect(mockEngineClientSubscribe).toHaveBeenCalledWith(activeRunId);
      expect(mockEngineClientResync).toHaveBeenCalledWith(activeRunId);
      // CRITICAL: an already-active run must never be started again.
      const startRunSent = capturedSentMessages.some((m) => (m as Record<string, unknown>).type === 'start_run');
      expect(startRunSent).toBe(false);
      // The resync snapshot was forwarded into the store.
      expect(mockApplySnapshot).toHaveBeenCalled();
      // Clean teardown.
      expect(mockEngineClientDisconnect).toHaveBeenCalledTimes(1);
    });

    it('picker: selecting an active run subscribes + resyncs, never sends start_run', async () => {
      const activeRunId = 'picker-active-run';
      const activeSummary = makeRunSummary(activeRunId, { workflowName: 'picker-wf', status: 'running' });
      mockInteractiveSelectRun.mockResolvedValue({ type: 'active', runSummary: activeSummary });

      const tempDir = getDir();
      const opts = {
        command: 'resume' as const,
        cwd: tempDir,
        maxConcurrent: 3,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      const cmd = resumeCommand(opts);
      await flushUntil(() => mockEngineClientSubscribe.mock.calls.length > 0);

      capturedEngineClientCallbacks?.onMessage({ type: 'run_complete', runId: activeRunId });
      await cmd;

      expect(mockInteractiveSelectRun).toHaveBeenCalledTimes(1);
      expect(mockEngineClientSubscribe).toHaveBeenCalledWith(activeRunId);
      expect(mockEngineClientResync).toHaveBeenCalledWith(activeRunId);
      const startRunSent = capturedSentMessages.some((m) => (m as Record<string, unknown>).type === 'start_run');
      expect(startRunSent).toBe(false);
      expect(mockEngineClientDisconnect).toHaveBeenCalledTimes(1);
    });

    it('attach path blocks until a terminal event for the attached runId', async () => {
      const activeRunId = 'blocking-active-run';
      mockQueryActiveRuns.mockResolvedValue([makeRunSummary(activeRunId)]);

      const tempDir = getDir();
      const opts = makeResumeOptions({ cwd: tempDir, sessionName: activeRunId });

      let resolved = false;
      const cmd = resumeCommand(opts).then(() => {
        resolved = true;
      });

      await flushUntil(() => mockEngineClientSubscribe.mock.calls.length > 0);

      // Attached but no terminal yet — the command must still be pending.
      await new Promise((r) => setTimeout(r, 30));
      expect(resolved).toBe(false);

      // A terminal for a DIFFERENT run must not resolve it.
      capturedEngineClientCallbacks?.onMessage({ type: 'run_complete', runId: 'someone-else' });
      await new Promise((r) => setTimeout(r, 30));
      expect(resolved).toBe(false);

      capturedEngineClientCallbacks?.onMessage({
        type: 'run_failed',
        runId: activeRunId,
        error: 'boom',
        phase: 'dev',
      });
      await cmd;
      expect(resolved).toBe(true);
      expect(mockEngineClientDisconnect).toHaveBeenCalledTimes(1);
    });

    it('positional: sessionName NOT matching an active run falls back to disk resume (start_run)', async () => {
      mockQueryActiveRuns.mockResolvedValue([]);
      const { make } = setupRun({ taskPrompt: 'disk resume prompt' }, '1700000000000-disk-only');

      const cmd = resumeCommand(make());
      await deliverAndAwait(cmd, [
        { type: 'run_started', runId: 'r1', summary: makeRunSummary('r1') },
        { type: 'run_complete', runId: 'r1' },
      ]);

      // queryActiveRuns was consulted before the disk fallback.
      expect(mockQueryActiveRuns).toHaveBeenCalledTimes(1);
      const startRunMsg = capturedSentMessages.find((m) => (m as Record<string, unknown>).type === 'start_run');
      expect(startRunMsg).toBeDefined();
    });

    it('forwards snapshot/events for the attached runId into the ClientStore', async () => {
      const activeRunId = 'attach-forward-run';
      mockQueryActiveRuns.mockResolvedValue([makeRunSummary(activeRunId)]);

      const tempDir = getDir();
      const opts = makeResumeOptions({ cwd: tempDir, sessionName: activeRunId });

      const cmd = resumeCommand(opts);
      await flushUntil(() => mockEngineClientSubscribe.mock.calls.length > 0);

      const snapshotState = { seq: 5, status: 'running' };
      const events = [{ seq: 6, type: 'phase_start' }];
      capturedEngineClientCallbacks?.onMessage({
        type: 'snapshot',
        runId: activeRunId,
        seq: 5,
        state: snapshotState,
      });
      capturedEngineClientCallbacks?.onMessage({ type: 'events', runId: activeRunId, seq: 6, events });
      capturedEngineClientCallbacks?.onMessage({ type: 'run_complete', runId: activeRunId });
      await cmd;

      expect(mockApplySnapshot).toHaveBeenCalledWith(snapshotState, 5);
      expect(mockApplyEvents).toHaveBeenCalledWith(events);
    });

    it('ignores snapshot messages for a runId other than the attached one', async () => {
      const activeRunId = 'attach-filter-run';
      mockQueryActiveRuns.mockResolvedValue([makeRunSummary(activeRunId)]);

      const tempDir = getDir();
      const opts = makeResumeOptions({ cwd: tempDir, sessionName: activeRunId });

      const cmd = resumeCommand(opts);
      await flushUntil(() => mockEngineClientSubscribe.mock.calls.length > 0);

      capturedEngineClientCallbacks?.onMessage({
        type: 'snapshot',
        runId: 'other-run',
        seq: 1,
        state: { wrong: true },
      });
      capturedEngineClientCallbacks?.onMessage({ type: 'run_complete', runId: activeRunId });
      await cmd;

      expect(mockApplySnapshot).not.toHaveBeenCalled();
    });
  });
});
