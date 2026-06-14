import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realWorkflowLoader = Object.assign({}, await import('../../src/core/workflow-loader.js'));
const realFs = Object.assign({}, await import('node:fs'));
const realUtils = Object.assign({}, await import('../../src/core/utils.js'));
const realNetwork = Object.assign({}, await import('../../src/core/network.js'));
const realConsoleStatus = Object.assign({}, await import('../../src/cli/console-status.js'));
const realConfig = Object.assign({}, await import('../../src/core/config.js'));
const realPostWorktree = Object.assign({}, await import('../../src/cli/post-worktree.js'));
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

// Post-worktree action mock
const mockPromptPostWorktreeAction = mock<(options: Record<string, unknown>) => Promise<void>>();

// Config mock
const mockResolveProfilesDirs = mock<(cwd: string, workflowName?: string) => string[]>();

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
 */
mock.module('../../src/cli/console-status.js', () => ({
  formatTime: () => '[00:00:00]',
  createStatusCallbacks: () => ({}),
  shouldUseTui: () => true,
}));

// Mock node:fs so we can control existsSync for build-check tests.
// Preserve the real readFileSync so state file reading still works.
mock.module('node:fs', () => ({
  ...realFs,
  existsSync: mockExistsSync,
}));

mock.module('../../src/core/network.js', () => ({
  getLocalNetworkIP: mockGetLocalNetworkIP,
}));

mock.module('../../src/core/config.js', () => ({
  ...realConfig,
  resolveProfilesDirs: mockResolveProfilesDirs,
}));

