// ─── EngineClient transport tests ──────────────────────────────────────────
//
// Verifies `packages/shared/src/engine-client.ts`: a framework-agnostic,
// pure-TypeScript WebSocket client extracted from the React `useWebSocket`
// hook. It owns connection lifecycle, exponential-backoff reconnection,
// resync, and multi-run subscription (run multiplexing) — with NO dependency
// on React, zustand, Node builtins, or pi packages.
//
// The shared package's ONLY runtime API is the global `WebSocket` constructor,
// which we replace with a MockWebSocket for these tests.
//
// CONTRACT UNDER TEST (behavioural spec for the implementer):
//
//  EngineClientOptions:
//    { url: string; authToken?: string;
//      backoff?: { initial?: number; multiplier?: number; max?: number } }
//      backoff defaults: initial 1000, multiplier 1.5, max 30_000.
//
//  EngineClientCallbacks (passed to connect()):
//    { onMessage(msg: ServerMessage): void;          // required
//      onConnected?(): void;
//      onDisconnected?(): void;
//      onRunsChanged?(runs: RunSummary[]): void; }   // fired on 'runs' msgs
//
//  Lifecycle:
//    - constructor(options) stores config; does NOT open a socket.
//    - connect(callbacks) opens `new WebSocket(url)` and wires handlers.
//    - disconnect() is a clean, manual teardown: clears any pending reconnect
//      timer, closes the socket, and does NOT schedule a reconnect.
//
//  On socket open:
//    1. reset backoff to its initial value;
//    2. if authToken provided, send { type:'auth', token };
//    3. send { type:'list_runs' };
//    4. for every runId in the subscribed Set, send { type:'subscribe', runId }
//       then { type:'resync', runId, lastSeq? } (re-subscribe on reconnect).
//
//  On socket message: JSON.parse → isServerMessage → callbacks.onMessage.
//    Unparseable / non-server payloads are silently ignored (no throw).
//    A 'runs' message additionally fires onRunsChanged(runs).
//
//  On socket close: if NOT a manual disconnect, schedule a reconnect with
//    exponential backoff (delay grows by `multiplier`, capped at `max`,
//    reset to `initial` on the next successful open).
//
//  On socket error: close the socket (which then routes through onclose).
//
//  lastSeq tracking: the client records the latest `seq` per runId from
//    incoming 'snapshot'/'events' messages and from explicit resync(runId,
//    lastSeq) calls. That value is replayed in the reconnect resync.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { EngineClientCallbacks, EngineClientOptions } from '@engin/shared/engine-client';
import { EngineClient } from '@engin/shared/engine-client';
import { createInitialProjection } from '@engin/shared/event-types';
import type { ClientMessage, RunSummary, ServerMessage } from '@engin/shared/protocol-types';

// ─── Mock WebSocket ────────────────────────────────────────────────────────
// Mirrors the shape of the DOM WebSocket just closely enough for the client:
// static ready-state constants, the four `on*` handlers, `readyState`,
// `send()`, and `close()`.

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readyState: number = MockWebSocket.CONNECTING;
  closeCalls = 0;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.closeCalls++;
    // Only transition + fire onclose once (idempotent, like a real socket).
    if (this.readyState !== MockWebSocket.CLOSED) {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.(new CloseEvent('close', { code: 1000, reason: 'close' }));
    }
  }

  // ── Simulation helpers (used by tests) ──────────────────────────────────
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateClose(code = 1000, reason = 'close'): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  /** Delivers a message. Strings are passed through raw (for malformed-JSON
   *  tests); everything else is JSON.stringified (matching real wire format). */
  simulateMessage(data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.(new MessageEvent('message', { data: payload }));
  }
}

// ─── Original global state (restored after each test) ──────────────────────

const ORIGINAL_WS = globalThis.WebSocket;

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Tracks every client created during a test so afterEach can tear them all
 *  down (cancelling pending reconnect timers → no cross-test leakage). */
let clients: EngineClient[] = [];

function makeClient(options: EngineClientOptions): EngineClient {
  const client = new EngineClient(options);
  clients.push(client);
  return client;
}

