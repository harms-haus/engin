/**
 * Tests for useWebSocket hook.
 *
 * We mock WebSocket and window.__WS_ENDPOINT__ to control the connection
 * and simulate server messages without a real server.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Types we need ──────────────────────────────────────────────────────────
import type {
  AgentWindowState,
  ClientMessage,
  LogEntry,
  ServerMessage,
  SidebarInfo,
  WorkflowSummary,
} from '../../types';

// ─── Module under test ──────────────────────────────────────────────────────
import { useWebSocket } from '../useWebSocket';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockSummary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    id: 'test-run-1',
    workflowName: 'Test Workflow',
    status: 'running',
    sidebar: { title: 'Test', indicator: '…' },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── WebSocket mock ─────────────────────────────────────────────────────────

// We use a class so that `new MockWebSocket(url)` works as a constructor.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number;

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  // Store listeners for test-triggered events
  private _openListeners = new Set<() => void>();
  private _closeListeners = new Set<(code?: number, reason?: string) => void>();
  private _errorListeners = new Set<() => void>();
  private _messageListeners = new Set<(data: ServerMessage) => void>();

  // Spies for verifying calls
  send = vi.fn<(data: string) => void>();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this._closeListeners.forEach((fn) => fn(1000, 'normal'));
  });

  constructor(url: string) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;

    // Track all instances
    MockWebSocket.instances.push(this);
    // Store reference globally so tests can interact with this instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__currentMockWs = this;
  }

  /** Register event listeners (used by testing-library or DOM env) */
  addEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
    if (type === 'open') this._openListeners.add(fn as unknown as () => void);
    else if (type === 'close') this._closeListeners.add(fn as unknown as (code?: number, reason?: string) => void);
    else if (type === 'error') this._errorListeners.add(fn as unknown as () => void);
    else if (type === 'message') this._messageListeners.add(fn as unknown as (data: ServerMessage) => void);
  }

  removeEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
    if (type === 'open') this._openListeners.delete(fn as unknown as () => void);
    else if (type === 'close') this._closeListeners.delete(fn as unknown as (code?: number, reason?: string) => void);
    else if (type === 'error') this._errorListeners.delete(fn as unknown as () => void);
    else if (type === 'message') this._messageListeners.delete(fn as unknown as (data: ServerMessage) => void);
  }

  // ── Test helpers ──────────────────────────────────────────────────────────

  _triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this._openListeners.forEach((fn) => fn());
    if (this.onopen) this.onopen(new Event('open'));
  }

  _triggerClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this._closeListeners.forEach((fn) => fn(code, reason));
    if (this.onclose) this.onclose(new CloseEvent('close', { code, reason, wasClean: true }));
  }

  _triggerError(): void {
    this._errorListeners.forEach((fn) => fn());
    if (this.onerror) this.onerror(new Event('error'));
  }

  _triggerMessage(data: ServerMessage): void {
    const json = JSON.stringify(data);
    const event = new MessageEvent('message', { data: json });
    this._messageListeners.forEach((fn) => fn(data));
    if (this.onmessage) this.onmessage(event);
  }
}

/** Convenience accessor for the current mock WebSocket in tests */
function getMockWs(): MockWebSocket {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = (globalThis as any).__currentMockWs;
  if (!ws) throw new Error('No MockWebSocket instance exists. Did the hook mount?');
  return ws;
}

// ─── Globals ─────────────────────────────────────────────────────────────────

