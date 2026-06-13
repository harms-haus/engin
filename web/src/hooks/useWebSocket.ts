import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '../protocol-types';
import type { AgentState, AppState } from '../types';
import { isServerMessage } from '../types';
import { agentKey } from '../utils/agent-key';

// ─── Initial state ─────────────────────────────────────────────────────────

const INITIAL_STATE: AppState = {
  currentPhase: '',
  completedPhases: [],
  tasks: [],
  agents: new Map(),
  sidebar: { title: '', indicator: '' },
  status: 'running',
};

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useWebSocket(): {
  state: AppState;
  send: (msg: ClientMessage) => void;
  connected: boolean;
  events: string[];
} {
  const [state, setState] = useState<AppState>(INITIAL_STATE);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // Determine WebSocket URL
  const wsEndpoint = (window as any).__WS_ENDPOINT__ || 'ws://localhost:3619/ws';

  // ─── Helper: append event ──────────────────────────────────────────────
  const addEvent = useCallback((entry: string) => {
    setEvents((prev) => [...prev, entry]);
  }, []);

  // ─── Message handler ───────────────────────────────────────────────────
  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'init': {
          const agents = new Map<string, AgentState>();
          for (const a of msg.agents) {
            const key = agentKey(a.agentId, a.taskId);
            agents.set(key, { ...a, toolCallCount: 0, inputTokens: 0, outputTokens: 0 });
          }
          setState({
            currentPhase: msg.currentPhase,
            completedPhases: msg.completedPhases,
            tasks: msg.tasks,
            agents,
            sidebar: msg.sidebar,
            status: 'running',
          });
          break;
        }
        case 'workflow_phase':
          setState((prev) => ({
            ...prev,
            currentPhase: msg.phase,
            completedPhases: msg.completed,
          }));
          addEvent(`Phase: ${msg.phase}`);
          break;
        case 'workflow_complete':
          setState((prev) => ({ ...prev, status: 'complete' }));
          addEvent('Complete');
          break;
        case 'workflow_failed':
          setState((prev) => ({ ...prev, status: 'failed', error: msg.error }));
          addEvent(`Failed: ${msg.error}`);
          break;
        case 'agent_spawned': {
          const agent = msg.agent;
          const key = agentKey(agent.agentId, agent.taskId);
          setState((prev) => {
            const next = new Map(prev.agents);
            next.set(key, {
              ...agent,
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
            });
            return { ...prev, agents: next };
          });
          addEvent(`Agent ${agent.agentId} spawned`);
          break;
        }
        case 'agent_log': {
          const key = agentKey(msg.agentId, msg.taskId);
          setState((prev) => {
            const agent = prev.agents.get(key);
            if (!agent) return prev;
            const next = new Map(prev.agents);
            next.set(key, { ...agent, log: [...agent.log, msg.entry] });
            return { ...prev, agents: next };
          });
          break;
        }
        case 'agent_complete': {
          const key = agentKey(msg.agentId, msg.taskId);
          setState((prev) => {
            const agent = prev.agents.get(key);
            if (!agent) return prev;
            const next = new Map(prev.agents);
            next.set(key, { ...agent, active: false });
            return { ...prev, agents: next };
          });
          addEvent(`Agent ${msg.agentId} complete`);
          break;
        }
        case 'agent_stats': {
          const key = agentKey(msg.agentId);
          setState((prev) => {
            const agent = prev.agents.get(key);
            if (!agent) return prev;
            const next = new Map(prev.agents);
            next.set(key, {
              ...agent,
              toolCallCount: agent.toolCallCount + (msg.toolCallCount ?? 0),
              inputTokens: agent.inputTokens + (msg.inputTokens ?? 0),
              outputTokens: agent.outputTokens + (msg.outputTokens ?? 0),
            });
            return { ...prev, agents: next };
          });
          break;
        }
        case 'tasks_updated':
          setState((prev) => ({ ...prev, tasks: msg.tasks }));
          break;
        case 'workflow_sidebar':
          setState((prev) => ({ ...prev, sidebar: msg.sidebar }));
          break;
      }
    },
    [addEvent],
  );

  // ─── connect ───────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    const ws = new WebSocket(wsEndpoint);

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (isServerMessage(data)) {
          handleServerMessage(data);
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      // Auto-reconnect after 3 seconds
      setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [wsEndpoint, handleServerMessage]);

  // ─── Connect on mount, clean up on unmount ─────────────────────────────
  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── send ──────────────────────────────────────────────────────────────
  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { state, send, connected, events };
}
