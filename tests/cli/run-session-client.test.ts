// ─── Tests for RunSessionClient → StdoutRenderer wiring ─────────────────────
//
// Verifies that the CLI's non-TUI path wires the (previously unused)
// `createStdoutRenderer` into `RunSessionClient.run()`:
//
//   - When `useTui` is false, the renderer is created with
//     `{ clientStore, verbose, formatTime }` (the real ClientStore + the
//     verbose flag + the shared formatTime), so verbose agent-log/token/runLog
//     output is actually produced.
//   - The `verbose` flag flows through (true → verbose output enabled).
//   - When `useTui` is true, the renderer is NOT created (the TUI owns output).
//   - The renderer's `dispose()` is invoked from the `finally` cleanup block —
//     on normal completion, on early exit (setup returns null), and on a
//     failed run.
//
// These tests are currently RED until the inline console.log block in
// `run-session-client.ts` is replaced with `createStdoutRenderer(...)` and its
// `dispose()` is wired into the finally block (and `verbose` is added to
// DaemonClientOptions).
//
// Mocking strategy (mirrors tests/cli/t33-worktree-lifecycle.test.ts):
//   - Mock SPECIFIC source files (not package barrels) so the mocks are scoped.
//   - Capture the real modules first, then RESTORE every mock in afterAll so
//     the mocks never leak into other test files (e.g. tests/shared/engine-
//     client.test.ts, tests/server/auth.test.ts, tests/cli/stdout-renderer).

import { ClientStore } from '@engin/shared/client-store';
import type { ClientMessage, RunSummary, ServerMessage } from '@engin/shared/protocol-types';
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { formatTime } from '../../packages/cli/src/cli/console-status.js';

// ─── Captured mock state ────────────────────────────────────────────────────

let createdClients: MockEngineClient[];
let createdTuis: MockWorkflowTUI[];
let rendererDisposedCount: number;
let lastRendererDeps: RendererDeps | null;
let sigintDisposedCount: number;

interface RendererDeps {
  clientStore: unknown;
  verbose: boolean;
  formatTime: unknown;
}

// ─── Mock implementations ───────────────────────────────────────────────────

const createRendererMock = mock((deps: RendererDeps): { dispose: () => void } => {
  lastRendererDeps = deps;
  return {
    dispose: () => {
      rendererDisposedCount++;
    },
  };
});

const setupNonTtyMock = mock((_runId: string, _client: unknown): { dispose: () => void } => ({
  dispose: () => {
    sigintDisposedCount++;
  },
}));

const readServerTokenMock = mock(async (): Promise<string | null> => null);
const isServerAliveMock = mock(async (): Promise<boolean> => true);
const startDaemonMock = mock(async (): Promise<{ pid: number }> => ({ pid: 0 }));

/** Controllable EngineClient: captures callbacks, records sends, can deliver
 *  server messages into the captured onMessage handler. */
class MockEngineClient {
  url: string;
  authToken?: string;
  callbacks: {
    onMessage: (msg: ServerMessage) => void;
    onConnected?: () => void;
    onDisconnected?: () => void;
  } | null = null;
  sent: ClientMessage[] = [];
  connected = false;

  constructor(opts: { url: string; authToken?: string }) {
    this.url = opts.url;
    this.authToken = opts.authToken;
    createdClients.push(this);
  }

  connect(cb: {
    onMessage: (msg: ServerMessage) => void;
    onConnected?: () => void;
    onDisconnected?: () => void;
  }): void {
    this.callbacks = cb;
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.callbacks?.onDisconnected?.();
  }

  isConnected(): boolean {
    return this.connected;
  }

  send(msg: ClientMessage): void {
    this.sent.push(msg);
  }

  subscribe(runId: string): void {
    this.sent.push({ type: 'subscribe', runId });
  }

  resync(runId: string, lastSeq?: number): void {
    const msg: ClientMessage = lastSeq !== undefined ? { type: 'resync', runId, lastSeq } : { type: 'resync', runId };
    this.sent.push(msg);
  }

