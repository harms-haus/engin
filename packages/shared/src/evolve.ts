import type {
  AgentEntity,
  EventRecord,
  LogEntry,
  PhaseEntity,
  StepEntity,
  TaskEntity,
  WorkflowProjection,
} from './event-types.js';
import { MAX_RUN_LOG } from './event-types.js';

export const MAX_AGENT_LOG = 500;

/**
 * Stable key for an agent entity.
 * - If taskId is undefined → just agentId (non-task agents like scouts/planners).
 * - If taskId is defined AND stepIndex is defined → agentId::taskId::stepIndex.
 * - If taskId is defined but stepIndex is undefined → agentId::taskId (backward-compatible).
 */
function agentKey(agentId: string, taskId?: string, stepIndex?: number): string {
  if (taskId === undefined) return agentId;
  if (stepIndex !== undefined) return `${agentId}::${taskId}::${stepIndex}`;
  return `${agentId}::${taskId}`;
}

/**
 * Resolve an agent entity by agentId (and optional taskId / stepIndex).
 *
 * 1. Fast path — try exact key match using all available identifiers.
 * 2. Fallback — search all agents for best match:
 *    - Filter by agentId (required) and taskId (if defined).
 *    - Prefer the last active agent (or any matching agent if none active).
 *
 * This unified fallback is critical because events such as `agent_completed`
 * may carry agentId + taskId but NOT stepIndex (legacy events). With per-step
 * keys, the exact-key match would fail, and the fallback ensures resolution.
 */
function resolveAgent(
  agents: Record<string, AgentEntity>,
  agentId: string,
  taskId?: string,
  stepIndex?: number,
): { key: string; entity: AgentEntity } | undefined {
  // 1. Exact key match (fast path)
  const exactKey = agentKey(agentId, taskId, stepIndex);
  if (agents[exactKey]) return { key: exactKey, entity: agents[exactKey] };

  // 2. Search fallback — iterate all agents for best match
  let best: { key: string; entity: AgentEntity } | undefined;
  for (const [k, v] of Object.entries(agents)) {
    if (v.agentId !== agentId) continue;
    if (taskId !== undefined && v.taskId !== taskId) continue;
    if (v.active) {
      best = { key: k, entity: v };
    } else if (!best) {
      best = { key: k, entity: v };
    }
  }
  return best;
}

/** Create a shallow clone with an optional field set. */
function clone<T>(obj: T, patch: Partial<T>): T {
  return { ...obj, ...patch };
}

/**
 * Pure, immutable state transition. Returns a **new** `WorkflowProjection`
 * reflecting the given event.
 */