mock.module('../../src/cli/post-worktree.js', () => ({
  promptPostWorktreeAction: mockPromptPostWorktreeAction,
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

import { resumeCommand } from '../../src/cli.ts';

// ─── Restore original modules ────────────────────────────────────────────

afterAll(() => {
  mock.module('../../src/core/workflow-loader.js', () => realWorkflowLoader);
  mock.module('../../src/core/utils.js', () => realUtils);
  mock.module('../../src/core/network.js', () => realNetwork);
  mock.module('../../src/cli/console-status.js', () => realConsoleStatus);
  mock.module('../../src/core/config.js', () => realConfig);
  mock.module('../../src/cli/post-worktree.js', () => realPostWorktree);
  mock.module('../../src/web/observer-server.js', () => realObserverServer);
  mock.module('../../src/web/status-bridge.js', () => realStatusBridge);
  mock.module('../../src/tui/workflow-tui.js', () => realWorkflowTUI);
  mock.module('node:fs', () => realFs);
});

// ═══════════════════════════════════════════════════════════════════════════
// resumeCommand — TUI / web / QR / pause integration
// ═══════════════════════════════════════════════════════════════════════════

describe('resumeCommand — TUI/web/QR/pause integration', () => {
  const { getDir } = useTempDir();

  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  function createPastRunDir(
    tempDir: string,
    dirName: string,
    state: { taskPrompt: string; worktree?: { worktreePath: string; branchName: string; originalCwd: string } },
  ) {
    const runDir = join(tempDir, '.engin', 'work', dirName);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, '.engin-state.json'), JSON.stringify(state));
  }

  function makeResumeOptions(overrides: { cwd: string; sessionName: string; apiKeys?: Record<string, string> }) {
    return {
      command: 'resume' as const,
      sessionName: overrides.sessionName,
      cwd: overrides.cwd,
      maxConcurrent: 3,
      verbose: false,
      worktree: false,
      apiKeys: overrides.apiKeys ?? {},
      warnings: [],
      host: undefined,
      port: undefined,
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
    mockPromptPostWorktreeAction.mockReset();
    mockResolveProfilesDirs.mockReset();
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

    mockPromptPostWorktreeAction.mockResolvedValue(undefined);
    mockResolveProfilesDirs.mockImplementation((_cwd: string, _workflowName?: string) => [
      '/local/profiles',
      '/global/profiles',
    ]);
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

  // ─── Non-worktree resume with TUI ─────────────────────────────────────

  describe('non-worktree resume with TUI', () => {
    it('starts observer server with default auto-detected LAN host', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(mockStartObserverServer).toHaveBeenCalledTimes(1);
      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      expect(opts).not.toBeNull();
      // When no --host given, bind to 0.0.0.0 and pass the LAN IP as displayHost
      expect(opts!.host).toBe('0.0.0.0');
      expect(opts!.port).toBe(3619);
      expect(opts!.displayHost).toBe('192.168.1.42');
    });

    it('uses host and port from options when provided, without displayHost', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      const opts = makeResumeOptions({ cwd: tempDir, sessionName: dirName });
      opts.host = '127.0.0.1';
      opts.port = 8080;
      await resumeCommand(opts);

      const serverOpts = capturedObserverServerOptions as Record<string, unknown> | null;
      expect(serverOpts!.host).toBe('127.0.0.1');
      expect(serverOpts!.port).toBe(8080);
      expect(serverOpts!.displayHost).toBeUndefined();
    });

    it('falls back to 127.0.0.1 for display when getLocalNetworkIP returns null', async () => {
      mockGetLocalNetworkIP.mockReturnValue(null);

      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      expect(opts!.host).toBe('0.0.0.0');
      expect(opts!.displayHost).toBe('127.0.0.1');
    });

    it('creates and starts WorkflowTUI', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(capturedTuiOptions).not.toBeNull();
      expect(capturedTuiOptions!.abort).toBeDefined();
      expect(mockTuiStart).toHaveBeenCalledTimes(1);
    });

    it('prepares QR code with server URL before start', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(mockTuiPrepareQrCode).toHaveBeenCalledTimes(1);
      expect(mockTuiPrepareQrCode.mock.calls[0][0]).toBe('http://127.0.0.1:3619');
    });

    it('creates StatusBridge with a wrapper that delegates to the observer broadcast', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(capturedBridgeBroadcast).not.toBeNull();
      // The captured function is a wrapper that delegates to the real broadcast
      capturedBridgeBroadcast!({ type: 'test' });
      expect(mockObserverBroadcast).toHaveBeenCalledWith({ type: 'test' });
    });

    it('passes storeCallbacks directly as onStatus (no composition in TUI path)', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      // composeStatusCallbacks should NOT be called in the TUI path
      expect(mockComposeStatusCallbacks).not.toHaveBeenCalled();
      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.onStatus).toBeDefined();
      expect(typeof runOpts.onStatus).toBe('object');
    });

    it('calls pauseForInspection after workflow.run completes', async () => {
      let runResolved = false;
      mockWorkflowRun.mockImplementation(async () => {
        runResolved = true;
      });

      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(runResolved).toBe(true);
      expect(mockTuiPauseForInspection).toHaveBeenCalledTimes(1);
    });

    it('passes the abort signal to pauseForInspection', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      const signalArg = mockTuiPauseForInspection.mock.calls[0][0];
      expect(signalArg).toBeDefined();
      expect(signalArg).toBeInstanceOf(AbortSignal);
    });

    it('stops TUI and observer server after pause resolves', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(mockTuiStop).toHaveBeenCalledTimes(1);
      expect(mockObserverStop).toHaveBeenCalledTimes(1);
    });

    it('passes the task prompt from state file to workflow.run', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'original saved prompt' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(mockWorkflowRun.mock.calls[0][0]).toBe('original saved prompt');
    });

    it('sets verbose to false in workflow.run options', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.verbose).toBe(false);
    });

    // ─── Build check warning ─────────────────────────────────────────--

    it('warns when web/dist does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).toContain('web/dist not found');
      expect(msg).toContain('npm run build');
    });

    it('does not warn when web/dist exists', async () => {
      mockExistsSync.mockReturnValue(true);

      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Worktree resume with TUI ─────────────────────────────────────────

  describe('worktree resume with TUI', () => {
    const mockWorktreeInfo = {
      worktreePath: '/tmp/resume-worktree-path',
      branchName: 'engin/test-resume-abc123',
      originalCwd: '/tmp/original-cwd',
    };

    it('starts observer server and TUI even with worktree info', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, {
        taskPrompt: 'resumed worktree task',
        worktree: mockWorktreeInfo,
      });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(mockStartObserverServer).toHaveBeenCalledTimes(1);
      expect(mockTuiStart).toHaveBeenCalledTimes(1);
      expect(mockTuiPrepareQrCode).toHaveBeenCalledTimes(1);
    });

    it('passes storeCallbacks directly as onStatus for worktree resume', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, {
        taskPrompt: 'resumed worktree task',
        worktree: mockWorktreeInfo,
      });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      // composeStatusCallbacks should NOT be called in the TUI path
      expect(mockComposeStatusCallbacks).not.toHaveBeenCalled();
      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.onStatus).toBeDefined();
      expect(typeof runOpts.onStatus).toBe('object');
    });

    it('calls pauseForInspection after workflow.run completes', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, {
        taskPrompt: 'resumed worktree task',
        worktree: mockWorktreeInfo,
      });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(mockTuiPauseForInspection).toHaveBeenCalledTimes(1);
    });

    it('stops TUI and observer server after completion', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, {
        taskPrompt: 'resumed worktree task',
        worktree: mockWorktreeInfo,
      });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(mockTuiStop).toHaveBeenCalledTimes(1);
      expect(mockObserverStop).toHaveBeenCalledTimes(1);
    });

    it('calls promptPostWorktreeAction after TUI pause resolves', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, {
        taskPrompt: 'resumed worktree task',
        worktree: mockWorktreeInfo,
      });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(mockPromptPostWorktreeAction).toHaveBeenCalledTimes(1);
    });

    it('throws descriptive error when state file has no taskPrompt', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: '' });

      const options = makeResumeOptions({ cwd: tempDir, sessionName: dirName });
      await expect(resumeCommand(options)).rejects.toThrow('no task prompt');
    });
  });

  // ─── Error handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    it('stops TUI and observer server when workflow.run throws', async () => {
      mockWorkflowRun.mockRejectedValue(new Error('resume crashed'));

      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await expect(resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }))).rejects.toThrow(
        'resume crashed',
      );

      expect(mockTuiStop).toHaveBeenCalled();
      expect(mockObserverStop).toHaveBeenCalled();
    });

    it('does not call pauseForInspection when workflow.run throws', async () => {
      mockWorkflowRun.mockRejectedValue(new Error('resume crashed'));

      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await expect(resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }))).rejects.toThrow(
        'resume crashed',
      );

      expect(mockTuiPauseForInspection).not.toHaveBeenCalled();
    });

    it('cleans up SIGINT handler in finally block', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });
  });

  // ─── Abort signal wiring ──────────────────────────────────────────────

  describe('abort signal wiring', () => {
    it('onTerminate aborts the controller signal passed to workflow.run', async () => {
      const ts = Date.now();
      const dirName = `${ts}-my-workflow`;
      const tempDir = getDir();
      createPastRunDir(tempDir, dirName, { taskPrompt: 'resumed task' });

      await resumeCommand(makeResumeOptions({ cwd: tempDir, sessionName: dirName }));

      const opts = capturedObserverServerOptions as Record<string, unknown> | null;
      const onTerminate = opts!.onTerminate as () => void;

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      const signal = runOpts.signal as AbortSignal;
      expect(signal.aborted).toBe(false);

      onTerminate();
      expect(signal.aborted).toBe(true);
    });
  });
});
