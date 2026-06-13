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

describe('App – connection status indicator', () => {
  it('renders the connection-status element', async () => {
    const { App } = await import('./App');
    render(<App />);

    const indicator = document.querySelector('.connection-status');
    expect(indicator).toBeInTheDocument();
  });

  it('shows "Disconnected — Reconnecting..." initially before WebSocket opens', async () => {
    const { App } = await import('./App');
    render(<App />);

    expect(screen.getByText('Disconnected — Reconnecting...')).toBeInTheDocument();
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

    // Initially disconnected
    expect(screen.getByText('Disconnected — Reconnecting...')).toBeInTheDocument();

    // Trigger the WebSocket open event (wrapped in act to flush React state updates)
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    });
    act(() => {
      MockWebSocket.simulateOpen();
    });

    // Now should show Connected
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Disconnected — Reconnecting...')).not.toBeInTheDocument();
  });

  it('has the connected modifier class after WebSocket opens', async () => {
    const { App } = await import('./App');
    render(<App />);

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    });
    act(() => {
      MockWebSocket.simulateOpen();
    });

    const indicator = document.querySelector('.connection-status');
    expect(indicator).toHaveClass('connection-status--connected');
    expect(indicator).not.toHaveClass('connection-status--disconnected');
  });
});
