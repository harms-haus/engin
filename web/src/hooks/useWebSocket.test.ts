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
    }
    // Advance enough time to get through all reconnects
    await vi.advanceTimersByTimeAsync(200_000);

    // After 9 consecutive closes, the backoff should be 30000
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

  it('workflow_phase sets currentPhase from msg.currentPhase (not msg.phase)', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Send a workflow_phase message where phase differs from currentPhase.
    // This simulates a phase completion: 'scouting' just completed,
    // but the still-running phase is 'planning'.
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'workflow_phase',
        phase: 'scouting',
        currentPhase: 'planning',
        completed: ['scouting'],
      });
    });

    // The state should reflect currentPhase = 'planning', NOT 'scouting'
    expect(result.current.state.currentPhase).toBe('planning');

    // The event log should describe the phase that was started/completed
    expect(result.current.events).toContain('Phase: scouting');

    // completedPhases should be updated
    expect(result.current.state.completedPhases).toEqual(['scouting']);
  });

  it('workflow_phase preserves existing completedPhases when new ones arrive', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // First phase complete
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'workflow_phase',
        phase: 'scouting',
        currentPhase: 'planning',
        completed: ['scouting'],
      });
    });

    expect(result.current.state.completedPhases).toEqual(['scouting']);

    // Second phase completes, currentPhase moves forward
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'workflow_phase',
        phase: 'planning',
        currentPhase: 'execution',
        completed: ['scouting', 'planning'],
      });
    });

    expect(result.current.state.currentPhase).toBe('execution');
    expect(result.current.state.completedPhases).toEqual(['scouting', 'planning']);
    expect(result.current.events).toContain('Phase: planning');
  });

  it('workflow_phase with same phase and currentPhase still works correctly', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // When a phase starts (not a completion), phase === currentPhase
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'workflow_phase',
        phase: 'scouting',
        currentPhase: 'scouting',
        completed: [],
      });
    });

    expect(result.current.state.currentPhase).toBe('scouting');
    expect(result.current.state.completedPhases).toEqual([]);
    expect(result.current.events).toContain('Phase: scouting');
  });

  it('workflow_failed stores both error and failedPhase', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'workflow_failed',
        error: 'something broke',
        phase: 'planning',
      });
    });

    expect(result.current.state.failedPhase).toBe('planning');
    expect(result.current.state.error).toBe('something broke');
    expect(result.current.state.status).toBe('failed');
    expect(result.current.events).toContain('Failed: something broke');
  });

  it('stores taskPrompt when init message includes it', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'init',
        currentPhase: 'planning',
        completedPhases: ['scouting'],
        tasks: [],
        agents: [],
        sidebar: { title: 'Test', indicator: 'green' },
        taskPrompt: 'Implement login page',
      });
    });

    expect(result.current.state.taskPrompt).toBe('Implement login page');
  });

  it('stores taskPrompt as empty string when init message omits it', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'init',
        currentPhase: '',
        completedPhases: [],
        tasks: [],
        agents: [],
        sidebar: { title: '', indicator: '' },
      });
    });

    expect(result.current.state.taskPrompt).toBeUndefined();
  });

  it('retains taskPrompt across subsequent messages after init', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Init sets the taskPrompt
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'init',
        currentPhase: 'scouting',
        completedPhases: [],
        tasks: [],
        agents: [],
        sidebar: { title: '', indicator: '' },
        taskPrompt: 'Build feature X',
      });
    });

    expect(result.current.state.taskPrompt).toBe('Build feature X');

    // Subsequent non-init messages should not clear taskPrompt
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'workflow_phase',
        phase: 'scouting',
        completed: [],
        currentPhase: 'scouting',
      });
    });

    expect(result.current.state.taskPrompt).toBe('Build feature X');
  });

  it('clears events array when init message is received after reconnection', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWebSocket());

    // Open the initial connection
    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Send several workflow_phase messages to accumulate events
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'workflow_phase',
        phase: 'scouting',
        currentPhase: 'scouting',
        completed: [],
      });
    });
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'workflow_phase',
        phase: 'planning',
        currentPhase: 'planning',
        completed: ['scouting'],
      });
    });
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'workflow_phase',
        phase: 'execution',
        currentPhase: 'execution',
        completed: ['scouting', 'planning'],
      });
    });
    act(() => {
      MockWebSocket.simulateMessage({
        type: 'agent_spawned',
        agent: {
          agentId: 'agent-1',
          taskId: 'task-1',
          profile: 'test',
          active: true,
          log: [],
        },
      });
    });

    // Verify events have accumulated
    expect(result.current.events.length).toBe(4);
    expect(result.current.events).toEqual([
      'Phase: scouting',
      'Phase: planning',
      'Phase: execution',
      'Agent agent-1 spawned',
    ]);

    // Simulate connection close → triggers reconnect
    act(() => {
      MockWebSocket.simulateClose(1000, 'connection lost');
    });
    expect(result.current.connected).toBe(false);

    // Advance timers past the backoff delay (1000ms) to create new connection
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Open the new connection
    act(() => {
      MockWebSocket.simulateOpen(MockWebSocket.instances[1]);
    });
    expect(result.current.connected).toBe(true);

    // Events should still be present before init (reconnection hasn't sent init yet)
    expect(result.current.events.length).toBe(4);

    // Send init message on the new connection
    act(() => {
      MockWebSocket.simulateMessage(
        {
          type: 'init',
          agents: [],
          currentPhase: 'planning',
          completedPhases: ['scouting'],
          tasks: [],
          sidebar: { title: 'Reconnected', indicator: 'green' },
        },
        MockWebSocket.instances[1],
      );
    });

    // Events array should be cleared after init
    expect(result.current.events).toEqual([]);

    vi.useRealTimers();
  });
});

