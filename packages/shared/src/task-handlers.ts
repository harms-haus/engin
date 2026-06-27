// ─── Task lifecycle handlers ────────────────────────────────────────────────
//
// Handlers for task registration and status transitions:
// task_registered, task_started, task_completed, task_rejected.

import type { EventRecord, TaskEntity, WorkflowProjection } from './event-types.js';
import { clone } from './evolve-utils.js';

export function handleTaskRegistered(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const taskId = String(event.data.taskId ?? event.data.id ?? '');
  if (!taskId) return clone(state, { seq: event.seq });
  if (state.tasks[taskId]) return clone(state, { seq: event.seq }); // already exists

  const rawDeps = Array.isArray(event.data.dependencies) ? (event.data.dependencies as string[]) : [];

  const entity: TaskEntity = {
    id: taskId,
    title: String(event.data.title ?? ''),
    phaseId: String(event.data.phaseId ?? ''),
    status: 'ready',
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
