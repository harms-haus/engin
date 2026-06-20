// Tests for EngineClient's requestRuns() one-shot helper.
//
// Regression coverage for the resume race: requestRuns() called immediately
// after connect() — but before the socket's onopen handshake fires — must NOT
// resolve [] prematurely. It must wait for the handshake's list_runs → runs
// exchange and resolve with the server's actual active-run list. Previously it
// resolved [] synchronously (because this.connected was still false), which
// made `engin resume` blind to an active run and fall through to start_run,
// which then collided with "Run '<id>' is already running."

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EngineClient } from './engine-client.js';
import type { RunSummary, ServerMessage } from './protocol-types.js';

// ─── Mock WebSocket ────────────────────────────────────────────────────────

class MockWebSocket {
  // EngineClient.send() checks `WebSocket.OPEN`, so the mock must expose the
  // readyState constants as statics just like the real DOM WebSocket.
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
  }
  send(data: string): void {
    this.sentMessages.push(data);
  }
}

function installMockWs(): () => void {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  MockWebSocket.instances = [];
  return () => {
    globalThis.WebSocket = original;
  };
}

const SAMPLE_RUN: RunSummary = {
  runId: '1781897614881-develop',
  cwd: '/repo',
  workflowName: 'develop',
  taskPrompt: 'implement task.md',
  status: 'running',
  startedAt: new Date().toISOString(),
};

describe('EngineClient.requestRuns', () => {
  let restoreWs: () => void;
  beforeEach(() => {
    restoreWs = installMockWs();
  });
  afterEach(() => {
    restoreWs();
  });

  it('resolves with the server run list when called before onopen (the resume race)', async () => {
    const client = new EngineClient({ url: 'ws://127.0.0.1:3619/ws' });
    client.connect({ onMessage: () => {} });

    // Called synchronously right after connect() — the socket is still
    // CONNECTING (this.connected === false). This is exactly where
    // resumeCommand's queryActiveRuns runs.
    const runsP = client.requestRuns(2000);

    // No socket yet → must NOT have already resolved []. Give the microtask
    // queue a tick to prove the promise is still pending.
    await new Promise((r) => setTimeout(r, 5));
    let settledEarly = false;
    void runsP.then(() => {
      settledEarly = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settledEarly).toBe(false);

    // Drive the handshake: onopen sends list_runs; then the server replies
    // with a `runs` message.
    const ws = MockWebSocket.instances[0]!;
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen!();

    // The handshake should have sent a list_runs request.
    expect(ws.sentMessages.some((m) => m.includes('"list_runs"'))).toBe(true);

    const runsMsg: ServerMessage = { type: 'runs', runs: [SAMPLE_RUN] };
    ws.onmessage!({ data: JSON.stringify(runsMsg) } as MessageEvent);

    const runs = await runsP;
    expect(runs).toEqual([SAMPLE_RUN]);
    client.disconnect();
  });

  it('still resolves [] when the socket never opens within the timeout', async () => {
    const client = new EngineClient({ url: 'ws://127.0.0.1:3619/ws' });
    client.connect({ onMessage: () => {} });

    // Never simulate onopen. requestRuns must fall back to [] after timeout
    // rather than hanging forever.
    const ws = MockWebSocket.instances[0]!;
    const start = Date.now();
    const runs = await client.requestRuns(150);
    const elapsed = Date.now() - start;
    expect(runs).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(140);
    client.disconnect();
  });
});
