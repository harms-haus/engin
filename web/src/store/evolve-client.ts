/**
 * Mirror of src/tracking/evolve.ts — keep in sync.
 *
 * Pure, immutable client-side state transition. Operates on plain Record
 * objects (no Maps) and produces a new WorkflowProjection for each event.
 */

import type { AgentEntity, EventRecord, TaskEntity, WorkflowProjection } from '../protocol-types';

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_AGENT_LOG = 500;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Stable key for an agent entity: agentId::taskId, or just agentId if no task. */
function agentKey(agentId: string, taskId?: string): string {
  return taskId ? `${agentId}::${taskId}` : agentId;
}

/**
 * Resolve an agent entity by agentId (and optional taskId).
 * When only agentId is available (e.g. turn/tool-call callbacks), finds
 * the active agent for that agentId, preferring the last spawned.
 */
function resolveAgent(
  agents: Record<string, AgentEntity>,
  agentId: string,
  taskId?: string,
): { key: string; entity: AgentEntity } | undefined {
  // 1. Exact key match (fast path)
  const exactKey = agentKey(agentId, taskId);
  if (agents[exactKey]) return { key: exactKey, entity: agents[exactKey] };

  // 2. Without taskId — search for best match
  if (!taskId) {
    let best: { key: string; entity: AgentEntity } | undefined;
    for (const [k, v] of Object.entries(agents)) {
      if (v.agentId !== agentId) continue;
      if (v.active) {
        best = { key: k, entity: v };
      } else if (!best) {
        best = { key: k, entity: v };
      }
    }
    return best;
  }

  return undefined;
}

/** Create a shallow clone with an optional field set. */
function clone<T>(obj: T, patch: Partial<T>): T {
  return { ...obj, ...patch };
}

/** Drop oldest entries to cap the log at MAX_AGENT_LOG. */
function capLog(log: AgentEntity['log']): AgentEntity['log'] {
  if (log.length <= MAX_AGENT_LOG) return log;
  return log.slice(log.length - MAX_AGENT_LOG);
}

// ─── Main evolve function ───────────────────────────────────────────────────