function makeCallbacks(overrides: Partial<EngineClientCallbacks> = {}): EngineClientCallbacks {
  return {
    onMessage: mock<(msg: ServerMessage) => void>(),
    ...overrides,
  };
}

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

/** Parsed copy of every ClientMessage the socket has sent. */
function sentMsgs(ws: MockWebSocket): any[] {
  return ws.sentMessages.map((raw) => JSON.parse(raw));
}

function sentTypes(ws: MockWebSocket): string[] {
  return sentMsgs(ws).map((m) => m.type as string);
}

function runSummary(runId: string): RunSummary {
  return {
    runId,
    cwd: '/tmp',
    workflowName: 'demo',
    taskPrompt: 'do the thing',
    status: 'running',
    startedAt: '2024-01-01T00:00:00.000Z',
  };
}

/**
 * Finds the pending reconnect timer scheduled via setTimeout for `expectedDelay`,
 * cancels the real timer (so it cannot fire after the test), and returns the
 * reconnect callback for manual invocation. This makes backoff assertions
 * deterministic without globally faking timers (which would break bun's own
 * internals).
 */
function takeReconnectTimer(setTimeoutSpy: ReturnType<typeof spyOn>, expectedDelay: number): () => void {
  const calls = setTimeoutSpy.mock.calls as unknown as Array<[unknown, unknown]>;
  const idx = calls.findIndex((c) => c[1] === expectedDelay);
  if (idx < 0) {
    const delays = calls.map((c) => c[1]);
    throw new Error(`No setTimeout for delay ${expectedDelay} found. Saw delays: ${JSON.stringify(delays)}`);
  }
  const cb = calls[idx][0] as () => void;
  const timerId = setTimeoutSpy.mock.results[idx].value as ReturnType<typeof setTimeout>;
  clearTimeout(timerId);
  return cb;
}

/** Returns every setTimeout delay observed by the spy. */
function observedDelays(setTimeoutSpy: ReturnType<typeof spyOn>): number[] {
  const calls = setTimeoutSpy.mock.calls as unknown as Array<[unknown, unknown]>;
  return calls.map((c) => (typeof c[1] === 'number' ? (c[1] as number) : 0));
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  MockWebSocket.instances = [];
  clients = [];
});

afterEach(() => {
  // Tear down every client created during the test (cancels pending reconnect
  // timers so they cannot fire into the next test).
  for (const client of clients) {
    try {
      client.disconnect();
    } catch {
      /* already disconnected — fine */
    }
  }
  clients = [];
  globalThis.WebSocket = ORIGINAL_WS;
});

// ─── Construction ──────────────────────────────────────────────────────────

describe('EngineClient – construction', () => {
  it('does not open a socket until connect() is called', () => {
    makeClient({ url: 'ws://test' });
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('isConnected() is false before connect()', () => {
    const client = makeClient({ url: 'ws://test' });
    expect(client.isConnected()).toBe(false);
  });
});

// ─── connect() & connection state ──────────────────────────────────────────

describe('EngineClient – connect() and connection state', () => {
  it('creates a WebSocket using the configured url', () => {
    const client = makeClient({ url: 'ws://example/ws' });
    client.connect(makeCallbacks());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://example/ws');
    expect(client.isConnected()).toBe(false); // still CONNECTING until open
  });

  it('reports connected=true after the socket opens', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();
    expect(client.isConnected()).toBe(true);
  });

  it('reports connected=false after the socket closes', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();
    expect(client.isConnected()).toBe(true);
    MockWebSocket.instances[0].simulateClose();
    expect(client.isConnected()).toBe(false);
  });

  it('invokes onConnected on open and onDisconnected on close', () => {
    const onConnected = mock();
    const onDisconnected = mock();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onConnected, onDisconnected }));

    MockWebSocket.instances[0].simulateOpen();
    expect(onConnected).toHaveBeenCalledTimes(1);

    MockWebSocket.instances[0].simulateClose();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });
});

// ─── On-open handshake ─────────────────────────────────────────────────────

