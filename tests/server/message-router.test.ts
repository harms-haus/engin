// ─── message-router — test-first specification ───────────────────────────────
//
// Tests for `src/server/message-router.ts`, the factory that routes parsed
// `ClientMessage`s to the appropriate `RunManager` method.
//
// Contract under test (see server-refactor.prompt.md):
//
//   export function createMessageRouter(runManager: RunManager): {
//     routeMessage(ws: ServerWebSocket, msg: ClientMessage): void
//   }
//
// Invariants verified here:
//   • Every inbound message passes through the `authorize` chokepoint from
//     auth.ts FIRST. The ws object is forwarded as the second argument.
//   • When authorize denies ({ authorized: false }) the router replies with
//     `{ type: 'auth_required' }`, closes the ws, and does NOT touch runManager.
//   • When authorized, the message is routed by `type`:
//       list_runs       → ws.send({ type:'runs', runs: runManager.listRuns() })
//       start_run       → runManager.startRun(payload WITHOUT `type`); on
//                         success ws.send({ type:'run_started', ... }) and the
//                         requesting ws is auto-subscribed. Optional fields
//                         (workDir, maxConcurrent, apiKeys) are
//                         forwarded verbatim. On rejection no run_started is
//                         sent and the ws is NOT auto-subscribed (no crash).
//       subscribe       → runManager.subscribe(ws, runId); if the run exists
//                         (runManager.getRun) also runManager.handleResync.
//       unsubscribe     → runManager.unsubscribe(ws, runId)
//       resync          → runManager.handleResync(ws, runId, lastSeq)
//       cancel_run      → runManager.cancelRun(runId)
//       worktree_action → runManager.handleWorktreeAction(runId, action)
//                         (tolerated; failures are caught, no crash)
//       auth            → no-op
//       unknown type    → ignored (no crash, no reply)
//
// `authorize` is mocked so the chokepoint can be spied on and toggled to
// denial. The RunManager is a real instance with every method overridden by a
// controllable mock (mirrors tests/web/control-server.test.ts), and the
// ServerWebSocket is a minimal fake that records sends and close calls. No
// live server is started.

import type { ClientMessage, RunSummary } from '@engin/shared/protocol-types';
import type { ServerWebSocket } from 'bun';
import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── authorize chokepoint mock ──────────────────────────────────────────────
//
// message-router.ts imports `authorize` from `./auth.js`. Mock it so each
// test can assert the chokepoint was consulted and simulate denial. This is
// the same proven pattern used in tests/web/control-server.test.ts: capture
// the real module via dynamic import, then mock.module the path the router
// resolves `./auth.js` to.

const realAuth = Object.assign({}, await import('../../packages/engine/src/server/auth.js'));
const mockAuthorize = mock<(msg: ClientMessage, ws: unknown) => { authorized: boolean }>(() => ({
  authorized: true,
}));

mock.module('../../packages/engine/src/server/auth.js', () => ({
  ...realAuth,
  authorize: mockAuthorize,
}));

// ─── Import the module under test AFTER registering the mock ────────────────

import { createMessageRouter } from '../../packages/engine/src/server/message-router.js';
import { RunManager, type StartRunMessage } from '../../packages/engine/src/server/run-manager.js';

// ─── Test fixtures ───────────────────────────────────────────────────────────

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

/**
 * Build a real `RunManager` instance with every method overridden by a
 * controllable mock. A real instance satisfies the `RunManager` parameter
 * type; the overrides let each test drive the registry without loading a
 * workflow.
 */
