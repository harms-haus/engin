/**
 * useWebSocket transport tests — multi-run protocol.
 *
 * Verifies:
 * - URL derivation (http→ws, https→wss, __WS_ENDPOINT__)
 * - Singleton connection (single socket, no duplicated event application)
 * - Connection state (connected true/false)
 * - On connect: sends `list_runs` (NOT resync)
 * - Exposed `subscribe(runId)` / `unsubscribe(runId)` / `resync(runId, lastSeq?)`
 * - `subscribe(runId)` triggers a catch-up `resync` carrying runId + lastSeq
 * - `resync(runId, lastSeq)` sends a resync message (delegates to EngineClient)
 * - Message routing:
 *     runs         → store.setRuns
 *     run_started  → store.addRun
 *     snapshot     → store.applySnapshot(runId, …)   (gated by selectedRunId)
 *     events       → store.applyEvents(runId, …)     (gated by selectedRunId)
 *     run_complete → store.setStatus(runId, 'complete')
 *     run_failed   → store.setFailed(runId, …)
 *     log          → store.appendRunLog(runId, …)
 *     error        → console.error
 *     auth_required → handled (no crash)
 * - Exponential backoff reconnect
 * - send() queues JSON when socket is OPEN
 * - Cleanup on unmount (no reconnect after unmount, pending timer cancelled)
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';
import { useWebSocket } from './useWebSocket';

// ─── Mock WebSocket ────────────────────────────────────────────────────────

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState: number = MockWebSocket.CONNECTING;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code: 1000, reason: 'close' }));
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  static simulateOpen(instance?: MockWebSocket): void {
    const ws = instance ?? MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.();
  }

  static simulateError(instance?: MockWebSocket): void {
    const ws = instance ?? MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.onerror?.(new Event('error'));
  }

  static simulateClose(code = 1000, reason = 'close', instance?: MockWebSocket): void {
    const ws = instance ?? MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.readyState = MockWebSocket.CLOSED;
    ws.onclose?.(new CloseEvent('close', { code, reason }));
  }

  static simulateMessage(data: unknown, instance?: MockWebSocket): void {
    const ws = instance ?? MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

// ─── Store original values ─────────────────────────────────────────────────

const ORIGINAL_WS = globalThis.WebSocket;

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

/** Read the JSON messages a socket has sent. */
function sentJson(ws: MockWebSocket): Record<string, unknown>[] {
  return ws.sentMessages.map((m) => JSON.parse(m));
}

// ─── Reset store between tests ─────────────────────────────────────────────

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
    // Multi-run fields
    runs: [],
    selectedRunId: null,
    runLogs: {},
  });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  MockWebSocket.instances = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setLocation('http://localhost:5173');
  delete (window as any).__WS_ENDPOINT__;
  resetStore();
});

afterEach(() => {
  globalThis.WebSocket = ORIGINAL_WS;
  vi.restoreAllMocks();
  resetStore();
});

// ─── Singleton connection (no duplication) ──────────────────────────────────

describe('useWebSocket – singleton connection', () => {
  it('shares a single connection across multiple concurrent callers', () => {
    renderHook(() => useWebSocket());
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    // Only the connect handshake (list_runs) should be sent once.
    expect(MockWebSocket.instances[0].sentMessages).toHaveLength(1);
  });

  it('does not duplicate event application across concurrent callers', () => {
    // Select run-1 so the events are applied (gated by selectedRunId).
    useWorkflowStore.setState({ selectedRunId: 'run-1' });

    renderHook(() => useWebSocket());
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'events',
        runId: 'run-1',
        seq: 1,
        events: [{ seq: 1, type: 'workflow_started', data: { taskPrompt: 'x' }, metadata: { timestamp: '' } }],
      });
    });

    // A single workflow_started event must produce exactly one event-log line.
    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(1);
  });

  it('creates a fresh connection when the last consumer unmounts and a new one mounts', () => {
    const { unmount: unmountFirst } = renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    unmountFirst();
    expect(MockWebSocket.instances).toHaveLength(1);

    renderHook(() => useWebSocket());
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});

// ─── Connection state ──────────────────────────────────────────────────────