describe('EngineClient – on-open handshake', () => {
  it('sends only list_runs when no authToken is provided', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    expect(sentTypes(ws)).toEqual(['list_runs']);
  });

  it('sends auth (with token) BEFORE list_runs when authToken is provided', () => {
    const client = makeClient({ url: 'ws://test', authToken: 'secret-token' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const msgs = sentMsgs(ws);
    const authIdx = msgs.findIndex((m) => m.type === 'auth');
    const listIdx = msgs.findIndex((m) => m.type === 'list_runs');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(listIdx);
    expect(msgs[authIdx]).toEqual({ type: 'auth', token: 'secret-token' });
  });

  it('does not send auth when authToken is absent (no {type:"auth"} at all)', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    expect(sentTypes(ws).filter((t) => t === 'auth')).toHaveLength(0);
  });
});

// ─── Message routing ───────────────────────────────────────────────────────

describe('EngineClient – message routing', () => {
  it('parses a valid server message and forwards it to onMessage', () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onMessage }));
    MockWebSocket.instances[0].simulateOpen();

    const msg: ServerMessage = { type: 'run_complete', runId: 'r1' };
    MockWebSocket.instances[0].simulateMessage(msg);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toEqual(msg);
  });

  it('silently ignores unparseable JSON (no throw, no onMessage)', () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onMessage }));
    MockWebSocket.instances[0].simulateOpen();

    expect(() => MockWebSocket.instances[0].simulateMessage('not-valid-json{')).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('silently ignores valid JSON that is not a ServerMessage', () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onMessage }));
    MockWebSocket.instances[0].simulateOpen();

    MockWebSocket.instances[0].simulateMessage({ type: 'totally_bogus', foo: 'bar' });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('forwards every valid message independently', () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onMessage }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    ws.simulateMessage({ type: 'run_complete', runId: 'a' });
    ws.simulateMessage({ type: 'run_failed', runId: 'b', error: 'boom', phase: 'exec' });
    // ignored — not a server message
    ws.simulateMessage({ type: 'nope' });

    expect(onMessage).toHaveBeenCalledTimes(2);
  });
});

// ─── onRunsChanged ─────────────────────────────────────────────────────────

describe('EngineClient – onRunsChanged callback', () => {
  it('fires onRunsChanged with the runs array when a "runs" message arrives', () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const onRunsChanged = mock<(runs: RunSummary[]) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onMessage, onRunsChanged }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const runs = [runSummary('r1'), runSummary('r2')];
    ws.simulateMessage({ type: 'runs', runs });

    expect(onRunsChanged).toHaveBeenCalledTimes(1);
    expect(onRunsChanged.mock.calls[0][0]).toEqual(runs);
    // The general onMessage handler still receives the full message.
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toMatchObject({ type: 'runs' });
  });

  it('does not fire onRunsChanged for non-runs messages', () => {
    const onRunsChanged = mock<(runs: RunSummary[]) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onRunsChanged }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    ws.simulateMessage({ type: 'run_complete', runId: 'r1' });
    expect(onRunsChanged).not.toHaveBeenCalled();
  });
});

// ─── send() ────────────────────────────────────────────────────────────────

describe('EngineClient – send()', () => {
  it('serializes and sends a ClientMessage when the socket is open', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.sentMessages.length = 0; // ignore handshake

    const msg: ClientMessage = { type: 'cancel_run', runId: 'r1' };
    client.send(msg);

    expect(ws.sentMessages).toEqual([JSON.stringify(msg)]);
  });

  it('is a no-op when the socket is not open', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    // socket created but never opened
    client.send({ type: 'cancel_run', runId: 'r1' });
    expect(MockWebSocket.instances[0].sentMessages).toHaveLength(0);
  });
});

// ─── Run multiplexing: subscribe / unsubscribe / resync ────────────────────

