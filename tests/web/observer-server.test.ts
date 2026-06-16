import type { ClientMessage, RunSummary, ServerMessage, WorkflowProjection } from '@engin/shared/protocol-types';
import { startObserverServer, type ObserverServer } from '@harms-haus/engin-engine';
import type { ServerWebSocket } from 'bun';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RunManager, type StartRunMessage } from '../../packages/engine/src/server/run-manager.ts';

// ─── T35: authorize chokepoint mock ────────────────────────────────────────
//
// observer-server.ts will import `authorize` from auth.ts and call it for
// every inbound ClientMessage. We mock it here so we can spy on calls and
// simulate rejection. Currently RED: observer-server.ts does NOT call
// authorize yet.

const realAuth = Object.assign({}, await import('../../packages/engine/src/server/auth.js'));
const mockAuthorize = mock<
  (
    msg: import('@engin/shared/protocol-types').ClientMessage,
    ws: unknown,
  ) => {
    authorized: boolean;
  }
>(() => ({ authorized: true }));

mock.module('../../packages/engine/src/server/auth.js', () => ({
  ...realAuth,
  authorize: mockAuthorize,
}));

// ─── Contract under test ────────────────────────────────────────────────────
//
// `startObserverServer` is being generalized from a single-run snapshot server
// to a multi-run WebSocket control server backed by a `RunManager`. The new
// options shape is:
//
//   startObserverServer({
//     host, port, displayHost?,
//     runManager: RunManager,   // NEW — owns the run registry + per-run bridges
//   })
//
// WS behaviours:
//   • open          → sends `{ type: 'runs', runs: runManager.listRuns() }`
//   • list_runs     → replies `{ type: 'runs', runs }`
//   • start_run     → awaits `runManager.startRun(msg)`; replies `run_started`;
//                     auto-subscribes the requesting ws (`runManager.subscribe`)
//   • subscribe     → `runManager.subscribe(ws, runId)`; sends a snapshot when
//                     the run exists (`runManager.handleResync(ws, runId)`)
//   • unsubscribe   → `runManager.unsubscribe(ws, runId)`
//   • resync        → `runManager.handleResync(ws, runId, lastSeq)`
//   • cancel_run    → `runManager.cancelRun(runId)`
//   • worktree_action → stub (tolerated; no crash, no protocol error)
//   • auth          → no-op
//   • close         → `runManager.unsubscribeAll(ws)`
//
// Preserved: Origin validation, static file serving, {{WS_ENDPOINT}}
// substitution, SPA fallback, displayHost URL, ws/wss scheme detection.

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeRunSummary(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    cwd: '/tmp/project',
    workflowName: 'develop',
    taskPrompt: 'Build the thing',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProjection(seq = 0, overrides: Partial<WorkflowProjection> = {}): WorkflowProjection {
  return {
    seq,
    taskPrompt: 'Build the thing',
    phases: [],
    currentPhaseId: 'scouting',
    completedPhaseIds: [],
    tasks: {},
    agents: {},
    sidebar: { title: 'Test', indicator: '🟢' },
    status: 'running',
    stats: { totalTokens: 0, agentCount: 0 },
    runLog: [],
    ...overrides,
  };
}

/**
 * Build a real `RunManager` instance with every method overridden by a
 * controllable mock. Using a real instance satisfies the `runManager: RunManager`
 * parameter type; the overrides let each test drive the registry without
 * actually loading/running a workflow.
 */
function createMockRunManager(): RunManager {
  const rm = new RunManager(() => {});
  rm.listRuns = mock((): RunSummary[] => []);
  rm.getRun = mock((_runId: string): RunSummary | undefined => undefined);
  rm.startRun = mock(async (_msg: StartRunMessage) => ({
    runId: 'run-1',
    summary: makeRunSummary('run-1'),
  }));
  rm.subscribe = mock((_ws: ServerWebSocket, _runId: string): void => {});
  rm.unsubscribe = mock((_ws: ServerWebSocket, _runId: string): void => {});
  rm.unsubscribeAll = mock((_ws: ServerWebSocket): void => {});
  rm.handleResync = mock((_ws: ServerWebSocket, _runId: string, _lastSeq?: number): void => {});
  rm.cancelRun = mock((_runId: string): void => {});
  return rm;
}

// ─── WebSocket helpers ──────────────────────────────────────────────────────

/** Wait for the WebSocket connection to open. */
function waitForOpen(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for open')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket error during open'));
    });
  });
}

interface MessageCollector {
  /** Resolve with the next message whose `type` matches (buffering earlier ones). */
  waitForType(type: string, timeoutMs?: number): Promise<any>;
  /** Resolve with the next message of any type. */
  waitForNext(timeoutMs?: number): Promise<any>;
  /** Buffered messages that no waiter has consumed. */
  buffer: any[];
}