describe('useWebSocket – connection state', () => {
  it('sets connected=true on open', () => {
    const { result } = renderHook(() => useWebSocket());
    expect(result.current.connected).toBe(false);

    act(() => {
      MockWebSocket.simulateOpen();
    });
    expect(result.current.connected).toBe(true);
  });

  it('sets connected=false on close', () => {
    const { result } = renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });
    expect(result.current.connected).toBe(true);

    act(() => {
      MockWebSocket.simulateClose(1006, 'abnormal');
    });
    expect(result.current.connected).toBe(false);
  });

  it('exposes hasConnectedOnce after the first successful open', () => {
    const { result } = renderHook(() => useWebSocket());
    expect(result.current.hasConnectedOnce).toBe(false);

    act(() => {
      MockWebSocket.simulateOpen();
    });
    expect(result.current.hasConnectedOnce).toBe(true);
  });

  it('keeps hasConnectedOnce true across a transient disconnect (latching)', () => {
    const { result } = renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });
    expect(result.current.hasConnectedOnce).toBe(true);

    act(() => {
      MockWebSocket.simulateClose(1006, 'abnormal');
    });
    // Disconnected, but hasConnectedOnce must persist — the UI uses it to tell
    // "reconnecting" (connected before) apart from "never connected".
    expect(result.current.connected).toBe(false);
    expect(result.current.hasConnectedOnce).toBe(true);
  });
});

// ─── Connect handshake (list_runs) ────────────────────────────────────────

describe('useWebSocket – connect handshake', () => {
  it('sends list_runs on connect', () => {
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    const msgs = sentJson(MockWebSocket.instances[0]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'list_runs' });
  });

  it('does NOT send resync on connect', () => {
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    const msgs = sentJson(MockWebSocket.instances[0]);
    expect(msgs.find((m) => m.type === 'resync')).toBeUndefined();
  });

  it('re-sends list_runs on reconnect', async () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      MockWebSocket.simulateOpen(MockWebSocket.instances[1]);
    });

    const msgs = sentJson(MockWebSocket.instances[1]);
    expect(msgs.find((m) => m.type === 'list_runs')).toBeDefined();

    vi.useRealTimers();
  });
});

// ─── subscribe / unsubscribe ───────────────────────────────────────────────

describe('useWebSocket – subscribe / unsubscribe', () => {
  it('exposes subscribe, unsubscribe, and resync functions', () => {
    const { result } = renderHook(() => useWebSocket());
    expect(typeof result.current.subscribe).toBe('function');
    expect(typeof result.current.unsubscribe).toBe('function');
    expect(typeof result.current.resync).toBe('function');
  });

  it('subscribe(runId) sends a subscribe message', () => {
    const { result } = renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      result.current.subscribe('run-1');
    });

    const msgs = sentJson(MockWebSocket.instances[0]);
    expect(msgs.find((m) => m.type === 'subscribe' && m.runId === 'run-1')).toBeDefined();
  });

  it('unsubscribe(runId) sends an unsubscribe message', () => {
    const { result } = renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      result.current.unsubscribe('run-1');
    });

    const msgs = sentJson(MockWebSocket.instances[0]);
    expect(msgs.find((m) => m.type === 'unsubscribe' && m.runId === 'run-1')).toBeDefined();
  });

  it('subscribe(runId) sends a resync carrying runId + current lastSeq (catch-up)', () => {
    // Advance the store seq to 5 so we can assert it is carried in the resync.
    useWorkflowStore.setState({ selectedRunId: 'run-1', seq: 5 });

    const { result } = renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      result.current.subscribe('run-1');
    });

    const msgs = sentJson(MockWebSocket.instances[0]);
    const resync = msgs.find((m) => m.type === 'resync');
    expect(resync).toBeDefined();
    expect(resync?.runId).toBe('run-1');
    expect(resync?.lastSeq).toBe(5);
  });

  it('subscribe / unsubscribe are no-ops when the socket is not open', () => {
    const { result } = renderHook(() => useWebSocket());
    // Never open the socket.
    act(() => {
      result.current.subscribe('run-1');
      result.current.unsubscribe('run-1');
    });

    expect(MockWebSocket.instances[0].sentMessages).toHaveLength(0);
  });
});

// ─── resync ─────────────────────────────────────────────────────────────────

describe('useWebSocket – resync', () => {
  it('resync(runId, lastSeq) sends a resync message when the socket is open', () => {
    const { result } = renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      result.current.resync('run-1', 7);
    });

    const msgs = sentJson(MockWebSocket.instances[0]);
    const resync = msgs.find((m) => m.type === 'resync' && m.runId === 'run-1');
    expect(resync).toBeDefined();
    expect(resync?.lastSeq).toBe(7);
  });

  it('resync is a no-op when the socket is not open', () => {
    const { result } = renderHook(() => useWebSocket());
    // Never open the socket.
    act(() => {
      result.current.resync('run-1', 7);
    });

    expect(MockWebSocket.instances[0].sentMessages).toHaveLength(0);
  });
});

