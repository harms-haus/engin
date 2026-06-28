import { formatElapsed } from '@engin/shared/text-utils';
import React, { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SessionEntity, TaskEntity } from '../protocol-types';
import {
  useHasSnapshot,
  useSelectedPhaseId,
  useSelectedTaskId,
  useTaskById,
  useTaskIds,
  useWorkflowStore,
} from '../store/workflow-store';
import './TaskList.css';

function getStatusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'var(--task-current)';
    case 'complete':
      return 'var(--task-completed)';
    case 'ready':
      return 'var(--task-ready)';
    case 'blocked':
      return 'var(--task-blocked)';
    case 'failed':
      return 'var(--error)';
    case 'cancelled':
      return 'var(--text-muted)';
    case 'parked':
      return 'var(--task-parked)';
    default:
      return 'var(--text-muted)';
  }
}

function sessionProgressLabel(
  taskId: string,
  sessionsById: Record<string, SessionEntity>,
  task?: TaskEntity,
): string | null {
  const count = Object.values(sessionsById).filter((a) => a.taskId === taskId).length;
  // When the task declares a sessionPlan and is in-progress (active/parked),
  // render ●{done}/{total} progress — mirroring the TUI task-list-widget.
  if (
    task &&
    (task.status === 'active' || task.status === 'parked') &&
    task.sessionPlan &&
    task.sessionPlan.length > 0
  ) {
    const total = task.sessionPlan.length;
    const done = Math.min(count, total);
    return `\u25CF${done}/${total}`;
  }
  if (count === 0) return null;
  return `${count} ${count === 1 ? 'session' : 'sessions'}`;
}

/**
 * Elapsed-time hook for a task row.
 *
 * - Terminal / completed: computes from startedAt → completedAt (no interval).
 * - Active: starts a 1-second interval that re-derives elapsed from `Date.now()`.
 * - Parked (F4): FREEZES the display — no interval is started, so the elapsed
 *   value captured at the last render (when the task became parked) persists
 *   without counting wall-clock pause time. The returned `paused` flag lets the
 *   caller apply a visual de-emphasis indicator.
 */
function useElapsed(
  startedAt?: number,
  completedAt?: string,
  status?: string,
): { text: string; paused: boolean } | null {
  const [now, setNow] = useState(() => Date.now());
  const isParked = status === 'parked';
  useEffect(() => {
    if (completedAt === undefined && !isParked) {
      const interval = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(interval);
    }
  }, [startedAt, completedAt, isParked]);
  if (startedAt === undefined) return null;
  const endTime = completedAt !== undefined ? new Date(completedAt).getTime() : now;
  return { text: formatElapsed(endTime - startedAt), paused: isParked };
}

const Task = React.memo(function Task({ taskId }: { taskId: string }) {
  const task = useTaskById(taskId);
  const selectedTaskId = useSelectedTaskId();
  const selectTask = useWorkflowStore((s) => s.selectTask);
  const tasksById = useWorkflowStore((s) => s.tasksById);
  const sessionsById = useWorkflowStore((s) => s.sessionsById);
  const elapsed = useElapsed(task?.startedAt, task?.completedAt, task?.status);

  if (!task) return null;

  const isSelected = taskId === selectedTaskId;
  const sessionLabel = sessionProgressLabel(task.id, sessionsById, task);

  return (
    <button
      type="button"
      className={`task-list__task${isSelected ? ' task-list__task--selected' : ''}`}
      style={{ borderLeftColor: getStatusColor(task.status) }}
      aria-label={`${task.title} — ${task.status}`}
      onClick={() => selectTask(task.id)}
    >
      <div className="task-list__body">
        <span className="task-list__title">{task.title}</span>
        {sessionLabel && <span className="task-list__sessions">{sessionLabel}</span>}
        {elapsed !== null && (
          <span className={`task-list__elapsed${elapsed.paused ? ' task-list__elapsed--paused' : ''}`}>
            {elapsed.paused ? '\u23F8 ' : ''}
            {elapsed.text}
          </span>
        )}
        {task.dependencies.length > 0 && (
          <span className="task-list__deps">
            {'deps: '}
            {task.dependencies.map((depId, idx) => (
              <React.Fragment key={depId}>
                {idx > 0 ? ', ' : ''}
                <span
                  className={
                    tasksById[depId]?.status === 'complete' ? 'task-list__dep--done' : 'task-list__dep--pending'
                  }
                >
                  {depId}
                </span>
              </React.Fragment>
            ))}
          </span>
        )}
      </div>
    </button>
  );
});

export function TaskList() {
  const selectedPhaseId = useSelectedPhaseId();
  const taskIds = useTaskIds();
  const tasksById = useWorkflowStore(useShallow((s) => s.tasksById));
  const hasSnapshot = useHasSnapshot();

  const filteredIds = useMemo(() => {
    if (!selectedPhaseId) return [];
    return taskIds.filter((id) => tasksById[id]?.phaseId === selectedPhaseId);
  }, [taskIds, tasksById, selectedPhaseId]);

  if (!hasSnapshot) {
    return <div className="task-list task-list--empty">Connecting to workflow…</div>;
  }

  if (!selectedPhaseId) {
    return <div className="task-list task-list--empty">No phase selected</div>;
  }

  if (filteredIds.length === 0) {
    return <div className="task-list task-list--empty">No tasks in this phase</div>;
  }

  return (
    <div className="task-list">
      {filteredIds.map((id) => (
        <Task key={id} taskId={id} />
      ))}
    </div>
  );
}