  unsubscribe(runId: string): void {
    this.sent.push({ type: 'unsubscribe', runId });
  }

  /** Test helper: deliver a server message to the captured onMessage handler. */
  deliver(msg: ServerMessage): void {
    this.callbacks?.onMessage(msg);
  }
}

/** Minimal WorkflowTUI stub exposing every method RunSessionClient calls. */
class MockWorkflowTUI {
  clientStore: unknown;
  setRunIdCalls: string[] = [];
  prepareCalls: string[] = [];
  started = false;
  stopped = 0;

  constructor(opts: { clientStore: unknown; onDetach: () => void; onKill: () => void }) {
    this.clientStore = opts.clientStore;
    createdTuis.push(this);
  }

  setRunId(id: string): void {
    this.setRunIdCalls.push(id);
  }

  async prepareQrCode(url: string): Promise<void> {
    this.prepareCalls.push(url);
  }

  start(): void {
    this.started = true;
  }

  async pauseForInspection(_?: unknown): Promise<void> {}

  stop(): void {
    this.stopped++;
  }
}

// ─── Capture real modules before mocking (for afterAll restore) ─────────────

// Note: capture imports use the `.js` extension (resolved to `.ts` by bun /
// moduleResolution:bundler) because TS5097 forbids `.ts` in import paths.
const realEngineClient = Object.assign({}, await import('../../packages/shared/src/engine-client.js'));
const realAuth = Object.assign({}, await import('../../packages/engine/src/server/auth.js'));
const realDaemon = Object.assign({}, await import('../../packages/engine/src/server/daemon.js'));
const realTui = Object.assign({}, await import('../../packages/tui/src/workflow-tui.js'));
const realSigint = Object.assign({}, await import('../../packages/cli/src/cli/sigint.js'));
const realStdoutRenderer = Object.assign({}, await import('../../packages/cli/src/cli/stdout-renderer.js'));

// ─── Register scoped source-file mocks BEFORE importing the SUT ─────────────

mock.module('../../packages/shared/src/engine-client.ts', () => ({
  ...realEngineClient,
  EngineClient: MockEngineClient,
}));

mock.module('../../packages/engine/src/server/auth.ts', () => ({
  ...realAuth,
  readServerToken: readServerTokenMock,
}));

mock.module('../../packages/engine/src/server/daemon.ts', () => ({
  ...realDaemon,
  isServerAlive: isServerAliveMock,
  startDaemon: startDaemonMock,
}));

mock.module('../../packages/tui/src/workflow-tui.ts', () => ({
  ...realTui,
  WorkflowTUI: MockWorkflowTUI,
}));

mock.module('../../packages/cli/src/cli/sigint.ts', () => ({
  ...realSigint,
  setupNonTtySigintHandler: setupNonTtyMock,
}));

mock.module('../../packages/cli/src/cli/stdout-renderer.ts', () => ({
  ...realStdoutRenderer,
  createStdoutRenderer: createRendererMock,
}));

// Restore every mock after this file's tests so they never leak into other
// test files (this is the same afterAll-restore pattern used by
// tests/cli/t33-worktree-lifecycle.test.ts).
afterAll(() => {
  mock.module('../../packages/shared/src/engine-client.ts', () => realEngineClient);
  mock.module('../../packages/engine/src/server/auth.ts', () => realAuth);
  mock.module('../../packages/engine/src/server/daemon.ts', () => realDaemon);
  mock.module('../../packages/tui/src/workflow-tui.ts', () => realTui);
  mock.module('../../packages/cli/src/cli/sigint.ts', () => realSigint);
  mock.module('../../packages/cli/src/cli/stdout-renderer.ts', () => realStdoutRenderer);
});