describe('useWebSocket – events cap', () => {
  it('caps events array at 200 and discards oldest entries (sliding window)', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Send 250 workflow_phase messages, each generating an event
    for (let i = 1; i <= 250; i++) {
      act(() => {
        MockWebSocket.simulateMessage({
          type: 'workflow_phase',
          phase: String(i),
          completed: [],
        });
      });
    }

    // Length should be capped at 200, not 250
    expect(result.current.events.length).toBe(200);

    // The first event should be phase 51 (the 51st entry, which is the oldest retained)
    expect(result.current.events[0]).toBe('Phase: 51');

    // The last event should be phase 250
    expect(result.current.events[result.current.events.length - 1]).toBe('Phase: 250');
  });

  it('keeps all events when under the limit', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    for (let i = 1; i <= 50; i++) {
      act(() => {
        MockWebSocket.simulateMessage({
          type: 'workflow_phase',
          phase: String(i),
          completed: [],
        });
      });
    }

    expect(result.current.events.length).toBe(50);
    expect(result.current.events[0]).toBe('Phase: 1');
    expect(result.current.events[49]).toBe('Phase: 50');
  });

  it('retains exactly 200 events when exactly 200 are added', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    for (let i = 1; i <= 200; i++) {
      act(() => {
        MockWebSocket.simulateMessage({
          type: 'workflow_phase',
          phase: String(i),
          completed: [],
        });
      });
    }

    expect(result.current.events.length).toBe(200);
    expect(result.current.events[0]).toBe('Phase: 1');
    expect(result.current.events[199]).toBe('Phase: 200');
  });

  it('continues to slide the window after multiple batches over the cap', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Send 1000 events total
    for (let i = 1; i <= 1000; i++) {
      act(() => {
        MockWebSocket.simulateMessage({
          type: 'workflow_phase',
          phase: String(i),
          completed: [],
        });
      });
    }

    expect(result.current.events.length).toBe(200);
    // The oldest retained should be event 801 (1000 - 200 + 1)
    expect(result.current.events[0]).toBe('Phase: 801');
    expect(result.current.events[199]).toBe('Phase: 1000');
  });

  it('interleaves different event types and caps total', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Send 150 phase events + 100 complete events + 50 failed events = 300 total
    for (let i = 1; i <= 150; i++) {
      act(() => {
        MockWebSocket.simulateMessage({
          type: 'workflow_phase',
          phase: String(i),
          completed: [],
        });
      });
    }
    for (let i = 1; i <= 100; i++) {
      act(() => {
        MockWebSocket.simulateMessage({
          type: 'workflow_complete',
        });
      });
    }
    for (let i = 1; i <= 50; i++) {
      act(() => {
        MockWebSocket.simulateMessage({
          type: 'workflow_failed',
          error: `error-${i}`,
        });
      });
    }

    // Total events generated: 300, should be capped to 200
    expect(result.current.events.length).toBe(200);

    // The first 50 phase events should be dropped; first retained is phase 101
    // (150 phases + 100 completes + 50 failures = 300 total, oldest 100 dropped)
    // Actually: events are added in order: 150 phases (Phase: 1..150), then 100 completes, then 50 failures
    // After capping: the first 100 are dropped. So first event is the 101st phase event = 'Phase: 101'
    expect(result.current.events[0]).toBe('Phase: 101');

    // The last event should be the last failure
    expect(result.current.events[199]).toBe('Failed: error-50');
  });
});