function createMockRunManager(): RunManager {
  const rm = new RunManager(() => {});
  rm.listRuns = mock((): RunSummary[] => []);
  rm.getRun = mock((_runId: string): RunSummary | undefined => undefined);
  rm.startRun = mock(async (_msg: StartRunMessage) => ({ runId: 'run-1', summary: makeRunSummary('run-1') }));
  rm.subscribe = mock((_ws: ServerWebSocket, _runId: string): void => {});
  rm.unsubscribe = mock((_ws: ServerWebSocket, _runId: string): void => {});
  rm.unsubscribeAll = mock((_ws: ServerWebSocket): void => {});
  rm.handleResync = mock((_ws: ServerWebSocket, _runId: string, _lastSeq?: number): void => {});
  rm.cancelRun = mock((_runId: string): void => {});
  rm.handleWorktreeAction = mock(async (_runId: string, _action: 'merge' | 'resolve' | 'decline'): Promise<void> => {});
  return rm;
}

/** Recorded state of a fake ServerWebSocket. */
interface FakeWsState {
  sent: string[];
  closed: boolean;
  readyState: number;
}

/**
 * Build a fake ServerWebSocket that records every `send` payload and tracks
 * `close` calls. The fake is shaped to satisfy `routeMessage`'s usage
 * (`ws.send(string)` and `ws.close()`).
 */
function makeFakeWs(): { ws: ServerWebSocket; state: FakeWsState } {
  const state: FakeWsState = { sent: [], closed: false, readyState: 1 };
  const ws = {
    readyState: 1,
    send: (data: string): void => {
      state.sent.push(data);
    },
    close: (): void => {
      state.closed = true;
    },
  } as unknown as ServerWebSocket;
  return { ws, state };
}

/** Parse the most-recent sent payload as JSON (asserting at least one send). */
function lastSentJson(state: FakeWsState): any {
  expect(state.sent.length).toBeGreaterThan(0);
  return JSON.parse(state.sent[state.sent.length - 1]);
}