describe('EngineClient – run multiplexing', () => {
  it('subscribe(runId) sends a subscribe message while connected', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.sentMessages.length = 0;

    client.subscribe('run-1');

    expect(ws.sentMessages).toEqual([JSON.stringify({ type: 'subscribe', runId: 'run-1' })]);
  });

  it('unsubscribe(runId) sends an unsubscribe message while connected', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.sentMessages.length = 0;

    client.unsubscribe('run-7');

    expect(ws.sentMessages).toEqual([JSON.stringify({ type: 'unsubscribe', runId: 'run-7' })]);
  });

  it('resync(runId, lastSeq) sends a resync message carrying the provided lastSeq', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.sentMessages.length = 0;

    client.resync('run-9', 42);

    expect(ws.sentMessages).toEqual([JSON.stringify({ type: 'resync', runId: 'run-9', lastSeq: 42 })]);
  });

  it('resync(runId) with no lastSeq and no tracked value omits lastSeq', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.sentMessages.length = 0;

    client.resync('run-9');

    // lastSeq absent → serialized form has no lastSeq field.
    expect(ws.sentMessages).toEqual([JSON.stringify({ type: 'resync', runId: 'run-9' })]);
  });

  it('subscribe() before connect() does not throw and tracks the runId', () => {
    const client = makeClient({ url: 'ws://test' });
    // No socket yet — subscribe must be safe.
    expect(() => client.subscribe('r1')).not.toThrow();
    expect(MockWebSocket.instances).toHaveLength(0);

    // The tracked runId surfaces in the handshake once connected.
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();
    expect(sentTypes(MockWebSocket.instances[0])).toContain('subscribe');
  });
});

// ─── Re-subscription on (re)connect ────────────────────────────────────────

describe('EngineClient – re-subscription on (re)connect', () => {
  it('re-subscribes (subscribe + resync) to runIds subscribed before connect', () => {
    const client = makeClient({ url: 'ws://test' });
    client.subscribe('r1');
    client.subscribe('r2');
    client.connect(makeCallbacks());

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const msgs = sentMsgs(ws);
    const listIdx = msgs.findIndex((m) => m.type === 'list_runs');

    // For r1: subscribe, then resync — and both after list_runs.
    const r1Sub = msgs.findIndex((m) => m.type === 'subscribe' && m.runId === 'r1');
    const r1Resync = msgs.findIndex((m) => m.type === 'resync' && m.runId === 'r1');
    const r2Sub = msgs.findIndex((m) => m.type === 'subscribe' && m.runId === 'r2');
    expect(r1Sub).toBeGreaterThan(listIdx);
    expect(r1Resync).toBeGreaterThan(r1Sub);
    expect(r2Sub).toBeGreaterThan(r1Resync);

    // No lastSeq tracked yet → resync carries no lastSeq field.
    expect(msgs[r1Resync]).toEqual({ type: 'resync', runId: 'r1' });
  });

  it('re-subscribes on reconnect after the socket drops', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());

    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();
    client.subscribe('r1'); // subscribed while connected

    // Drop the connection (non-manual) → schedules reconnect.
    ws0.simulateClose();
    takeReconnectTimer(spy, 1000)(); // fire reconnect → new socket
    const ws1 = lastSocket();
    ws1.simulateOpen();

    const msgs = sentMsgs(ws1);
    expect(msgs.some((m) => m.type === 'subscribe' && m.runId === 'r1')).toBe(true);
    expect(msgs.some((m) => m.type === 'resync' && m.runId === 'r1')).toBe(true);

    spy.mockRestore();
  });

  it('does not re-subscribe a runId that was unsubscribed', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();

    client.subscribe('r1');
    client.unsubscribe('r1');

    ws0.simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws1 = lastSocket();
    ws1.simulateOpen();

    const msgs = sentMsgs(ws1);
    expect(msgs.some((m) => m.type === 'subscribe' && m.runId === 'r1')).toBe(false);
    expect(msgs.some((m) => m.type === 'resync' && m.runId === 'r1')).toBe(false);

    spy.mockRestore();
  });
});

// ─── lastSeq tracking ──────────────────────────────────────────────────────

