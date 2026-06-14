import React, { useMemo } from 'react';
import { useHasSnapshot, useTaskById, useTaskIds, useWorkflowStore } from '../store/workflow-store';
import './LanePool.css';

const STATUS_PRIORITY: Record<string, number> = {
  implementing: 1,
  reviewing: 1,
  claimed: 1,
  ready: 2,
  blocked: 3,
  done: 4,
  failed: 4,
};

function getStatusColor(status: string): string {
  switch (status) {
    case 'implementing':
    case 'reviewing':
    case 'claimed':
      return 'var(--task-current)';
    case 'done':
      return 'var(--task-completed)';
    case 'ready':
      return 'var(--task-ready)';
    case 'blocked':
      return 'var(--task-blocked)';
    case 'failed':
      return 'var(--error)';
    default:
      return 'var(--text-muted)';
  }
}

const Lane = React.memo(function Lane({ taskId }: { taskId: string }) {
  const task = useTaskById(taskId);
  if (!task) return null;
  return (
    <div className="lane-pool__lane" style={{ borderLeftColor: getStatusColor(task.status) }}>
      <span className="lane-pool__title">{task.title}</span>
    </div>
  );
});

export function LanePool() {
  const taskIds = useTaskIds();
  const hasSnapshot = useHasSnapshot();
  // Subscribe to tasksById for sorting — individual Lanes are memoized so
  // a single task update only re-renders the affected Lane, not siblings.
  const tasksById = useWorkflowStore((s) => s.tasksById);

  const sortedIds = useMemo(() => {
    return [...taskIds].sort((a, b) => {
      const sa = STATUS_PRIORITY[tasksById[a]?.status] ?? 99;
      const sb = STATUS_PRIORITY[tasksById[b]?.status] ?? 99;
      return sa - sb;
    });
  }, [taskIds, tasksById]);

  if (sortedIds.length === 0) {
    const message = hasSnapshot ? 'No tasks yet' : 'Connecting to workflow…';
    return <div className="lane-pool lane-pool--empty">{message}</div>;
  }

  return (
    <div className="lane-pool">
      {sortedIds.map((id) => (
        <Lane key={id} taskId={id} />
      ))}
    </div>
  );
}
