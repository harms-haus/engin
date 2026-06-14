/**
 * useWebSocket transport tests.
 *
 * Verifies:
 * - URL derivation (http→ws, https→wss, __WS_ENDPOINT__)
 * - Connection state (connected true/false)
 * - Exponential backoff reconnect
 * - Cleanup on unmount (no reconnect after unmount, pending timer cancelled)
 * - Snapshot → store.applySnapshot
 * - Events → store.applyEvents
 * - workflow_complete → store.setStatus('complete')
 * - workflow_failed → store.setStatus('failed')
 * - Resync sent on (re)connect with current seq
 * - send() queues JSON when socket is OPEN
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// ─── Reset store between tests ─────────────────────────────────────────────

function resetStore(): void {
  useWorkflowStore.setState({
    agentsById: {},
    tasksById: {},
    currentPhase: '',
    completedPhases: [],
    sidebar: { title: '', indicator: '' },
    status: 'running',
    taskPrompt: '',
    error: undefined,
    failedPhase: undefined,
    seq: 0,
    stats: { totalTokens: 0, agentCount: 0 },
    workflowEventLog: [],
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

// ─── URL derivation ────────────────────────────────────────────────────────

describe('useWebSocket – URL derivation', () => {
  it('derives ws:// URL from http:// window.location', () => {
    setLocation('http://localhost:5173');
    renderHook(() => useWebSocket());
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:5173/ws');
  });

  it('derives wss:// URL from https:// window.location', () => {
    setLocation('https://example.com:3619');
    renderHook(() => useWebSocket());
    expect(MockWebSocket.instances[0].url).toBe('wss://example.com:3619/ws');
  });

  it('ignores the {{WS_ENDPOINT}} placeholder', () => {
    (window as any).__WS_ENDPOINT__ = '{{WS_ENDPOINT}}';
    renderHook(() => useWebSocket());
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:5173/ws');
  });

  it('uses __WS_ENDPOINT__ when it is a real URL', () => {
    (window as any).__WS_ENDPOINT__ = 'ws://my-server:9999/ws';
    renderHook(() => useWebSocket());
    expect(MockWebSocket.instances[0].url).toBe('ws://my-server:9999/ws');
  });
});

// ─── Singleton connection (no duplication) ──────────────────────────────────

describe('useWebSocket – singleton connection', () => {
  it('shares a single connection across multiple concurrent callers', () => {
    // Two components consuming the hook must NOT open two sockets — otherwise
    // every event is applied twice (doubled agent-log entries).
    renderHook(() => useWebSocket());
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].sentMessages).toHaveLength(1);
  });

  it('does not duplicate event application across concurrent callers', () => {
    renderHook(() => useWebSocket());
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'events',
        seq: 1,
        events: [{ seq: 1, type: 'workflow_started', data: { taskPrompt: 'x' }, metadata: { timestamp: '' } }],
      });
    });

    // A single workflow_started event must produce exactly one event-log line,
    // not two (which would happen if two sockets each applied it).
    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(1);
  });

  it('creates a fresh connection when the last consumer unmounts and a new one mounts', () => {
    const { unmount: unmountFirst } = renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    // Last consumer gone → teardown.
    unmountFirst();
    expect(MockWebSocket.instances).toHaveLength(1);

    // A new consumer starts fresh.
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
});

// ─── Resync on connect ────────────────────────────────────────────────────

describe('useWebSocket – resync', () => {
  it('sends resync with lastSeq=0 on initial connect', () => {
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    const ws = MockWebSocket.instances[0];
    expect(ws.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe('resync');
    expect(msg.lastSeq).toBe(0);
  });

  it('sends resync with current seq on reconnect', async () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket());

    // Open initial connection
    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Advance the store seq
    act(() => {
      useWorkflowStore
        .getState()
        .applyEvents([{ seq: 5, type: 'workflow_started', data: { taskPrompt: 'x' }, metadata: { timestamp: '' } }]);
    });
    expect(useWorkflowStore.getState().seq).toBe(5);

    // Close → triggers reconnect
    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });

    // Wait for backoff
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Open the new connection
    act(() => {
      MockWebSocket.simulateOpen(MockWebSocket.instances[1]);
    });

    // The second ws should have sent resync with lastSeq=5
    const ws2 = MockWebSocket.instances[1];
    expect(ws2.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws2.sentMessages[0]);
    expect(msg.type).toBe('resync');
    expect(msg.lastSeq).toBe(5);

    vi.useRealTimers();
  });
});

// ─── Store integration ────────────────────────────────────────────────────

describe('useWebSocket – snapshot → store', () => {
  it('applies snapshot to the store', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'snapshot',
        seq: 10,
        state: {
          seq: 10,
          taskPrompt: 'hello',
          currentPhase: 'exec',
          completedPhases: ['plan'],
          tasks: {},
          agents: {},
          sidebar: { title: 'App', indicator: 'green' },
          status: 'running',
          stats: { totalTokens: 0, agentCount: 0 },
        },
      });
    });

    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('hello');
    expect(s.currentPhase).toBe('exec');
    expect(s.completedPhases).toEqual(['plan']);
    expect(s.seq).toBe(10);
  });
});

describe('useWebSocket – events → store', () => {
  it('applies events to the store', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'events',
        seq: 3,
        events: [
          { seq: 1, type: 'workflow_started', data: { taskPrompt: 'test' }, metadata: { timestamp: '' } },
          { seq: 2, type: 'phase_started', data: { phase: 'scouting' }, metadata: { timestamp: '' } },
          {
            seq: 3,
            type: 'agent_spawned',
            data: { profile: 'coder' },
            metadata: { timestamp: '', agentId: 'a1', taskId: 't1' },
          },
        ],
      });
    });

    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('test');
    expect(s.currentPhase).toBe('scouting');
    expect(s.agentsById['a1::t1']).toBeDefined();
    expect(s.seq).toBe(3);
  });
});

describe('useWebSocket – workflow_complete → store', () => {
  it('sets store status to complete', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({ type: 'workflow_complete' });
    });

    expect(useWorkflowStore.getState().status).toBe('complete');
  });
});

describe('useWebSocket – workflow_failed → store', () => {
  it('sets store status to failed', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({ type: 'workflow_failed', error: 'boom', phase: 'exec' });
    });

    expect(useWorkflowStore.getState().status).toBe('failed');
  });
});

describe('useWebSocket – ignores non-server messages', () => {
  it('does not crash on unrecognized message types', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Should not throw
    act(() => {
      MockWebSocket.simulateMessage({ type: 'bogus_type', foo: 'bar' });
    });

    // Store should be unchanged
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

    // Close 1 → 1000ms
    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Close 2 → 1500ms (1000 * 1.5)
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

    // Close → reconnect (1000ms)
    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Open successfully
    act(() => {
      MockWebSocket.simulateOpen(MockWebSocket.instances[1]);
    });

    // Close again → should be 1000ms again (reset)
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

    result.current.send({ type: 'terminate_server' });
    expect(MockWebSocket.instances[0].sentMessages).toContain(JSON.stringify({ type: 'terminate_server' }));
  });

  it('does not send when socket is not OPEN', () => {
    const { result } = renderHook(() => useWebSocket());

    result.current.send({ type: 'terminate_server' });
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

// ─── No console.log/warn in useWebSocket ───────────────────────────────────

describe('useWebSocket – no diagnostic logging', () => {
  it('does not call console.log', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });
    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });

    // No console.log calls from useWebSocket (store may log internally, but
    // the transport itself should be silent).
    const transportLogs = (console.log as ReturnType<typeof vi.spyOn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].startsWith('[WebSocket]'),
    );
    expect(transportLogs).toHaveLength(0);
  });

  it('does not call console.warn', () => {
    renderHook(() => useWebSocket());
    act(() => {
      MockWebSocket.simulateOpen();
    });
    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });

    const transportWarns = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].startsWith('[WebSocket]'),
    );
    expect(transportWarns).toHaveLength(0);
  });
});