// Import the SUT AFTER the mocks are registered.
const { RunSessionClient } = await import('../../packages/cli/src/cli/run-session-client.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSummary(): RunSummary {
  return {
    runId: 'run-1',
    cwd: '/tmp/proj',
    workflowName: 'wf',
    taskPrompt: 'do thing',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeStartRun(): ClientMessage {
  return { type: 'start_run', workflowName: 'wf', taskPrompt: 'do thing', cwd: '/tmp/proj' };
}

interface RunOpts {
  useTui: boolean;
  verbose: boolean;
  setup?: (ec: MockEngineClient) => Promise<unknown>;
}

/** Drive a RunSessionClient to completion and return the created mock client. */
async function runSession(opts: RunOpts): Promise<MockEngineClient> {
  const defaultSetup = (ec: MockEngineClient): Promise<unknown> => {
    // Deliver run_started then run_complete on the next macrotask — by then
    // run() has parked on `await terminalPromise`, so the onMessage handler
    // is installed and runId bookkeeping works.
    setTimeout(() => {
      ec.deliver({ type: 'run_started', runId: 'run-1', summary: makeSummary() });
      ec.deliver({ type: 'run_complete', runId: 'run-1' });
    }, 0);
    return Promise.resolve({ mode: 'start' as const, startRunMessage: makeStartRun() });
  };

  // After wiring, `DaemonClientOptions` carries a `verbose` field (forwarded to
  // createStdoutRenderer) and `setup` is typed against the real EngineClient.
  // Until that change lands we cast the options object so the test still
  // typechecks while exercising the target shape.

  const client = new RunSessionClient({
    port: 3619,
    host: '127.0.0.1',
    useTui: opts.useTui,
    verbose: opts.verbose,
    setup: opts.setup ?? defaultSetup,
  } as any);
  await client.run();
  return createdClients[0];
}

// ─── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  createdClients = [];
  createdTuis = [];
  rendererDisposedCount = 0;
  lastRendererDeps = null;
  sigintDisposedCount = 0;
  createRendererMock.mockClear();
  setupNonTtyMock.mockClear();
  readServerTokenMock.mockClear();
  isServerAliveMock.mockClear();
  startDaemonMock.mockClear();
  process.exitCode = undefined;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RunSessionClient — StdoutRenderer wiring', () => {
  it('creates the StdoutRenderer in non-TUI mode with clientStore, verbose, and formatTime', async () => {
    await runSession({ useTui: false, verbose: true });

    expect(createRendererMock).toHaveBeenCalledTimes(1);
    expect(lastRendererDeps).not.toBeNull();
    expect(lastRendererDeps!.verbose).toBe(true);
    expect(lastRendererDeps!.clientStore).toBeInstanceOf(ClientStore);
    expect(lastRendererDeps!.formatTime).toBe(formatTime);
  });

  it('disposes the renderer in the finally block after a completed run', async () => {
    await runSession({ useTui: false, verbose: true });

    expect(rendererDisposedCount).toBe(1);
  });

  it('passes verbose=false to the renderer when verbose is disabled', async () => {
    await runSession({ useTui: false, verbose: false });

    expect(createRendererMock).toHaveBeenCalledTimes(1);
    expect(lastRendererDeps!.verbose).toBe(false);
  });

  it('does not create the StdoutRenderer in TUI mode', async () => {
    await runSession({ useTui: true, verbose: false });

    expect(createRendererMock).not.toHaveBeenCalled();
    expect(createdTuis).toHaveLength(1);
  });

  it('creates and disposes the renderer even when setup returns null (early exit)', async () => {
    await runSession({ useTui: false, verbose: true, setup: async () => null });

    expect(createRendererMock).toHaveBeenCalledTimes(1);
    expect(rendererDisposedCount).toBe(1);
  });

  it('disposes the renderer after a failed run', async () => {
    const savedExitCode = process.exitCode;
    await runSession({
      useTui: false,
      verbose: false,
      setup: (ec) => {
        setTimeout(() => {
          ec.deliver({ type: 'run_started', runId: 'run-1', summary: makeSummary() });
          ec.deliver({ type: 'run_failed', runId: 'run-1', error: 'boom', phase: 'p1' });
        }, 0);
        return Promise.resolve({ mode: 'start' as const, startRunMessage: makeStartRun() });
      },
    });

    expect(rendererDisposedCount).toBe(1);
    process.exitCode = savedExitCode;
  });
});