describe('EngineClient – lastSeq tracking per runId', () => {
  it('tracks lastSeq from incoming "events" messages and replays it on reconnect', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();
    client.subscribe('r1');

    ws0.simulateMessage({ type: 'events', runId: 'r1', seq: 7, events: [] });

    ws0.simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws1 = lastSocket();
    ws1.simulateOpen();

    const resync = sentMsgs(ws1).find((m) => m.type === 'resync' && m.runId === 'r1');
    expect(resync).toBeDefined();
    expect(resync.lastSeq).toBe(7);

    spy.mockRestore();
  });

  it('tracks lastSeq from incoming "snapshot" messages', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();
    client.subscribe('r1');

    ws0.simulateMessage({
      type: 'snapshot',
      runId: 'r1',
      seq: 12,
      state: createInitialProjection(),
    });

    ws0.simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws1 = lastSocket();
    ws1.simulateOpen();

    const resync = sentMsgs(ws1).find((m) => m.type === 'resync' && m.runId === 'r1');
    expect(resync.lastSeq).toBe(12);

    spy.mockRestore();
  });

  it('uses the most recent seq when multiple messages arrive', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();
    client.subscribe('r1');

    ws0.simulateMessage({ type: 'events', runId: 'r1', seq: 3, events: [] });
    ws0.simulateMessage({ type: 'events', runId: 'r1', seq: 9, events: [] });

    ws0.simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws1 = lastSocket();
    ws1.simulateOpen();

    const resync = sentMsgs(ws1).find((m) => m.type === 'resync' && m.runId === 'r1');
    expect(resync.lastSeq).toBe(9);

    spy.mockRestore();
  });

  it('explicit resync(runId, lastSeq) updates the tracked lastSeq', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();
    client.subscribe('r1');
    client.resync('r1', 99); // explicit override

    ws0.simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws1 = lastSocket();
    ws1.simulateOpen();

    const resync = sentMsgs(ws1).find((m) => m.type === 'resync' && m.runId === 'r1');
    expect(resync.lastSeq).toBe(99);

    spy.mockRestore();
  });

  it('keeps lastSeq independent per runId', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();
    client.subscribe('r1');
    client.subscribe('r2');

    ws0.simulateMessage({ type: 'events', runId: 'r1', seq: 5, events: [] });
    ws0.simulateMessage({ type: 'events', runId: 'r2', seq: 50, events: [] });

    ws0.simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws1 = lastSocket();
    ws1.simulateOpen();

    const msgs = sentMsgs(ws1);
    expect(msgs.find((m) => m.type === 'resync' && m.runId === 'r1').lastSeq).toBe(5);
    expect(msgs.find((m) => m.type === 'resync' && m.runId === 'r2').lastSeq).toBe(50);

    spy.mockRestore();
  });
});

// ─── Exponential backoff reconnection ──────────────────────────────────────

