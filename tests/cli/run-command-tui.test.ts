import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Capture real modules before mocking ──────────────────────────────────

const realWorkflowLoader = Object.assign({}, await import('../../src/core/workflow-loader.js'));
const realNodeFs = Object.assign({}, await import('node:fs'));
const realUtils = Object.assign({}, await import('../../src/core/utils.js'));
const realNetwork = Object.assign({}, await import('../../src/core/network.js'));
const realConsoleStatus = Object.assign({}, await import('../../src/cli/console-status.js'));
const realObserverServer = Object.assign({}, await import('../../src/web/observer-server.js'));
const realStatusBridge = Object.assign({}, await import('../../src/web/status-bridge.js'));
const realWorkflowTUI = Object.assign({}, await import('../../src/tui/workflow-tui.js'));

// ─── Mock functions ──────────────────────────────────────────────────────

const mockWorkflowRun = mock<(taskPrompt: string, options: Record<string, unknown>) => Promise<void>>();

// Observer server components
const mockObserverBroadcast = mock<(msg: unknown) => void>();
const mockObserverStop = mock<() => Promise<void>>();
const mockStartObserverServer = mock<(opts: unknown) => Promise<unknown>>();

// TUI method spies
const mockTuiStart = mock<() => void>();
const mockTuiStop = mock<() => void>();
const mockTuiShowQrCode = mock<(url: string) => Promise<void>>();
const mockTuiPrepareQrCode = mock<(url: string) => Promise<void>>();
const mockTuiPauseForInspection = mock<(signal?: AbortSignal) => Promise<void>>();
const mockTuiGetStatusCallbacks = mock<() => Record<string, unknown>>();

// StatusBridge method spies
const mockBridgeGetCallbacks = mock<() => Record<string, unknown>>();
const mockBridgeGetSnapshot = mock<() => Record<string, unknown>>();

// composeStatusCallbacks spy
const mockComposeStatusCallbacks = mock<(callbacks: unknown[]) => unknown>();

// Network spy
const mockGetLocalNetworkIP = mock<() => string | null>();

// existsSync mock for build check tests
const mockExistsSync = mock<(path: string) => boolean>();

// Capture constructor arguments
let capturedTuiOptions: { abort?: () => void } | null = null;
let capturedBridgeBroadcast: ((msg: unknown) => void) | null = null;
let capturedObserverServerOptions: Record<string, unknown> | null = null;

// ─── Mock modules (executes before static imports in Bun) ─────────────────

mock.module('../../src/core/workflow-loader.js', () => ({
  loadWorkflow: () => Promise.resolve({ run: mockWorkflowRun }),
  clearWorkflowCache: () => {},
}));

mock.module('../../src/core/utils.js', () => ({
  validateWorkflowName: () => {},
  composeStatusCallbacks: mockComposeStatusCallbacks,
  isEnoentError: () => false,
  safeErrorMessage: (err: unknown) => String(err),
}));

mock.module('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: () => '',
}));

mock.module('../../src/core/network.js', () => ({
  getLocalNetworkIP: mockGetLocalNetworkIP,
}));

/**
 * Mock console-status so that shouldUseTui always returns true (TUI path).
 * formatTime and createStatusCallbacks are simple stubs — they exist only
 * to satisfy the import, they are not called when useTui is true.
 */
mock.module('../../src/cli/console-status.js', () => ({
  formatTime: () => '[00:00:00]',
  createStatusCallbacks: () => ({}),
  shouldUseTui: () => true,
}));

mock.module('../../src/web/observer-server.js', () => ({
  startObserverServer: mockStartObserverServer,
}));

mock.module('../../src/web/status-bridge.js', () => ({
  StatusBridge: class {
    constructor(broadcast: (msg: unknown) => void, _store: unknown) {
      capturedBridgeBroadcast = broadcast;
    }
    getSnapshot() {
      return mockBridgeGetSnapshot();
    }
    dispose() {}
  },
}));