/** Flush pending microtasks so async routes (start_run, worktree_action) settle. */
async function flushAsync(): Promise<void> {
  await Bun.sleep(5);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createMessageRouter', () => {
  beforeEach(() => {
    mockAuthorize.mockReset();
    mockAuthorize.mockReturnValue({ authorized: true });
  });

  // ── authorize chokepoint ────────────────────────────────────────────────

  describe('authorize chokepoint', () => {
    it('passes every inbound message through authorize()', () => {
      const router = createMessageRouter(createMockRunManager());
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'list_runs' });

      expect(mockAuthorize).toHaveBeenCalledTimes(1);
      expect(mockAuthorize.mock.calls[0][0]).toEqual({ type: 'list_runs' });
    });

    it('forwards the ws object as the second argument to authorize()', () => {
      const router = createMessageRouter(createMockRunManager());
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'list_runs' });

      expect(mockAuthorize.mock.calls[0][1]).toBe(ws);
    });

    it('sends auth_required and closes the ws when authorize denies', () => {
      mockAuthorize.mockReturnValue({ authorized: false });
      const router = createMessageRouter(createMockRunManager());
      const { ws, state } = makeFakeWs();

      router.routeMessage(ws, { type: 'list_runs' });

      expect(lastSentJson(state)).toEqual({ type: 'auth_required' });
      expect(state.closed).toBe(true);
    });

    it('does not route a denied message to runManager', () => {
      mockAuthorize.mockReturnValue({ authorized: false });
      const runManager = createMockRunManager();
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'list_runs' });

      expect(runManager.listRuns).not.toHaveBeenCalled();
    });

    it('does not send the normal reply when authorize denies', () => {
      mockAuthorize.mockReturnValue({ authorized: false });
      const router = createMessageRouter(createMockRunManager());
      const { ws, state } = makeFakeWs();

      router.routeMessage(ws, { type: 'list_runs' });
      // auth_required is the ONLY frame sent.
      expect(state.sent).toHaveLength(1);
      expect(JSON.parse(state.sent[0])).toEqual({ type: 'auth_required' });
    });
  });

  // ── routing (authorized) ────────────────────────────────────────────────

  describe('routing (authorized)', () => {
    it('list_runs replies with a runs message sourced from runManager.listRuns()', () => {
      const runManager = createMockRunManager();
      const runs = [makeRunSummary('run-x')];
      runManager.listRuns = mock(() => runs);
      const router = createMessageRouter(runManager);
      const { ws, state } = makeFakeWs();

      router.routeMessage(ws, { type: 'list_runs' });

      expect(lastSentJson(state)).toEqual({ type: 'runs', runs });
      expect(runManager.listRuns).toHaveBeenCalledTimes(1);
    });

    it('start_run forwards the payload with the type discriminator stripped', async () => {
      const runManager = createMockRunManager();
      const startRunMock = mock(async (_msg: StartRunMessage) => ({
        runId: 'run-started',
        summary: makeRunSummary('run-started', { workflowName: 'ship', taskPrompt: 'Ship it' }),
      }));
      runManager.startRun = startRunMock;
      runManager.subscribe = mock((_ws: ServerWebSocket, _runId: string): void => {});
      const router = createMessageRouter(runManager);
      const { ws, state } = makeFakeWs();

      router.routeMessage(ws, {
        type: 'start_run',
        workflowName: 'ship',
        taskPrompt: 'Ship it',
        cwd: '/tmp/project',
      });
      await flushAsync();

      expect(lastSentJson(state)).toEqual({
        type: 'run_started',
        runId: 'run-started',
        summary: makeRunSummary('run-started', { workflowName: 'ship', taskPrompt: 'Ship it' }),
      });

      expect(startRunMock).toHaveBeenCalledTimes(1);
      const passed = startRunMock.mock.calls[0][0] as StartRunMessage;
      // StartRunMessage is the start_run payload WITHOUT the `type` discriminator.
      expect(passed).not.toHaveProperty('type');
      expect(passed.workflowName).toBe('ship');
      expect(passed.taskPrompt).toBe('Ship it');
      expect(passed.cwd).toBe('/tmp/project');
    });

    it('start_run forwards optional fields verbatim (workDir, maxConcurrent, apiKeys)', async () => {
      const runManager = createMockRunManager();
      const startRunMock = mock(async (_msg: StartRunMessage) => ({
        runId: 'run-opt',
        summary: makeRunSummary('run-opt'),
      }));
      runManager.startRun = startRunMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, {
        type: 'start_run',
        workflowName: 'develop',
        taskPrompt: 'Do stuff',
        cwd: '/tmp/proj',
        workDir: '/tmp/work',
        maxConcurrent: 3,
        apiKeys: { OPENAI_API_KEY: 'sk-x' },
      });
      await flushAsync();

      expect(startRunMock).toHaveBeenCalledTimes(1);
      const passed = startRunMock.mock.calls[0][0] as StartRunMessage;
      expect(passed).toEqual({
        workflowName: 'develop',
        taskPrompt: 'Do stuff',
        cwd: '/tmp/proj',
        workDir: '/tmp/work',
        maxConcurrent: 3,
        apiKeys: { OPENAI_API_KEY: 'sk-x' },
      });
    });

    it('start_run auto-subscribes the requesting ws to the new run', async () => {
      const runManager = createMockRunManager();
      runManager.startRun = mock(async (_msg: StartRunMessage) => ({
        runId: 'run-started',
        summary: makeRunSummary('run-started'),
      }));
      const subscribeMock = mock((_ws: ServerWebSocket, _runId: string): void => {});
      runManager.subscribe = subscribeMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'start_run', workflowName: 'x', taskPrompt: 'y', cwd: '/tmp' });
      await flushAsync();

      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect(subscribeMock.mock.calls[0][1]).toBe('run-started');
      // The auto-subscribe targets the requesting socket itself.
      expect(subscribeMock.mock.calls[0][0]).toBe(ws);
    });

    it('start_run keeps its composure when runManager.startRun rejects (no run_started, no subscribe)', async () => {
      const runManager = createMockRunManager();
      runManager.startRun = mock(async () => {
        throw new Error('boom');
      });
      const subscribeMock = mock((_ws: ServerWebSocket, _runId: string): void => {});
      runManager.subscribe = subscribeMock;
      const router = createMessageRouter(runManager);
      const { ws, state } = makeFakeWs();

      router.routeMessage(ws, { type: 'start_run', workflowName: 'x', taskPrompt: 'y', cwd: '/tmp' });
      await flushAsync();

      // No run_started frame and no auto-subscribe.
      expect(state.sent.filter((raw) => JSON.parse(raw).type === 'run_started')).toHaveLength(0);
      expect(subscribeMock).not.toHaveBeenCalled();
    });

    it('subscribe for an existing run subscribes and triggers a snapshot', () => {
      const runManager = createMockRunManager();
      runManager.getRun = mock((runId: string) => (runId === 'run-live' ? makeRunSummary('run-live') : undefined));
      const subscribeMock = mock((_ws: ServerWebSocket, _runId: string): void => {});
      runManager.subscribe = subscribeMock;
      const handleResyncMock = mock((_ws: ServerWebSocket, _runId: string, _lastSeq?: number): void => {});
      runManager.handleResync = handleResyncMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'subscribe', runId: 'run-live' });

      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect(subscribeMock.mock.calls[0][1]).toBe('run-live');
      expect(handleResyncMock).toHaveBeenCalledTimes(1);
      expect(handleResyncMock.mock.calls[0][1]).toBe('run-live');
    });

    it('subscribe for a non-existent run subscribes but sends no snapshot', () => {
      const runManager = createMockRunManager();
      runManager.getRun = mock(() => undefined);
      const subscribeMock = mock((_ws: ServerWebSocket, _runId: string): void => {});
      runManager.subscribe = subscribeMock;
      const handleResyncMock = mock((_ws: ServerWebSocket, _runId: string, _lastSeq?: number): void => {});
      runManager.handleResync = handleResyncMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'subscribe', runId: 'ghost' });

      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect(subscribeMock.mock.calls[0][1]).toBe('ghost');
      expect(handleResyncMock).not.toHaveBeenCalled();
    });

    it('unsubscribe calls runManager.unsubscribe(ws, runId)', () => {
      const runManager = createMockRunManager();
      const unsubscribeMock = mock((_ws: ServerWebSocket, _runId: string): void => {});
      runManager.unsubscribe = unsubscribeMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'unsubscribe', runId: 'run-1' });

      expect(unsubscribeMock).toHaveBeenCalledTimes(1);
      expect(unsubscribeMock.mock.calls[0][1]).toBe('run-1');
      expect(unsubscribeMock.mock.calls[0][0]).toBe(ws);
    });

    it('resync forwards runId and lastSeq to runManager.handleResync', () => {
      const runManager = createMockRunManager();
      const handleResyncMock = mock((_ws: ServerWebSocket, _runId: string, _lastSeq?: number): void => {});
      runManager.handleResync = handleResyncMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'resync', runId: 'run-1', lastSeq: 7 });

      expect(handleResyncMock).toHaveBeenCalledTimes(1);
      const [wsArg, runIdArg, lastSeqArg] = handleResyncMock.mock.calls[0];
      expect(wsArg).toBe(ws);
      expect(runIdArg).toBe('run-1');
      expect(lastSeqArg).toBe(7);
    });

    it('resync without lastSeq forwards undefined as the lastSeq argument', () => {
      const runManager = createMockRunManager();
      const handleResyncMock = mock((_ws: ServerWebSocket, _runId: string, _lastSeq?: number): void => {});
      runManager.handleResync = handleResyncMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'resync', runId: 'run-1' });

      expect(handleResyncMock).toHaveBeenCalledTimes(1);
      const [, runIdArg, lastSeqArg] = handleResyncMock.mock.calls[0];
      expect(runIdArg).toBe('run-1');
      expect(lastSeqArg).toBeUndefined();
    });

    it('cancel_run calls runManager.cancelRun(runId)', () => {
      const runManager = createMockRunManager();
      const cancelRunMock = mock((_runId: string): void => {});
      runManager.cancelRun = cancelRunMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'cancel_run', runId: 'run-doomed' });

      expect(cancelRunMock).toHaveBeenCalledTimes(1);
      expect(cancelRunMock.mock.calls[0][0]).toBe('run-doomed');
    });

    it('worktree_action forwards runId and action to runManager.handleWorktreeAction', async () => {
      const runManager = createMockRunManager();
      const wtMock = mock(async (_runId: string, _action: 'merge' | 'resolve' | 'decline'): Promise<void> => {});
      runManager.handleWorktreeAction = wtMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'worktree_action', runId: 'run-1', action: 'merge' });
      await flushAsync();

      expect(wtMock).toHaveBeenCalledTimes(1);
      const [runIdArg, actionArg] = wtMock.mock.calls[0];
      expect(runIdArg).toBe('run-1');
      expect(actionArg).toBe('merge');
    });

    it('worktree_action forwards each new two-prompt action type verbatim (resolve, decline)', async () => {
      const runManager = createMockRunManager();
      const wtMock = mock(async (_runId: string, _action: 'merge' | 'resolve' | 'decline'): Promise<void> => {});
      runManager.handleWorktreeAction = wtMock;
      const router = createMessageRouter(runManager);
      const { ws } = makeFakeWs();

      router.routeMessage(ws, { type: 'worktree_action', runId: 'r', action: 'resolve' });
      await flushAsync();
      router.routeMessage(ws, { type: 'worktree_action', runId: 'r', action: 'decline' });
      await flushAsync();

      expect(wtMock).toHaveBeenCalledTimes(2);
      expect(wtMock.mock.calls[0][0]).toBe('r');
      expect(wtMock.mock.calls[0][1]).toBe('resolve');
      expect(wtMock.mock.calls[1][0]).toBe('r');
      expect(wtMock.mock.calls[1][1]).toBe('decline');
    });

    it('worktree_action tolerates a rejecting handler without throwing', async () => {
      const runManager = createMockRunManager();
      runManager.handleWorktreeAction = mock(async () => {
        throw new Error('nope');
      });
      const router = createMessageRouter(runManager);
      const { ws, state } = makeFakeWs();

      // Must not throw synchronously.
      router.routeMessage(ws, { type: 'worktree_action', runId: 'run-1', action: 'decline' });
      await flushAsync();

      // No reply is expected for worktree_action.
      expect(state.sent).toHaveLength(0);
    });

    it('auth is a no-op (no runManager interaction, no reply)', () => {
      const runManager = createMockRunManager();
      const router = createMessageRouter(runManager);
      const { ws, state } = makeFakeWs();

      router.routeMessage(ws, { type: 'auth', token: 'whatever' });

      expect(state.sent).toHaveLength(0);
    });

    it('ignores unknown message types without crashing or replying', () => {
      const runManager = createMockRunManager();
      const router = createMessageRouter(runManager);
      const { ws, state } = makeFakeWs();

      router.routeMessage(ws, { type: 'totally_bogus' } as unknown as ClientMessage);

      expect(state.sent).toHaveLength(0);
    });
  });

  // ── factory isolation ───────────────────────────────────────────────────

  describe('factory isolation', () => {
    it('returns an object with a routeMessage function', () => {
      const router = createMessageRouter(createMockRunManager());
      expect(typeof router.routeMessage).toBe('function');
    });

    it('each router instance binds to its own runManager', () => {
      const rmA = createMockRunManager();
      const rmB = createMockRunManager();
      const cancelA = mock((_runId: string): void => {});
      const cancelB = mock((_runId: string): void => {});
      rmA.cancelRun = cancelA;
      rmB.cancelRun = cancelB;
      const routerA = createMessageRouter(rmA);
      const routerB = createMessageRouter(rmB);
      const { ws } = makeFakeWs();

      routerA.routeMessage(ws, { type: 'cancel_run', runId: 'a' });
      routerB.routeMessage(ws, { type: 'cancel_run', runId: 'b' });

      expect(cancelA.mock.calls[0][0]).toBe('a');
      expect(cancelB.mock.calls[0][0]).toBe('b');
    });
  });
});
