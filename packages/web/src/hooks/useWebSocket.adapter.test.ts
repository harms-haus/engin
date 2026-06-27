/**
 * useWebSocket adapter tests — verifies the hook is a thin React adapter over
 * the shared EngineClient.
 *
 * These tests mock `@engin/shared/engine-client` so they can assert directly
 * that useWebSocket:
 *   - imports & instantiates EngineClient (no inline WebSocket management)
 *   - shares ONE module-level EngineClient singleton across every consumer
 *   - ref-counts acquire/release (first mount connects, last unmount disconnects)
 *   - routes the EngineClient onMessage callback into the zustand store
 *   - reflects onConnected/onDisconnected into reactive connected/hasConnectedOnce
 *   - delegates send / subscribe / unsubscribe / resync to EngineClient
 *
 * Transport concerns (reconnect / backoff / resync-replay) now live in
 * EngineClient and are covered by the end-to-end suite in useWebSocket.test.ts.
 */

import type { EngineClientCallbacks } from '@engin/shared/engine-client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, RunSummary, ServerMessage } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';
import { useWebSocket } from './useWebSocket';

// ─── Mock the shared EngineClient ──────────────────────────────────────────
//
// The constructor is a constructable vi.fn that always returns the SAME shared
// instance, so that:
//   - "constructor called once for N consumers" stays meaningful, and
//   - every method assertion (connect/send/subscribe/…) lands on one object.

const { mockClient, MockEngineClient } = vi.hoisted(() => {
  const mockClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    resync: vi.fn(),
    isConnected: vi.fn(),
  };
  const MockEngineClient = vi.fn(function () {
    return mockClient;
  });
  return { mockClient, MockEngineClient };
});

vi.mock('@engin/shared/engine-client', () => ({
  EngineClient: MockEngineClient,
}));

// ─── Location helper ───────────────────────────────────────────────────────

