import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useHasSnapshot,
  useSelectedPhaseId,
  useSelectedTaskId,
  useTaskById,
  useTaskIds,
  useWorkflowStore,
} from '../store/workflow-store';
import './TaskList.css';

const STATUS_PRIORITY: Record<string, number> = {
  active: 0,
  ready: 1,
  blocked: 2,
  complete: 3,
  failed: 3,
  cancelled: 3,
};

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

function stepLabel(task: { steps: { name: string; index: number }[]; activeStepIndex?: number }): string | null {
  if (task.activeStepIndex === undefined) return null;
  const total = task.steps.length;
  const current = task.activeStepIndex;
  const step = task.steps[current];
  if (!step) return null;
  return `step ${current + 1}/${total}: ${step.name}`;
}

const Task = React.memo(function Task({ taskId }: { taskId: string }) {
  const task = useTaskById(taskId);
  const selectedTaskId = useSelectedTaskId();
  const selectTask = useWorkflowStore((s) => s.selectTask);

  if (!task) return null;

  const isSelected = taskId === selectedTaskId;
  const label = stepLabel(task);

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
        {task.status === 'active' && label && <span className="task-list__step">{label}</span>}
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

  const sortedIds = useMemo(() => {
    return [...filteredIds].sort((a, b) => {
      const sa = STATUS_PRIORITY[tasksById[a]?.status] ?? 99;
      const sb = STATUS_PRIORITY[tasksById[b]?.status] ?? 99;
      return sa - sb;
    });
  }, [filteredIds, tasksById]);

  if (!hasSnapshot) {
    return <div className="task-list task-list--empty">Connecting to workflow…</div>;
  }

  if (!selectedPhaseId) {
    return <div className="task-list task-list--empty">No phase selected</div>;
  }

  if (sortedIds.length === 0) {
    return <div className="task-list task-list--empty">No tasks in this phase</div>;
  }

  return (
    <div className="task-list">
      {sortedIds.map((id) => (
        <Task key={id} taskId={id} />
      ))}
    </div>
  );
}