mock.module('../../src/tui/workflow-tui.js', () => ({
  WorkflowTUI: class {
    constructor(options: { abort?: () => void }) {
      capturedTuiOptions = options;
    }
    start() {
      mockTuiStart();
    }
    stop() {
      mockTuiStop();
    }
    showQrCode(url: string) {
      return mockTuiShowQrCode(url);
    }
    prepareQrCode(url: string) {
      return mockTuiPrepareQrCode(url);
    }
    pauseForInspection(signal?: AbortSignal) {
      return mockTuiPauseForInspection(signal);
    }
    getStatusCallbacks() {
      return mockTuiGetStatusCallbacks();
    }
  },
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────

import { runCommand } from '../../src/cli.ts';

// ─── Restore original modules ────────────────────────────────────────────

afterAll(() => {
  mock.module('../../src/core/workflow-loader.js', () => realWorkflowLoader);
  mock.module('../../src/core/utils.js', () => realUtils);
  mock.module('../../src/core/network.js', () => realNetwork);
  mock.module('../../src/cli/console-status.js', () => realConsoleStatus);
  mock.module('../../src/web/observer-server.js', () => realObserverServer);
  mock.module('../../src/web/status-bridge.js', () => realStatusBridge);
  mock.module('../../src/tui/workflow-tui.js', () => realWorkflowTUI);
  mock.module('node:fs', () => realNodeFs);
});

// ═══════════════════════════════════════════════════════════════════════════
// runCommand — TUI / web / QR / pause integration
// ═══════════════════════════════════════════════════════════════════════════

describe('runCommand — TUI/web/QR/pause integration', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  function makeOptions(overrides: Record<string, unknown> = {}) {
    return {
      command: 'run' as const,
      workflowName: 'test-workflow',
      taskPrompt: 'test task prompt',
      cwd: '/tmp/test-cwd',
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

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    onSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');

    // Reset all mock functions
    mockWorkflowRun.mockReset();
    mockObserverBroadcast.mockReset();
    mockObserverStop.mockReset();
    mockStartObserverServer.mockReset();
    mockTuiStart.mockReset();
    mockTuiStop.mockReset();
    mockTuiShowQrCode.mockReset();
    mockTuiPrepareQrCode.mockReset();
    mockTuiPauseForInspection.mockReset();
    mockTuiGetStatusCallbacks.mockReset();
    mockBridgeGetCallbacks.mockReset();
    mockBridgeGetSnapshot.mockReset();
    mockComposeStatusCallbacks.mockReset();
    mockGetLocalNetworkIP.mockReset();
    mockExistsSync.mockReset();
    capturedTuiOptions = null;
    capturedBridgeBroadcast = null;
    capturedObserverServerOptions = null;

    // Default: getLocalNetworkIP returns a LAN IP
    mockGetLocalNetworkIP.mockReturnValue('192.168.1.42');

    // Default: web/dist exists (no warning expected)
    mockExistsSync.mockReturnValue(true);

    // Default mock behaviors
    mockWorkflowRun.mockResolvedValue(undefined);

    mockStartObserverServer.mockImplementation(async (opts: unknown) => {
      capturedObserverServerOptions = opts as Record<string, unknown>;
      return {
        server: {} as Record<string, unknown>,
        broadcast: mockObserverBroadcast,
        url: 'http://127.0.0.1:3619',
        stop: mockObserverStop,
      };
    });

    mockTuiStart.mockImplementation(() => {});
    mockTuiStop.mockImplementation(() => {});
    mockTuiShowQrCode.mockResolvedValue(undefined);
    mockTuiPrepareQrCode.mockResolvedValue(undefined);
    mockTuiPauseForInspection.mockResolvedValue(undefined);
    mockTuiGetStatusCallbacks.mockReturnValue({ isTuiCallbacks: true });
    mockBridgeGetCallbacks.mockReturnValue({ isBridgeCallbacks: true });
    mockBridgeGetSnapshot.mockReturnValue({
      type: 'snapshot',
      seq: 0,
      state: {
        seq: 0,
        taskPrompt: '',
        currentPhase: '',
        completedPhases: [],
        tasks: {},
        agents: {},
        sidebar: { title: '', indicator: '' },
        status: 'running',
        stats: { totalTokens: 0, agentCount: 0 },
      },
    });
    mockComposeStatusCallbacks.mockImplementation((callbacks: unknown[]) => ({
      composed: true,
      length: callbacks.length,
    }));
  });

  afterEach(() => {
    // Clean up any SIGINT listeners left on the process
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  // ─── Server startup ─────────────────────────────────────────────────────

  describe('observer server startup', () => {
    it('starts the observer server with default auto-detected LAN host', async () => {
      await runCommand(makeOptions());

      expect(mockStartObserverServer).toHaveBeenCalledTimes(1);
      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      expect(opts).not.toBeNull();
      // When no --host given, bind to 0.0.0.0 and pass the LAN IP as displayHost
      expect(opts!.host).toBe('0.0.0.0');
      expect(opts!.port).toBe(3619);
      expect(opts!.displayHost).toBe('192.168.1.42');
    });

    it('uses host and port from options when provided, without displayHost', async () => {
      await runCommand(makeOptions({ host: '127.0.0.1', port: 8080 }));

      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      expect(opts!.host).toBe('127.0.0.1');
      expect(opts!.port).toBe(8080);
      expect(opts!.displayHost).toBeUndefined();
    });

    it('falls back to 127.0.0.1 for display when getLocalNetworkIP returns null', async () => {
      mockGetLocalNetworkIP.mockReturnValue(null);
      await runCommand(makeOptions());

      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      expect(opts!.host).toBe('0.0.0.0');
      expect(opts!.displayHost).toBe('127.0.0.1');
    });

    it('passes onTerminate that aborts the controller', async () => {
      await runCommand(makeOptions());

      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      expect(opts).not.toBeNull();

      const onTerminate = opts!.onTerminate as () => void;
      expect(onTerminate).toBeDefined();

      // The signal passed to workflow.run should be abortable via onTerminate
      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      const signal = runOpts.signal as AbortSignal;
      expect(signal.aborted).toBe(false);

      onTerminate();
      expect(signal.aborted).toBe(true);
    });

    it('passes getSnapshot that delegates to StatusBridge.getSnapshot', async () => {
      await runCommand(makeOptions());

      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      const getSnapshot = opts!.getSnapshot as () => Record<string, unknown>;

      const result = getSnapshot();
      expect(mockBridgeGetSnapshot).toHaveBeenCalled();
      expect(result).toEqual({
        type: 'snapshot',
        seq: 0,
        state: {
          seq: 0,
          taskPrompt: '',
          currentPhase: '',
          completedPhases: [],
          tasks: {},
          agents: {},
          sidebar: { title: '', indicator: '' },
          status: 'running',
          stats: { totalTokens: 0, agentCount: 0 },
        },
      });
    });

    // ─── Build check warning ─────────────────────────────────────────--

    it('warns when web/dist does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await runCommand(makeOptions());

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).toContain('web/dist not found');
      expect(msg).toContain('npm run build');
    });

    it('does not warn when web/dist exists', async () => {
      mockExistsSync.mockReturnValue(true);

      await runCommand(makeOptions());

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ─── TUI lifecycle ─────────────────────────────────────────────────────

  describe('TUI lifecycle', () => {
    it('creates a WorkflowTUI instance with abort callback', async () => {
      await runCommand(makeOptions());

      expect(capturedTuiOptions).not.toBeNull();
      expect(capturedTuiOptions!.abort).toBeDefined();
      expect(typeof capturedTuiOptions!.abort).toBe('function');
    });

    it('starts the TUI', async () => {
      await runCommand(makeOptions());

      expect(mockTuiStart).toHaveBeenCalledTimes(1);
    });

    it('prepares QR code with the server URL before start', async () => {
      await runCommand(makeOptions());

      expect(mockTuiPrepareQrCode).toHaveBeenCalledTimes(1);
      expect(mockTuiPrepareQrCode.mock.calls[0][0]).toBe('http://127.0.0.1:3619');
    });

    it('calls pauseForInspection after workflow.run completes', async () => {
      let runResolved = false;
      mockWorkflowRun.mockImplementation(async () => {
        runResolved = true;
      });

      await runCommand(makeOptions());

      expect(runResolved).toBe(true);
      expect(mockTuiPauseForInspection).toHaveBeenCalledTimes(1);
    });

    it('passes the controller signal to pauseForInspection', async () => {
      await runCommand(makeOptions());

      expect(mockTuiPauseForInspection).toHaveBeenCalledTimes(1);
      const signalArg = mockTuiPauseForInspection.mock.calls[0][0];
      expect(signalArg).toBeDefined();
      expect(signalArg).toBeInstanceOf(AbortSignal);
    });

    it('stops the TUI and observer server after pause resolves', async () => {
      await runCommand(makeOptions());

      expect(mockTuiStop).toHaveBeenCalledTimes(1);
      expect(mockObserverStop).toHaveBeenCalledTimes(1);
    });
  });

  // ─── StatusBridge ──────────────────────────────────────────────────────

  describe('StatusBridge wiring', () => {
    it('creates StatusBridge with a wrapper that delegates to the observer broadcast', async () => {
      await runCommand(makeOptions());

      expect(capturedBridgeBroadcast).not.toBeNull();
      // The captured function is a wrapper that delegates to the real broadcast
      capturedBridgeBroadcast!({ type: 'test' });
      expect(mockObserverBroadcast).toHaveBeenCalledWith({ type: 'test' });
    });

    // getCallbacks no longer exists on StatusBridge (bridge reads from store)

    it('passes storeCallbacks directly as onStatus to workflow.run (no composition)', async () => {
      await runCommand(makeOptions());

      // composeStatusCallbacks should NOT be called in the TUI path
      // (the bridge reads from the store, not from onStatus)
      expect(mockComposeStatusCallbacks).not.toHaveBeenCalled();

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      // onStatus should be the storeCallbacks object (not composed)
      expect(runOpts.onStatus).toBeDefined();
      expect(typeof runOpts.onStatus).toBe('object');
    });
  });

  // ─── workflow.run options ──────────────────────────────────────────────

  describe('workflow.run receives correct options', () => {
    it('passes the task prompt as first argument', async () => {
      await runCommand(makeOptions({ taskPrompt: 'my special task' }));

      expect(mockWorkflowRun.mock.calls[0][0]).toBe('my special task');
    });

    it('sets verbose to false in TUI mode', async () => {
      await runCommand(makeOptions());

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.verbose).toBe(false);
    });

    it('passes the abort signal to workflow.run', async () => {
      await runCommand(makeOptions());

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.signal).toBeDefined();
      expect(runOpts.signal).toBeInstanceOf(AbortSignal);
    });

    it('passes apiKeys when provided', async () => {
      const apiKeys = { anthropic: 'sk-test-key' };
      await runCommand(makeOptions({ apiKeys }));

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.apiKeys).toEqual(apiKeys);
    });

    it('does not pass apiKeys when empty', async () => {
      await runCommand(makeOptions({ apiKeys: {} }));

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.apiKeys).toBeUndefined();
    });

    it('passes maxConcurrentTasks from options', async () => {
      await runCommand(makeOptions({ maxConcurrent: 7 }));

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.maxConcurrentTasks).toBe(7);
    });
  });

  // ─── Error handling ────────────────────────────────────────────────────

  describe('error handling and cleanup', () => {
    it('stops TUI and observer server when workflow.run throws', async () => {
      mockWorkflowRun.mockRejectedValue(new Error('workflow crashed'));

      await expect(runCommand(makeOptions())).rejects.toThrow('workflow crashed');

      expect(mockTuiStop).toHaveBeenCalled();
      expect(mockObserverStop).toHaveBeenCalled();
    });

    it('does not call pauseForInspection when workflow.run throws', async () => {
      mockWorkflowRun.mockRejectedValue(new Error('workflow crashed'));

      await expect(runCommand(makeOptions())).rejects.toThrow('workflow crashed');

      expect(mockTuiPauseForInspection).not.toHaveBeenCalled();
    });

    it('cleans up SIGINT handler in finally block', async () => {
      await runCommand(makeOptions());

      expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });

    it('still cleans up SIGINT handler when workflow.run throws', async () => {
      mockWorkflowRun.mockRejectedValue(new Error('crash'));

      try {
        await runCommand(makeOptions());
      } catch {
        // expected
      }

      expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });
  });
});
