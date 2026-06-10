/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Tests for Sidebar component.
 *
 * Verifies:
 * - Header text 'Workflows' (muted, uppercase)
 * - Two sections: 'Active' (status==='running') and 'Past' (others)
 * - Each item shows indicator emoji, truncated title, relative time
 * - Left border colored by status
 * - Selected item gets highlighted background
 * - Running items have pulse animation on indicator
 * - onClick calls onSelectRun(workflow.id)
 */

import '@testing-library/jest-dom/vitest';

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { Sidebar } from '../Sidebar';
import type { WorkflowSummary } from '../../types';

function makeWorkflow(overrides: Partial<WorkflowSummary> & { id: string }): WorkflowSummary {
  return {
    workflowName: 'test-workflow',
    status: 'running',
    sidebar: { title: 'Test Workflow', indicator: '🚀' },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Sidebar', () => {
  const onSelectRun = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Basic rendering ──────────────────────────────────────────────────

  it('renders the sidebar element with class "sidebar"', () => {
    const { container } = render(
      <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const sidebar = container.querySelector('aside.sidebar');
    expect(sidebar).toBeInTheDocument();
  });

  it('renders the header text "Workflows"', () => {
    render(<Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('Workflows')).toBeInTheDocument();
  });

  it('renders the header text with class "sidebar-header-text"', () => {
    const { container } = render(
      <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const header = container.querySelector('.sidebar-header-text');
    expect(header).toBeInTheDocument();
    expect(header).toHaveTextContent('Workflows');
  });

  // ── Sections ─────────────────────────────────────────────────────────

  it('renders "Active" section when there are running workflows', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders "Past" section when there are non-running workflows', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'completed' })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('Past')).toBeInTheDocument();
  });

  it('does not render "Active" section when no running workflows', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'completed' })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('does not render "Past" section when no non-running workflows', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.queryByText('Past')).not.toBeInTheDocument();
  });

  it('renders both sections when both running and completed workflows exist', () => {
    const workflows = [
      makeWorkflow({ id: '1', status: 'running' }),
      makeWorkflow({ id: '2', status: 'completed' }),
    ];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Past')).toBeInTheDocument();
  });

  it('renders section titles with class "sidebar-section-title"', () => {
    const workflows = [
      makeWorkflow({ id: '1', status: 'running' }),
      makeWorkflow({ id: '2', status: 'completed' }),
    ];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const titles = container.querySelectorAll('.sidebar-section-title');
    expect(titles).toHaveLength(2);
    expect(titles[0]).toHaveTextContent('Active');
    expect(titles[1]).toHaveTextContent('Past');
  });

  // ── Item rendering ───────────────────────────────────────────────────

  it('renders each workflow as a sidebar-item', () => {
    const workflows = [
      makeWorkflow({ id: '1', status: 'running' }),
      makeWorkflow({ id: '2', status: 'completed' }),
      makeWorkflow({ id: '3', status: 'failed' }),
    ];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const items = container.querySelectorAll('.sidebar-item');
    expect(items).toHaveLength(3);
  });

  it('displays the indicator emoji from sidebar.indicator', () => {
    const workflows = [makeWorkflow({ id: '1', sidebar: { title: 'Test', indicator: '🔥' } })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('🔥')).toBeInTheDocument();
  });

  it('displays the title from sidebar.title', () => {
    const workflows = [makeWorkflow({ id: '1', sidebar: { title: 'My Pipeline', indicator: '🚀' } })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('My Pipeline')).toBeInTheDocument();
  });

  it('displays relative time for a workflow started just now', () => {
    const workflows = [makeWorkflow({ id: '1', startedAt: new Date().toISOString() })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('displays relative time in minutes for recent workflows', () => {
    const date = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    const workflows = [makeWorkflow({ id: '1', startedAt: date.toISOString() })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('5m ago')).toBeInTheDocument();
  });

  it('displays relative time in hours for workflows started hours ago', () => {
    const date = new Date(Date.now() - 3 * 3600 * 1000); // 3 hours ago
    const workflows = [makeWorkflow({ id: '1', startedAt: date.toISOString() })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('3h ago')).toBeInTheDocument();
  });

  it('displays relative time in days for workflows started days ago', () => {
    const date = new Date(Date.now() - 2 * 86400 * 1000); // 2 days ago
    const workflows = [makeWorkflow({ id: '1', startedAt: date.toISOString() })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('2d ago')).toBeInTheDocument();
  });

  it('renders the title with class "sidebar-title" for CSS truncation', () => {
    const workflows = [
      makeWorkflow({
        id: '1',
        sidebar: { title: 'A long title that will be truncated via CSS', indicator: '🚀' },
      }),
    ];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const title = container.querySelector('.sidebar-title');
    expect(title).toBeInTheDocument();
    expect(title).toHaveTextContent('A long title that will be truncated via CSS');
    // The CSS class sidebar-title has overflow:hidden, text-overflow:ellipsis, white-space:nowrap
    // These are verified in the CSS file; here we verify the class is present.
    expect(title).toHaveClass('sidebar-title');
  });

  // ── Status classes ───────────────────────────────────────────────────

  it('applies "running" class to items with running status', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const item = container.querySelector('.sidebar-item');
    expect(item).toHaveClass('running');
    expect(item).not.toHaveClass('completed');
    expect(item).not.toHaveClass('failed');
  });

  it('applies "completed" class to items with completed status', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'completed' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const item = container.querySelector('.sidebar-item');
    expect(item).toHaveClass('completed');
    expect(item).not.toHaveClass('running');
    expect(item).not.toHaveClass('failed');
  });

  it('applies "failed" class to items with failed status', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'failed' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const item = container.querySelector('.sidebar-item');
    expect(item).toHaveClass('failed');
    expect(item).not.toHaveClass('running');
    expect(item).not.toHaveClass('completed');
  });

  // ── Selection ────────────────────────────────────────────────────────

  it('applies "selected" class to the item matching selectedRunId', () => {
    const workflows = [
      makeWorkflow({ id: '1', status: 'running' }),
      makeWorkflow({ id: '2', status: 'completed' }),
    ];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId="1" onSelectRun={onSelectRun} />,
    );
    const items = container.querySelectorAll('.sidebar-item');
    expect(items[0]).toHaveClass('selected');
    expect(items[1]).not.toHaveClass('selected');
  });

  it('does not apply "selected" when selectedRunId is null', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const item = container.querySelector('.sidebar-item');
    expect(item).not.toHaveClass('selected');
  });

  // ── Pulse animation ──────────────────────────────────────────────────

  it('applies "pulsing" class on the indicator for running items', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const indicator = container.querySelector('.sidebar-indicator');
    expect(indicator).toHaveClass('pulsing');
  });

  it('does not apply "pulsing" class on the indicator for completed items', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'completed' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const indicator = container.querySelector('.sidebar-indicator');
    expect(indicator).not.toHaveClass('pulsing');
  });

  it('does not apply "pulsing" class on the indicator for failed items', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'failed' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const indicator = container.querySelector('.sidebar-indicator');
    expect(indicator).not.toHaveClass('pulsing');
  });

  // ── onClick ──────────────────────────────────────────────────────────

  it('calls onSelectRun with workflow id when clicking an item', () => {
    const workflows = [makeWorkflow({ id: 'wf-1', status: 'running' })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const item = screen.getByText('🚀').closest('.sidebar-item')!;
    fireEvent.click(item);
    expect(onSelectRun).toHaveBeenCalledWith('wf-1');
  });

  it('calls onSelectRun only once when clicking an item', () => {
    const workflows = [
      makeWorkflow({ id: '1', status: 'running' }),
      makeWorkflow({ id: '2', status: 'completed' }),
    ];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const items = screen.getAllByText(/Test Workflow/i);
    fireEvent.click(items[0]);
    expect(onSelectRun).toHaveBeenCalledTimes(1);
  });

  it('calls onSelectRun with the correct id for each item', () => {
    const workflows = [
      makeWorkflow({ id: 'alpha', status: 'running', sidebar: { title: 'Alpha', indicator: '🚀' } }),
      makeWorkflow({ id: 'beta', status: 'completed', sidebar: { title: 'Beta', indicator: '✅' } }),
    ];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const items = screen.getAllByText(/Alpha|Beta/);
    fireEvent.click(items[0]); // Alpha
    expect(onSelectRun).toHaveBeenCalledWith('alpha');
    fireEvent.click(items[1]); // Beta
    expect(onSelectRun).toHaveBeenCalledWith('beta');
  });

  // ── CSS class structure ──────────────────────────────────────────────

  it('each sidebar-item contains a sidebar-indicator span', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const item = container.querySelector('.sidebar-item');
    expect(item!.querySelector('.sidebar-indicator')).toBeInTheDocument();
  });

  it('each sidebar-item contains a sidebar-title span', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const item = container.querySelector('.sidebar-item');
    expect(item!.querySelector('.sidebar-title')).toBeInTheDocument();
  });

  it('each sidebar-item contains a sidebar-time span', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(
      <Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />,
    );
    const item = container.querySelector('.sidebar-item');
    expect(item!.querySelector('.sidebar-time')).toBeInTheDocument();
  });
});
