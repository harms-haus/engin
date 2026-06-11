import { useCallback, useEffect, useRef, useState } from 'react';

import './Sidebar.css';

import type { WorkflowEntry, WorkflowSummary } from '../types';

interface SidebarProps {
  workflows: WorkflowSummary[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onStartWorkflow?: (workflowName: string, taskPrompt: string) => void;
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

export function Sidebar({ workflows, selectedRunId, onSelectRun, onStartWorkflow }: SidebarProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [availableWorkflows, setAvailableWorkflows] = useState<WorkflowEntry[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedWorkflowName, setSelectedWorkflowName] = useState('');
  const [filterText, setFilterText] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);

  const closePopover = useCallback(() => {
    setPopoverOpen(false);
    setSelectedWorkflowName('');
    setFilterText('');
    setTaskPrompt('');
    setShowDropdown(false);
    setFetchError(null);
  }, []);

  useEffect(() => {
    if (!popoverOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closePopover();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePopover();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [popoverOpen, closePopover]);

  useEffect(() => {
    if (!popoverOpen) return;
    const controller = new AbortController();
    setLoadingWorkflows(true);
    setFetchError(null);
    fetch('/api/workflows', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch workflows');
        return res.json();
      })
      .then((data: WorkflowEntry[]) => {
        setAvailableWorkflows(data);
        setLoadingWorkflows(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setFetchError(err instanceof Error ? err.message : 'Failed to load workflows');
        setLoadingWorkflows(false);
      });
    return () => controller.abort();
  }, [popoverOpen]);

  const handleSubmit = useCallback(() => {
    if (!selectedWorkflowName || !taskPrompt.trim()) return;
    onStartWorkflow?.(selectedWorkflowName, taskPrompt.trim());
    closePopover();
  }, [selectedWorkflowName, taskPrompt, onStartWorkflow, closePopover]);

  const filteredWorkflows = availableWorkflows.filter((w) => w.name.toLowerCase().includes(filterText.toLowerCase()));

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
        <button
          className="sidebar-new-btn"
          onClick={() => setPopoverOpen((prev) => !prev)}
          aria-label="Start new workflow"
          title="Start new workflow"
        >
          +
        </button>
        {popoverOpen && (
          <div className="sidebar-popover" ref={popoverRef}>
            <span className="sidebar-popover-label">Workflow</span>
            {loadingWorkflows && <span className="sidebar-popover-loading">Loading...</span>}
            {fetchError && <span className="sidebar-popover-error">{fetchError}</span>}
            {!loadingWorkflows && !fetchError && (
              <div className="sidebar-combobox">
                <input
                  className="sidebar-popover-input"
                  type="text"
                  placeholder="Filter workflows..."
                  value={showDropdown ? filterText : selectedWorkflowName || filterText}
                  onChange={(e) => {
                    setFilterText(e.target.value);
                    setSelectedWorkflowName('');
                    setShowDropdown(true);
                    setActiveIndex(0);
                  }}
                  onFocus={() => setShowDropdown(true)}
                />
                {showDropdown && filterText && !selectedWorkflowName && filteredWorkflows.length > 0 && (
                  <div className="sidebar-combobox-list">
                    {filteredWorkflows.map((w, i) => (
                      <div
                        key={w.name}
                        className={`sidebar-combobox-item${i === activeIndex ? ' active' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setSelectedWorkflowName(w.name);
                          setFilterText(w.name);
                          setShowDropdown(false);
                        }}
                      >
                        {w.name}
                        <span className="sidebar-combobox-source">{w.source}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <span className="sidebar-popover-label">Prompt</span>
            <textarea
              className="sidebar-popover-textarea"
              placeholder="Describe what you want to do..."
              value={taskPrompt}
              onChange={(e) => setTaskPrompt(e.target.value)}
            />
            <button
              className="sidebar-popover-submit"
              onClick={handleSubmit}
              disabled={!selectedWorkflowName || !taskPrompt.trim()}
            >
              Start Workflow
            </button>
          </div>
        )}
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
