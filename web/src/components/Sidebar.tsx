import './Sidebar.css';

import type { WorkflowSummary } from '../types';

interface SidebarProps {
  workflows: WorkflowSummary[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}

/**
 * Returns a human-readable relative time string.
 *
 * - < 60s: "just now"
 * - < 60m: "Xm ago"
 * - < 24h: "Xh ago"
 * - else:  "Xd ago"
 */
function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

const ACTIVE_LABEL = 'Active';
const PAST_LABEL = 'Past';

export function Sidebar({ workflows, selectedRunId, onSelectRun }: SidebarProps) {
  const active = workflows.filter((w) => w.status === 'running');
  const past = workflows.filter((w) => w.status !== 'running');

  const renderItem = (workflow: WorkflowSummary) => {
    const isSelected = workflow.id === selectedRunId;
    const statusClass =
      workflow.status === 'running' ? 'running' : workflow.status === 'completed' ? 'completed' : 'failed';

    return (
      <div
        key={workflow.id}
        className={`sidebar-item${isSelected ? ' selected' : ''} ${statusClass}`}
        onClick={() => onSelectRun(workflow.id)}
      >
        <span className={`sidebar-indicator${workflow.status === 'running' ? ' pulsing' : ''}`}>
          {workflow.sidebar.indicator}
        </span>
        <span className="sidebar-title">{workflow.sidebar.title}</span>
        <span className="sidebar-time">{relativeTime(workflow.startedAt)}</span>
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-header-text">Workflows</span>
      </div>

      {active.length > 0 && (
        <div className="sidebar-section">
          <span className="sidebar-section-title">{ACTIVE_LABEL}</span>
          {active.map(renderItem)}
        </div>
      )}

      {past.length > 0 && (
        <div className="sidebar-section">
          <span className="sidebar-section-title">{PAST_LABEL}</span>
          {past.map(renderItem)}
        </div>
      )}
    </aside>
  );
}
