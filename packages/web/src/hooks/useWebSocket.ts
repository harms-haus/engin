/**
 * Thin React adapter over the shared EngineClient. Connection management,
 * exponential-backoff reconnection, resync, and run multiplexing all live in
 * EngineClient (packages/shared); this hook wires it into React via
 * useSyncExternalStore and routes incoming messages into the Zustand
 * workflow-store.
 *
 * The EngineClient instance is a MODULE-LEVEL SINGLETON shared by every caller
 * of `useWebSocket()`. The first caller to mount acquires it; the last caller
 * to unmount tears it down. This guarantees a single live connection per app
 * session regardless of how many components consume the hook — preventing
 * duplicate event application (e.g. doubled agent-log entries) that would
 * occur if each consumer opened its own socket.
 */

import type { EngineClientCallbacks } from '@engin/shared/engine-client';
import { EngineClient } from '@engin/shared/engine-client';
import { useEffect, useSyncExternalStore } from 'react';
import type { ClientMessage, ServerMessage } from '../protocol-types';
import { setStoreSendFn, useWorkflowStore } from '../store/workflow-store';

// ─── Helper: derive WS URL from the environment ───────────────────────────

function deriveWsUrl(): string {
  const configured = window.__WS_ENDPOINT__;
  // Production case: server replaced the placeholder with a real ws/wss URL.
  if (configured && configured !== '{{WS_ENDPOINT}}') {
    return configured;
  }
  // Derive from window.location (works for dev Vite and production observer).
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + window.location.host + '/ws';
}

// ─── Shared connection state (module-level singleton) ──────────────────────

let engineClient: EngineClient | null = null;
let refCount = 0;

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
    case 'runs':
      store.setRuns(msg.runs);
      break;
    case 'run_started':
      store.addRun(msg.summary);
      break;
    case 'snapshot':
      store.applySnapshot(msg.runId, msg.state, msg.seq);
      break;
    case 'events':
      store.applyEvents(msg.runId, msg.events);
      break;
    case 'run_complete':
      store.setStatus(msg.runId, 'complete');
      break;
    case 'run_failed':
      store.setFailed(msg.runId, msg.error, msg.phase);
      break;
    case 'log':
      store.appendRunLog(msg.runId, {
        level: msg.level,
        message: msg.message,
        timestamp: msg.timestamp,
      });
      break;
    case 'error':
      console.error(`[engine] ${msg.code}${msg.runId ? ` (${msg.runId})` : ''}: ${msg.message}`);
      break;
    case 'auth_required':
      // Reserved for future auth enforcement; nothing to project.
      break;
    default:
      break;
  }
}

// ─── EngineClient callbacks ────────────────────────────────────────────────

const engineClientCallbacks: EngineClientCallbacks = {
  onMessage: handleServerMessage,
  onConnected: () => {
    connected = true;
    hasConnectedOnce = true;
    emitChange();
  },
  onDisconnected: () => {
    connected = false;
    emitChange();
  },
};

// ─── EngineClient singleton ────────────────────────────────────────────────

/** Lazily create the shared EngineClient (idempotent). */
function ensureClient(): EngineClient {
  if (engineClient === null) {
    engineClient = new EngineClient({ url: deriveWsUrl() });
  }
  return engineClient;
}

// ─── Ref-counted acquire / release ─────────────────────────────────────────

function acquire(): void {
  refCount++;
  if (refCount === 1) {
    const client = ensureClient();
    client.connect(engineClientCallbacks);
    setStoreSendFn((msg) => client.send(msg));
  }
}

function release(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && engineClient !== null) {
    setStoreSendFn(null);
    // Last consumer gone — tear down and reset all shared state so the next
    // acquire starts fresh (also restores test isolation between cases).
    engineClient.disconnect();
    engineClient = null;
    connected = false;
    hasConnectedOnce = false;
    emitChange();
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useWebSocket(): {
  send: (msg: ClientMessage) => void;
  subscribe: (runId: string) => void;
  unsubscribe: (runId: string) => void;
  resync: (runId: string, lastSeq?: number) => void;
  connected: boolean;
  hasConnectedOnce: boolean;
} {
  const connectedValue = useSyncExternalStore(subscribe, getConnected, getConnected);
  const hasConnectedOnceValue = useSyncExternalStore(subscribe, getHasConnectedOnce, getHasConnectedOnce);

  useEffect(() => {
    acquire();
    return () => release();
  }, []);

  return {
    send: (msg: ClientMessage) => {
      engineClient?.send(msg);
    },
    subscribe: (runId: string) => {
      const client = ensureClient();
      client.subscribe(runId);
      // Catch-up: request a resync carrying the current projection seq so the
      // server replays any missed events for this run.
      client.resync(runId, useWorkflowStore.getState().seq);
    },
    unsubscribe: (runId: string) => {
      ensureClient().unsubscribe(runId);
    },
    resync: (runId: string, lastSeq?: number) => {
      ensureClient().resync(runId, lastSeq);
    },
    connected: connectedValue,
    hasConnectedOnce: hasConnectedOnceValue,
  };
}
