import { formatElapsed } from '@engin/shared/text-utils';
import React, { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SessionEntity } from '../protocol-types';
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
    default:
      return 'var(--text-muted)';
  }
}

function sessionCountLabel(taskId: string, sessionsById: Record<string, SessionEntity>): string | null {
  const count = Object.values(sessionsById).filter((a) => a.taskId === taskId).length;
  if (count === 0) return null;
  return `${count} ${count === 1 ? 'session' : 'sessions'}`;
}

function useElapsed(startedAt?: number, completedAt?: string): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (completedAt === undefined) {
      const interval = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(interval);
    }
  }, [startedAt, completedAt]);
  if (startedAt === undefined) return null;
  const endTime = completedAt !== undefined ? new Date(completedAt).getTime() : now;
  return formatElapsed(endTime - startedAt);
}

const Task = React.memo(function Task({ taskId }: { taskId: string }) {
  const task = useTaskById(taskId);
  const selectedTaskId = useSelectedTaskId();
  const selectTask = useWorkflowStore((s) => s.selectTask);
  const tasksById = useWorkflowStore((s) => s.tasksById);
  const sessionsById = useWorkflowStore((s) => s.sessionsById);
  const elapsed = useElapsed(task?.startedAt, task?.completedAt);

  if (!task) return null;

  const isSelected = taskId === selectedTaskId;
  const sessionLabel = sessionCountLabel(task.id, sessionsById);

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
        {elapsed !== null && <span className="task-list__elapsed">{elapsed}</span>}
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