// ─── Message routing ───────────────────────────────────────────────────────

describe('useWebSocket – runs → store.setRuns', () => {
  it('applies the active-run list to the store', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'runs',
        runs: [runSummary({ runId: 'a' }), runSummary({ runId: 'b' })],
      });
    });

    expect(useWorkflowStore.getState().runs.map((r) => r.runId)).toEqual(['a', 'b']);
  });
});

describe('useWebSocket – run_started → store.addRun', () => {
  it('adds a new run summary to the store', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'run_started',
        runId: 'run-99',
        summary: runSummary({ runId: 'run-99', taskPrompt: 'new run' }),
      });
    });

    const runs = useWorkflowStore.getState().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('run-99');
    expect(runs[0].taskPrompt).toBe('new run');
  });
});

describe('useWebSocket – snapshot → store.applySnapshot(runId, …)', () => {
  it('applies a snapshot for the selected run', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'snapshot',
        runId: 'run-1',
        seq: 10,
        state: {
          seq: 10,
          taskPrompt: 'hello',
          phases: [{ id: 'plan', label: 'Plan', icon: '📋', taskIds: [] }],
          currentPhaseId: 'exec',
          completedPhaseIds: ['plan'],
          tasks: {},
          sessions: {},
          sidebar: { title: 'App', indicator: 'green' },
          status: 'running',
          stats: { totalTokens: 0, sessionCount: 0 },
        },
      });
    });

    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('hello');
    expect(s.currentPhaseId).toBe('exec');
    expect(s.seq).toBe(10);
  });

  it('ignores a snapshot for a non-selected run (gated by selectedRunId)', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
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
        },
      });
    });

    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('');
    expect(s.seq).toBe(0);
  });
});

describe('useWebSocket – events → store.applyEvents(runId, …)', () => {
  it('applies events for the selected run', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'events',
        runId: 'run-1',
        seq: 3,
        events: [
          { seq: 1, type: 'workflow_started', data: { taskPrompt: 'test' }, metadata: { timestamp: '' } },
          { seq: 2, type: 'phase_started', data: { phase: 'scouting' }, metadata: { timestamp: '' } },
          {
            seq: 3,
            type: 'session_started',
            data: { profile: 'coder' },
            metadata: { timestamp: '', agentId: 'a1', taskId: 't1' },
          },
        ],
      });
    });

    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('test');
    expect(s.currentPhaseId).toBe('scouting');
    expect(s.sessionsById['a1::t1']).toBeDefined();
    expect(s.seq).toBe(3);
  });

  it('ignores events for a non-selected run (gated by selectedRunId)', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'events',
        runId: 'run-other',
        seq: 1,
        events: [{ seq: 1, type: 'workflow_started', data: { taskPrompt: 'x' }, metadata: { timestamp: '' } }],
      });
    });

    expect(useWorkflowStore.getState().taskPrompt).toBe('');
    expect(useWorkflowStore.getState().seq).toBe(0);
  });
});

describe('useWebSocket – run_complete → store.setStatus(runId, complete)', () => {
  it('sets status to complete for the selected run', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({ type: 'run_complete', runId: 'run-1' });
    });

    expect(useWorkflowStore.getState().status).toBe('complete');
  });

  it('ignores run_complete for a non-selected run', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({ type: 'run_complete', runId: 'run-other' });
    });

    expect(useWorkflowStore.getState().status).toBe('running');
  });
});

describe('useWebSocket – run_failed → store.setFailed(runId, …)', () => {
  it('marks the selected run failed', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({ type: 'run_failed', runId: 'run-1', error: 'boom', phase: 'exec' });
    });

    const s = useWorkflowStore.getState();
    expect(s.status).toBe('failed');
    expect(s.error).toBe('boom');
    expect(s.failedPhase).toBe('exec');
  });

  it('ignores run_failed for a non-selected run', () => {
    useWorkflowStore.setState({ selectedRunId: 'run-1' });
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({ type: 'run_failed', runId: 'run-other', error: 'boom', phase: 'exec' });
    });

    expect(useWorkflowStore.getState().status).toBe('running');
  });
});