describe('EngineClient – exponential backoff reconnection', () => {
  it('schedules the first reconnect after the default initial delay (1000ms)', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateClose();

    const reconnect = takeReconnectTimer(spy, 1000);
    reconnect(); // fire reconnect
    expect(MockWebSocket.instances).toHaveLength(2);

    spy.mockRestore();
  });

  it('grows the delay on successive closes without a successful open', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();

    // Close 1 → 1000ms (backoff then becomes 1500)
    ws0.simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws1 = lastSocket(); // never opened

    // Close 2 → 1500ms (backoff then becomes 2250)
    ws1.simulateClose();
    takeReconnectTimer(spy, 1500)();
    expect(MockWebSocket.instances).toHaveLength(3);

    spy.mockRestore();
  });

  it('resets backoff to the initial delay after a successful open', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();

    // First close → 1000ms; backoff grows to 1500.
    MockWebSocket.instances[0].simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws1 = lastSocket();
    ws1.simulateOpen(); // ← successful open resets backoff to 1000.

    // Close again → 1000ms (reset), not 1500.
    ws1.simulateClose();
    takeReconnectTimer(spy, 1000)();

    spy.mockRestore();
  });

  it('caps the delay at backoff.max', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({
      url: 'ws://test',
      backoff: { initial: 500, multiplier: 2, max: 1000 },
    });
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();

    // Close 1 → 500ms (backoff → min(1000, 1000) = 1000)
    MockWebSocket.instances[0].simulateClose();
    takeReconnectTimer(spy, 500)();
    const ws1 = lastSocket();

    // Close 2 → 1000ms (capped; backoff stays 1000)
    ws1.simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws2 = lastSocket();

    // Close 3 → still 1000ms (capped)
    ws2.simulateClose();
    takeReconnectTimer(spy, 1000)();

    spy.mockRestore();
  });

  it('honours custom backoff.initial and backoff.multiplier', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({
      url: 'ws://test',
      backoff: { initial: 2000, multiplier: 3, max: 60_000 },
    });
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();

    // Close 1 → 2000ms (backoff → 6000)
    MockWebSocket.instances[0].simulateClose();
    takeReconnectTimer(spy, 2000)();
    const ws1 = lastSocket();

    // Close 2 → 6000ms (2000 * 3)
    ws1.simulateClose();
    takeReconnectTimer(spy, 6000)();

    spy.mockRestore();
  });

  it('resends auth + list_runs on a reconnected socket', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test', authToken: 'tok' });
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();

    MockWebSocket.instances[0].simulateClose();
    takeReconnectTimer(spy, 1000)();
    const ws1 = lastSocket();
    ws1.simulateOpen();

    const msgs = sentMsgs(ws1);
    // Reconnect handshake must re-auth then re-list.
    const authIdx = msgs.findIndex((m) => m.type === 'auth');
    const listIdx = msgs.findIndex((m) => m.type === 'list_runs');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThan(authIdx);
    expect(msgs[authIdx]).toEqual({ type: 'auth', token: 'tok' });

    spy.mockRestore();
  });
});

// ─── Error handling ────────────────────────────────────────────────────────

describe('EngineClient – error handling', () => {
  it('closes the socket when an error occurs', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    ws.simulateError();

    // The onerror handler must have closed the socket.
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(ws.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('routes an error into onDisconnected (via the induced close)', () => {
    const onDisconnected = mock();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onDisconnected }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    ws.simulateError();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });
});

// ─── disconnect() ──────────────────────────────────────────────────────────

describe('EngineClient – disconnect()', () => {
  it('does not schedule a reconnect after a manual disconnect', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();

    client.disconnect();

    // No backoff-range timer (>= 1000ms) should ever have been scheduled.
    const backoffTimers = observedDelays(spy).filter((d) => d >= 1000);
    expect(backoffTimers).toHaveLength(0);
    spy.mockRestore();
  });

  it('closes the socket and reports disconnected', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    expect(client.isConnected()).toBe(true);

    client.disconnect();

    expect(client.isConnected()).toBe(false);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('clears a pending reconnect timer', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const clearSpy = spyOn(globalThis, 'clearTimeout');
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();

    // Non-manual close → schedules a 1000ms reconnect.
    MockWebSocket.instances[0].simulateClose();
    const calls = spy.mock.calls as unknown as Array<[unknown, unknown]>;
    const idx = calls.findIndex((c) => c[1] === 1000);
    expect(idx).toBeGreaterThanOrEqual(0);
    const timerId = spy.mock.results[idx].value;

    client.disconnect();

    expect(clearSpy).toHaveBeenCalledWith(timerId);
    spy.mockRestore();
    clearSpy.mockRestore();
  });

  it('is safe to call more than once (idempotent teardown)', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();

    expect(() => {
      client.disconnect();
      client.disconnect();
    }).not.toThrow();
  });
});

// ─── connect → disconnect → connect cycle ──────────────────────────────────

