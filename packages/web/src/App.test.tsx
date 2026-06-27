/**
 * Tests for the App component – WebSocket connection status indicator.
 *
 * Verifies:
 * - The connection-status element is rendered
 * - Shows "Disconnected — Reconnecting..." initially (before WS open)
 * - Shows "Connected" after the mock WebSocket fires onopen
 */

import '@testing-library/jest-dom/vitest';

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowStore } from './store/workflow-store';

// ─── Constants ────────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';

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

  /** Simulate opening ALL active instances (useful when multiple hooks create sockets). */
  static simulateOpenAll(): void {
    for (const ws of MockWebSocket.instances) {
      if (ws.readyState === MockWebSocket.CONNECTING) {
        ws.readyState = MockWebSocket.OPEN;
        ws.onopen?.();
      }
    }
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
    selectedRunId: RUN_ID,
    runLogs: {},
  });
}

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
  // Reset Zustand store
  resetStore();
});

afterEach(() => {
  globalThis.WebSocket = ORIGINAL_WS;
  vi.restoreAllMocks();
});

describe('App – connection status indicator', () => {
  it('renders the connection-status element', async () => {
    const { App } = await import('./App');
    render(<App />);

    const indicator = document.querySelector('.connection-status');
    expect(indicator).toBeInTheDocument();
  });

  it('shows "Connecting..." initially before first WebSocket connection', async () => {
    const { App } = await import('./App');
    render(<App />);

    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });

  it('has the disconnected modifier class before WebSocket opens', async () => {
    const { App } = await import('./App');
    render(<App />);

    const indicator = document.querySelector('.connection-status');
    expect(indicator).toHaveClass('connection-status--disconnected');
    expect(indicator).not.toHaveClass('connection-status--connected');
  });

  it('shows "Connected" after WebSocket onopen fires', async () => {
    const { App } = await import('./App');
    render(<App />);

    // Initially connecting (first attempt)
    expect(screen.getByText('Connecting...')).toBeInTheDocument();

    // Wait for at least one WS instance (multiple hooks create sockets)
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    });
    // Open ALL instances so every useWebSocket hook gets connected
    act(() => {
      MockWebSocket.simulateOpenAll();
    });

    // Now should show Connected
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
  });

  it('shows "Disconnected — Reconnecting..." after a connection drops (not on first attempt)', async () => {
    const { App } = await import('./App');
    render(<App />);

    // Initially connecting
    expect(screen.getByText('Connecting...')).toBeInTheDocument();

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    });

    // Connect
    act(() => {
      MockWebSocket.simulateOpenAll();
    });
    expect(screen.getByText('Connected')).toBeInTheDocument();

    // Simulate a connection drop
    act(() => {
      for (const ws of MockWebSocket.instances) {
        if (ws.readyState === MockWebSocket.OPEN) {
          MockWebSocket.simulateClose(1006, 'abnormal closure', ws);
        }
      }
    });

    // Should now show reconnecting (not connecting, since we connected once)
    expect(screen.getByText('Disconnected — Reconnecting...')).toBeInTheDocument();
    expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
  });

  it('connection-status has aria-live="polite"', async () => {
    const { App } = await import('./App');
    render(<App />);

    const indicator = document.querySelector('.connection-status');
    expect(indicator).toHaveAttribute('aria-live', 'polite');
  });

  it('has the connected modifier class after WebSocket opens', async () => {
    const { App } = await import('./App');
    render(<App />);

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    });
    act(() => {
      MockWebSocket.simulateOpenAll();
    });

    const indicator = document.querySelector('.connection-status');
    expect(indicator).toHaveClass('connection-status--connected');
    expect(indicator).not.toHaveClass('connection-status--disconnected');
  });
});

describe('App – status banner', () => {
  it('does not render a status banner while running', async () => {
    const { App } = await import('./App');
    render(<App />);

    expect(document.querySelector('.status-banner')).not.toBeInTheDocument();
  });

  it('renders a failed banner with error and phase when status is failed', async () => {
    const { App } = await import('./App');
    render(<App />);

    act(() => {
      useWorkflowStore.getState().setFailed(RUN_ID, 'Something went wrong', 'scouting');
    });

    const banner = document.querySelector('.status-banner--failed');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Workflow failed in phase scouting');
    expect(banner).toHaveTextContent('Something went wrong');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });

  it('renders a failed banner with "unknown" phase when no phase set', async () => {
    const { App } = await import('./App');
    render(<App />);

    act(() => {
      useWorkflowStore.setState({ status: 'failed', error: 'crash', failedPhase: undefined });
    });

    const banner = document.querySelector('.status-banner--failed');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('unknown');
  });

  it('renders a complete banner when status is complete', async () => {
    const { App } = await import('./App');
    render(<App />);

    act(() => {
      useWorkflowStore.getState().setStatus(RUN_ID, 'complete');
    });

    const banner = document.querySelector('.status-banner--complete');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Workflow complete');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });
});

describe('App – layout', () => {
  it('renders EventLog as a flat sibling', async () => {
    const { App } = await import('./App');
    const { container } = render(<App />);

    const eventLog = container.querySelector('.event-log');
    expect(eventLog).toBeInTheDocument();
  });

  it('renders PhaseBar as a flat sibling', async () => {
    const { App } = await import('./App');
    const { container } = render(<App />);

    const phaseBar = container.querySelector('.phase-bar');
    expect(phaseBar).toBeInTheDocument();
  });

  it('renders TaskList as a flat sibling', async () => {
    const { App } = await import('./App');
    const { container } = render(<App />);

    const taskList = container.querySelector('.task-list');
    expect(taskList).toBeInTheDocument();
  });

  it('renders AgentLog as a flat sibling', async () => {
    const { App } = await import('./App');
    const { container } = render(<App />);

    const agentLog = container.querySelector('.agent-log');
    expect(agentLog).toBeInTheDocument();
  });

  it('all four main sections are inside a main landmark', async () => {
    const { App } = await import('./App');
    const { container } = render(<App />);

    const appDiv = container.querySelector('.app');
    expect(appDiv).toBeInTheDocument();

    const mainEl = appDiv?.querySelector('main');
    expect(mainEl).toBeInTheDocument();

    const eventLog = mainEl?.querySelector('.event-log');
    const phaseBar = mainEl?.querySelector('.phase-bar');
    const taskList = mainEl?.querySelector('.task-list');
    const agentLog = mainEl?.querySelector('.agent-log');

    expect(eventLog).toBeInTheDocument();
    expect(phaseBar).toBeInTheDocument();
    expect(taskList).toBeInTheDocument();
    expect(agentLog).toBeInTheDocument();

    // EventLog, TaskList, AgentLog are direct children of <main>
    expect(eventLog?.parentElement).toBe(mainEl);
    expect(taskList?.parentElement).toBe(mainEl);
    expect(agentLog?.parentElement).toBe(mainEl);

    // PhaseBar is inside a <nav> with aria-label
    const nav = mainEl?.querySelector('nav[aria-label="Workflow phases"]');
    expect(nav).toBeInTheDocument();
    expect(phaseBar?.parentElement).toBe(nav);
  });
});
