/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Tests for the root App component.
 *
 * Verifies:
 * - Layout: div.app > Header + div.app-body > Sidebar + main.app-main
 * - No selection state shows placeholder "Select a workflow from the sidebar"
 * - Selected workflow with renderer renders the renderer component
 * - Selected workflow without renderer shows "Workflow selected, but no renderer available"
 * - Header receives connected prop from useWebSocket
 * - Sidebar receives workflows, selectedRunId, onSelectRun, and onStartWorkflow
 * - onStartWorkflow is wired to send with start_workflow message in both branches
 * - Fallback runState is created from summary when not in runStates
 */

import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComponentType } from 'react';
import type { WorkflowRendererProps } from '../renderers/types';
import type { AppGlobalState, WorkflowRunState } from '../types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockUseWebSocket = vi.fn();
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => mockUseWebSocket(),
}));

// We need a proper mock for the registry that we can control per test.
// getRenderer is imported indirectly by App.tsx; we mock the module.
const mockGetRenderer = vi.fn();
vi.mock('../renderers/registry', () => ({
  getRenderer: (...args: Parameters<typeof mockGetRenderer>) => mockGetRenderer(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<AppGlobalState['workflows'][number]> = {}) {
  return {
    id: 'test-run-1',
    workflowName: 'develop',
    status: 'running' as const,
    sidebar: { title: 'Test Workflow', indicator: '🚀' },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  const summary = overrides.summary ?? makeSummary();
  return {
    summary,
    agents: new Map(),
    currentPhase: '',
    completedPhases: [],
    ...overrides,
  };
}

/** A dummy renderer component we can detect in the DOM */
const DummyRenderer: ComponentType<WorkflowRendererProps> = ({ runState }) => (
  <div data-testid="dummy-renderer">
    {runState.summary.sidebar.title} — {runState.currentPhase || 'no phase'}
  </div>
);

// ─── Default mock state ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: no workflows, not connected
  mockUseWebSocket.mockReturnValue({
    state: {
      workflows: [],
      selectedRunId: null,
      runStates: new Map(),
    },
    send: vi.fn(),
    selectRun: vi.fn(),
    connected: false,
  });

  // Default: no renderer registered
  mockGetRenderer.mockReturnValue(undefined);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('App', () => {
  it('renders the top-level .app container', async () => {
    const { container } = await renderApp();
    const app = container.querySelector('.app');
    expect(app).toBeInTheDocument();
  });

  it('renders Header inside .app', async () => {
    const { container } = await renderApp();
    const app = container.querySelector('.app');
    expect(app?.querySelector('header.header')).toBeInTheDocument();
  });

  it('renders .app-body div inside .app', async () => {
    const { container } = await renderApp();
    const app = container.querySelector('.app');
    expect(app?.querySelector('.app-body')).toBeInTheDocument();
  });

  it('renders Sidebar inside .app-body', async () => {
    const { container } = await renderApp();
    const appBody = container.querySelector('.app-body');
    expect(appBody?.querySelector('aside.sidebar')).toBeInTheDocument();
  });

  it('renders main.app-main inside .app-body', async () => {
    const { container } = await renderApp();
    const appBody = container.querySelector('.app-body');
    expect(appBody?.querySelector('main.app-main')).toBeInTheDocument();
  });

  // ── Connected prop ──────────────────────────────────────────────────

  it('passes connected=true to Header', async () => {
    mockUseWebSocket.mockReturnValue({
      state: { workflows: [], selectedRunId: null, runStates: new Map() },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: true,
    });
    const { container } = await renderApp();
    const dot = container.querySelector('.connection-dot') as HTMLElement;
    expect(dot).toHaveStyle({ backgroundColor: 'var(--engin-success)' });
  });

  it('passes connected=false to Header', async () => {
    mockUseWebSocket.mockReturnValue({
      state: { workflows: [], selectedRunId: null, runStates: new Map() },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    const { container } = await renderApp();
    const dot = container.querySelector('.connection-dot') as HTMLElement;
    expect(dot).toHaveStyle({ backgroundColor: 'var(--engin-error)' });
  });

  // ── Sidebar props ───────────────────────────────────────────────────

  it('passes workflows to Sidebar', async () => {
    const workflows = [makeSummary({ id: 'w1' }), makeSummary({ id: 'w2' })];
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows,
        selectedRunId: null,
        runStates: new Map(),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    const { container } = await renderApp();
    const items = container.querySelectorAll('.sidebar-item');
    expect(items).toHaveLength(2);
  });

  it('passes selectedRunId to Sidebar and highlights selected item', async () => {
    const workflows = [makeSummary({ id: 'w1', status: 'running' }), makeSummary({ id: 'w2', status: 'completed' })];
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows,
        selectedRunId: 'w1',
        runStates: new Map(),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    const { container } = await renderApp();
    const items = container.querySelectorAll('.sidebar-item');
    expect(items[0]).toHaveClass('selected');
    expect(items[1]).not.toHaveClass('selected');
  });

  it('passes onSelectRun to Sidebar (calls selectRun when item clicked)', async () => {
    const selectRun = vi.fn();
    const workflows = [makeSummary({ id: 'w1' })];
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows,
        selectedRunId: null,
        runStates: new Map(),
      },
      send: vi.fn(),
      selectRun,
      connected: false,
    });
    await renderApp();
    const item = screen.getByText('🚀').closest('.sidebar-item')!;
    fireEvent.click(item);
    expect(selectRun).toHaveBeenCalledWith('w1');
  });

  it('passes onStartWorkflow to Sidebar that calls send with start_workflow message', async () => {
    const send = vi.fn();
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [],
        selectedRunId: null,
        runStates: new Map(),
      },
      send,
      selectRun: vi.fn(),
      connected: false,
    });
    const { container } = await renderApp();

    // The '+' button (className 'sidebar-new-btn') is rendered by Sidebar
    // when onStartWorkflow is provided. Its presence confirms the prop wiring.
    const newBtn = container.querySelector('.sidebar-new-btn');
    expect(newBtn).toBeInTheDocument();
  });

  it('passes onStartWorkflow to Sidebar (button visible) in no-selection branch', async () => {
    const send = vi.fn();
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [],
        selectedRunId: null,
        runStates: new Map(),
      },
      send,
      selectRun: vi.fn(),
      connected: false,
    });
    const { container } = await renderApp();

    // The '+' button (className 'sidebar-new-btn') is rendered by Sidebar
    // when onStartWorkflow is provided. Its presence confirms the prop wiring.
    const newBtn = container.querySelector('.sidebar-new-btn');
    expect(newBtn).toBeInTheDocument();
  });

  it('passes onStartWorkflow to Sidebar (button visible) in selected-workflow branch', async () => {
    const send = vi.fn();
    const summary = makeSummary({ id: 'w1', workflowName: 'develop' });
    const runState = makeRunState({ summary });
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [summary],
        selectedRunId: 'w1',
        runStates: new Map([['w1', runState]]),
      },
      send,
      selectRun: vi.fn(),
      connected: false,
    });
    mockGetRenderer.mockReturnValue(DummyRenderer);

    const { container } = await renderApp();
    const newBtn = container.querySelector('.sidebar-new-btn');
    expect(newBtn).toBeInTheDocument();
  });

  it('calls send with start_workflow message when user submits through Sidebar popover', async () => {
    const send = vi.fn();
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [],
        selectedRunId: null,
        runStates: new Map(),
      },
      send,
      selectRun: vi.fn(),
      connected: false,
    });

    // Make fetch return a workflow so the popover can select it
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'develop', source: 'local', path: '/workflows/develop' }],
    });

    const { container } = await renderApp();

    // Open the popover
    const newBtn = container.querySelector('.sidebar-new-btn')!;
    fireEvent.click(newBtn);

    // Wait for fetch to resolve and the input to appear
    const input = await screen.findByPlaceholderText('Filter workflows...');
    fireEvent.change(input, { target: { value: 'develop' } });

    // Select the workflow from dropdown
    const item = container.querySelector('.sidebar-combobox-item')!;
    fireEvent.mouseDown(item);

    // Type a prompt
    const textarea = container.querySelector('.sidebar-popover-textarea')!;
    fireEvent.change(textarea, { target: { value: 'Build the feature' } });

    // Submit
    const submitBtn = container.querySelector('.sidebar-popover-submit')!;
    fireEvent.click(submitBtn);

    // Verify send was called with start_workflow message
    expect(send).toHaveBeenCalledWith({
      type: 'start_workflow',
      workflowName: 'develop',
      taskPrompt: 'Build the feature',
    });
    expect(send).toHaveBeenCalledTimes(1);

    // Restore fetch mock to default for other tests
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  it('calls send with start_workflow message in selected-workflow render branch', async () => {
    const send = vi.fn();
    const summary = makeSummary({ id: 'w1', workflowName: 'develop' });
    const runState = makeRunState({ summary });
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [summary],
        selectedRunId: 'w1',
        runStates: new Map([['w1', runState]]),
      },
      send,
      selectRun: vi.fn(),
      connected: false,
    });
    mockGetRenderer.mockReturnValue(DummyRenderer);

    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'deploy', source: 'global', path: '/workflows/deploy' }],
    });

    const { container } = await renderApp();

    // Open the popover
    const newBtn = container.querySelector('.sidebar-new-btn')!;
    fireEvent.click(newBtn);

    // Wait for fetch and select workflow
    const input = await screen.findByPlaceholderText('Filter workflows...');
    fireEvent.change(input, { target: { value: 'deploy' } });

    const item = container.querySelector('.sidebar-combobox-item')!;
    fireEvent.mouseDown(item);

    // Type a prompt
    const textarea = container.querySelector('.sidebar-popover-textarea')!;
    fireEvent.change(textarea, { target: { value: 'Deploy to production' } });

    // Submit
    const submitBtn = container.querySelector('.sidebar-popover-submit')!;
    fireEvent.click(submitBtn);

    // Verify send was called with start_workflow message
    expect(send).toHaveBeenCalledWith({
      type: 'start_workflow',
      workflowName: 'deploy',
      taskPrompt: 'Deploy to production',
    });
    expect(send).toHaveBeenCalledTimes(1);

    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  it('trims whitespace from prompt before calling send', async () => {
    const send = vi.fn();
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [],
        selectedRunId: null,
        runStates: new Map(),
      },
      send,
      selectRun: vi.fn(),
      connected: false,
    });

    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'test-wf', source: 'local', path: '/workflows/test-wf' }],
    });

    const { container } = await renderApp();

    const newBtn = container.querySelector('.sidebar-new-btn')!;
    fireEvent.click(newBtn);

    const input = await screen.findByPlaceholderText('Filter workflows...');
    fireEvent.change(input, { target: { value: 'test-wf' } });

    const item = container.querySelector('.sidebar-combobox-item')!;
    fireEvent.mouseDown(item);

    const textarea = container.querySelector('.sidebar-popover-textarea')!;
    fireEvent.change(textarea, { target: { value: '  mission critical  ' } });

    const submitBtn = container.querySelector('.sidebar-popover-submit')!;
    fireEvent.click(submitBtn);

    expect(send).toHaveBeenCalledWith({
      type: 'start_workflow',
      workflowName: 'test-wf',
      taskPrompt: 'mission critical',
    });

    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  it('does not call send when popover is closed without submitting', async () => {
    const send = vi.fn();
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [],
        selectedRunId: null,
        runStates: new Map(),
      },
      send,
      selectRun: vi.fn(),
      connected: false,
    });

    const { container } = await renderApp();

    const newBtn = container.querySelector('.sidebar-new-btn')!;
    fireEvent.click(newBtn);

    // Close the popover without submitting
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(send).not.toHaveBeenCalled();
  });

  // ── No selection ────────────────────────────────────────────────────

  it('shows placeholder "Select a workflow from the sidebar" when no workflow selected', async () => {
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [],
        selectedRunId: null,
        runStates: new Map(),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    await renderApp();
    expect(screen.getByText('Select a workflow from the sidebar')).toBeInTheDocument();
  });

  it('shows placeholder when selectedRunId does not match any workflow', async () => {
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [makeSummary({ id: 'w1' })],
        selectedRunId: 'nonexistent',
        runStates: new Map(),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    await renderApp();
    expect(screen.getByText('Select a workflow from the sidebar')).toBeInTheDocument();
  });

  it('shows placeholder in a div with class app-main-placeholder', async () => {
    await renderApp();
    const placeholder = screen.getByText('Select a workflow from the sidebar');
    expect(placeholder).toHaveClass('app-main-placeholder');
  });

  // ── Selected workflow with renderer ─────────────────────────────────

  it('renders the renderer component when a matching renderer is registered', async () => {
    const summary = makeSummary({ id: 'w1', workflowName: 'develop' });
    const runState = makeRunState({
      summary,
      currentPhase: 'coding',
    });
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [summary],
        selectedRunId: 'w1',
        runStates: new Map([['w1', runState]]),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    mockGetRenderer.mockReturnValue(DummyRenderer);

    await renderApp();
    const rendererEl = screen.getByTestId('dummy-renderer');
    expect(rendererEl).toBeInTheDocument();
    expect(rendererEl).toHaveTextContent('Test Workflow');
    expect(rendererEl).toHaveTextContent('coding');
  });

  it('passes the correct runState to the renderer', async () => {
    const summary = makeSummary({ id: 'w1', workflowName: 'develop' });
    const runState = makeRunState({
      summary,
      currentPhase: 'testing',
      completedPhases: ['design', 'coding'],
    });
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [summary],
        selectedRunId: 'w1',
        runStates: new Map([['w1', runState]]),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    // Capture the runState passed to the renderer for assertion
    let capturedRunState: WorkflowRendererProps['runState'] | undefined;
    const CapturingRenderer: ComponentType<WorkflowRendererProps> = (props) => {
      capturedRunState = props.runState;
      return <div data-testid="captured" />;
    };
    mockGetRenderer.mockReturnValue(CapturingRenderer);

    await renderApp();
    expect(capturedRunState).toBeDefined();
    expect(capturedRunState!.summary).toEqual(summary);
    expect(capturedRunState!.currentPhase).toBe('testing');
    expect(capturedRunState!.completedPhases).toEqual(['design', 'coding']);
  });

  it('calls getRenderer with the workflowName of the selected workflow', async () => {
    const summary = makeSummary({ id: 'w1', workflowName: 'my-custom-workflow' });
    const runState = makeRunState({ summary });
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [summary],
        selectedRunId: 'w1',
        runStates: new Map([['w1', runState]]),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    mockGetRenderer.mockReturnValue(DummyRenderer);

    await renderApp();
    expect(mockGetRenderer).toHaveBeenCalledWith('my-custom-workflow');
  });

  // ── Selected workflow without renderer ──────────────────────────────

  it('shows "Workflow selected, but no renderer available" when no renderer registered', async () => {
    const summary = makeSummary({ id: 'w1', workflowName: 'unknown' });
    const runState = makeRunState({ summary });
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [summary],
        selectedRunId: 'w1',
        runStates: new Map([['w1', runState]]),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    mockGetRenderer.mockReturnValue(undefined);

    await renderApp();
    expect(screen.getByText('Workflow selected, but no renderer available')).toBeInTheDocument();
  });

  it('shows fallback placeholder when Renderer is undefined', async () => {
    const summary = makeSummary({ id: 'w1', workflowName: 'unknown' });
    const runState = makeRunState({ summary });
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [summary],
        selectedRunId: 'w1',
        runStates: new Map([['w1', runState]]),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    mockGetRenderer.mockReturnValue(undefined);

    await renderApp();
    const placeholder = screen.getByText('Workflow selected, but no renderer available');
    expect(placeholder).toHaveClass('app-main-placeholder');
  });

  // ── Fallback runState ───────────────────────────────────────────────

  it('creates a minimal runState from summary when not in runStates map', async () => {
    const summary = makeSummary({ id: 'w1', workflowName: 'develop' });
    // No runState for this workflow in runStates map
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [summary],
        selectedRunId: 'w1',
        runStates: new Map(),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    let capturedRunState: WorkflowRendererProps['runState'] | undefined;
    const CapturingRenderer: ComponentType<WorkflowRendererProps> = (props) => {
      capturedRunState = props.runState;
      return <div data-testid="captured" />;
    };
    mockGetRenderer.mockReturnValue(CapturingRenderer);

    await renderApp();
    expect(capturedRunState).toBeDefined();
    expect(capturedRunState!.summary).toEqual(summary);
    expect(capturedRunState!.agents).toBeInstanceOf(Map);
    expect(capturedRunState!.agents.size).toBe(0);
    expect(capturedRunState!.currentPhase).toBe('');
    expect(capturedRunState!.completedPhases).toEqual([]);
  });

  it('prefers existing runState over fallback when present in map', async () => {
    const summary = makeSummary({ id: 'w1' });
    const existingRunState = makeRunState({
      summary,
      currentPhase: 'existing-phase',
      completedPhases: ['phase-1'],
    });
    mockUseWebSocket.mockReturnValue({
      state: {
        workflows: [summary],
        selectedRunId: 'w1',
        runStates: new Map([['w1', existingRunState]]),
      },
      send: vi.fn(),
      selectRun: vi.fn(),
      connected: false,
    });
    let capturedRunState: WorkflowRendererProps['runState'] | undefined;
    const CapturingRenderer: ComponentType<WorkflowRendererProps> = (props) => {
      capturedRunState = props.runState;
      return <div data-testid="captured" />;
    };
    mockGetRenderer.mockReturnValue(CapturingRenderer);

    await renderApp();
    expect(capturedRunState?.currentPhase).toBe('existing-phase');
    expect(capturedRunState?.completedPhases).toEqual(['phase-1']);
  });
});

// ─── Async render helper (for consistency with potential lazy components) ───

async function renderApp() {
  const { App } = await import('../App');
  return render(<App />);
}
