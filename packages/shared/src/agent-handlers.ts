// ─── Agent lifecycle handlers ───────────────────────────────────────────────
//
// Handlers for agent spawning, completion, and turn-level events:
// agent_spawned, agent_completed, turn_started, turn_ended.

import type { AgentEntity, EventRecord, WorkflowProjection } from './event-types.js';
import { agentKey, capLog, clone, resolveAgent } from './evolve-utils.js';

export function handleAgentSpawned(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
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
      contextWindow: typeof event.data.contextWindow === 'number' ? event.data.contextWindow : existing.contextWindow,
      startedAt: existing.startedAt ?? event.metadata.timestamp,
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
    contextWindow: typeof event.data.contextWindow === 'number' ? event.data.contextWindow : undefined,
    startedAt: event.metadata.timestamp,
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

export function handleAgentCompleted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
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

export function handleTurnStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  // No-op — just bump seq
  return clone(state, { seq: event.seq });
}

export function handleTurnEnded(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const agentId = String(event.metadata.agentId ?? '');
  const taskId = event.metadata.taskId;
  const resolved = resolveAgent(state.agents, agentId, taskId);
  if (!resolved) return clone(state, { seq: event.seq });
  const { key, entity: existing } = resolved;

  const tokens = event.data.tokens as { input?: number; output?: number } | undefined;
  const blocks = Array.isArray(event.data.contentBlocks) ? (event.data.contentBlocks as Record<string, unknown>[]) : [];

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