export function evolve(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
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
        failedPhase:
          typeof event.data.phaseId === 'string'
            ? event.data.phaseId
            : typeof event.data.phase === 'string'
              ? event.data.phase
              : undefined,
        seq: event.seq,
      });

    // ── Phase lifecycle ────────────────────────────────────────────
    case 'phase_registered': {
      const id = String(event.data.id ?? '');
      if (!id) return clone(state, { seq: event.seq });
      // No-op if phase already registered
      if (state.phases.some((p) => p.id === id)) return clone(state, { seq: event.seq });
      const entity: PhaseEntity = {
        id,
        label: String(event.data.label ?? id),
        icon: String(event.data.icon ?? ''),
        taskIds: [],
      };
      return clone(state, {
        phases: [...state.phases, entity],
        seq: event.seq,
      });
    }

    case 'phase_started':
      return clone(state, {
        currentPhaseId: String(event.data.phase ?? event.metadata.phaseId ?? state.currentPhaseId),
        seq: event.seq,
      });

    case 'phase_completed': {
      const phaseId = String(event.data.phase ?? state.currentPhaseId);
      if (phaseId && !state.completedPhaseIds.includes(phaseId)) {
        return clone(state, {
          completedPhaseIds: [...state.completedPhaseIds, phaseId],
          seq: event.seq,
        });
      }
      return clone(state, { seq: event.seq });
    }

    // ── Agent lifecycle ────────────────────────────────────────────
    case 'agent_spawned': {
      const agentId = String(event.metadata.agentId ?? event.data.agentId ?? '');
      const taskId = event.metadata.taskId;
      const stepIndex = event.metadata.stepIndex;
      const key = agentKey(agentId, taskId, stepIndex);
      const existing = state.agents[key];
      // If this agent is associated with a task, copy the task's title.
      const existingTask = taskId ? state.tasks[taskId] : undefined;

      if (existing) {
        // UPSERT: preserve accumulated log/tokens/toolCallCount, update metadata.
        const entity: AgentEntity = {
          ...existing,
          profile: String(event.data.profile ?? existing.profile),
          phaseId: String(event.metadata.phaseId ?? event.data.phaseId ?? existing.phaseId ?? ''),
          stepIndex: stepIndex ?? existing.stepIndex,
          sessionId: typeof event.data.sessionId === 'string' ? event.data.sessionId : existing.sessionId,
          sessionPath: typeof event.data.sessionPath === 'string' ? event.data.sessionPath : existing.sessionPath,
          active: true,
          completedAt: undefined,
          taskTitle: existingTask?.title ?? existing.taskTitle,
        };
        const newAgents = { ...state.agents, [key]: entity };

        // Link agent to task step if applicable
        let newTasks = state.tasks;
        if (taskId !== undefined && stepIndex !== undefined && newTasks[taskId]) {
          const task = newTasks[taskId];
          if (task.steps[stepIndex]) {
            const newSteps = [...task.steps];
            newSteps[stepIndex] = { ...newSteps[stepIndex], agentKey: key };
            newTasks = { ...newTasks, [taskId]: { ...task, steps: newSteps } };
          }
        }

        return clone(state, {
          agents: newAgents,
          tasks: newTasks,
          // Do NOT increment agentCount — this agent was already counted.
          seq: event.seq,
        });
      }

      // First spawn — create fresh entity and increment agentCount.
      const entity: AgentEntity = {
        uid: key,
        agentId,
        profile: String(event.data.profile ?? ''),
        phaseId: String(event.metadata.phaseId ?? event.data.phaseId ?? ''),
        stepIndex,
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
      const newAgents = { ...state.agents, [key]: entity };

      // Link agent to task step if applicable
      let newTasks = state.tasks;
      if (taskId !== undefined && stepIndex !== undefined && newTasks[taskId]) {
        const task = newTasks[taskId];
        if (task.steps[stepIndex]) {
          const newSteps = [...task.steps];
          newSteps[stepIndex] = { ...newSteps[stepIndex], agentKey: key };
          newTasks = { ...newTasks, [taskId]: { ...task, steps: newSteps } };
        }
      }

      return clone(state, {
        agents: newAgents,
        tasks: newTasks,
        stats: { ...state.stats, agentCount: state.stats.agentCount + 1 },
        seq: event.seq,
      });
    }

    case 'agent_completed': {
      const agentId = String(event.metadata.agentId ?? event.data.agentId ?? '');
      const taskId = event.metadata.taskId;
      const resolved = resolveAgent(state.agents, agentId, taskId, event.metadata.stepIndex as number | undefined);
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
    case 'task_registered': {
      const taskId = String(event.data.taskId ?? event.data.id ?? '');
      if (!taskId) return clone(state, { seq: event.seq });
      if (state.tasks[taskId]) return clone(state, { seq: event.seq }); // already exists

      const rawSteps = Array.isArray(event.data.steps) ? (event.data.steps as Record<string, unknown>[]) : [];
      const steps: StepEntity[] = rawSteps.map((s, i) => ({
        name: String(s.name ?? s.profileId ?? ''),
        index: i,
        profile: String(s.profileId ?? s.profile ?? ''),
        isReadOnly: s.isReadOnly === true,
        agentKey: undefined,
      }));

      const rawDeps = Array.isArray(event.data.dependencies) ? (event.data.dependencies as string[]) : [];

      const entity: TaskEntity = {
        id: taskId,
        title: String(event.data.title ?? ''),
        phaseId: String(event.data.phaseId ?? ''),
        status: 'ready',
        steps,
        activeStepIndex: undefined,
        dependencies: rawDeps,
        startedAt: undefined,
        completedAt: undefined,
      };

      const newTasks = { ...state.tasks, [taskId]: entity };

      // Append taskId to the owning PhaseEntity.taskIds
      const phaseId = entity.phaseId;
      let newPhases = state.phases;
      if (phaseId) {
        const phaseIdx = newPhases.findIndex((p) => p.id === phaseId);
        if (phaseIdx !== -1 && !newPhases[phaseIdx].taskIds.includes(taskId)) {
          newPhases = newPhases.map((p, i) => (i === phaseIdx ? { ...p, taskIds: [...p.taskIds, taskId] } : p));
        }
      }

      return clone(state, {
        tasks: newTasks,
        phases: newPhases,
        seq: event.seq,
      });
    }

    case 'task_started': {
      const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
      const existing = state.tasks[taskId];
      if (!existing) return clone(state, { seq: event.seq });
      return clone(state, {
        tasks: {
          ...state.tasks,
          [taskId]: clone(existing, {
            status: 'active' as const,
            startedAt: typeof event.data.startedAt === 'number' ? event.data.startedAt : existing.startedAt,
          }),
        },
        seq: event.seq,
      });
    }

    case 'step_started': {
      const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
      const existing = state.tasks[taskId];
      if (!existing) return clone(state, { seq: event.seq });
      const stepIndex = event.data.stepIndex as number | undefined;
      if (typeof stepIndex !== 'number') return clone(state, { seq: event.seq });

      // Set activeStepIndex
      const update: Partial<TaskEntity> = {
        activeStepIndex: stepIndex,
      };

      // If the agent exists, link it
      const agentId = String(event.metadata.agentId ?? event.data.agentId ?? '');
      if (agentId) {
        const taskIdForAgent = event.metadata.taskId ?? taskId;
        const resolved = resolveAgent(state.agents, agentId, taskIdForAgent, stepIndex);
        if (resolved && existing.steps[stepIndex]) {
          const newSteps = [...existing.steps];
          newSteps[stepIndex] = { ...newSteps[stepIndex], agentKey: resolved.key };
          update.steps = newSteps;
        }
      }

      return clone(state, {
        tasks: {
          ...state.tasks,
          [taskId]: clone(existing, update),
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
            status: 'complete' as const,
            completedAt: event.metadata.timestamp,
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
          [taskId]: clone(existing, { status: 'failed' as const }),
        },
        seq: event.seq,
      });
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
          [key]: clone(existing, { log: capLog(existing.log, entry) }),
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
          [key]: clone(existing, { log: capLog(existing.log, entry) }),
        },
        seq: event.seq,
      });
    }

    case 'agent_rendered': {
      const agentId = String(event.metadata.agentId ?? '');
      const taskId = event.metadata.taskId;
      const resolved = resolveAgent(state.agents, agentId, taskId);
      if (!resolved) return clone(state, { seq: event.seq });
      const { key, entity: existing } = resolved;
      const entry = {
        id: `log-${event.seq}`,
        timestamp: event.metadata.timestamp,
        type: 'render' as const,
        content: String(event.data.rendered ?? ''),
      };
      return clone(state, {
        agents: {
          ...state.agents,
          [key]: clone(existing, { log: capLog(existing.log, entry) }),
        },
        seq: event.seq,
      });
    }

    // ── Turn lifecycle ─────────────────────────────────────────────
    case 'turn_started':
      // No-op — just bump seq
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
        // Preserve tool arguments so renderers (TUI + web) can produce
        // human-readable summaries like `read → ./path` via formatToolCall.
        metadata: {
          toolName: event.data.toolName,
          toolCallId: event.data.toolCallId,
          arguments: event.data.arguments ?? {},
        },
      };
      return clone(state, {
        agents: {
          ...state.agents,
          [key]: clone(existing, {
            log: capLog(existing.log, entry),
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
        metadata: { toolName: event.data.toolName, toolCallId: event.data.toolCallId, isError: event.data.isError },
      };
      return clone(state, {
        agents: {
          ...state.agents,
          [key]: clone(existing, { log: capLog(existing.log, entry) }),
        },
        seq: event.seq,
      });
    }

    // ── Server-captured console output ─────────────────────────────
    case 'log': {
      const level = String(event.data.level ?? 'info');
      const entry: LogEntry = {
        id: `log-${event.seq}`,
        timestamp: event.metadata.timestamp,
        type: level === 'error' ? 'error' : 'text',
        content: String(event.data.message ?? ''),
      };
      const nextRunLog = [...state.runLog, entry];
      return clone(state, {
        runLog: nextRunLog.length > MAX_RUN_LOG ? nextRunLog.slice(nextRunLog.length - MAX_RUN_LOG) : nextRunLog,
        seq: event.seq,
      });
    }

    // ── Sidebar ────────────────────────────────────────────────────
    case 'sidebar_updated': {
      const sidebar = { ...state.sidebar };
      if (event.data.title !== undefined) sidebar.title = String(event.data.title);
      if (event.data.indicator !== undefined) sidebar.indicator = String(event.data.indicator);
      // NOTE: phases is no longer updated via sidebar_updated; use phase_registered instead.
      return clone(state, { sidebar, seq: event.seq });
    }

    default:
      return clone(state, { seq: event.seq });
  }
}

/**
 * Cap the log at MAX_AGENT_LOG. When `entry` is provided the append is folded
 * in, producing a single O(n) allocation instead of a spread + slice.
 */
function capLog(log: AgentEntity['log'], entry?: AgentEntity['log'][number]): AgentEntity['log'] {
  if (entry === undefined) {
    return log.length <= MAX_AGENT_LOG ? log : log.slice(log.length - MAX_AGENT_LOG);
  }
  if (log.length < MAX_AGENT_LOG) {
    return [...log, entry];
  }
  // At capacity — drop oldest + add newest in one allocation.
  return [...log.slice(1), entry];
}