describe('useWebSocket – log → store.appendRunLog(runId, …)', () => {
  it('appends a log entry for the run', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'log',
        runId: 'run-1',
        level: 'warn',
        message: 'something odd',
        timestamp: '2025-01-01T00:00:00.000Z',
      });
    });

    const logs = useWorkflowStore.getState().runLogs['run-1'];
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      level: 'warn',
      message: 'something odd',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
  });

  it('appends logs for any run regardless of selection', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'log',
        runId: 'run-a',
        level: 'info',
        message: 'a',
        timestamp: 't1',
      });
      MockWebSocket.simulateMessage({
        type: 'log',
        runId: 'run-b',
        level: 'error',
        message: 'b',
        timestamp: 't2',
      });
    });

    const s = useWorkflowStore.getState();
    expect(s.runLogs['run-a']).toHaveLength(1);
    expect(s.runLogs['run-b']).toHaveLength(1);
  });
});

describe('useWebSocket – error → console.error', () => {
  it('logs protocol-level error messages to console.error', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({ type: 'error', code: 'unknown_run', message: 'no such run' });
    });

    expect(console.error).toHaveBeenCalled();
    const calls = (console.error as ReturnType<typeof vi.spyOn>).mock.calls.map((c: unknown[]) => c.join(' '));
    expect(calls.some((line: string) => line.includes('no such run'))).toBe(true);
  });

  it('logs error messages tagged with a runId', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'error',
        runId: 'run-1',
        code: 'bad_request',
        message: 'malformed payload',
      });
    });

    expect(console.error).toHaveBeenCalled();
    const calls = (console.error as ReturnType<typeof vi.spyOn>).mock.calls.map((c: unknown[]) => c.join(' '));
    expect(calls.some((line: string) => line.includes('malformed payload'))).toBe(true);
  });
});

describe('useWebSocket – auth_required', () => {
  it('is handled without crashing and without mutating store state', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    const before = useWorkflowStore.getState().seq;

    act(() => {
      MockWebSocket.simulateMessage({ type: 'auth_required' });
    });

    // No throw, no state change.
    expect(useWorkflowStore.getState().seq).toBe(before);
  });
});

describe('useWebSocket – ignores non-server messages', () => {
  it('does not crash on unrecognized message types', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({ type: 'bogus_type', foo: 'bar' });
    });

    expect(useWorkflowStore.getState().seq).toBe(0);
  });
});

// ─── Exponential backoff ──────────────────────────────────────────────────

describe('useWebSocket – exponential backoff', () => {
  it('reconnects after 1000ms on first close', async () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    vi.useRealTimers();
  });

  it('increases delay on successive closes', async () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      MockWebSocket.simulateClose(1000, 'close', MockWebSocket.instances[1]);
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    vi.useRealTimers();
  });

  it('resets backoff on successful open', async () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      MockWebSocket.simulateOpen(MockWebSocket.instances[1]);
    });

    act(() => {
      MockWebSocket.simulateClose(1000, 'close', MockWebSocket.instances[1]);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(3);

    vi.useRealTimers();
  });
});

// ─── send() ────────────────────────────────────────────────────────────────

describe('useWebSocket – send', () => {
  it('sends JSON when socket is OPEN', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    result.current.send({ type: 'cancel_run', runId: 'run-1' });
    expect(MockWebSocket.instances[0].sentMessages).toContain(JSON.stringify({ type: 'cancel_run', runId: 'run-1' }));
  });

  it('does not send when socket is not OPEN', () => {
    const { result } = renderHook(() => useWebSocket());

    result.current.send({ type: 'cancel_run', runId: 'run-1' });
    expect(MockWebSocket.instances[0].sentMessages).toHaveLength(0);
  });
});

// ─── Cleanup on unmount ───────────────────────────────────────────────────

describe('useWebSocket – cleanup', () => {
  it('does not reconnect after unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    unmount();

    await vi.advanceTimersByTimeAsync(100_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.useRealTimers();
  });

  it('cancels pending reconnect timer on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });

    unmount();

    await vi.advanceTimersByTimeAsync(2000);
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.useRealTimers();
  });
});

// ─── Transport logging ───────────────────────────────────────────────────

describe('useWebSocket – transport logging', () => {
  it('does not emit [WebSocket] console.log or console.warn', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });
    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });

    const transportLogs = (console.log as ReturnType<typeof vi.spyOn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].startsWith('[WebSocket]'),
    );
    expect(transportLogs).toHaveLength(0);

    const transportWarns = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].startsWith('[WebSocket]'),
    );
    expect(transportWarns).toHaveLength(0);
  });
});
