import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code: 1000, reason: 'close' }));
  }

  send(_data: string): void {
    // no-op
  }

  /** Simulate the server opening the connection. */
  static simulateOpen(instance?: MockWebSocket): void {
    const ws = instance ?? MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.();
  }

  /** Simulate a socket error. */
  static simulateError(instance?: MockWebSocket): void {
    const ws = instance ?? MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.onerror?.(new Event('error'));
  }

  /** Simulate the connection closing. */
  static simulateClose(code = 1000, reason = 'close', instance?: MockWebSocket): void {
    const ws = instance ?? MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.readyState = MockWebSocket.CLOSED;
    ws.onclose?.(new CloseEvent('close', { code, reason }));
  }

  /** Simulate receiving a message from the server. */
  static simulateMessage(data: unknown, instance?: MockWebSocket): void {
    const ws = instance ?? MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

// ─── Store original values so we can restore ───────────────────────────────

const ORIGINAL_WS = globalThis.WebSocket;

// ─── Location helpers ──────────────────────────────────────────────────────

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

// ─── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Replace global WebSocket with mock
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  MockWebSocket.instances = [];
  // Silence console noise during tests
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Default location
  setLocation('http://localhost:5173');
  // Ensure no leftover __WS_ENDPOINT__
  delete (window as any).__WS_ENDPOINT__;
});

afterEach(() => {
  globalThis.WebSocket = ORIGINAL_WS;
  vi.restoreAllMocks();
});

describe('useWebSocket – URL derivation', () => {
  it('derives ws:// URL when window.location.protocol is http:', () => {
    setLocation('http://localhost:5173');
    renderHook(() => useWebSocket());

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:5173/ws');
  });

  it('derives wss:// URL when window.location.protocol is https:', () => {
    setLocation('https://example.com:3619');
    renderHook(() => useWebSocket());

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('wss://example.com:3619/ws');
  });

  it('derives ws:// from http:// window.location even with port', () => {
    setLocation('http://localhost:3619');
    renderHook(() => useWebSocket());

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:3619/ws');
  });

  it('ignores the {{WS_ENDPOINT}} placeholder and falls back to window.location', () => {
    (window as any).__WS_ENDPOINT__ = '{{WS_ENDPOINT}}';
    setLocation('http://localhost:5173');
    renderHook(() => useWebSocket());

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:5173/ws');
  });

  it('uses a valid __WS_ENDPOINT__ when it is a real ws:// URL', () => {
    (window as any).__WS_ENDPOINT__ = 'ws://my-server:9999/ws';
    setLocation('http://localhost:5173'); // should be ignored
    renderHook(() => useWebSocket());

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://my-server:9999/ws');
  });

  it('uses a valid __WS_ENDPOINT__ when it is a real wss:// URL', () => {
    (window as any).__WS_ENDPOINT__ = 'wss://secure.example.com/ws';
    setLocation('http://localhost:5173');
    renderHook(() => useWebSocket());

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('wss://secure.example.com/ws');
  });
});

describe('useWebSocket – connection state and logging', () => {
  it('sets connected=true on open and resets backoff', () => {
    const { result } = renderHook(() => useWebSocket());

    expect(result.current.connected).toBe(false);
    expect(console.log).not.toHaveBeenCalled();

    act(() => {
      MockWebSocket.simulateOpen();
    });

    expect(result.current.connected).toBe(true);
    expect(console.log).toHaveBeenCalledWith('[WebSocket] Connected to', 'ws://localhost:5173/ws');
  });

  it('sets connected=false on close and logs a warning', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });
    expect(result.current.connected).toBe(true);

    act(() => {
      MockWebSocket.simulateClose(1006, 'abnormal');
    });

    expect(result.current.connected).toBe(false);
    expect(console.warn).toHaveBeenCalledWith('[WebSocket] Connection closed (code=%s reason=%s)', 1006, 'abnormal');
  });

  it('logs error on ws.onerror', () => {
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateError();
    });

    expect(console.error).toHaveBeenCalledWith('[WebSocket] Error', expect.any(Event));
  });
});