// ─── Worktree identity captured from the TERMINAL broadcast ────────────────
//
// Reproduces the regression where the post-run final-merge prompt was never
// shown: the main worktree is set up ASYNCHRONOUSLY by RunExecutor.execute()
// AFTER RunManager.startRun() returned, so the `run_started` summary it sent
// carried NO worktree. The client must therefore read the worktree identity
// from the terminal run_complete/run_failed broadcast (the race-free source)
// and forward it to postTerminalAction so the merge prompt fires.

describe('RunSessionClient — worktree captured from terminal broadcast', () => {
  it('forwards the worktree to postTerminalAction even when run_started carried none', async () => {
    let capturedWorktree: unknown = 'SENTINEL_UNSET';

    await runSession({
      useTui: false,
      verbose: false,
      setup: (ec) => {
        setTimeout(() => {
          // run_started carries NO worktree (async setup hasn't completed).
          ec.deliver({ type: 'run_started', runId: 'run-1', summary: makeSummary() });
          // run_complete carries it — the authoritative, race-free source.
          ec.deliver({
            type: 'run_complete',
            runId: 'run-1',
            worktree: {
              worktreePath: '/proj/.engin/work/run-1/worktree',
              branchName: 'engin/run-1',
              originalCwd: '/proj',
            },
          });
        }, 0);
        return Promise.resolve({
          mode: 'start' as const,
          startRunMessage: makeStartRun(),
          postTerminalAction: async (ctx: { capturedWorktree?: unknown }) => {
            capturedWorktree = ctx.capturedWorktree;
          },
        });
      },
    });

    expect(capturedWorktree).toEqual({
      worktreePath: '/proj/.engin/work/run-1/worktree',
      branchName: 'engin/run-1',
      originalCwd: '/proj',
    });
  });

  it('also captures the worktree from a run_failed terminal broadcast', async () => {
    let capturedWorktree: unknown = 'SENTINEL_UNSET';
    const savedExitCode = process.exitCode;

    await runSession({
      useTui: false,
      verbose: false,
      setup: (ec) => {
        setTimeout(() => {
          ec.deliver({ type: 'run_started', runId: 'run-1', summary: makeSummary() });
          ec.deliver({
            type: 'run_failed',
            runId: 'run-1',
            error: 'boom',
            phase: 'p1',
            worktree: {
              worktreePath: '/proj/.engin/work/run-1/worktree',
              branchName: 'engin/run-1',
              originalCwd: '/proj',
            },
          });
        }, 0);
        return Promise.resolve({
          mode: 'start' as const,
          startRunMessage: makeStartRun(),
          postTerminalAction: async (ctx: { capturedWorktree?: unknown }) => {
            capturedWorktree = ctx.capturedWorktree;
          },
        });
      },
    });

    expect(capturedWorktree).toEqual({
      worktreePath: '/proj/.engin/work/run-1/worktree',
      branchName: 'engin/run-1',
      originalCwd: '/proj',
    });
    process.exitCode = savedExitCode;
  });

  it('leaves capturedWorktree undefined (no merge prompt) on a non-git run with no worktree', async () => {
    let capturedWorktree: unknown = 'SENTINEL_SET';

    await runSession({
      useTui: false,
      verbose: false,
      setup: (ec) => {
        setTimeout(() => {
          ec.deliver({ type: 'run_started', runId: 'run-1', summary: makeSummary() });
          // No worktree field — non-git run.
          ec.deliver({ type: 'run_complete', runId: 'run-1' });
        }, 0);
        return Promise.resolve({
          mode: 'start' as const,
          startRunMessage: makeStartRun(),
          postTerminalAction: async (ctx: { capturedWorktree?: unknown }) => {
            capturedWorktree = ctx.capturedWorktree;
          },
        });
      },
    });

    expect(capturedWorktree).toBeUndefined();
  });
});
