// ─── Task lifecycle handlers ────────────────────────────────────────────────
//
// Handlers for task registration, status transitions, and step linking:
// task_registered, task_started, step_started, task_completed, task_rejected.

import type { EventRecord, StepEntity, TaskEntity, WorkflowProjection } from './event-types.js';
import { clone, resolveAgent } from './evolve-utils.js';

export function handleTaskRegistered(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
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

export function handleTaskStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
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

export function handleStepStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
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

export function handleTaskCompleted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
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

export function handleTaskRejected(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
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