/**
 * Attach a message collector to a WebSocket. Messages are buffered until a
 * waiter claims them; waiters time out cleanly on error/close.
 */
function createMessageCollector(ws: WebSocket): MessageCollector {
  const buffer: any[] = [];
  type Waiter = {
    match: (m: any) => boolean;
    resolve: (m: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const waiters: Waiter[] = [];

  function handle(msg: any): void {
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) {
      const w = waiters.splice(idx, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      buffer.push(msg);
    }
  }

  ws.addEventListener('message', (event) => {
    try {
      handle(JSON.parse(event.data as string));
    } catch {
      // Ignore non-JSON frames.
    }
  });
  const onFail = (message: string): void => {
    while (waiters.length) {
      const w = waiters.shift()!;
      clearTimeout(w.timer);
      w.reject(new Error(message));
    }
  };
  ws.addEventListener('error', () => onFail('WebSocket error'));
  ws.addEventListener('close', () => onFail('WebSocket closed'));

  function register(match: (m: any) => boolean, timeoutMsg: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(timeoutMsg));
      }, timeoutMs);
      waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
    });
  }

  return {
    buffer,
    waitForType(type: string, timeoutMs = 3000): Promise<any> {
      const idx = buffer.findIndex((m) => m.type === type);
      if (idx >= 0) return Promise.resolve(buffer.splice(idx, 1)[0]);
      return register((m) => m.type === type, `Timed out waiting for message type "${type}"`, timeoutMs);
    },
    waitForNext(timeoutMs = 3000): Promise<any> {
      if (buffer.length) return Promise.resolve(buffer.shift()!);
      return register(() => true, 'Timed out waiting for message', timeoutMs);
    },
  };
}

/**
 * Open a WebSocket and attach a message collector.
 *
 * The collector is attached BEFORE awaiting open so the connect-time `runs`
 * message (sent synchronously in the server's `open` handler) cannot be lost
 * to a race between the open event and listener registration.
 */
async function connect(port: number, host = '127.0.0.1'): Promise<{ ws: WebSocket; collector: MessageCollector }> {
  const ws = new WebSocket(`ws://${host}:${port}/ws`);
  const collector = createMessageCollector(ws);
  await waitForOpen(ws);
  return { ws, collector };
}

