import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Capture real modules before mocking ──────────────────────────────────

const realWorkflowLoader = Object.assign({}, await import('../../src/core/workflow-loader.js'));
const realUtils = Object.assign({}, await import('../../src/core/utils.js'));
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
const mockTuiPauseForInspection = mock<(signal?: AbortSignal) => Promise<void>>();
const mockTuiGetStatusCallbacks = mock<() => Record<string, unknown>>();

// StatusBridge method spies
const mockBridgeGetCallbacks = mock<() => Record<string, unknown>>();
const mockBridgeGetSnapshot = mock<() => Record<string, unknown>>();

// composeStatusCallbacks spy
const mockComposeStatusCallbacks = mock<(callbacks: unknown[]) => unknown>();

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
    constructor(broadcast: (msg: unknown) => void) {
      capturedBridgeBroadcast = broadcast;
    }
    getCallbacks() {
      return mockBridgeGetCallbacks();
    }
    getSnapshot() {
      return mockBridgeGetSnapshot();
    }
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
  mock.module('../../src/cli/console-status.js', () => ({}) as never);
  mock.module('../../src/web/observer-server.js', () => realObserverServer);
  mock.module('../../src/web/status-bridge.js', () => realStatusBridge);
  mock.module('../../src/tui/workflow-tui.js', () => realWorkflowTUI);
});

// ═══════════════════════════════════════════════════════════════════════════
// runCommand — TUI / web / QR / pause integration
// ═══════════════════════════════════════════════════════════════════════════

describe('runCommand — TUI/web/QR/pause integration', () => {
  let logSpy: ReturnType<typeof spyOn>;
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
    mockTuiPauseForInspection.mockReset();
    mockTuiGetStatusCallbacks.mockReset();
    mockBridgeGetCallbacks.mockReset();
    mockBridgeGetSnapshot.mockReset();
    mockComposeStatusCallbacks.mockReset();
    capturedTuiOptions = null;
    capturedBridgeBroadcast = null;
    capturedObserverServerOptions = null;

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
    mockTuiPauseForInspection.mockResolvedValue(undefined);
    mockTuiGetStatusCallbacks.mockReturnValue({ isTuiCallbacks: true });
    mockBridgeGetCallbacks.mockReturnValue({ isBridgeCallbacks: true });
    mockBridgeGetSnapshot.mockReturnValue({
      type: 'init',
      currentPhase: '',
      completedPhases: [],
      tasks: [],
      agents: [],
      sidebar: { title: '', indicator: '' },
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
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  // ─── Server startup ─────────────────────────────────────────────────────

  describe('observer server startup', () => {
    it('starts the observer server with default host and port', async () => {
      await runCommand(makeOptions());

      expect(mockStartObserverServer).toHaveBeenCalledTimes(1);
      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      expect(opts).not.toBeNull();
      expect(opts!.host).toBe('127.0.0.1');
      expect(opts!.port).toBe(3619);
    });

    it('uses host and port from options when provided', async () => {
      await runCommand(makeOptions({ host: '0.0.0.0', port: 8080 }));

      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      expect(opts!.host).toBe('0.0.0.0');
      expect(opts!.port).toBe(8080);
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
        type: 'init',
        currentPhase: '',
        completedPhases: [],
        tasks: [],
        agents: [],
        sidebar: { title: '', indicator: '' },
      });
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

    it('shows QR code with the server URL', async () => {
      await runCommand(makeOptions());

      expect(mockTuiShowQrCode).toHaveBeenCalledTimes(1);
      expect(mockTuiShowQrCode.mock.calls[0][0]).toBe('http://127.0.0.1:3619');
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
    it('creates StatusBridge with the observer broadcast function', async () => {
      await runCommand(makeOptions());

      expect(capturedBridgeBroadcast).not.toBeNull();
      expect(capturedBridgeBroadcast).toBe(mockObserverBroadcast);
    });

    it('gets callbacks from both TUI and StatusBridge', async () => {
      await runCommand(makeOptions());

      expect(mockTuiGetStatusCallbacks).toHaveBeenCalledTimes(1);
      expect(mockBridgeGetCallbacks).toHaveBeenCalledTimes(1);
    });

    it('composes callbacks from TUI and StatusBridge', async () => {
      await runCommand(makeOptions());

      expect(mockComposeStatusCallbacks).toHaveBeenCalledTimes(1);
      const composeArgs = mockComposeStatusCallbacks.mock.calls[0][0] as unknown[];
      expect(composeArgs).toHaveLength(2);
    });

    it('passes composed callbacks as onStatus to workflow.run', async () => {
      const composedResult = { composed: true, custom: 'test' };
      mockComposeStatusCallbacks.mockReturnValue(composedResult);

      await runCommand(makeOptions());

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.onStatus).toBe(composedResult);
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