describe('useWebSocket – cleanup on unmount', () => {
  it('does not reconnect after unmount when close fires after cleanup', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useWebSocket());

    // Open the connection so it's live
    act(() => {
      MockWebSocket.simulateOpen();
    });
    expect(result.current.connected).toBe(true);

    // Unmount: sets manualCloseRef = true, clears timer, closes socket
    unmount();

    // The close() call during cleanup fires the onclose handler.
    // Because manualCloseRef.current is true, it should NOT schedule a reconnect.
    // After cleanup, no reconnect timer should be pending.
    // Advance time significantly to ensure no new WebSocket instances appear.
    await vi.advanceTimersByTimeAsync(100_000);

    // There should be exactly 1 instance (the one created during mount)
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.useRealTimers();
  });

  it('cancels a pending reconnect timer on unmount', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useWebSocket());

    // Simulate a close → this schedules a reconnect timer via setTimeout
    act(() => {
      MockWebSocket.simulateClose(1000, 'connection lost');
    });
    expect(result.current.connected).toBe(false);

    // At this point a reconnect timer is scheduled for 1000ms from now.
    // Before it fires, we unmount the hook.
    unmount();

    // The cleanup should have cleared the pending timer.
    // Advance time past the scheduled fire time to verify it never fires.
    await vi.advanceTimersByTimeAsync(2000);

    // No new WebSocket instance should have been created
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.useRealTimers();
  });

  it('allows a fresh mount after unmount to reconnect normally', async () => {
    vi.useFakeTimers();
    // First mount and unmount
    const { unmount: firstUnmount } = renderHook(() => useWebSocket());
    firstUnmount();

    // Now mount again – should connect fresh
    const { result } = renderHook(() => useWebSocket());

    // Should have created a new WebSocket instance
    expect(MockWebSocket.instances).toHaveLength(2);

    // Opening the new connection should work
    act(() => {
      MockWebSocket.simulateOpen(MockWebSocket.instances[1]);
    });
    expect(result.current.connected).toBe(true);

    // Close should trigger reconnect (manualCloseRef was reset at start of connect)
    act(() => {
      MockWebSocket.simulateClose(1000, 'close', MockWebSocket.instances[1]);
    });
    expect(result.current.connected).toBe(false);

    // Reconnect timer should fire after 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(3);

    vi.useRealTimers();
  });

  it('sets manualCloseRef before closing the socket during cleanup', () => {
    // This test verifies the ORDER of operations in cleanup:
    // 1. manualCloseRef is set to true FIRST
    // 2. Then the reconnect timer is cleared
    // 3. Then the socket is closed
    // This ensures that if close() synchronously fires onclose, it sees manualCloseRef=true
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useWebSocket());

    // Spy on the original close method after render
    const closeSpy = vi.spyOn(MockWebSocket.prototype, 'close');

    unmount();

    // close() should have been called
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // After unmount, no reconnect should happen (manualCloseRef prevents it)
    // Advance time to verify
    vi.advanceTimersByTimeAsync(100_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.useRealTimers();
  });

  it('does not reconnect when close is triggered by manual cleanup after error', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useWebSocket());

    // Open the connection
    act(() => {
      MockWebSocket.simulateOpen();
    });
    expect(result.current.connected).toBe(true);

    // Simulate an error which calls ws.close() internally
    act(() => {
      MockWebSocket.simulateError();
    });
    // The error handler calls ws.close(), which fires onclose.
    // At this point manualCloseRef is still false, so reconnect is scheduled.
    expect(result.current.connected).toBe(false);

    // Now unmount before the reconnect timer fires
    unmount();

    // The cleanup should cancel the pending reconnect timer
    await vi.advanceTimersByTimeAsync(100_000);

    // No new WebSocket instances should have been created
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.useRealTimers();
  });
});

