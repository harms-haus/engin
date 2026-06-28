// ─── Task lifecycle handlers ────────────────────────────────────────────────
//
// Handlers for task registration and status transitions:
// task_registered, task_started, task_completed, task_rejected,
// task_parked, task_unparked.

import type { EventRecord, TaskEntity, TaskStatus, WorkflowProjection } from './event-types.js';
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
        // Store the declared session plan (ordered roles/profiles) so consumers
        // can render all planned sessions + a ●N/M progress counter.
        ...(Array.isArray(event.data.sessionPlan)
          ? { sessionPlan: event.data.sessionPlan as { role: string; profile: string }[] }
          : {}),
      }),
    },
    seq: event.seq,
  });
}

// ─── Shared status transition helper ───────────────────────────────────────

function transitionTaskStatus(
  state: WorkflowProjection,
  event: EventRecord,
  status: TaskStatus,
  extraPatch?: Record<string, unknown>,
): WorkflowProjection {
  const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
  const existing = state.tasks[taskId];
  if (!existing) return clone(state, { seq: event.seq });
  return clone(state, {
    tasks: {
      ...state.tasks,
      [taskId]: clone(existing, { status, ...extraPatch }),
    },
    seq: event.seq,
  });
}

export function handleTaskCompleted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  return transitionTaskStatus(state, event, 'complete', { completedAt: event.metadata.timestamp });
}

export function handleTaskRejected(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  return transitionTaskStatus(state, event, 'failed');
}

export function handleTaskParked(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  return transitionTaskStatus(state, event, 'parked');
}

export function handleTaskUnparked(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  return transitionTaskStatus(state, event, 'active');
}
