// ─── Task lifecycle handlers ────────────────────────────────────────────────
//
// Handlers for task registration and status transitions:
// task_registered, task_started, task_completed, task_rejected,
// task_parked, task_unparked.
//
// Active-time accounting (the task timer):
//   • `elapsedMs` accumulates ACTIVE running time only — wall-clock time spent
//     `parked` (waiting for a gate slot) is excluded.
//   • `activeStartedAt` marks the start of the current active interval; it is
//     set on `task_started` / `task_unparked` and cleared on `task_parked` /
//     terminal transitions.
//   • On every park / terminal transition the just-elapsed active interval is
//     folded into `elapsedMs`.
//   • All timestamps come from `event.metadata.timestamp`, so the projection is
//     deterministic under replay (a fresh `Date.now()` would over-count).
//   Consumers render a live timer for an active task as
//   `elapsedMs + (Date.now() - activeStartedAt)`; parked / terminal tasks show
//   the frozen `elapsedMs`.

import type { EventRecord, TaskEntity, WorkflowProjection } from './event-types.js';
import { clone } from './evolve-utils.js';

/** Parse the event's metadata timestamp to epoch ms (the timing source of truth). */
function eventMs(event: EventRecord): number {
  return Date.parse(event.metadata.timestamp);
}

/**
 * Fold the current active interval (if any) into `elapsedMs` and clear
 * `activeStartedAt`. Returns a patch to spread into the next task entity clone.
 * Idempotent: a no-op when the task is not mid-active-interval.
 */
function closeActiveInterval(existing: TaskEntity, ts: number): Partial<TaskEntity> {
  if (existing.activeStartedAt === undefined) {
    return { activeStartedAt: undefined };
  }
  return {
    elapsedMs: (existing.elapsedMs ?? 0) + Math.max(0, ts - existing.activeStartedAt),
    activeStartedAt: undefined,
  };
}

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
  // task_started fires once per task (ready → active). (Re)start the timer:
  // a fresh active interval begins, and any prior accounting is reset.
  // `startedAt` honours an explicit `data.startedAt` when the engine supplies
  // one (e.g. meta-sessions); otherwise fall back to the event timestamp so
  // the SessionScheduler path — which omits `data.startedAt` — is still timed.
  const ts = typeof event.data.startedAt === 'number' ? event.data.startedAt : eventMs(event);
  return clone(state, {
    tasks: {
      ...state.tasks,
      [taskId]: clone(existing, {
        status: 'active' as const,
        startedAt: ts,
        activeStartedAt: ts,
        elapsedMs: 0,
        parkedAt: undefined,
        completedAt: undefined,
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

export function handleTaskCompleted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
  const existing = state.tasks[taskId];
  if (!existing) return clone(state, { seq: event.seq });
  // Fold the final active interval into elapsedMs before freezing.
  const patch = closeActiveInterval(existing, eventMs(event));
  return clone(state, {
    tasks: {
      ...state.tasks,
      [taskId]: clone(existing, { status: 'complete', completedAt: event.metadata.timestamp, ...patch }),
    },
    seq: event.seq,
  });
}

export function handleTaskRejected(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
  const existing = state.tasks[taskId];
  if (!existing) return clone(state, { seq: event.seq });
  const patch = closeActiveInterval(existing, eventMs(event));
  return clone(state, {
    tasks: {
      ...state.tasks,
      [taskId]: clone(existing, { status: 'failed', ...patch }),
    },
    seq: event.seq,
  });
}

export function handleTaskParked(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
  const existing = state.tasks[taskId];
  if (!existing) return clone(state, { seq: event.seq });
  const ts = eventMs(event);
  // Fold the active interval that just ended into elapsedMs, then freeze.
  const patch = closeActiveInterval(existing, ts);
  return clone(state, {
    tasks: {
      ...state.tasks,
      [taskId]: clone(existing, { status: 'parked', parkedAt: ts, ...patch }),
    },
    seq: event.seq,
  });
}

export function handleTaskUnparked(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const taskId = String(event.data.taskId ?? event.metadata.taskId ?? '');
  const existing = state.tasks[taskId];
  if (!existing) return clone(state, { seq: event.seq });
  const ts = eventMs(event);
  // A new active interval begins; elapsedMs carries over as the baseline.
  return clone(state, {
    tasks: {
      ...state.tasks,
      [taskId]: clone(existing, { status: 'active', activeStartedAt: ts, parkedAt: undefined }),
    },
    seq: event.seq,
  });
}