export function evolveClient(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  switch (event.type) {
    // ── Workflow lifecycle ──────────────────────────────────────────
    case 'workflow_started':
      return clone(state, {
        taskPrompt: String(event.data.taskPrompt ?? ''),
        status: 'running' as const,
        seq: event.seq,
      });

    case 'workflow_completed':
      return clone(state, { status: 'complete' as const, seq: event.seq });

    case 'workflow_failed':
      return clone(state, {
        status: 'failed' as const,
        error: typeof event.data.error === 'string' ? event.data.error : String(event.data.error ?? ''),
        failedPhase: typeof event.data.phase === 'string' ? event.data.phase : undefined,
        seq: event.seq,
      });

    // ── Phase lifecycle ────────────────────────────────────────────
    case 'phase_started':
      return clone(state, {
        currentPhase: String(event.data.phase ?? ''),
        seq: event.seq,
      });

    case 'phase_completed': {
      const phase = String(event.data.phase ?? state.currentPhase);
      if (phase && !state.completedPhases.includes(phase)) {
        return clone(state, {
          completedPhases: [...state.completedPhases, phase],
          seq: event.seq,
        });
      }
      return clone(state, { seq: event.seq });
    }

    // ── Agent lifecycle ────────────────────────────────────────────
    case 'agent_spawned': {
      const agentId = String(event.metadata.agentId ?? event.data.agentId ?? '');
      const taskId = event.metadata.taskId;
      const key = agentKey(agentId, taskId);
      const existing = state.agents[key];
      const existingTask = taskId ? state.tasks[taskId] : undefined;

      if (existing) {
        // UPSERT: preserve accumulated log/tokens/toolCallCount, update metadata.
        const entity: AgentEntity = {
          ...existing,
          profile: String(event.data.profile ?? existing.profile),
          phase: String(event.metadata.phase ?? existing.phase),
          sessionId: typeof event.data.sessionId === 'string' ? event.data.sessionId : existing.sessionId,
          sessionPath: typeof event.data.sessionPath === 'string' ? event.data.sessionPath : existing.sessionPath,
          active: true,
          completedAt: undefined,
          taskTitle: existingTask?.title ?? existing.taskTitle,
        };
        return clone(state, {
          agents: { ...state.agents, [key]: entity },
          seq: event.seq,
        });
      }

      // First spawn — create fresh entity and increment agentCount.
      const entity: AgentEntity = {
        uid: key,
        agentId,
        profile: String(event.data.profile ?? ''),
        phase: String(event.metadata.phase ?? ''),
        taskId,
        sessionId: typeof event.data.sessionId === 'string' ? event.data.sessionId : undefined,
        sessionPath: typeof event.data.sessionPath === 'string' ? event.data.sessionPath : undefined,
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: existingTask?.title ?? '',
      };
      return clone(state, {
        agents: { ...state.agents, [key]: entity },
        stats: { ...state.stats, agentCount: state.stats.agentCount + 1 },
        seq: event.seq,
      });
    }

    case 'agent_completed': {
      const agentId = String(event.metadata.agentId ?? event.data.agentId ?? '');
      const taskId = event.metadata.taskId;
      const resolved = resolveAgent(state.agents, agentId, taskId);
      if (!resolved) return clone(state, { seq: event.seq });
      const { key, entity: existing } = resolved;
      return clone(state, {
        agents: {
          ...state.agents,
          [key]: clone(existing, { active: false, completedAt: event.metadata.timestamp }),
        },
        seq: event.seq,
      });
    }

    // ── Task lifecycle ─────────────────────────────────────────────
    case 'task_started': {
      const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
      const existing = state.tasks[taskId];
      const entity: TaskEntity = {
        id: taskId,
        title: String(event.data.title ?? existing?.title ?? ''),
        status: 'implementing',
        phase: event.metadata.phase ?? existing?.phase,
        agentId: String(event.data.agentId ?? event.metadata.agentId ?? existing?.agentId ?? ''),
        startedAt: typeof event.data.startedAt === 'number' ? event.data.startedAt : existing?.startedAt,
        stepInfo: existing?.stepInfo,
      };
      return clone(state, {
        tasks: { ...state.tasks, [taskId]: entity },
        seq: event.seq,
      });
    }

    case 'task_step_started': {
      const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
      const existing = state.tasks[taskId];
      if (!existing) return clone(state, { seq: event.seq });
      return clone(state, {
        tasks: {
          ...state.tasks,
          [taskId]: clone(existing, { stepInfo: String(event.data.stepName ?? '') }),
        },
        seq: event.seq,
      });
    }

    case 'task_completed': {
      const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
      const existing = state.tasks[taskId];
      if (!existing) return clone(state, { seq: event.seq });
      return clone(state, {
        tasks: {
          ...state.tasks,
          [taskId]: clone(existing, {
            status: 'done',
            completedAt: event.metadata.timestamp,
            stepInfo: undefined,
          }),
        },
        seq: event.seq,
      });
    }

    case 'task_rejected': {
      const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
      const existing = state.tasks[taskId];
      if (!existing) return clone(state, { seq: event.seq });
      return clone(state, {
        tasks: {
          ...state.tasks,
          [taskId]: clone(existing, { status: 'failed' }),
        },
        seq: event.seq,
      });
    }

    case 'tasks_added': {
      const incoming = Array.isArray(event.data.tasks) ? (event.data.tasks as Record<string, unknown>[]) : [];
      const tasks = { ...state.tasks };
      for (const t of incoming) {
        const id = String(t.id ?? '');
        if (!id) continue;
        if (!tasks[id]) {
          tasks[id] = {
            id,
            title: String(t.title ?? ''),
            status: String(t.status ?? 'ready'),
            phase: typeof t.phase === 'string' ? t.phase : undefined,
            agentId: typeof t.agentId === 'string' ? t.agentId : undefined,
            startedAt: typeof t.startedAt === 'number' ? t.startedAt : undefined,
            stepInfo: typeof t.stepInfo === 'string' ? t.stepInfo : undefined,
          };
        }
      }
      return clone(state, { tasks, seq: event.seq });
    }

    // ── Agent log / decisions / errors ─────────────────────────────
    case 'decision': {
      const agentId = String(event.metadata.agentId ?? '');
      const taskId = event.metadata.taskId;
      const resolved = resolveAgent(state.agents, agentId, taskId);
      if (!resolved) return clone(state, { seq: event.seq });
      const { key, entity: existing } = resolved;
      const entry = {
        id: `log-${event.seq}`,
        timestamp: event.metadata.timestamp,
        type: 'decision' as const,
        content: String(event.data.decision ?? ''),
        metadata: { reasoning: event.data.reasoning },
      };
      return clone(state, {
        agents: {
          ...state.agents,
          [key]: clone(existing, { log: capLog([...existing.log, entry]) }),
        },
        seq: event.seq,
      });
    }

    case 'error': {
      const agentId = String(event.metadata.agentId ?? '');
      const taskId = event.metadata.taskId;
      const resolved = resolveAgent(state.agents, agentId, taskId);
      if (!resolved) return clone(state, { seq: event.seq });
      const { key, entity: existing } = resolved;
      const entry = {
        id: `log-${event.seq}`,
        timestamp: event.metadata.timestamp,
        type: 'error' as const,
        content: String(event.data.error ?? ''),
      };
      return clone(state, {
        agents: {
          ...state.agents,
          [key]: clone(existing, { log: capLog([...existing.log, entry]) }),
        },
        seq: event.seq,
      });
    }

    // ── Turn lifecycle ─────────────────────────────────────────────
    case 'turn_started':
      return clone(state, { seq: event.seq });

    case 'turn_ended': {
      const agentId = String(event.metadata.agentId ?? '');
      const taskId = event.metadata.taskId;
      const resolved = resolveAgent(state.agents, agentId, taskId);
      if (!resolved) return clone(state, { seq: event.seq });
      const { key, entity: existing } = resolved;

      const tokens = event.data.tokens as { input?: number; output?: number } | undefined;
      const blocks = Array.isArray(event.data.contentBlocks)
        ? (event.data.contentBlocks as Record<string, unknown>[])
        : [];

      const newLog = [...existing.log];
      for (const block of blocks) {
        const blockType = String(block.type ?? '');
        if (blockType === 'text') {
          newLog.push({
            id: `log-${event.seq}-${newLog.length}`,
            timestamp: event.metadata.timestamp,
            type: 'text',
            content: String(block.text ?? ''),
          });
        } else if (blockType === 'thinking') {
          newLog.push({
            id: `log-${event.seq}-${newLog.length}`,
            timestamp: event.metadata.timestamp,
            type: 'thinking',
            content: String(block.thinking ?? ''),
          });
        }
      }

      const inputTokens = existing.inputTokens + (tokens?.input ?? 0);
      const outputTokens = existing.outputTokens + (tokens?.output ?? 0);

      return clone(state, {
        agents: {
          ...state.agents,
          [key]: clone(existing, { log: capLog(newLog), inputTokens, outputTokens }),
        },
        stats: {
          ...state.stats,
          totalTokens: state.stats.totalTokens + (tokens?.input ?? 0) + (tokens?.output ?? 0),
        },
        seq: event.seq,
      });
    }

    // ── Tool call lifecycle ────────────────────────────────────────
    case 'tool_call_started': {
      const agentId = String(event.metadata.agentId ?? '');
      const taskId = event.metadata.taskId;
      const resolved = resolveAgent(state.agents, agentId, taskId);
      if (!resolved) return clone(state, { seq: event.seq });
      const { key, entity: existing } = resolved;
      const entry = {
        id: `log-${event.seq}`,
        timestamp: event.metadata.timestamp,
        type: 'tool_call_start' as const,
        content: String(event.data.toolName ?? ''),
        metadata: { toolName: event.data.toolName, toolCallId: event.data.toolCallId },
      };
      return clone(state, {
        agents: {
          ...state.agents,
          [key]: clone(existing, {
            log: capLog([...existing.log, entry]),
            toolCallCount: existing.toolCallCount + 1,
          }),
        },
        seq: event.seq,
      });
    }

    case 'tool_call_ended': {
      const agentId = String(event.metadata.agentId ?? '');
      const taskId = event.metadata.taskId;
      const resolved = resolveAgent(state.agents, agentId, taskId);
      if (!resolved) return clone(state, { seq: event.seq });
      const { key, entity: existing } = resolved;
      const entry = {
        id: `log-${event.seq}`,
        timestamp: event.metadata.timestamp,
        type: 'tool_call_end' as const,
        content: String(event.data.toolName ?? ''),
        metadata: {
          toolName: event.data.toolName,
          toolCallId: event.data.toolCallId,
          isError: event.data.isError,
        },
      };
      return clone(state, {
        agents: {
          ...state.agents,
          [key]: clone(existing, { log: capLog([...existing.log, entry]) }),
        },
        seq: event.seq,
      });
    }

    // ── Sidebar ────────────────────────────────────────────────────
    case 'sidebar_updated': {
      const sidebar = { ...state.sidebar };
      if (event.data.title !== undefined) sidebar.title = String(event.data.title);
      if (event.data.indicator !== undefined) sidebar.indicator = String(event.data.indicator);
      if (event.data.phases !== undefined) {
        sidebar.phases = event.data.phases as WorkflowProjection['sidebar']['phases'];
      }
      return clone(state, { sidebar, seq: event.seq });
    }

    default:
      return clone(state, { seq: event.seq });
  }
}