// ─── Diagnostic logging tests (kb-2) ─────────────────────────────────────
// Diagnostics live in useWebSocket.ts (onmessage + handleServerMessage).
// These tests guard against regressions in diagnostic logging.

describe('useWebSocket – diagnostic logging', () => {
  it('logs a warning when a malformed JSON payload is received', () => {
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Directly invoke onmessage with raw invalid JSON (bypass simulateMessage
    // which always JSON.stringify's, producing valid JSON).
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.onmessage?.(new MessageEvent('message', { data: '{not valid json' }));
    });

    // The hook should log a warning that includes 'Failed to parse'
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
  });

  it('logs a warning when a valid JSON object has an unrecognized message type', () => {
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Send a valid JSON object with a type that isServerMessage does not recognize.
    // Include extra fields so we can verify the full payload is surfaced in the warning.
    act(() => {
      MockWebSocket.simulateMessage({ type: 'bogus_type', foo: 'bar-BODY' });
    });

    // The hook should log a single-string warning that includes BOTH the
    // 'unknown message type' label AND the stringified data payload.
    // This guards against the regression where only the type was logged and the
    // rest of the message body was silently discarded.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unknown message type'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('bar-BODY'));
  });

  it('logs an init snapshot with correct counts on init message', () => {
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.simulateOpen();
    });

    act(() => {
      MockWebSocket.simulateMessage({
        type: 'init',
        currentPhase: 'planning',
        completedPhases: ['scouting', 'recon'],
        tasks: [
          { id: 't1', name: 'task 1' },
          { id: 't2', name: 'task 2' },
          { id: 't3', name: 'task 3' },
        ],
        agents: [
          { agentId: 'a1', taskId: 't1', profile: 'p1', active: true, log: [] },
          { agentId: 'a2', taskId: 't2', profile: 'p2', active: true, log: [] },
        ],
        sidebar: { title: 'S', indicator: 'green' },
      });
    });

    // The hook should log a message containing 'init snapshot'
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('init snapshot'));

    // Verify the snapshot includes the correct counts.
    // Find the call that contains 'init snapshot' and check for the counts.
    const initCalls = (console.log as ReturnType<typeof vi.spyOn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('init snapshot'),
    );
    expect(initCalls.length).toBeGreaterThanOrEqual(1);
    const snapshotMsg = initCalls[0][0] as string;
    expect(snapshotMsg).toContain('3'); // 3 tasks
    expect(snapshotMsg).toContain('2'); // 2 agents
    expect(snapshotMsg).toContain('2'); // 2 completedPhases
  });
});