describe('EngineClient – connect/disconnect/connect cycle', () => {
  it('supports connect, disconnect, then connect again', () => {
    const client = makeClient({ url: 'ws://test' });

    client.connect(makeCallbacks());
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].simulateOpen();
    expect(client.isConnected()).toBe(true);

    client.disconnect();
    expect(client.isConnected()).toBe(false);
    // disconnect must NOT have triggered a reconnect (no extra socket).
    expect(MockWebSocket.instances).toHaveLength(1);

    client.connect(makeCallbacks());
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].simulateOpen();
    expect(client.isConnected()).toBe(true);
  });

  it('re-enables reconnection after a fresh connect() following disconnect()', () => {
    const spy = spyOn(globalThis, 'setTimeout');
    const client = makeClient({ url: 'ws://test' });

    client.connect(makeCallbacks());
    MockWebSocket.instances[0].simulateOpen();
    client.disconnect();

    // Reconnect manually; a subsequent close must schedule a reconnect again
    // (i.e. connect() resets the manual-close flag).
    client.connect(makeCallbacks());
    MockWebSocket.instances[1].simulateOpen();
    MockWebSocket.instances[1].simulateClose();

    expect(() => takeReconnectTimer(spy, 1000)).not.toThrow();

    spy.mockRestore();
  });
});

// ─── requestRuns() ─────────────────────────────────────────────────────────
//
// requestRuns(timeoutMs) sends { type:'list_runs' } and returns a one-shot
// Promise that resolves with the server's active-run list. Behavioural rules:
//   - resolves with the runs array when a 'runs' message arrives;
//   - resolves with [] when not connected / socket not open, or on timeout;
//   - does NOT mutate the user-supplied callbacks.onMessage (regression: an
//     earlier implementation swapped onMessage with a wrapper, which under
//     concurrent calls overwrote the previous wrapper and dropped the first
//     caller's resolver, creating a desync);
//   - keeps forwarding every server message — including the resolving 'runs'
//     message — to the user's onMessage, and keeps firing onRunsChanged;
//   - supports concurrent calls: a single 'runs' message resolves ALL pending
//     requestRuns() promises.

describe('EngineClient – requestRuns()', () => {
  it('sends list_runs and resolves with the runs array on a runs message', async () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.sentMessages.length = 0;

    const runs = [runSummary('r1'), runSummary('r2')];
    const promise = client.requestRuns(1000);

    expect(sentTypes(ws)).toContain('list_runs');

    ws.simulateMessage({ type: 'runs', runs });
    const result = await promise;

    expect(result).toEqual(runs);
  });

  it('resolves with [] immediately when the socket is not open (and sends no list_runs)', async () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    // Socket created but never opened → not connected.
    const ws = MockWebSocket.instances[0];

    const result = await client.requestRuns();

    expect(result).toEqual([]);
    expect(sentTypes(ws)).not.toContain('list_runs');
  });

  it('resolves with [] when no runs message arrives before the timeout', async () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.sentMessages.length = 0;

    const result = await client.requestRuns(50);

    expect(result).toEqual([]);
    expect(sentTypes(ws)).toContain('list_runs');
  });

  it('forwards non-runs messages to onMessage while a request is pending', async () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onMessage }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const promise = client.requestRuns(1000);
    ws.simulateMessage({ type: 'run_complete', runId: 'r1' });
    ws.simulateMessage({ type: 'run_failed', runId: 'r2', error: 'boom', phase: 'exec' });
    ws.simulateMessage({ type: 'runs', runs: [] });
    await promise;

    const seen = onMessage.mock.calls.map((c) => (c[0] as ServerMessage).type);
    expect(seen).toContain('run_complete');
    expect(seen).toContain('run_failed');
  });

  it('forwards the resolving runs message to onMessage (does not swallow it)', async () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onMessage }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const runs = [runSummary('r1')];
    const promise = client.requestRuns(1000);
    ws.simulateMessage({ type: 'runs', runs });
    await promise;

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect((onMessage.mock.calls[0][0] as ServerMessage).type).toBe('runs');
  });

  it('fires onRunsChanged for the runs message that resolves the request', async () => {
    const onRunsChanged = mock<(runs: RunSummary[]) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onRunsChanged }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const runs = [runSummary('r1')];
    const promise = client.requestRuns(1000);
    ws.simulateMessage({ type: 'runs', runs });
    await promise;

    expect(onRunsChanged).toHaveBeenCalledTimes(1);
    expect(onRunsChanged.mock.calls[0][0]).toEqual(runs);
  });

  it('does not mutate the user-supplied callbacks.onMessage reference', async () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const callbacks = makeCallbacks({ onMessage });
    const originalRef = callbacks.onMessage;

    const client = makeClient({ url: 'ws://test' });
    client.connect(callbacks);
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const promise = client.requestRuns(1000);
    // While a request is in flight the user's handler must NOT be swapped out.
    expect(callbacks.onMessage).toBe(originalRef);

    ws.simulateMessage({ type: 'runs', runs: [] });
    await promise;

    // And it must remain the same handler after resolution.
    expect(callbacks.onMessage).toBe(originalRef);
  });

  it('does not permanently intercept onMessage (later messages flow normally)', async () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onMessage }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const promise = client.requestRuns(1000);
    ws.simulateMessage({ type: 'runs', runs: [] });
    await promise;

    onMessage.mockReset();
    ws.simulateMessage({ type: 'run_complete', runId: 'rX' });
    ws.simulateMessage({ type: 'runs', runs: [runSummary('z1')] });

    expect(onMessage).toHaveBeenCalledTimes(2);
  });
});