describe('useWebSocket – exponential backoff', () => {
  it('starts backoff at 1000ms and increases on each reconnect', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWebSocket());

    // Simulate first close → reconnect with 1000ms delay
    act(() => {
      MockWebSocket.simulateClose(1000, 'test close');
    });
    expect(result.current.connected).toBe(false);

    // First reconnect timer: 1000ms
    await vi.advanceTimersByTimeAsync(999);
    // Only one instance so far (the original connection)
    expect(MockWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    // Now a new WebSocket instance should have been created
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toBe('ws://localhost:5173/ws');

    // Simulate second close → next delay should be 1500ms (1000 * 1.5)
    act(() => {
      MockWebSocket.simulateClose(1000, 'test close', MockWebSocket.instances[1]);
    });

    await vi.advanceTimersByTimeAsync(1499);
    expect(MockWebSocket.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    vi.useRealTimers();
  });

  it('resets backoff on successful open after reconnect', async () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket());

    // Close once → backoff 1000ms → reconnect
    act(() => {
      MockWebSocket.simulateClose(1000, 'close');
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Open successfully → backoff resets to 1000ms
    act(() => {
      MockWebSocket.simulateOpen(MockWebSocket.instances[1]);
    });

    // Close again → delay should be 1000ms (reset), not 1500ms
    act(() => {
      MockWebSocket.simulateClose(1000, 'close', MockWebSocket.instances[1]);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(3);

    vi.useRealTimers();
  });

  it('caps backoff at 30000ms', async () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket());

    // Feed enough closes to push past the cap
    // sequence: 1000 → 1500 → 2250 → 3375 → 5062.5 → 7593.75 → 11390.625 → 17085.9375 → 25628.90625 → 30000
    for (let i = 0; i < 9; i++) {
      const instance = MockWebSocket.instances[i];
      act(() => {
        MockWebSocket.simulateClose(1000, 'close', instance);
      });
      // We need to advance time enough to trigger the reconnect
      // The delay is stored in backoffRef before multiplying
      // After each close, a new connect is scheduled
      // Let's just advance by a large amount to trigger all reconnects
    }
    // Advance enough time to get through all reconnects
    await vi.advanceTimersByTimeAsync(200_000);

    // After 9 consecutive closes, the backoff should be 30000
    // Each close creates a new WebSocket instance
    // We started with instance[0], closed it → reconnect → instance[1], etc.
    // After 9 closes, we should have 10 instances (original + 9 reconnects)
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(9);

    // Now close the latest instance and check that delay is capped
    const latest = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => {
      MockWebSocket.simulateClose(1000, 'close', latest);
    });

    // The delay should be 30000ms (capped), so after 29999ms no new connection
    await vi.advanceTimersByTimeAsync(29_999);
    const countAfterShortWait = MockWebSocket.instances.length;

    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances.length).toBe(countAfterShortWait + 1);

    vi.useRealTimers();
  });
});

describe('useWebSocket – send and message handling', () => {
  it('send() queues JSON when socket is OPEN', () => {
    const { result } = renderHook(() => useWebSocket());
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');

    // Socket not open yet → send should be a no-op
    result.current.send({ type: 'terminate_server' });
    expect(sendSpy).not.toHaveBeenCalled();

    // Open the socket
    act(() => {
      MockWebSocket.simulateOpen();
    });

    result.current.send({ type: 'terminate_server' });
    expect(sendSpy).toHaveBeenCalledWith(JSON.stringify({ type: 'terminate_server' }));
  });

  it('agent_stats updates an agent that was spawned with a taskId', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // 1. Spawn an agent with both agentId and taskId
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'agent_spawned',
        agent: {
          agentId: 'agent-1',
          taskId: 'task-42',
          profile: 'test',
          active: true,
          log: [],
        },
      });
    });

    // 2. Send stats with matching agentId and taskId
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'agent_stats',
        agentId: 'agent-1',
        taskId: 'task-42',
        toolCallCount: 3,
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    // 3. Verify the agent's counters were updated
    const agent = result.current.state.agents.get('agent-1::task-42');
    expect(agent).toBeDefined();
    expect(agent!.toolCallCount).toBe(3);
    expect(agent!.inputTokens).toBe(100);
    expect(agent!.outputTokens).toBe(50);
  });

  it('agent_stats without taskId still works for agents stored under plain key', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Spawn an agent without a taskId (plain key)
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'agent_spawned',
        agent: {
          agentId: 'agent-legacy',
          profile: 'legacy',
          active: true,
          log: [],
        },
      });
    });

    // Send stats without taskId
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'agent_stats',
        agentId: 'agent-legacy',
        toolCallCount: 5,
      });
    });

    const agent = result.current.state.agents.get('agent-legacy');
    expect(agent).toBeDefined();
    expect(agent!.toolCallCount).toBe(5);
  });
});
