import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppGlobalState, ClientMessage, ServerMessage, WorkflowRunState } from '../types';
import { isServerMessage } from '../types';
import { agentKey } from '../utils/agent-key';

/**
 * Look up an agent in the agents Map using composite-key logic.
 *
 * If taskId is provided the lookup uses the composite key directly.
 * Otherwise it tries the bare agentId first (backward compat) and then
 * falls back to the first active agent with that agentId, or the last
 * match if none are active.
 */
function findAgentEntry(
  agents: Map<string, import('../types').AgentWindowState>,
  agentId: string,
  taskId?: string,
): [string, import('../types').AgentWindowState] | undefined {
  if (taskId) {
    const key = agentKey(agentId, taskId);
    const agent = agents.get(key);
    return agent ? [key, agent] : undefined;
  }

  // Try bare key first (backward compat with agents that have no taskId)
  const bare = agents.get(agentId);
  if (bare) return [agentId, bare];

  // Fall back to iterating — prefer first active, else last match
  let lastMatch: [string, import('../types').AgentWindowState] | undefined;
  for (const [key, agent] of agents) {
    if (agent.agentId === agentId) {
      if (agent.active) return [key, agent];
      lastMatch = [key, agent];
    }
  }
  return lastMatch;
}

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
        const runStates = new Map<string, WorkflowRunState>();
        for (const w of msg.workflows) {
          runStates.set(w.id, {
            summary: w,
            agents: new Map(),
            currentPhase: '',
            completedPhases: [],
          });
        }
        setState((prev) => ({ ...prev, workflows: msg.workflows, runStates }));
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
        setState((prev) => {
          const workflows = prev.workflows.map((w) => (w.id === msg.workflowId ? { ...w, sidebar: msg.sidebar } : w));
          const runStates = new Map(prev.runStates);
          const existing = runStates.get(msg.workflowId);
          if (existing) {
            runStates.set(msg.workflowId, {
              ...existing,
              summary: { ...existing.summary, sidebar: msg.sidebar },
            });
          }
          return { ...prev, workflows, runStates };
        });
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
      case 'workflow_complete':
      case 'workflow_failed': {
        setState((prev) => {
          const workflows = prev.workflows.map((w) =>
            w.id === msg.summary.id ? { ...w, status: msg.summary.status, completedAt: msg.summary.completedAt } : w,
          );
          const runStates = new Map(prev.runStates);
          const existing = runStates.get(msg.summary.id);
          if (existing) {
            const update: WorkflowRunState = {
              ...existing,
              summary: { ...existing.summary, status: msg.summary.status, completedAt: msg.summary.completedAt },
            };
            if (msg.type === 'workflow_failed') {
              update.error = msg.error;
            }
            runStates.set(msg.summary.id, update);
          }
          return { ...prev, workflows, runStates };
        });
        break;
      }
      case 'agent_spawned': {
        setState((prev) => {
          const runStates = new Map(prev.runStates);
          const existing = runStates.get(msg.workflowId);
          const key = agentKey(msg.agent.agentId, msg.agent.taskId);
          if (existing) {
            const agents = new Map(existing.agents);
            agents.set(key, msg.agent);
            runStates.set(msg.workflowId, { ...existing, agents });
          } else {
            const workflow = prev.workflows.find((w) => w.id === msg.workflowId);
            if (!workflow) {
              return prev;
            }
            runStates.set(msg.workflowId, {
              summary: workflow,
              agents: new Map([[key, msg.agent]]),
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
            const found = findAgentEntry(agents, msg.agentId, msg.taskId);
            if (found) {
              const [key, agent] = found;
              agents.set(key, {
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
            const found = findAgentEntry(agents, msg.agentId, msg.taskId);
            if (found) {
              const [key, agent] = found;
              agents.set(key, { ...agent, active: false });
            }
            runStates.set(msg.workflowId, { ...runState, agents });
          }
          return { ...prev, runStates };
        });
        break;
      }
      case 'load_past_run': {
        setState((prev) => {
          const runStates = new Map(prev.runStates);
          const agentsMap = new Map(msg.agents.map((a) => [agentKey(a.agentId, a.taskId), a]));
          runStates.set(msg.workflowId, {
            summary: msg.summary,
            agents: agentsMap,
            currentPhase: msg.currentPhase,
            completedPhases: msg.completedPhases,
          });
          return { ...prev, runStates, selectedRunId: msg.workflowId };
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