// ─── requestRuns() concurrency (callback-mutation regression) ──────────────
//
// The headline bug: when requestRuns() was called concurrently, the second
// call overwrote the first call's installed onMessage wrapper. The first
// caller's interceptor was lost, so it never resolved (until its timeout) and
// the two callers fell out of sync. The fix must let a single 'runs' message
// resolve every pending caller without touching the user's callbacks.

describe('EngineClient – requestRuns() concurrency (no callback mutation)', () => {
  it('resolves BOTH concurrent requestRuns() calls from a single runs message', async () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.sentMessages.length = 0;

    const runs = [runSummary('r1'), runSummary('r2')];

    // Two callers issue the request before either has resolved.
    const pA = client.requestRuns(500);
    const pB = client.requestRuns(500);

    // The server may answer both list_runs with a single consolidated message.
    ws.simulateMessage({ type: 'runs', runs });

    const [a, b] = await Promise.all([pA, pB]);

    expect(a).toEqual(runs);
    expect(b).toEqual(runs);
  });

  it('resolves many concurrent requestRuns() calls from a single runs message', async () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const runs = [runSummary('only')];
    const pending = Array.from({ length: 5 }, () => client.requestRuns(500));

    ws.simulateMessage({ type: 'runs', runs });

    const results = await Promise.all(pending);

    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r).toEqual(runs);
    }
  });

  it('sends a list_runs for each concurrent requestRuns() call', () => {
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks());
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.sentMessages.length = 0;

    client.requestRuns(500);
    client.requestRuns(500);
    client.requestRuns(500);

    expect(sentTypes(ws).filter((t) => t === 'list_runs')).toHaveLength(3);
  });

  it('does not mutate callbacks.onMessage while concurrent requests are pending', () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const callbacks = makeCallbacks({ onMessage });
    const originalRef = callbacks.onMessage;

    const client = makeClient({ url: 'ws://test' });
    client.connect(callbacks);
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    // Stack two requests; neither has resolved yet.
    client.requestRuns(500);
    client.requestRuns(500);

    // The second call must NOT have overwritten the first's handler — the
    // user's onMessage reference must be untouched altogether.
    expect(callbacks.onMessage).toBe(originalRef);
  });

  it('keeps delivering messages to onMessage under concurrent requests', async () => {
    const onMessage = mock<(msg: ServerMessage) => void>();
    const client = makeClient({ url: 'ws://test' });
    client.connect(makeCallbacks({ onMessage }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const pA = client.requestRuns(500);
    const pB = client.requestRuns(500);

    // A non-runs message must reach the user even with two requests pending.
    ws.simulateMessage({ type: 'run_complete', runId: 'r1' });
    // The resolving runs message must reach the user too (and resolve both).
    ws.simulateMessage({ type: 'runs', runs: [runSummary('a')] });

    await Promise.all([pA, pB]);

    const seen = onMessage.mock.calls.map((c) => (c[0] as ServerMessage).type);
    expect(seen).toContain('run_complete');
    expect(seen.filter((t) => t === 'runs')).toHaveLength(1);
  });
});
