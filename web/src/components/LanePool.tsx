import type { TaskInfo } from '../protocol-types';
import './LanePool.css';

export interface LanePoolProps {
  tasks: TaskInfo[];
}

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

export function LanePool({ tasks }: LanePoolProps) {
  const sorted = [...tasks].sort(
    (a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99),
  );

  if (sorted.length === 0) {
    return <div className="lane-pool lane-pool--empty">No tasks</div>;
  }

  return (
    <div className="lane-pool">
      {sorted.map((task) => (
        <div
          key={task.id}
          className="lane-pool__lane"
          style={{ borderLeftColor: getStatusColor(task.status) }}
        >
          <span className="lane-pool__title">{task.title}</span>
        </div>
      ))}
    </div>
  );
}