const originalWebSocket = globalThis.WebSocket;

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__currentMockWs = null;
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof globalThis.WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__currentMockWs;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__WS_ENDPOINT__;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('useWebSocket', () => {
  it('should connect to default dev endpoint on mount', () => {
    const { unmount } = renderHook(() => useWebSocket());
    const ws = getMockWs();
    expect(ws.url).toBe('ws://localhost:3619/ws');
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);
    unmount();
  });

  it('should use __WS_ENDPOINT__ when set (production)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__WS_ENDPOINT__ = 'wss://example.com/ws';
    const { unmount } = renderHook(() => useWebSocket());
    const ws = getMockWs();
    expect(ws.url).toBe('wss://example.com/ws');
    unmount();
  });

  it('should set connected=true after WebSocket opens', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    expect(result.current.connected).toBe(false);
    act(() => {
      getMockWs()._triggerOpen();
    });
    expect(result.current.connected).toBe(true);
    unmount();
  });

  it('should close WebSocket on unmount', () => {
    const { unmount } = renderHook(() => useWebSocket());
    const ws = getMockWs();
    expect(ws.close).not.toHaveBeenCalled();
    unmount();
    expect(ws.close).toHaveBeenCalled();
  });

  it('should send JSON-stringified messages via send()', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    act(() => {
      getMockWs()._triggerOpen();
    });
    const msg: ClientMessage = {
      type: 'start_workflow',
      workflowName: 'test',
      taskPrompt: 'do stuff',
    };
    act(() => {
      result.current.send(msg);
    });
    expect(getMockWs().send).toHaveBeenCalledWith(JSON.stringify(msg));
    unmount();
  });

  it('should update selectedRunId and send select_workflow on selectRun()', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    act(() => {
      getMockWs()._triggerOpen();
    });
    act(() => {
      result.current.selectRun('run-42');
    });
    expect(result.current.state.selectedRunId).toBe('run-42');
    const expectedMsg: ClientMessage = { type: 'select_workflow', workflowId: 'run-42' };
    expect(getMockWs().send).toHaveBeenCalledWith(JSON.stringify(expectedMsg));
    unmount();
  });

  it('should handle init message', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const workflows: WorkflowSummary[] = [
      createMockSummary({ id: 'w1', workflowName: 'Alpha' }),
      createMockSummary({ id: 'w2', workflowName: 'Beta' }),
    ];
    act(() => {
      getMockWs()._triggerMessage({ type: 'init', workflows });
    });
    expect(result.current.state.workflows).toEqual(workflows);
    unmount();
  });

  it('should handle workflow_started message', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({ id: 'w-new' });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_started', summary });
    });
    expect(result.current.state.workflows).toContainEqual(summary);
    expect(result.current.state.runStates.has('w-new')).toBe(true);
    const runState = result.current.state.runStates.get('w-new');
    expect(runState?.summary).toEqual(summary);
    expect(runState?.agents).toBeInstanceOf(Map);
    unmount();
  });

  it('should handle workflow_sidebar message', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({
      id: 'w-side',
      sidebar: { title: 'Old', indicator: '…' },
    });
    act(() => {
      getMockWs()._triggerMessage({ type: 'init', workflows: [summary] });
    });
    const newSidebar: SidebarInfo = { title: 'New Title', indicator: '✓' };
    act(() => {
      getMockWs()._triggerMessage({
        type: 'workflow_sidebar',
        workflowId: 'w-side',
        sidebar: newSidebar,
      });
    });
    const updated = result.current.state.workflows.find((w) => w.id === 'w-side');
    expect(updated?.sidebar).toEqual(newSidebar);
    unmount();
  });

  it('should handle workflow_phase message', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({ id: 'w-phase' });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_started', summary });
    });
    act(() => {
      getMockWs()._triggerMessage({
        type: 'workflow_phase',
        workflowId: 'w-phase',
        phase: 'phase-2',
        completed: ['phase-1'],
      });
    });
    const runState = result.current.state.runStates.get('w-phase');
    expect(runState?.currentPhase).toBe('phase-2');
    expect(runState?.completedPhases).toEqual(['phase-1']);
    unmount();
  });

  it('should handle workflow_complete message', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({ id: 'w-done', status: 'running' });
    act(() => {
      getMockWs()._triggerMessage({ type: 'init', workflows: [summary] });
    });
    const completedSummary = createMockSummary({
      id: 'w-done',
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_complete', summary: completedSummary });
    });
    const updated = result.current.state.workflows.find((w) => w.id === 'w-done');
    expect(updated?.status).toBe('completed');
    expect(updated?.completedAt).toBe(completedSummary.completedAt);
    unmount();
  });

  it('should handle workflow_failed message', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({ id: 'w-fail', status: 'running' });
    act(() => {
      getMockWs()._triggerMessage({ type: 'init', workflows: [summary] });
    });
    const failedSummary = createMockSummary({
      id: 'w-fail',
      status: 'failed',
      completedAt: new Date().toISOString(),
    });
    act(() => {
      getMockWs()._triggerMessage({
        type: 'workflow_failed',
        summary: failedSummary,
        error: 'Something broke',
        phase: 'phase-1',
      });
    });
    const updated = result.current.state.workflows.find((w) => w.id === 'w-fail');
    expect(updated?.status).toBe('failed');
    expect(updated?.completedAt).toBe(failedSummary.completedAt);
    unmount();
  });

  it('should handle agent_spawned message', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({ id: 'w-agent' });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_started', summary });
    });
    const agent: AgentWindowState = {
      agentId: 'agent-1',
      profile: 'helper',
      active: true,
      log: [],
    };
    act(() => {
      getMockWs()._triggerMessage({
        type: 'agent_spawned',
        workflowId: 'w-agent',
        agent,
      });
    });
    const runState = result.current.state.runStates.get('w-agent');
    expect(runState?.agents.get('agent-1')).toEqual(agent);
    unmount();
  });

  it('should handle agent_log message', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({ id: 'w-log' });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_started', summary });
    });
    const agent: AgentWindowState = {
      agentId: 'agent-log',
      profile: 'logger',
      active: true,
      log: [],
    };
    act(() => {
      getMockWs()._triggerMessage({
        type: 'agent_spawned',
        workflowId: 'w-log',
        agent,
      });
    });
    const entry: LogEntry = {
      id: 'log-1',
      timestamp: new Date().toISOString(),
      type: 'text',
      content: 'Hello',
    };
    act(() => {
      getMockWs()._triggerMessage({
        type: 'agent_log',
        workflowId: 'w-log',
        agentId: 'agent-log',
        entry,
      });
    });
    const runState = result.current.state.runStates.get('w-log');
    expect(runState?.agents.get('agent-log')?.log).toContainEqual(entry);
    unmount();
  });

  it('should handle agent_complete message', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({ id: 'w-agent-done' });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_started', summary });
    });
    const agent: AgentWindowState = {
      agentId: 'agent-done',
      profile: 'worker',
      active: true,
      log: [],
    };
    act(() => {
      getMockWs()._triggerMessage({
        type: 'agent_spawned',
        workflowId: 'w-agent-done',
        agent,
      });
    });
    act(() => {
      getMockWs()._triggerMessage({
        type: 'agent_complete',
        workflowId: 'w-agent-done',
        agentId: 'agent-done',
      });
    });
    const runState = result.current.state.runStates.get('w-agent-done');
    expect(runState?.agents.get('agent-done')?.active).toBe(false);
    unmount();
  });

  it('should reconnect on close after 3 seconds', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useWebSocket());
    const initialWs = getMockWs();
    const initialCount = MockWebSocket.instances.length;
    act(() => {
      initialWs._triggerClose();
    });
    // Should not have reconnected immediately
    expect(MockWebSocket.instances.length).toBe(initialCount);
    // Advance timers by 3 seconds
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Should have created a new WebSocket
    expect(MockWebSocket.instances.length).toBe(initialCount + 1);
    vi.useRealTimers();
    unmount();
  });

  it('should clear reconnect timeout on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useWebSocket());
    const initialWs = getMockWs();
    act(() => {
      initialWs._triggerClose();
    });
    // Unmount before the timer fires
    unmount();
    // Advance timers
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Should NOT have reconnected because we unmounted (same instance still)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__currentMockWs).toBe(initialWs);
    vi.useRealTimers();
  });

  it('should fall through to default case for unknown message types', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* noop */
    });
    const { unmount } = renderHook(() => useWebSocket());
    act(() => {
      getMockWs()._triggerMessage({ type: 'unknown_type' } as unknown as ServerMessage);
    });
    // unknown type passes isServerMessage (which only checks for a 'type' property)
    // and falls through to the default case
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Unhandled server message type',
      expect.objectContaining({ type: 'unknown_type' }),
    );
    consoleWarnSpy.mockRestore();
    unmount();
  });

  // ── State sync tests (Bug A–E) ──────────────────────────────────────────

  it('should create runStates entries for each workflow on init', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const workflows: WorkflowSummary[] = [
      createMockSummary({ id: 'init-w1', workflowName: 'Workflow A' }),
      createMockSummary({ id: 'init-w2', workflowName: 'Workflow B' }),
      createMockSummary({ id: 'init-w3', workflowName: 'Workflow C' }),
    ];
    act(() => {
      getMockWs()._triggerMessage({ type: 'init', workflows });
    });
    expect(result.current.state.workflows).toEqual(workflows);
    // runStates should have an entry for each workflow
    expect(result.current.state.runStates.size).toBe(3);
    for (const w of workflows) {
      const runState = result.current.state.runStates.get(w.id);
      expect(runState).toBeDefined();
      expect(runState?.summary).toEqual(w);
      expect(runState?.agents).toBeInstanceOf(Map);
      expect(runState?.agents.size).toBe(0);
      expect(runState?.currentPhase).toBe('');
      expect(runState?.completedPhases).toEqual([]);
    }
    unmount();
  });

  it('should sync runStates summary.sidebar on workflow_sidebar', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({
      id: 'sync-side',
      sidebar: { title: 'Old Title', indicator: '⏳' },
    });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_started', summary });
    });
    // Verify initial state in runStates
    expect(result.current.state.runStates.get('sync-side')?.summary.sidebar).toEqual({
      title: 'Old Title',
      indicator: '⏳',
    });

    const newSidebar: SidebarInfo = { title: 'Updated Title', indicator: '✓', phases: [] };
    act(() => {
      getMockWs()._triggerMessage({
        type: 'workflow_sidebar',
        workflowId: 'sync-side',
        sidebar: newSidebar,
      });
    });
    // Both workflows and runStates should be updated
    const workflowItem = result.current.state.workflows.find((w) => w.id === 'sync-side');
    expect(workflowItem?.sidebar).toEqual(newSidebar);
    const runState = result.current.state.runStates.get('sync-side');
    expect(runState?.summary.sidebar).toEqual(newSidebar);
    unmount();
  });

  it('should sync runStates summary on workflow_complete', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({ id: 'sync-complete', status: 'running' });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_started', summary });
    });
    expect(result.current.state.runStates.get('sync-complete')?.summary.status).toBe('running');

    const completedSummary = createMockSummary({
      id: 'sync-complete',
      status: 'completed',
      completedAt: '2026-06-10T12:00:00.000Z',
    });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_complete', summary: completedSummary });
    });
    // workflows should be updated
    const workflowItem = result.current.state.workflows.find((w) => w.id === 'sync-complete');
    expect(workflowItem?.status).toBe('completed');
    expect(workflowItem?.completedAt).toBe('2026-06-10T12:00:00.000Z');
    // runStates should also be synced
    const runState = result.current.state.runStates.get('sync-complete');
    expect(runState?.summary.status).toBe('completed');
    expect(runState?.summary.completedAt).toBe('2026-06-10T12:00:00.000Z');
    unmount();
  });

  it('should sync runStates summary on workflow_failed', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const summary = createMockSummary({ id: 'sync-fail', status: 'running' });
    act(() => {
      getMockWs()._triggerMessage({ type: 'workflow_started', summary });
    });
    expect(result.current.state.runStates.get('sync-fail')?.summary.status).toBe('running');

    const failedSummary = createMockSummary({
      id: 'sync-fail',
      status: 'failed',
      completedAt: '2026-06-10T12:05:00.000Z',
    });
    act(() => {
      getMockWs()._triggerMessage({
        type: 'workflow_failed',
        summary: failedSummary,
        error: 'Boom',
        phase: 'deploy',
      });
    });
    // workflows should be updated
    const workflowItem = result.current.state.workflows.find((w) => w.id === 'sync-fail');
    expect(workflowItem?.status).toBe('failed');
    expect(workflowItem?.completedAt).toBe('2026-06-10T12:05:00.000Z');
    // runStates should also be synced
    const runState = result.current.state.runStates.get('sync-fail');
    expect(runState?.summary.status).toBe('failed');
    expect(runState?.summary.completedAt).toBe('2026-06-10T12:05:00.000Z');
    unmount();
  });

  it('should create runState and set selectedRunId on load_past_run', () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const agents: AgentWindowState[] = [
      {
        agentId: 'past-agent-1',
        profile: 'planner',
        active: false,
        log: [
          {
            id: 'log-1',
            timestamp: '2026-06-10T10:00:00.000Z',
            type: 'text',
            content: 'Planning done',
          },
        ],
      },
      {
        agentId: 'past-agent-2',
        profile: 'worker',
        active: true,
        log: [],
      },
    ];
    const summary = createMockSummary({
      id: 'past-run-1',
      workflowName: 'Past Run',
      status: 'running',
    });

    act(() => {
      getMockWs()._triggerMessage({
        type: 'load_past_run',
        workflowId: 'past-run-1',
        summary,
        currentPhase: 'build',
        completedPhases: ['setup', 'test'],
        agents,
      });
    });

    // runStates should have the entry
    const runState = result.current.state.runStates.get('past-run-1');
    expect(runState).toBeDefined();
    expect(runState?.summary).toEqual(summary);
    expect(runState?.currentPhase).toBe('build');
    expect(runState?.completedPhases).toEqual(['setup', 'test']);

    // Agents array should be converted to a Map
    expect(runState?.agents).toBeInstanceOf(Map);
    expect(runState?.agents.size).toBe(2);
    expect(runState?.agents.get('past-agent-1')).toEqual(agents[0]);
    expect(runState?.agents.get('past-agent-2')).toEqual(agents[1]);

    // selectedRunId should be set
    expect(result.current.state.selectedRunId).toBe('past-run-1');
    unmount();
  });
});
