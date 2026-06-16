// ─── T35: CLI reads server token and passes as authToken to EngineClient ──
//
// Before creating the EngineClient in executeViaDaemon, the CLI must read
// the server token via `readServerToken` from auth.ts and pass it as
// `authToken` in EngineClientOptions. The EngineClient then sends
// `{ type: 'auth', token }` on each (re)connect.
//
// These tests mock both `readServerToken` and the `EngineClient` class to
// verify the wiring without touching real WebSockets or daemons.
//
// Currently RED: commands.ts does not call readServerToken and creates
// EngineClient without authToken.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Capture real modules before mocking ─────────────────────────────────────

const realAuth = Object.assign({}, await import('../../packages/engine/src/server/auth.js'));
const realDaemon = Object.assign({}, await import('../../packages/engine/src/server/daemon.js'));

// ─── T35 mocks ──────────────────────────────────────────────────────────────

/** Captured EngineClient constructor options for every instance created. */
const capturedEngineClientOpts: Array<{ url: string; authToken?: string }> = [];

const mockReadServerToken = mock<() => Promise<string | null>>();
const mockStartDaemon = mock<(opts: { port: number; host: string }) => Promise<{ pid: number; port: number }>>();
const mockIsServerAlive = mock<(port: number) => Promise<boolean>>();

// ─── Mock modules (hoisted before imports by Bun test runtime) ───────────────

mock.module('../../packages/engine/src/server/auth.js', () => ({
  ...realAuth,
  readServerToken: mockReadServerToken,
}));

mock.module('../../packages/engine/src/server/daemon.js', () => ({
  ...realDaemon,
  startDaemon: mockStartDaemon,
  isServerAlive: mockIsServerAlive,
}));

/**
 * Mock EngineClient that records constructor options and auto-completes
 * a run when connect() is called. This lets executeViaDaemon run to
 * completion without a real WebSocket.
 */
mock.module('@engin/shared/engine-client', () => ({
  EngineClient: class MockEngineClient {
    constructor(opts: { url: string; authToken?: string }) {
      capturedEngineClientOpts.push(opts);
    }
    connect(callbacks: { onMessage: (msg: any) => void; onConnected?: () => void }) {
      // Simulate connection and run lifecycle after a tick so that
      // executeViaDaemon finishes its synchronous setup first.
      setTimeout(() => {
        callbacks.onConnected?.();
        callbacks.onMessage({ type: 'runs', runs: [] });
        callbacks.onMessage({
          type: 'run_started',
          runId: 't35-test-run',
          summary: {
            runId: 't35-test-run',
            cwd: '/tmp',
            workflowName: 'test',
            taskPrompt: 'test prompt',
            status: 'running',
            startedAt: new Date().toISOString(),
          },
        });
        // Small delay before run_complete so executeViaDaemon processes run_started first.
        setTimeout(() => {
          callbacks.onMessage({ type: 'run_complete', runId: 't35-test-run' });
        }, 10);
      }, 10);
    }
    disconnect() {}
    send() {}
    isConnected() {
      return false;
    }
    subscribe() {}
  },
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import { runCommand } from '../../packages/cli/src/cli/commands.js';

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/server/auth.js', () => realAuth);
  mock.module('../../packages/engine/src/server/daemon.js', () => realDaemon);
});

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('T35: CLI reads server token for EngineClient auth', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let prevExitCode: number | undefined;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    process.exitCode = undefined as unknown as number;
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockReadServerToken.mockReset();
    mockStartDaemon.mockReset();
    mockIsServerAlive.mockReset();
    capturedEngineClientOpts.length = 0;

    // Daemon is "already running" so executeViaDaemon skips startDaemon.
    mockIsServerAlive.mockResolvedValue(true);
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    logSpy.mockRestore();
    stderrSpy.mockRestore();
    // Clean up SIGINT listeners that executeViaDaemon may register.
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as (...args: unknown[]) => void);
  });

  /** Valid options for runCommand (non-TUI mode). */
  function baseRunOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      command: 'run',
      workflowName: 'test',
      taskPrompt: 'do the thing',
      cwd: '/tmp',
      maxConcurrent: 5,
      verbose: true, // disable TUI — shouldUseTui returns false
      worktree: false,
      apiKeys: {},
      warnings: [],
      ...overrides,
    };
  }

  // ── readServerToken is called ───────────────────────────────────────────

  it('calls readServerToken() when executing a run', async () => {
    mockReadServerToken.mockResolvedValue('tok-abc123');

    await runCommand(baseRunOptions() as any);

    expect(mockReadServerToken).toHaveBeenCalledTimes(1);
  });

  it('calls readServerToken() when the token file is absent (returns null)', async () => {
    mockReadServerToken.mockResolvedValue(null);

    await runCommand(baseRunOptions() as any);

    expect(mockReadServerToken).toHaveBeenCalledTimes(1);
  });

  // ── authToken forwarded to EngineClient ─────────────────────────────────

  it('passes the server token as authToken to EngineClient constructor', async () => {
    mockReadServerToken.mockResolvedValue('tok-abc123');

    await runCommand(baseRunOptions() as any);

    // EngineClient must have been constructed at least once.
    expect(capturedEngineClientOpts.length).toBeGreaterThanOrEqual(1);
    // The constructor must receive the token as authToken.
    expect(capturedEngineClientOpts[0]).toEqual(expect.objectContaining({ authToken: 'tok-abc123' }));
  });

  it('omits authToken when readServerToken returns null', async () => {
    mockReadServerToken.mockResolvedValue(null);

    await runCommand(baseRunOptions() as any);

    // readServerToken must still be called (even when it returns null).
    expect(mockReadServerToken).toHaveBeenCalledTimes(1);
    // authToken should be absent (undefined) when no token is stored.
    expect(capturedEngineClientOpts[0].authToken).toBeUndefined();
  });

  it('uses the URL format ws://127.0.0.1:<port>/ws regardless of token', async () => {
    mockReadServerToken.mockResolvedValue('tok-xyz');

    await runCommand(baseRunOptions({ port: 4242 }) as any);

    expect(capturedEngineClientOpts[0].url).toBe('ws://127.0.0.1:4242/ws');
  });

  it('always connects to 127.0.0.1 even when --host is a different address', async () => {
    mockReadServerToken.mockResolvedValue('tok-xyz');

    // --host is used for daemon binding, not the WS client.
    // The WS client always connects to localhost.
    await runCommand(baseRunOptions({ host: '0.0.0.0' }) as any);

    expect(capturedEngineClientOpts[0].url).toBe('ws://127.0.0.1:3619/ws');
  });
});