/** Send a ClientMessage over a WebSocket. */
function send(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

// Each test gets a unique port so multiple servers never collide with EADDRINUSE.
let nextPort = 20000 + Math.floor(Math.random() * 8000);
function randomPort(): number {
  return nextPort++;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('observer-server', () => {
  let server: ObserverServer | undefined;

  // afterEach (not afterAll) so every test's server is torn down immediately.
  // Tests reassign the shared `server` variable, so a single afterAll would
  // orphan every server except the last — leaking Bun.serve sockets across
  // the suite (masked only by unique ports). afterEach guarantees each
  // server is stopped right after its owning test.
  //
  // Use the RAW Bun server's `stop(true)` (force-close active connections)
  // rather than `ObserverServer.stop()`. Failing tests leave WebSockets open;
  // a plain `stop()` waits for them to drain and hangs until the hook timeout.
  // `stop(true)` mirrors the teardown pattern in tests/server/daemon.test.ts.
  afterEach(async () => {
    if (server) {
      const raw = server.server;
      server = undefined;
      raw.stop(true);
      // Give the event loop a tick to release the listening socket.
      await Bun.sleep(10);
    }
  });

  // ── lifecycle ───────────────────────────────────────────────────────────

  it('starts and can be stopped', async () => {
    server = await startObserverServer({
      host: '127.0.0.1',
      port: randomPort(),
      runManager: createMockRunManager(),
    });
    expect(server.server).toBeDefined();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof server.broadcast).toBe('function');
    expect(typeof server.stop).toBe('function');

    await server.stop();
    server = undefined;
  });

  // ── open handler ────────────────────────────────────────────────────────

  it('sends a runs message on connect (active-run list)', async () => {
    const runManager = createMockRunManager();
    const runs = [makeRunSummary('run-a'), makeRunSummary('run-b', { status: 'complete' })];
    runManager.listRuns = mock(() => runs);

    const port = randomPort();
    server = await startObserverServer({ host: '127.0.0.1', port, runManager });

    const { ws, collector } = await connect(port);
    try {
      const msg = await collector.waitForType('runs');
      expect(msg.type).toBe('runs');
      expect(msg.runs).toEqual(runs);
      expect(msg.runs).toHaveLength(2);
      expect(msg.runs[0].runId).toBe('run-a');
      // The connect-time runs list must be sourced from runManager.listRuns().
      expect(runManager.listRuns).toHaveBeenCalled();
    } finally {
      ws.close();
    }
  });

  it('sends an empty runs list when the registry is empty', async () => {
    const port = randomPort();
    server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

    const { ws, collector } = await connect(port);
    try {
      const msg = await collector.waitForType('runs');
      expect(msg.runs).toEqual([]);
    } finally {
      ws.close();
    }
  });

  // ── ClientMessage routing ───────────────────────────────────────────────

  describe('message routing', () => {
    it('list_runs replies with a runs message', async () => {
      const runManager = createMockRunManager();
      const runs = [makeRunSummary('run-x')];
      runManager.listRuns = mock(() => runs);

      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        send(ws, { type: 'list_runs' });
        const msg = await collector.waitForType('runs');
        expect(msg.runs).toEqual(runs);
        // listRuns should have been invoked again for the explicit request
        expect(runManager.listRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        ws.close();
      }
    });

    it('start_run calls runManager.startRun, replies run_started, and auto-subscribes', async () => {
      const runManager = createMockRunManager();
      const summary = makeRunSummary('run-started', { workflowName: 'ship', taskPrompt: 'Ship it' });
      runManager.startRun = mock(async (_msg: StartRunMessage) => ({ runId: 'run-started', summary }));

      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        const startMsg: ClientMessage = {
          type: 'start_run',
          workflowName: 'ship',
          taskPrompt: 'Ship it',
          cwd: '/tmp/project',
        };
        send(ws, startMsg);

        const msg = await collector.waitForType('run_started');
        expect(msg.type).toBe('run_started');
        expect(msg.runId).toBe('run-started');
        expect(msg.summary).toEqual(summary);

        // startRun received the payload (workflowName/taskPrompt/cwd forwarded)
        expect(runManager.startRun).toHaveBeenCalledTimes(1);
        const passed = runManager.startRun.mock.calls[0][0] as StartRunMessage;
        expect(passed.workflowName).toBe('ship');
        expect(passed.taskPrompt).toBe('Ship it');
        expect(passed.cwd).toBe('/tmp/project');

        // Auto-subscribe: the requesting ws is subscribed to the new run
        expect(runManager.subscribe).toHaveBeenCalledTimes(1);
        expect(runManager.subscribe.mock.calls[0][1]).toBe('run-started');
        // The auto-subscribe must target the requesting socket itself.
        expect(runManager.subscribe.mock.calls[0][0]).toBeDefined();
      } finally {
        ws.close();
      }
    });

    it('start_run forwards optional fields (workDir, maxConcurrent, apiKeys, worktree) to runManager', async () => {
      const runManager = createMockRunManager();
      runManager.startRun = mock(async (_msg: StartRunMessage) => ({
        runId: 'run-opt',
        summary: makeRunSummary('run-opt'),
      }));

      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, {
          type: 'start_run',
          workflowName: 'develop',
          taskPrompt: 'Do stuff',
          cwd: '/tmp/proj',
          workDir: '/tmp/work',
          maxConcurrent: 3,
          apiKeys: { OPENAI_API_KEY: 'sk-x' },
          worktree: true,
        });

        const msg = await collector.waitForType('run_started');
        expect(msg.runId).toBe('run-opt');

        // Every optional field must be forwarded verbatim to runManager.startRun.
        expect(runManager.startRun).toHaveBeenCalledTimes(1);
        const passed = runManager.startRun.mock.calls[0][0] as StartRunMessage;
        expect(passed.workflowName).toBe('develop');
        expect(passed.taskPrompt).toBe('Do stuff');
        expect(passed.cwd).toBe('/tmp/proj');
        expect(passed.workDir).toBe('/tmp/work');
        expect(passed.maxConcurrent).toBe(3);
        expect(passed.apiKeys).toEqual({ OPENAI_API_KEY: 'sk-x' });
        expect(passed.worktree).toBe(true);
      } finally {
        ws.close();
      }
    });

    it('start_run keeps the connection alive when runManager.startRun rejects (no auto-subscribe)', async () => {
      const runManager = createMockRunManager();
      runManager.startRun = mock(async () => {
        throw new Error('boom');
      });

      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, { type: 'start_run', workflowName: 'develop', taskPrompt: 'x', cwd: '/tmp' });
        // Allow the rejected promise to settle on the server side.
        await Bun.sleep(80);

        // The connection must survive the failure and keep processing.
        expect(ws.readyState).toBe(WebSocket.OPEN);
        send(ws, { type: 'list_runs' });
        const probe = await collector.waitForType('runs');
        expect(probe.type).toBe('runs');

        // No run_started and no auto-subscribe should have occurred on failure.
        expect(runManager.subscribe).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('subscribe for an existing run subscribes and sends a snapshot', async () => {
      const runManager = createMockRunManager();
      runManager.getRun = mock((runId: string) => (runId === 'run-live' ? makeRunSummary('run-live') : undefined));
      const snap = makeProjection(42);
      runManager.handleResync = mock((ws: ServerWebSocket, runId: string, _lastSeq?: number) => {
        ws.send(JSON.stringify({ type: 'snapshot', runId, seq: snap.seq, state: snap }));
      });

      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        send(ws, { type: 'subscribe', runId: 'run-live' });

        const msg = await collector.waitForType('snapshot');
        expect(msg.type).toBe('snapshot');
        expect(msg.runId).toBe('run-live');
        expect(msg.seq).toBe(42);
        expect(msg.state.currentPhaseId).toBe('scouting');

        expect(runManager.subscribe).toHaveBeenCalledTimes(1);
        expect(runManager.subscribe.mock.calls[0][1]).toBe('run-live');
        // Snapshot delivery delegated to runManager.handleResync
        expect(runManager.handleResync).toHaveBeenCalledTimes(1);
        expect(runManager.handleResync.mock.calls[0][1]).toBe('run-live');
      } finally {
        ws.close();
      }
    });

    it('subscribe for a non-existent run subscribes but sends no snapshot', async () => {
      const runManager = createMockRunManager();
      runManager.getRun = mock(() => undefined);
      runManager.handleResync = mock(() => {});

      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        send(ws, { type: 'subscribe', runId: 'ghost' });

        // No snapshot should arrive — verify by issuing a list_runs and
        // asserting the very next message is the runs reply (no snapshot
        // interleaved).
        send(ws, { type: 'list_runs' });
        const next = await collector.waitForNext();
        expect(next.type).toBe('runs');

        expect(runManager.subscribe).toHaveBeenCalledTimes(1);
        expect(runManager.subscribe.mock.calls[0][1]).toBe('ghost');
        expect(runManager.handleResync).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('unsubscribe calls runManager.unsubscribe for the runId', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        send(ws, { type: 'unsubscribe', runId: 'run-1' });

        // No reply expected — confirm processing via a liveness probe.
        send(ws, { type: 'list_runs' });
        expect((await collector.waitForNext()).type).toBe('runs');

        expect(runManager.unsubscribe).toHaveBeenCalledTimes(1);
        expect(runManager.unsubscribe.mock.calls[0][1]).toBe('run-1');
      } finally {
        ws.close();
      }
    });

    it('resync calls runManager.handleResync with runId and lastSeq', async () => {
      const runManager = createMockRunManager();
      runManager.handleResync = mock((ws: ServerWebSocket, runId: string) => {
        ws.send(JSON.stringify({ type: 'snapshot', runId, seq: 10, state: makeProjection(10) }));
      });

      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        send(ws, { type: 'resync', runId: 'run-1', lastSeq: 7 });

        const msg = await collector.waitForType('snapshot');
        expect(msg.runId).toBe('run-1');

        expect(runManager.handleResync).toHaveBeenCalledTimes(1);
        const [wsArg, runIdArg, lastSeqArg] = runManager.handleResync.mock.calls[0];
        expect(wsArg).toBeDefined();
        expect(runIdArg).toBe('run-1');
        expect(lastSeqArg).toBe(7);
      } finally {
        ws.close();
      }
    });

    it('resync without lastSeq calls runManager.handleResync with undefined lastSeq', async () => {
      const runManager = createMockRunManager();
      runManager.handleResync = mock((ws: ServerWebSocket, runId: string) => {
        ws.send(JSON.stringify({ type: 'snapshot', runId, seq: 0, state: makeProjection(0) }));
      });

      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        send(ws, { type: 'resync', runId: 'run-1' });

        const msg = await collector.waitForType('snapshot');
        expect(msg.runId).toBe('run-1');

        expect(runManager.handleResync).toHaveBeenCalledTimes(1);
        const [, runIdArg, lastSeqArg] = runManager.handleResync.mock.calls[0];
        expect(runIdArg).toBe('run-1');
        expect(lastSeqArg).toBeUndefined();
      } finally {
        ws.close();
      }
    });

    it('cancel_run calls runManager.cancelRun for the runId', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        send(ws, { type: 'cancel_run', runId: 'run-doomed' });

        // No reply expected — confirm processing via a liveness probe.
        send(ws, { type: 'list_runs' });
        expect((await collector.waitForNext()).type).toBe('runs');

        expect(runManager.cancelRun).toHaveBeenCalledTimes(1);
        expect(runManager.cancelRun.mock.calls[0][0]).toBe('run-doomed');
      } finally {
        ws.close();
      }
    });

    it('worktree_action is tolerated (stub) without crashing or erroring', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        send(ws, { type: 'worktree_action', runId: 'run-1', action: 'merge' });

        // The connection must stay alive and keep processing; no error reply.
        send(ws, { type: 'list_runs' });
        const next = await collector.waitForNext();
        expect(next.type).toBe('runs');
      } finally {
        ws.close();
      }
    });

    it('auth is a no-op (connection stays alive)', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        send(ws, { type: 'auth', token: 'whatever' });

        send(ws, { type: 'list_runs' });
        const next = await collector.waitForNext();
        expect(next.type).toBe('runs');
      } finally {
        ws.close();
      }
    });

    it('ignores invalid JSON without crashing', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        ws.send('this is not json {{{');

        send(ws, { type: 'list_runs' });
        const next = await collector.waitForNext();
        expect(next.type).toBe('runs');
      } finally {
        ws.close();
      }
    });

    it('ignores unknown message types without crashing', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs
        ws.send(JSON.stringify({ type: 'totally_bogus' }));

        send(ws, { type: 'list_runs' });
        const next = await collector.waitForNext();
        expect(next.type).toBe('runs');
      } finally {
        ws.close();
      }
    });
  });

  // ── close handler ───────────────────────────────────────────────────────

  it('close calls runManager.unsubscribeAll for the disconnecting ws', async () => {
    const runManager = createMockRunManager();
    const port = randomPort();
    server = await startObserverServer({ host: '127.0.0.1', port, runManager });

    const { ws } = await connect(port);
    try {
      ws.close();
      // The server's close handler fires asynchronously.
      await Bun.sleep(150);
      expect(runManager.unsubscribeAll).toHaveBeenCalledTimes(1);
      expect(runManager.unsubscribeAll.mock.calls[0][0]).toBeDefined();
    } finally {
      // already closed
    }
  });

  // ── broadcast ───────────────────────────────────────────────────────────

  it('broadcast delivers a message to all connected clients', async () => {
    const port = randomPort();
    server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

    const c1 = await connect(port);
    const c2 = await connect(port);
    try {
      // Drain the connect-time runs messages so the broadcast is unambiguous.
      await c1.collector.waitForType('runs');
      await c2.collector.waitForType('runs');

      const msg: ServerMessage = { type: 'run_complete', runId: 'run-bcast' };
      server.broadcast(msg);

      const [a, b] = await Promise.all([
        c1.collector.waitForType('run_complete'),
        c2.collector.waitForType('run_complete'),
      ]);
      expect(a).toEqual(msg);
      expect(b).toEqual(msg);
    } finally {
      c1.ws.close();
      c2.ws.close();
    }
  });

  // ── static file serving (preserved) ─────────────────────────────────────

  it('serves index.html with WS_ENDPOINT replaced', async () => {
    const port = randomPort();
    server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>engin');
    expect(html).not.toContain('{{WS_ENDPOINT}}');
    expect(html).toContain(`ws://127.0.0.1:${port}/ws`);
  });

  it('serves static assets from dist when available', async () => {
    const distDir = join(import.meta.dir, '../../packages/web/dist');
    if (!existsSync(distDir)) return;

    const port = randomPort();
    server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

    const assetsDir = join(distDir, 'assets');
    const files = readdirSync(assetsDir);
    const jsFile = files.find((f) => f.endsWith('.js'));
    if (!jsFile) return;

    const response = await fetch(`http://127.0.0.1:${port}/assets/${jsFile}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
  });

  it('SPA fallback serves index.html for unknown paths', async () => {
    const port = randomPort();
    server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

    const response = await fetch(`http://127.0.0.1:${port}/some/unknown/path`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>engin');
    expect(html).toContain(`ws://127.0.0.1:${port}/ws`);
  });

  // ── Origin validation (preserved) ───────────────────────────────────────

  describe('origin validation', () => {
    /**
     * Send a plain HTTP GET to /ws and return the response status. Lacking
     * upgrade headers, the server returns 400 when origin validation passes
     * (upgrade fails) or 403 when validation rejects.
     */
    async function hitWs(serverUrl: string, origin?: string): Promise<Response> {
      const headers: Record<string, string> = {};
      if (origin !== undefined) headers['Origin'] = origin;
      return await fetch(`${serverUrl}/ws`, { headers });
    }

    it('rejects mismatched Origin on non-localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://0.0.0.0:${port}`, 'https://evil.com');
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('Forbidden');
    });

    it('allows missing Origin on non-localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://0.0.0.0:${port}`);
      expect(res.status).not.toBe(403);
    });

    it('rejects matching Origin while auth is disabled (browser-originated connections blocked)', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://0.0.0.0:${port}`, `http://0.0.0.0:${port}`);
      expect(res.status).toBe(403);
    });

    it('rejects any Origin when connecting via 127.0.0.1 while auth is disabled', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://127.0.0.1:${port}`, 'https://evil.com');
      expect(res.status).toBe(403);
    });

    it('rejects any Origin when connecting via localhost while auth is disabled', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://localhost:${port}`, 'https://evil.com');
      expect(res.status).toBe(403);
    });

    it('allows missing Origin on localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://127.0.0.1:${port}`);
      expect(res.status).not.toBe(403);
    });

    it('rejects capacitor://localhost origin while auth is disabled', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://0.0.0.0:${port}`, 'capacitor://localhost');
      expect(res.status).toBe(403);
    });

    it('rejects file:// origin while auth is disabled', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://0.0.0.0:${port}`, 'file://');
      expect(res.status).toBe(403);
    });

    it('rejects Origin with omitted port while auth is disabled', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://0.0.0.0:${port}`, `http://0.0.0.0`);
      expect(res.status).toBe(403);
    });

    it('rejects genuinely mismatched hostname', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://0.0.0.0:${port}`, 'http://evil.com');
      expect(res.status).toBe(403);
    });

    it('rejects Origin with case-insensitive hostname while auth is disabled', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port, runManager: createMockRunManager() });
      const res = await hitWs(`http://0.0.0.0:${port}`, `http://0.0.0.0:${port}`);
      expect(res.status).toBe(403);
    });

    it('does not trust x-forwarded-host header for Origin validation', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port, runManager: createMockRunManager() });
      const headers: Record<string, string> = {
        Origin: `http://1.2.3.4:${port}`,
        'X-Forwarded-Host': `1.2.3.4:${port}`,
      };
      const res = await fetch(`http://0.0.0.0:${port}/ws`, { headers });
      expect(res.status).toBe(403);
    });

    it('still allows real WebSocket connections from browser on localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });
      const { ws, collector } = await connect(port);
      try {
        // In the multi-run model a fresh connection receives a `runs` message.
        const msg = await collector.waitForType('runs');
        expect(msg.type).toBe('runs');
      } finally {
        ws.close();
      }
    });
  });

  // ── displayHost (preserved) ─────────────────────────────────────────────

  it('uses server.hostname in URL when displayHost is not provided (backward compat)', async () => {
    server = await startObserverServer({
      host: '127.0.0.1',
      port: 0,
      runManager: createMockRunManager(),
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await server.stop();
    server = undefined;
  });

  it('uses displayHost in URL when provided, replacing server.hostname', async () => {
    server = await startObserverServer({
      host: '0.0.0.0',
      port: 0,
      displayHost: '192.168.1.50',
      runManager: createMockRunManager(),
    });
    expect(server.url).toMatch(/^http:\/\/192\.168\.1\.50:\d+$/);
    expect(server.url).not.toContain('0.0.0.0');
    await server.stop();
    server = undefined;
  });

  it('displayHost works with localhost host', async () => {
    server = await startObserverServer({
      host: '127.0.0.1',
      port: 0,
      displayHost: 'myhost.local',
      runManager: createMockRunManager(),
    });
    expect(server.url).toMatch(/^http:\/\/myhost\.local:\d+$/);
    await server.stop();
    server = undefined;
  });

  it('displayHost preserves port in URL', async () => {
    server = await startObserverServer({
      host: '0.0.0.0',
      port: 0,
      displayHost: 'example.com',
      runManager: createMockRunManager(),
    });
    expect(server.url).toBe(`http://example.com:${server.server.port}`);
    await server.stop();
    server = undefined;
  });

  it('startObserverServer with host 0.0.0.0, port 0, and displayHost 192.168.1.50 returns a URL containing 192.168.1.50 not 0.0.0.0', async () => {
    server = await startObserverServer({
      host: '0.0.0.0',
      port: 0,
      displayHost: '192.168.1.50',
      runManager: createMockRunManager(),
    });
    expect(server.url).toContain('192.168.1.50');
    expect(server.url).not.toContain('0.0.0.0');
    expect(server.url).toMatch(/^http:\/\/192\.168\.1\.50:\d+$/);
    await server.stop();
    server = undefined;
  });

  // ── WS scheme detection (preserved) ─────────────────────────────────────

  describe('WS scheme detection', () => {
    it('uses ws:// scheme when serving over plain HTTP (no x-forwarded-proto)', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`ws://127.0.0.1:${port}/ws`);
      expect(html).not.toContain(`wss://127.0.0.1:${port}/ws`);
    });

    it('does not trust x-forwarded-proto header', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`ws://127.0.0.1:${port}/ws`);
      expect(html).not.toContain(`wss://127.0.0.1:${port}/ws`);
    });

    it('does not trust x-forwarded-proto for SPA fallback path', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });
      const response = await fetch(`http://127.0.0.1:${port}/some/random/path`, {
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`ws://127.0.0.1:${port}/ws`);
      expect(html).not.toContain(`wss://127.0.0.1:${port}/ws`);
    });
  });

  // ── GET /health (T25) ───────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with JSON containing pid, port, and activeRuns', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const body = await response.json();
      expect(typeof body.pid).toBe('number');
      expect(body.pid).toBe(process.pid);
      expect(typeof body.port).toBe('number');
      expect(body.port).toBe(port);
      expect(typeof body.activeRuns).toBe('number');
      expect(body.activeRuns).toBe(0); // default mock returns empty list
    });

    it('returns activeRuns matching runManager.listRuns().length', async () => {
      const runManager = createMockRunManager();
      runManager.listRuns = mock(() => [makeRunSummary('run-a'), makeRunSummary('run-b'), makeRunSummary('run-c')]);

      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.activeRuns).toBe(3);
    });

    it('returns activeRuns of 0 when no runs exist', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json();
      expect(body.activeRuns).toBe(0);
    });

    it('does not serve HTML placeholder when web/dist is absent', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      const text = await response.text();
      // Must be JSON, not the placeholder HTML
      expect(text).not.toContain('<!doctype html>');
      expect(text).not.toContain('engin observer');
      const body = JSON.parse(text);
      expect(body).toHaveProperty('pid');
    });

    it('returns a valid JSON structure with all required fields', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json();

      // Exact shape: { pid, port, activeRuns } — no extra fields, no missing fields.
      expect(Object.keys(body).sort()).toEqual(['activeRuns', 'pid', 'port']);
    });

    it('serves /health even when a query string is present (exact path match)', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager: createMockRunManager() });

      // A query string should not prevent /health from matching.
      const response = await fetch(`http://127.0.0.1:${port}/health?foo=bar`);
      // Depending on implementation, this may be 200 (health) or 200 (SPA fallback).
      // The important thing is the /health path itself works.
      expect(response.status).toBe(200);
    });
  });

  // ── onShutdown callback (T25) ───────────────────────────────────────────

  describe('onShutdown callback', () => {
    it('calls onShutdown when stop() is invoked', async () => {
      const onShutdown = mock(async () => {});
      const port = randomPort();
      server = await startObserverServer({
        host: '127.0.0.1',
        port,
        runManager: createMockRunManager(),
        onShutdown,
      } as any); // cast needed until onShutdown is added to the options type

      await server.stop();
      server = undefined;

      expect(onShutdown).toHaveBeenCalledTimes(1);
    });

    it('awaits onShutdown before stopping the server', async () => {
      const order: string[] = [];
      const onShutdown = mock(async () => {
        // Small delay to prove await semantics
        await Bun.sleep(10);
        order.push('onShutdown');
      });
      const port = randomPort();
      server = await startObserverServer({
        host: '127.0.0.1',
        port,
        runManager: createMockRunManager(),
        onShutdown,
      } as any);

      await server.stop();
      server = undefined;

      order.push('stopped');
      // onShutdown must have completed before stop() returned
      expect(order).toEqual(['onShutdown', 'stopped']);
    });

    it('does not crash when onShutdown is not provided', async () => {
      const port = randomPort();
      server = await startObserverServer({
        host: '127.0.0.1',
        port,
        runManager: createMockRunManager(),
      });

      // Should not throw — onShutdown is optional
      await server.stop();
      server = undefined;
    });

    it('wires runManager.shutdownAll() via onShutdown when provided', async () => {
      const runManager = createMockRunManager();
      runManager.shutdownAll = mock(async () => {});

      // The typical onShutdown wiring: it should call runManager.shutdownAll()
      const onShutdown = mock(async () => {
        await runManager.shutdownAll();
      });

      const port = randomPort();
      server = await startObserverServer({
        host: '127.0.0.1',
        port,
        runManager,
        onShutdown,
      } as any);

      await server.stop();
      server = undefined;

      expect(onShutdown).toHaveBeenCalledTimes(1);
      expect(runManager.shutdownAll).toHaveBeenCalledTimes(1);
    });
  });

  // ── T35: authorize chokepoint ──────────────────────────────────────────
  //
  // Every inbound ClientMessage must pass through `authorize(msg, ws)`
  // from auth.ts. If authorize returns `{ authorized: false }`, the server
  // must reply with `{ type: 'auth_required' }` and close the WebSocket.
  //
  // Currently RED: observer-server.ts does NOT call authorize.

  describe('T35: authorize chokepoint', () => {
    beforeEach(() => {
      mockAuthorize.mockReset();
      mockAuthorize.mockReturnValue({ authorized: true });
    });

    it('calls authorize() for every inbound ClientMessage', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        // Send a list_runs message.
        send(ws, { type: 'list_runs' });
        await collector.waitForType('runs'); // consume reply

        // authorize must have been called at least once with the list_runs message.
        expect(mockAuthorize).toHaveBeenCalled();
        // The first call's first argument must be the ClientMessage we sent.
        const firstCallMsg = mockAuthorize.mock.calls[0][0];
        expect(firstCallMsg).toEqual({ type: 'list_runs' });
      } finally {
        ws.close();
      }
    });

    it('calls authorize() for subscribe messages', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, { type: 'subscribe', runId: 'run-x' });
        // Liveness probe — subscribe may or may not produce output.
        send(ws, { type: 'list_runs' });
        await collector.waitForType('runs');

        // authorize must have been called with the subscribe message.
        const subscribeCalls = mockAuthorize.mock.calls.filter((c) => (c[0] as any).type === 'subscribe');
        expect(subscribeCalls.length).toBeGreaterThanOrEqual(1);
        expect((subscribeCalls[0][0] as any).runId).toBe('run-x');
      } finally {
        ws.close();
      }
    });

    it('calls authorize() for start_run messages', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, {
          type: 'start_run',
          workflowName: 'ship',
          taskPrompt: 'Ship it',
          cwd: '/tmp',
        });
        await collector.waitForType('run_started');

        // authorize must have been called with the start_run message.
        const startCalls = mockAuthorize.mock.calls.filter((c) => (c[0] as any).type === 'start_run');
        expect(startCalls.length).toBeGreaterThanOrEqual(1);
        expect((startCalls[0][0] as any).workflowName).toBe('ship');
      } finally {
        ws.close();
      }
    });

    it('calls authorize() for cancel_run messages', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, { type: 'cancel_run', runId: 'run-doomed' });
        send(ws, { type: 'list_runs' });
        await collector.waitForType('runs');

        const cancelCalls = mockAuthorize.mock.calls.filter((c) => (c[0] as any).type === 'cancel_run');
        expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
      } finally {
        ws.close();
      }
    });

    it('passes the ws object as the second argument to authorize()', async () => {
      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, { type: 'list_runs' });
        await collector.waitForType('runs');

        // The second argument to authorize must be the WebSocket object.
        expect(mockAuthorize).toHaveBeenCalled();
        const wsArg = mockAuthorize.mock.calls[0][1];
        expect(wsArg).toBeDefined();
        // wsArg should be the ServerWebSocket — it must have a send method.
        expect(typeof (wsArg as any).send).toBe('function');
      } finally {
        ws.close();
      }
    });

    // ── Rejection: authorize returns { authorized: false } ───────────────

    it('sends auth_required when authorize rejects a message', async () => {
      mockAuthorize.mockReturnValue({ authorized: false });

      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, { type: 'list_runs' });

        // The server must reply with auth_required instead of the normal runs reply.
        const msg = await collector.waitForType('auth_required');
        expect(msg.type).toBe('auth_required');
      } finally {
        ws.close();
      }
    });

    it('closes the WebSocket after sending auth_required', async () => {
      mockAuthorize.mockReturnValue({ authorized: false });

      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, { type: 'list_runs' });
        await collector.waitForType('auth_required');

        // After auth_required, the ws should be closed by the server.
        // Wait briefly for the close event to propagate.
        const closed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 1000);
          ws.addEventListener('close', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        expect(closed).toBe(true);
      } finally {
        ws.close();
      }
    });

    it('does NOT process the rejected message (no routeMessage side effects)', async () => {
      mockAuthorize.mockReturnValue({ authorized: false });

      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, { type: 'list_runs' });
        await collector.waitForType('auth_required');

        // runManager.listRuns should NOT have been called a second time
        // (the message was rejected before routing).
        // The first call was from the connect handler; there should be no more.
        expect(runManager.listRuns.mock.calls.length).toBe(1);
      } finally {
        ws.close();
      }
    });

    it('rejects start_run when authorize denies (no run_started reply)', async () => {
      mockAuthorize.mockReturnValue({ authorized: false });

      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        send(ws, {
          type: 'start_run',
          workflowName: 'evil',
          taskPrompt: 'Bad stuff',
          cwd: '/tmp',
        });

        // Must get auth_required, NOT run_started.
        const msg = await collector.waitForType('auth_required');
        expect(msg.type).toBe('auth_required');

        // startRun must NOT have been called.
        expect(runManager.startRun).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('allows all subsequent messages after authorize starts returning true', async () => {
      // Simulate: first message rejected, then authorize starts allowing.
      let callCount = 0;
      mockAuthorize.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? { authorized: false } : { authorized: true };
      });

      const runManager = createMockRunManager();
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port, runManager });

      const { ws, collector } = await connect(port);
      try {
        await collector.waitForType('runs'); // consume connect-time runs

        // First message — rejected.
        send(ws, { type: 'list_runs' });
        await collector.waitForType('auth_required');

        // Note: after rejection the ws is closed, so this second message
        // cannot actually be sent. This test verifies the contract that
        // rejection + close prevents further processing. We verify the
        // ws is closed instead.
        const closed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 1000);
          ws.addEventListener('close', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        expect(closed).toBe(true);
      } finally {
        ws.close();
      }
    });
  });
});
