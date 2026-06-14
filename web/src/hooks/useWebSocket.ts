/**
 * Thin WebSocket transport. Connection management and message routing only;
 * all domain state lives in the Zustand workflow-store.
 *
 * The WebSocket connection is a MODULE-LEVEL SINGLETON shared by every caller
 * of `useWebSocket()`. The first caller to mount acquires it; the last caller
 * to unmount tears it down. This guarantees a single live connection per app
 * session regardless of how many components consume the hook — preventing
 * duplicate event application (e.g. doubled agent-log entries) that would
 * occur if each consumer opened its own socket.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { ClientMessage, ServerMessage } from '../protocol-types';
import { isServerMessage } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';

// ─── Backoff defaults ──────────────────────────────────────────────────────

const BACKOFF_INITIAL = 1000;
const BACKOFF_MULTIPLIER = 1.5;
const BACKOFF_MAX = 30_000;

// ─── Helper: derive WS URL from the environment ───────────────────────────

function deriveWsUrl(): string {
  const configured = (window as any).__WS_ENDPOINT__;
  // Production case: server replaced the placeholder with a real ws/wss URL.
  if (configured && configured !== '{{WS_ENDPOINT}}') {
    return configured;
  }
  // Derive from window.location (works for dev Vite and production observer).
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + window.location.host + '/ws';
}

// ─── Shared connection state (module-level singleton) ──────────────────────

let wsRef: WebSocket | null = null;
let refCount = 0;
let backoff = BACKOFF_INITIAL;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let manualClose = false;

// Reactive slices consumed via useSyncExternalStore.
let connected = false;
let hasConnectedOnce = false;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getConnected = () => connected;
const getHasConnectedOnce = () => hasConnectedOnce;

// ─── Message routing ───────────────────────────────────────────────────────

function handleServerMessage(msg: ServerMessage): void {
  const store = useWorkflowStore.getState();
  switch (msg.type) {
    case 'snapshot':
      store.applySnapshot(msg.state, msg.seq);
      break;
    case 'events':
      store.applyEvents(msg.events);
      break;
    case 'workflow_complete':
      store.setStatus('complete');
      break;
    case 'workflow_failed':
      store.setFailed(msg.error, msg.phase);
      break;
    default:
      break;
  }
}

// ─── Connection lifecycle ──────────────────────────────────────────────────

function connect(): void {
  // Reset the manual close flag so reconnections are not blocked
  manualClose = false;

  const url = deriveWsUrl();
  const ws = new WebSocket(url);

  ws.onopen = () => {
    connected = true;
    hasConnectedOnce = true;
    // Reset backoff on successful connection
    backoff = BACKOFF_INITIAL;
    // Request catch-up from the server
    const lastSeq = useWorkflowStore.getState().seq;
    ws.send(JSON.stringify({ type: 'resync', lastSeq } satisfies ClientMessage));
    emitChange();
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      if (isServerMessage(data)) {
        handleServerMessage(data);
      }
    } catch {
      // Silently ignore unparseable messages
    }
  };

  ws.onclose = () => {
    connected = false;
    emitChange();

    // Do not reconnect if this close was triggered by teardown
    if (manualClose) return;

    // Exponential backoff reconnect
    const delay = backoff;
    backoff = Math.min(delay * BACKOFF_MULTIPLIER, BACKOFF_MAX);
    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  };

  ws.onerror = () => {
    ws.close();
  };

  wsRef = ws;
}

/** Send a client message over the active socket (no-op if not open). */
function send(msg: ClientMessage): void {
  if (wsRef?.readyState === WebSocket.OPEN) {
    wsRef.send(JSON.stringify(msg));
  }
}

// ─── Ref-counted acquire / release ─────────────────────────────────────────

function acquire(): void {
  refCount++;
  if (refCount === 1) connect();
}

function release(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) {
    // Last consumer gone — tear down and reset all shared state so the next
    // acquire starts fresh (also restores test isolation between cases).
    manualClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (wsRef) {
      wsRef.close();
      wsRef = null;
    }
    connected = false;
    hasConnectedOnce = false;
    backoff = BACKOFF_INITIAL;
    emitChange();
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useWebSocket(): {
  send: (msg: ClientMessage) => void;
  connected: boolean;
  hasConnectedOnce: boolean;
} {
  const connectedValue = useSyncExternalStore(subscribe, getConnected, getConnected);
  const hasConnectedOnceValue = useSyncExternalStore(subscribe, getHasConnectedOnce, getHasConnectedOnce);

  useEffect(() => {
    acquire();
    return () => release();
  }, []);

  return { send, connected: connectedValue, hasConnectedOnce: hasConnectedOnceValue };
}
