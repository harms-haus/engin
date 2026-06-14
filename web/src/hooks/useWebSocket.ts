/**
 * Thin WebSocket transport. Connection management and message routing only;
 * all domain state lives in the Zustand workflow-store.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useWebSocket(): {
  send: (msg: ClientMessage) => void;
  connected: boolean;
  hasConnectedOnce: boolean;
} {
  const [connected, setConnected] = useState(false);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef<number>(BACKOFF_INITIAL);
  const manualCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Message handler ───────────────────────────────────────────────
  const handleServerMessage = useCallback((msg: ServerMessage) => {
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
  }, []);

  // ─── connect ───────────────────────────────────────────────────────
  const connect = useCallback(() => {
    // Reset the manual close flag so reconnections are not blocked
    manualCloseRef.current = false;

    const url = deriveWsUrl();
    const ws = new WebSocket(url);

    ws.onopen = () => {
      setConnected(true);
      setHasConnectedOnce(true);
      // Reset backoff on successful connection
      backoffRef.current = BACKOFF_INITIAL;
      // Request catch-up from the server
      const lastSeq = useWorkflowStore.getState().seq;
      ws.send(JSON.stringify({ type: 'resync', lastSeq } satisfies ClientMessage));
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
      setConnected(false);

      // Do not reconnect if this close was triggered by manual cleanup
      if (manualCloseRef.current) return;

      // Exponential backoff reconnect
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * BACKOFF_MULTIPLIER, BACKOFF_MAX);
      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [handleServerMessage]);

  // ─── Connect on mount, clean up on unmount ─────────────────────────
  useEffect(() => {
    connect();
    return () => {
      manualCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── send ──────────────────────────────────────────────────────────
  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send, connected, hasConnectedOnce };
}