function setLocation(href: string): void {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    value: {
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    },
    writable: true,
    configurable: true,
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function runSummary(overrides?: Partial<RunSummary>): RunSummary {
  return {
    runId: 'run-1',
    cwd: '/tmp/work',
    workflowName: 'default',
    taskPrompt: 'do something',
    status: 'running',
    startedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function resetStore(): void {
  useWorkflowStore.setState({
    sessionsById: {},
    tasksById: {},
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    sidebar: { title: '', indicator: '' },
    status: 'running',
    taskPrompt: '',
    error: undefined,
    failedPhase: undefined,
    seq: 0,
    stats: { totalTokens: 0, sessionCount: 0 },
    workflowEventLog: [],
    selectedPhaseId: null,
    selectedTaskId: null,
    userPinnedPhase: false,
    runs: [],
    selectedRunId: null,
    runLogs: {},
  });
}

/** Grab the most recent callbacks object handed to EngineClient.connect(). */
function getCallbacks(): EngineClientCallbacks {
  expect(mockClient.connect).toHaveBeenCalled();
  const calls = mockClient.connect.mock.calls as unknown as Array<[EngineClientCallbacks]>;
  return calls.at(-1)![0];
}

/** Read the options object passed to the Nth `new EngineClient(...)` call. */
function ctorOptions(index = 0): { url: string } {
  const calls = MockEngineClient.mock.calls as unknown as Array<[{ url: string }]>;
  return calls[index][0];
}

/** Drive the hook's onMessage handler as if EngineClient delivered a message. */
function deliverMessage(msg: ServerMessage): void {
  act(() => {
    getCallbacks().onMessage(msg);
  });
}

function deliverConnected(): void {
  act(() => {
    getCallbacks().onConnected?.();
  });
}

function deliverDisconnected(): void {
  act(() => {
    getCallbacks().onDisconnected?.();
  });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setLocation('http://localhost:5173');
  delete (window as any).__WS_ENDPOINT__;
  resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStore();
});

// ─── EngineClient wiring ──────────────────────────────────────────────────

describe('useWebSocket adapter – EngineClient wiring', () => {
  it('instantiates the shared EngineClient from @engin/shared/engine-client', () => {
    renderHook(() => useWebSocket());
    expect(MockEngineClient).toHaveBeenCalledTimes(1);
  });

  it('derives the ws:// URL from http:// window.location', () => {
    setLocation('http://localhost:5173');
    renderHook(() => useWebSocket());
    expect(ctorOptions().url).toBe('ws://localhost:5173/ws');
  });

  it('derives the wss:// URL from https:// window.location', () => {
    setLocation('https://example.com:3619');
    renderHook(() => useWebSocket());
    expect(ctorOptions().url).toBe('wss://example.com:3619/ws');
  });

  it('uses __WS_ENDPOINT__ when it is a real URL', () => {
    (window as any).__WS_ENDPOINT__ = 'ws://my-server:9999/ws';
    renderHook(() => useWebSocket());
    expect(ctorOptions().url).toBe('ws://my-server:9999/ws');
  });

  it('ignores the {{WS_ENDPOINT}} placeholder and falls back to location', () => {
    (window as any).__WS_ENDPOINT__ = '{{WS_ENDPOINT}}';
    renderHook(() => useWebSocket());
    expect(ctorOptions().url).toBe('ws://localhost:5173/ws');
  });

  it('does not construct a WebSocket directly (transport lives in EngineClient)', () => {
    // If the hook ever re-introduced inline WS management, constructing a
    // socket would throw here — proving all transport is delegated.
    const original = globalThis.WebSocket;
    (globalThis as any).WebSocket = vi.fn(() => {
      throw new Error('useWebSocket must not construct a WebSocket directly');
    });
    try {
      expect(() => renderHook(() => useWebSocket())).not.toThrow();
      expect((globalThis as any).WebSocket).not.toHaveBeenCalled();
    } finally {
      globalThis.WebSocket = original;
    }
  });
});

// ─── Singleton sharing ────────────────────────────────────────────────────

describe('useWebSocket adapter – module-level singleton', () => {
  it('shares a single EngineClient instance across multiple concurrent consumers', () => {
    renderHook(() => useWebSocket());
    renderHook(() => useWebSocket());
    renderHook(() => useWebSocket());

    expect(MockEngineClient).toHaveBeenCalledTimes(1);
  });

  it('calls EngineClient.connect exactly once for multiple consumers', () => {
    renderHook(() => useWebSocket());
    renderHook(() => useWebSocket());

    expect(mockClient.connect).toHaveBeenCalledTimes(1);
  });
});

// ─── Ref-counted acquire / release ────────────────────────────────────────

describe('useWebSocket adapter – ref-counted acquire/release', () => {
  it('connects on the first mount', () => {
    renderHook(() => useWebSocket());
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.disconnect).not.toHaveBeenCalled();
  });

  it('does NOT connect again for additional mounts', () => {
    renderHook(() => useWebSocket());
    renderHook(() => useWebSocket());

    expect(mockClient.connect).toHaveBeenCalledTimes(1);
  });

  it('disconnects when the last consumer unmounts', () => {
    const { unmount } = renderHook(() => useWebSocket());
    expect(mockClient.disconnect).not.toHaveBeenCalled();

    unmount();
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does NOT disconnect while consumers remain', () => {
    const { unmount: unmountFirst } = renderHook(() => useWebSocket());
    renderHook(() => useWebSocket());

    unmountFirst();
    expect(mockClient.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects only when the final remaining consumer unmounts', () => {
    const { unmount: unmountFirst } = renderHook(() => useWebSocket());
    const { unmount: unmountSecond } = renderHook(() => useWebSocket());

    unmountFirst();
    expect(mockClient.disconnect).not.toHaveBeenCalled();

    unmountSecond();
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh EngineClient after full teardown then a new mount', () => {
    const { unmount } = renderHook(() => useWebSocket());
    unmount();
    expect(MockEngineClient).toHaveBeenCalledTimes(1);

    renderHook(() => useWebSocket());
    expect(MockEngineClient).toHaveBeenCalledTimes(2);
    expect(mockClient.connect).toHaveBeenCalledTimes(2);
  });

  it('passes onMessage / onConnected / onDisconnected callbacks to connect', () => {
    renderHook(() => useWebSocket());
    const callbacks = getCallbacks();
    expect(typeof callbacks.onMessage).toBe('function');
    expect(typeof callbacks.onConnected).toBe('function');
    expect(typeof callbacks.onDisconnected).toBe('function');
  });
});

// ─── Reactive connection state (useSyncExternalStore) ─────────────────────

describe('useWebSocket adapter – reactive connection state', () => {
  it('starts disconnected', () => {
    const { result } = renderHook(() => useWebSocket());
    expect(result.current.connected).toBe(false);
    expect(result.current.hasConnectedOnce).toBe(false);
  });

  it('sets connected=true and hasConnectedOnce=true on onConnected', () => {
    const { result } = renderHook(() => useWebSocket());
    deliverConnected();
    expect(result.current.connected).toBe(true);
    expect(result.current.hasConnectedOnce).toBe(true);
  });

  it('sets connected=false on onDisconnected', () => {
    const { result } = renderHook(() => useWebSocket());
    deliverConnected();
    deliverDisconnected();
    expect(result.current.connected).toBe(false);
  });

  it('latches hasConnectedOnce across a transient disconnect', () => {
    const { result } = renderHook(() => useWebSocket());
    deliverConnected();
    expect(result.current.hasConnectedOnce).toBe(true);

    deliverDisconnected();
    expect(result.current.connected).toBe(false);
    expect(result.current.hasConnectedOnce).toBe(true);
  });

  it('reflects connected transitions across multiple open/close cycles', () => {
    const { result } = renderHook(() => useWebSocket());

    deliverConnected();
    expect(result.current.connected).toBe(true);

    deliverDisconnected();
    expect(result.current.connected).toBe(false);

    deliverConnected();
    expect(result.current.connected).toBe(true);
  });

  it('reflects connected state across consumers (shared singleton)', () => {
    const { result: first } = renderHook(() => useWebSocket());
    const { result: second } = renderHook(() => useWebSocket());

    deliverConnected();
    expect(first.current.connected).toBe(true);
    expect(second.current.connected).toBe(true);
  });
});

// ─── Message routing: onMessage → zustand store ───────────────────────────

describe('useWebSocket adapter – message routing', () => {
  it('runs → store.setRuns', () => {
    renderHook(() => useWebSocket());
    deliverMessage({
      type: 'runs',
      runs: [runSummary({ runId: 'a' }), runSummary({ runId: 'b' })],
    });
    expect(useWorkflowStore.getState().runs.map((r) => r.runId)).toEqual(['a', 'b']);
  });

  it('run_started → store.addRun', () => {
    renderHook(() => useWebSocket());
    deliverMessage({
      type: 'run_started',
      runId: 'run-99',
      summary: runSummary({ runId: 'run-99', taskPrompt: 'new run' }),
    });
    const runs = useWorkflowStore.getState().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('run-99');
    expect(runs[0].taskPrompt).toBe('new run');
  });

  it('snapshot → store.applySnapshot for the selected run', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    deliverMessage({
      type: 'snapshot',
      runId: 'run-1',
      seq: 10,
      state: {
        seq: 10,
        taskPrompt: 'hello',
        phases: [],
        currentPhaseId: 'exec',
        completedPhaseIds: [],
        tasks: {},
        sessions: {},
        sidebar: { title: 'App', indicator: 'green' },
        status: 'running',
        stats: { totalTokens: 0, sessionCount: 0 },
        runLog: [],
      },
    });
    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('hello');
    expect(s.seq).toBe(10);
  });

  it('snapshot is ignored for a non-selected run (gated by selectedRunId)', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    deliverMessage({
      type: 'snapshot',
      runId: 'run-other',
      seq: 10,
      state: {
        seq: 10,
        taskPrompt: 'hello',
        phases: [],
        currentPhaseId: 'exec',
        completedPhaseIds: [],
        tasks: {},
        sessions: {},
        sidebar: { title: '', indicator: '' },
        status: 'running',
        stats: { totalTokens: 0, sessionCount: 0 },
        runLog: [],
      },
    });
    expect(useWorkflowStore.getState().seq).toBe(0);
  });

  it('events → store.applyEvents for the selected run', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    deliverMessage({
      type: 'events',
      runId: 'run-1',
      seq: 1,
      events: [{ seq: 1, type: 'workflow_started', data: { taskPrompt: 'test' }, metadata: { timestamp: '' } }],
    });
    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('test');
    expect(s.seq).toBe(1);
  });

  it('events are ignored for a non-selected run (gated by selectedRunId)', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    deliverMessage({
      type: 'events',
      runId: 'run-other',
      seq: 1,
      events: [{ seq: 1, type: 'workflow_started', data: { taskPrompt: 'x' }, metadata: { timestamp: '' } }],
    });
    expect(useWorkflowStore.getState().seq).toBe(0);
  });

  it('run_complete → store.setStatus(runId, complete) for the selected run', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    deliverMessage({ type: 'run_complete', runId: 'run-1' });
    expect(useWorkflowStore.getState().status).toBe('complete');
  });

  it('run_failed → store.setFailed for the selected run', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    deliverMessage({ type: 'run_failed', runId: 'run-1', error: 'boom', phase: 'exec' });
    const s = useWorkflowStore.getState();
    expect(s.status).toBe('failed');
    expect(s.error).toBe('boom');
    expect(s.failedPhase).toBe('exec');
  });

  it('log → store.appendRunLog', () => {
    renderHook(() => useWebSocket());
    deliverMessage({
      type: 'log',
      runId: 'run-1',
      level: 'warn',
      message: 'odd',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    const logs = useWorkflowStore.getState().runLogs['run-1'];
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({ level: 'warn', message: 'odd', timestamp: '2025-01-01T00:00:00.000Z' });
  });

  it('error → console.error', () => {
    renderHook(() => useWebSocket());
    deliverMessage({ type: 'error', code: 'unknown_run', message: 'no such run' });
    expect(console.error).toHaveBeenCalled();
  });

  it('auth_required is handled without mutating store state', () => {
    renderHook(() => useWebSocket());
    const before = useWorkflowStore.getState().seq;
    deliverMessage({ type: 'auth_required' });
    expect(useWorkflowStore.getState().seq).toBe(before);
  });

  it('does not crash on an unrecognized message type', () => {
    renderHook(() => useWebSocket());
    expect(() => deliverMessage({ type: 'bogus_type' } as unknown as ServerMessage)).not.toThrow();
    expect(useWorkflowStore.getState().seq).toBe(0);
  });
});

