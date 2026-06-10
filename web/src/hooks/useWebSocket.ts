import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppGlobalState, ClientMessage, ServerMessage, WorkflowSummary } from '../types';
import { isServerMessage } from '../types';

export function useWebSocket() {
  const [state, setState] = useState<AppGlobalState>({
    workflows: [],
    selectedRunId: null,
    runStates: new Map(),
  });

  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    // Determine WS URL
    const wsEndpoint =
      (typeof window !== 'undefined' && (window as { __WS_ENDPOINT__?: string }).__WS_ENDPOINT__) ||
      'ws://localhost:3619/ws';

    const ws = new WebSocket(wsEndpoint);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data: unknown = JSON.parse(event.data as string);
        if (!isServerMessage(data)) {
          console.warn('Received invalid message from server', data);
          return;
        }
        handleServerMessage(data);
      } catch (err) {
        console.error('Failed to parse WebSocket message', err);
      }
    };

    ws.onerror = (error: Event) => {
      console.error('WebSocket error', error);
    };

    ws.onclose = () => {
      setConnected(false);
      console.log('WebSocket disconnected, reconnecting in 3s...');
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 3000);
    };
  }, []);

  function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'init': {
        setState((prev) => ({
          ...prev,
          workflows: msg.workflows,
        }));
        break;
      }
      case 'workflow_started': {
        setState((prev) => ({
          ...prev,
          workflows: [...prev.workflows, msg.summary],
          runStates: new Map(prev.runStates).set(msg.summary.id, {
            summary: msg.summary,
            agents: new Map(),
            currentPhase: '',
            completedPhases: [],
          }),
        }));
        break;
      }
      case 'workflow_sidebar': {
        setState((prev) => ({
          ...prev,
          workflows: prev.workflows.map((w) => (w.id === msg.workflowId ? { ...w, sidebar: msg.sidebar } : w)),
        }));
        break;
      }
      case 'workflow_phase': {
        setState((prev) => {
          const runStates = new Map(prev.runStates);
          const existing = runStates.get(msg.workflowId);
          if (existing) {
            runStates.set(msg.workflowId, {
              ...existing,
              currentPhase: msg.phase,
              completedPhases: msg.completed,
            });
          }
          return { ...prev, runStates };
        });
        break;
      }
      case 'workflow_complete': {
        setState((prev) => ({
          ...prev,
          workflows: prev.workflows.map((w) =>
            w.id === msg.summary.id ? { ...w, status: msg.summary.status, completedAt: msg.summary.completedAt } : w,
          ),
        }));
        break;
      }
      case 'workflow_failed': {
        setState((prev) => ({
          ...prev,
          workflows: prev.workflows.map((w) =>
            w.id === msg.summary.id ? { ...w, status: msg.summary.status, completedAt: msg.summary.completedAt } : w,
          ),
        }));
        break;
      }
      case 'agent_spawned': {
        setState((prev) => {
          const runStates = new Map(prev.runStates);
          const existing = runStates.get(msg.workflowId);
          if (existing) {
            const agents = new Map(existing.agents);
            agents.set(msg.agent.agentId, msg.agent);
            runStates.set(msg.workflowId, { ...existing, agents });
          } else {
            // Create new run state if not exists
            const workflow = prev.workflows.find((w) => w.id === msg.workflowId) as WorkflowSummary | undefined;
            runStates.set(msg.workflowId, {
              summary: workflow as WorkflowSummary,
              agents: new Map([[msg.agent.agentId, msg.agent]]),
              currentPhase: '',
              completedPhases: [],
            });
          }
          return { ...prev, runStates };
        });
        break;
      }
      case 'agent_log': {
        setState((prev) => {
          const runStates = new Map(prev.runStates);
          const runState = runStates.get(msg.workflowId);
          if (runState) {
            const agents = new Map(runState.agents);
            const agent = agents.get(msg.agentId);
            if (agent) {
              agents.set(msg.agentId, {
                ...agent,
                log: [...agent.log, msg.entry],
              });
            }
            runStates.set(msg.workflowId, { ...runState, agents });
          }
          return { ...prev, runStates };
        });
        break;
      }
      case 'agent_complete': {
        setState((prev) => {
          const runStates = new Map(prev.runStates);
          const runState = runStates.get(msg.workflowId);
          if (runState) {
            const agents = new Map(runState.agents);
            const agent = agents.get(msg.agentId);
            if (agent) {
              agents.set(msg.agentId, { ...agent, active: false });
            }
            runStates.set(msg.workflowId, { ...runState, agents });
          }
          return { ...prev, runStates };
        });
        break;
      }
      default: {
        // Exhaustiveness check for compile-time safety
        const _exhaustive: never = msg;
        console.warn('Unhandled server message type', _exhaustive);
        break;
      }
    }
  }

  const send = useCallback((msg: ClientMessage) => {
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  const selectRun = useCallback(
    (runId: string) => {
      setState((prev) => ({ ...prev, selectedRunId: runId }));
      send({ type: 'select_workflow', workflowId: runId });
    },
    [send],
  );

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { state, send, selectRun, connected };
}
