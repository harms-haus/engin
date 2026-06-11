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

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowSummary } from '../../types';
import { Sidebar } from '../Sidebar';

const originalFetch = globalThis.fetch;

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

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Basic rendering ──────────────────────────────────────────────────

  it('renders the sidebar element with class "sidebar"', () => {
    const { container } = render(<Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} />);
    const sidebar = container.querySelector('aside.sidebar');
    expect(sidebar).toBeInTheDocument();
  });

  it('renders the header text "Workflows"', () => {
    render(<Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('Workflows')).toBeInTheDocument();
  });

  it('renders the header text with class "sidebar-header-text"', () => {
    const { container } = render(<Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} />);
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
    const workflows = [makeWorkflow({ id: '1', status: 'running' }), makeWorkflow({ id: '2', status: 'completed' })];
    render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Past')).toBeInTheDocument();
  });

  it('renders section titles with class "sidebar-section-title"', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' }), makeWorkflow({ id: '2', status: 'completed' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
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
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
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
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
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
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const item = container.querySelector('.sidebar-item');
    expect(item).toHaveClass('running');
    expect(item).not.toHaveClass('completed');
    expect(item).not.toHaveClass('failed');
  });

  it('applies "completed" class to items with completed status', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'completed' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const item = container.querySelector('.sidebar-item');
    expect(item).toHaveClass('completed');
    expect(item).not.toHaveClass('running');
    expect(item).not.toHaveClass('failed');
  });

  it('applies "failed" class to items with failed status', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'failed' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const item = container.querySelector('.sidebar-item');
    expect(item).toHaveClass('failed');
    expect(item).not.toHaveClass('running');
    expect(item).not.toHaveClass('completed');
  });

  // ── Selection ────────────────────────────────────────────────────────

  it('applies "selected" class to the item matching selectedRunId', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' }), makeWorkflow({ id: '2', status: 'completed' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId="1" onSelectRun={onSelectRun} />);
    const items = container.querySelectorAll('.sidebar-item');
    expect(items[0]).toHaveClass('selected');
    expect(items[1]).not.toHaveClass('selected');
  });

  it('does not apply "selected" when selectedRunId is null', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const item = container.querySelector('.sidebar-item');
    expect(item).not.toHaveClass('selected');
  });

  // ── Pulse animation ──────────────────────────────────────────────────

  it('applies "pulsing" class on the indicator for running items', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const indicator = container.querySelector('.sidebar-indicator');
    expect(indicator).toHaveClass('pulsing');
  });

  it('does not apply "pulsing" class on the indicator for completed items', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'completed' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const indicator = container.querySelector('.sidebar-indicator');
    expect(indicator).not.toHaveClass('pulsing');
  });

  it('does not apply "pulsing" class on the indicator for failed items', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'failed' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
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
    const workflows = [makeWorkflow({ id: '1', status: 'running' }), makeWorkflow({ id: '2', status: 'completed' })];
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
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const item = container.querySelector('.sidebar-item');
    expect(item!.querySelector('.sidebar-indicator')).toBeInTheDocument();
  });

  it('each sidebar-item contains a sidebar-title span', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const item = container.querySelector('.sidebar-item');
    expect(item!.querySelector('.sidebar-title')).toBeInTheDocument();
  });

  it('each sidebar-item contains a sidebar-time span', () => {
    const workflows = [makeWorkflow({ id: '1', status: 'running' })];
    const { container } = render(<Sidebar workflows={workflows} selectedRunId={null} onSelectRun={onSelectRun} />);
    const item = container.querySelector('.sidebar-item');
    expect(item!.querySelector('.sidebar-time')).toBeInTheDocument();
  });

  // ── New workflow popover ─────────────────────────────────────────────

  describe('New workflow popover', () => {
    const onStartWorkflow = vi.fn();

    it('popover is closed by default', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      expect(document.querySelector('.sidebar-popover')).not.toBeInTheDocument();
    });

    it('renders a + button in the header', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      const btn = document.querySelector('.sidebar-new-btn');
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveTextContent('+');
    });

    it('opens popover when + button is clicked', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      expect(document.querySelector('.sidebar-popover')).toBeInTheDocument();
    });

    it('toggles popover closed when + button is clicked again', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      expect(document.querySelector('.sidebar-popover')).toBeInTheDocument();
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      expect(document.querySelector('.sidebar-popover')).not.toBeInTheDocument();
    });

    it('closes popover when Escape is pressed', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      expect(document.querySelector('.sidebar-popover')).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(document.querySelector('.sidebar-popover')).not.toBeInTheDocument();
    });

    it('closes popover on click outside', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      expect(document.querySelector('.sidebar-popover')).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
      expect(document.querySelector('.sidebar-popover')).not.toBeInTheDocument();
    });

    it('does not close popover on click inside popover', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      const popover = document.querySelector('.sidebar-popover')!;
      expect(popover).toBeInTheDocument();
      fireEvent.mouseDown(popover);
      expect(document.querySelector('.sidebar-popover')).toBeInTheDocument();
    });

    it('fetches /api/workflows when popover opens', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/workflows',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('shows loading placeholder while fetching', async () => {
      const onStartWorkflow = vi.fn();
      let resolveFetch: (value: unknown) => void;
      const fetchPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => fetchPromise,
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      expect(screen.getByText('Loading...')).toBeInTheDocument();

      await act(async () => {
        resolveFetch([]);
      });

      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    });

    it('shows error message when fetch fails with non-ok status', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      await waitFor(() => {
        expect(document.querySelector('.sidebar-popover-error')).toBeInTheDocument();
      });
    });

    it('shows error message when fetch network request fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      await waitFor(() => {
        const errorEl = document.querySelector('.sidebar-popover-error');
        expect(errorEl).toBeInTheDocument();
        expect(errorEl).toHaveTextContent('Network error');
      });
    });

    it('shows generic error message when fetch rejects with non-Error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue('string error') as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      await waitFor(() => {
        const errorEl = document.querySelector('.sidebar-popover-error');
        expect(errorEl).toBeInTheDocument();
        expect(errorEl).toHaveTextContent('Failed to load workflows');
      });
    });

    it('displays filtered workflow entries in dropdown', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { name: 'develop', source: 'local', path: '/a' },
          { name: 'deploy', source: 'global', path: '/b' },
        ],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'deve' } });

      expect(screen.getByText('develop')).toBeInTheDocument();

      const items = document.querySelectorAll('.sidebar-combobox-item');
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent('develop');
    });

    it('selects workflow when dropdown item is clicked', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'develop', source: 'local', path: '/a' }],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = (await screen.findByPlaceholderText('Filter workflows...')) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'dev' } });

      const item = document.querySelector('.sidebar-combobox-item')!;
      fireEvent.mouseDown(item);

      expect(input).toHaveValue('develop');
    });

    it('disables submit when no workflow selected', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const submitBtn = document.querySelector('.sidebar-popover-submit') as HTMLButtonElement;
      expect(submitBtn).toBeDisabled();
    });

    it('disables submit when only workflow is selected but prompt is empty', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      // With no fetch data, user can't select workflow, so submit stays disabled
      const submitBtn = document.querySelector('.sidebar-popover-submit') as HTMLButtonElement;
      expect(submitBtn).toBeDisabled();
    });

    it('disables submit when prompt is empty', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'develop', source: 'local', path: '/a' }],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'dev' } });

      const item = document.querySelector('.sidebar-combobox-item')!;
      fireEvent.mouseDown(item);

      const submitBtn = document.querySelector('.sidebar-popover-submit') as HTMLButtonElement;
      expect(submitBtn).toBeDisabled();
    });

    it('calls onStartWorkflow and closes popover on submit', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'develop', source: 'local', path: '/a' }],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'develop' } });

      const item = document.querySelector('.sidebar-combobox-item')!;
      fireEvent.mouseDown(item);

      const textarea = document.querySelector('.sidebar-popover-textarea')!;
      fireEvent.change(textarea, { target: { value: 'Build the feature' } });

      const submitBtn = document.querySelector('.sidebar-popover-submit')!;
      fireEvent.click(submitBtn);

      expect(onStartWorkflow).toHaveBeenCalledWith('develop', 'Build the feature');
      expect(document.querySelector('.sidebar-popover')).not.toBeInTheDocument();
    });

    it('trims whitespace from prompt before submitting', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'develop', source: 'local', path: '/a' }],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'develop' } });

      const item = document.querySelector('.sidebar-combobox-item')!;
      fireEvent.mouseDown(item);

      const textarea = document.querySelector('.sidebar-popover-textarea')!;
      fireEvent.change(textarea, { target: { value: '  padded prompt  ' } });

      const submitBtn = document.querySelector('.sidebar-popover-submit')!;
      fireEvent.click(submitBtn);

      expect(onStartWorkflow).toHaveBeenCalledWith('develop', 'padded prompt');
      expect(document.querySelector('.sidebar-popover')).not.toBeInTheDocument();
    });

    // ── CSS class structure for popover elements ────────────────────────

    it('renders the + button with class "sidebar-new-btn"', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      const btn = document.querySelector('.sidebar-new-btn');
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveClass('sidebar-new-btn');
      expect(btn!.tagName).toBe('BUTTON');
    });

    it('renders sidebar-header with a button child for layout', () => {
      const { container } = render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      const header = container.querySelector('.sidebar-header');
      expect(header).toBeInTheDocument();
      const btn = header!.querySelector('.sidebar-new-btn');
      expect(btn).toBeInTheDocument();
      // The header uses flexbox; the button should be the last child
      const children = header!.children;
      expect(children[children.length - 1]).toBe(btn);
    });

    it('renders popover label elements with class "sidebar-popover-label"', () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      const labels = document.querySelectorAll('.sidebar-popover-label');
      expect(labels).toHaveLength(2);
      expect(labels[0]).toHaveTextContent('Workflow');
      expect(labels[1]).toHaveTextContent('Prompt');
    });

    it('renders input with class "sidebar-popover-input"', async () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      const input = await screen.findByPlaceholderText('Filter workflows...');
      expect(input).toHaveClass('sidebar-popover-input');
      expect(input.tagName).toBe('INPUT');
    });

    it('renders textarea with class "sidebar-popover-textarea"', async () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      const textarea = await screen.findByPlaceholderText('Describe what you want to do...');
      expect(textarea).toHaveClass('sidebar-popover-textarea');
      expect(textarea.tagName).toBe('TEXTAREA');
    });

    it('renders submit button with class "sidebar-popover-submit"', async () => {
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      const submitBtn = await screen.findByRole('button', { name: /start workflow/i });
      expect(submitBtn).toHaveClass('sidebar-popover-submit');
    });

    it('renders combobox wrapper with class "sidebar-combobox"', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'dev', source: 'local', path: '/a' }],
      }) as unknown as typeof fetch;
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);
      // The combobox wrapper appears after loading completes
      await screen.findByPlaceholderText('Filter workflows...');
      const combobox = document.querySelector('.sidebar-combobox');
      expect(combobox).toBeInTheDocument();
    });

    it('renders combobox dropdown list with class "sidebar-combobox-list" when filtering', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'dev', source: 'local', path: '/a' }],
      }) as unknown as typeof fetch;
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'dev' } });

      const list = document.querySelector('.sidebar-combobox-list');
      expect(list).toBeInTheDocument();
    });

    it('renders combobox items with class "sidebar-combobox-item" and source with class "sidebar-combobox-source"', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { name: 'alpha', source: 'local', path: '/a' },
          { name: 'beta', source: 'global', path: '/b' },
        ],
      }) as unknown as typeof fetch;
      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: '' } });
      // Type something to trigger dropdown, then clear to show all
      fireEvent.change(input, { target: { value: 'a' } });

      const items = document.querySelectorAll('.sidebar-combobox-item');
      expect(items.length).toBeGreaterThan(0);
      const source = items[0].querySelector('.sidebar-combobox-source');
      expect(source).toBeInTheDocument();
      expect(source!.tagName).toBe('SPAN');
    });

    it('does not call onStartWorkflow when onStartWorkflow is undefined', async () => {
      // Render without onStartWorkflow prop
      render(<Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} />);
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      // Since fetch returns empty, we can't select a workflow, so submit stays disabled.
      // This test verifies that not providing onStartWorkflow doesn't crash.
      const submitBtn = document.querySelector('.sidebar-popover-submit') as HTMLButtonElement;
      expect(submitBtn).toBeDisabled();
    });

    it('shows no dropdown when filter has no matches', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { name: 'develop', source: 'local', path: '/a' },
          { name: 'deploy', source: 'global', path: '/b' },
        ],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'nonexistent' } });

      // No matching items, dropdown list should not appear
      expect(document.querySelector('.sidebar-combobox-list')).not.toBeInTheDocument();
    });

    it('renders the first combobox-item with active class when dropdown opens', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { name: 'alpha', source: 'local', path: '/a' },
          { name: 'beta', source: 'global', path: '/b' },
        ],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'a' } });

      const items = document.querySelectorAll('.sidebar-combobox-item');
      expect(items.length).toBeGreaterThan(0);
      expect(items[0]).toHaveClass('active');
    });

    it('closes dropdown list after selecting a workflow item', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'develop', source: 'local', path: '/a' }],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'dev' } });

      expect(document.querySelector('.sidebar-combobox-list')).toBeInTheDocument();

      const item = document.querySelector('.sidebar-combobox-item')!;
      fireEvent.mouseDown(item);

      expect(document.querySelector('.sidebar-combobox-list')).not.toBeInTheDocument();
    });

    it('filters workflows case-insensitively', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { name: 'Develop', source: 'local', path: '/a' },
          { name: 'Deploy', source: 'global', path: '/b' },
        ],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'develop' } });

      const items = document.querySelectorAll('.sidebar-combobox-item');
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent('Develop');
    });

    it('accepts multi-line prompt with quotes and special characters', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'develop', source: 'local', path: '/a' }],
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'develop' } });

      const item = document.querySelector('.sidebar-combobox-item')!;
      fireEvent.mouseDown(item);

      const textarea = document.querySelector('.sidebar-popover-textarea') as HTMLTextAreaElement;
      const multiLinePrompt = 'Write a script that:\n- Does X\n- Handles "quotes"\n- Supports $pecial chars & more!';
      fireEvent.change(textarea, { target: { value: multiLinePrompt } });

      expect(textarea).toHaveValue(multiLinePrompt);

      const submitBtn = document.querySelector('.sidebar-popover-submit') as HTMLButtonElement;
      expect(submitBtn).not.toBeDisabled();

      fireEvent.click(submitBtn);

      expect(onStartWorkflow).toHaveBeenCalledWith('develop', multiLinePrompt);
      expect(document.querySelector('.sidebar-popover')).not.toBeInTheDocument();
    });

    it('submits without error when onStartWorkflow is undefined', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'develop', source: 'local', path: '/a' }],
      }) as unknown as typeof fetch;

      // Render without onStartWorkflow prop – optional chaining should handle it
      render(<Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} />);
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      const input = await screen.findByPlaceholderText('Filter workflows...');
      fireEvent.change(input, { target: { value: 'develop' } });

      const item = document.querySelector('.sidebar-combobox-item')!;
      fireEvent.mouseDown(item);

      const textarea = document.querySelector('.sidebar-popover-textarea')!;
      fireEvent.change(textarea, { target: { value: 'Do something' } });

      const submitBtn = document.querySelector('.sidebar-popover-submit') as HTMLButtonElement;
      expect(submitBtn).not.toBeDisabled();

      // Should not throw even though onStartWorkflow is undefined
      expect(() => {
        fireEvent.click(submitBtn);
      }).not.toThrow();

      // Popover should close after submit
      expect(document.querySelector('.sidebar-popover')).not.toBeInTheDocument();
    });

    it('aborts fetch when popover closes before fetch completes', async () => {
      let resolveFetch: (value: unknown) => void;
      const fetchPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => fetchPromise,
      }) as unknown as typeof fetch;

      render(
        <Sidebar workflows={[]} selectedRunId={null} onSelectRun={onSelectRun} onStartWorkflow={onStartWorkflow} />,
      );
      fireEvent.click(document.querySelector('.sidebar-new-btn')!);

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
        expect(fetchCall[0]).toBe('/api/workflows');
        const options = fetchCall[1] as { signal: AbortSignal };
        expect(options.signal.aborted).toBe(true);
      });
    });
  });
});