// ─── Delegation: send / subscribe / unsubscribe / resync ──────────────────

describe('useWebSocket adapter – delegation to EngineClient', () => {
  it('exposes send, subscribe, unsubscribe, and resync', () => {
    const { result } = renderHook(() => useWebSocket());
    expect(typeof result.current.send).toBe('function');
    expect(typeof result.current.subscribe).toBe('function');
    expect(typeof result.current.unsubscribe).toBe('function');
    expect(typeof result.current.resync).toBe('function');
  });

  it('send delegates the message straight to engineClient.send', () => {
    const { result } = renderHook(() => useWebSocket());
    const msg: ClientMessage = { type: 'cancel_run', runId: 'run-1' };
    result.current.send(msg);
    expect(mockClient.send).toHaveBeenCalledWith(msg);
  });

  it('subscribe delegates to engineClient.subscribe', () => {
    const { result } = renderHook(() => useWebSocket());
    result.current.subscribe('run-1');
    expect(mockClient.subscribe).toHaveBeenCalledWith('run-1');
  });

  it('subscribe also requests a catch-up resync carrying the current seq', () => {
    useWorkflowStore.setState({ seq: 42 });
    const { result } = renderHook(() => useWebSocket());
    result.current.subscribe('run-1');
    expect(mockClient.resync).toHaveBeenCalledWith('run-1', 42);
  });

  it('unsubscribe delegates to engineClient.unsubscribe', () => {
    const { result } = renderHook(() => useWebSocket());
    result.current.unsubscribe('run-1');
    expect(mockClient.unsubscribe).toHaveBeenCalledWith('run-1');
  });

  it('resync delegates to engineClient.resync with lastSeq', () => {
    const { result } = renderHook(() => useWebSocket());
    result.current.resync('run-1', 7);
    expect(mockClient.resync).toHaveBeenCalledWith('run-1', 7);
  });

  it('resync delegates without lastSeq when omitted', () => {
    const { result } = renderHook(() => useWebSocket());
    result.current.resync('run-1');
    expect(mockClient.resync).toHaveBeenCalledWith('run-1', undefined);
  });
});

// ─── send is a safe no-op once the client is torn down ────────────────────

describe('useWebSocket adapter – send without an active client', () => {
  it('send is a no-op after the client is torn down (optional chaining)', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    unmount();
    // After teardown engineClient is null; send must not throw or send.
    expect(() => result.current.send({ type: 'cancel_run', runId: 'run-1' })).not.toThrow();
    expect(mockClient.send).not.toHaveBeenCalled();
  });
});
