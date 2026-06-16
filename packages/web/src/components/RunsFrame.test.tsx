/**
 * Tests for RunsFrame — the persistent sidebar listing active runs.
 *
 * Verifies (per server-refactor.prompt.md §12):
 * - Renders active runs list from the `runs` ServerMessage
 * - Each entry shows workflowName, truncated taskPrompt, status badge, currentPhaseId
 * - Running runs get a green indicator; non-running do not
 * - Clicking an entry calls selectRun (triggering subscribe)
 * - Cancel button next to each running run sends cancel_run via WebSocket
 * - Empty state placeholder when no runs exist
 * - Store: selectRun sets selectedRunId; cancelRun sends cancel_run
 * - App integration: App renders RunsFrame; selecting a run shows projection
 *
 * These tests are RED (TDD) — RunsFrame does not exist yet.
 */

import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '../protocol-types';
import { setStoreSendFn, useWorkflowStore } from '../store/workflow-store';

// ─── Constants ───────────────────────────────────────────────────────────────

// ─── Mock useWebSocket ─────────────────────────────────────────────────────

const mockSend = vi.fn();

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({
    send: mockSend,
    connected: true,
    hasConnectedOnce: true,
  })),
}));

// Must import AFTER vi.mock so the mock is wired up
import { useWebSocket } from '../hooks/useWebSocket';
import { RunsFrame } from './RunsFrame';

const mockUseWebSocket = useWebSocket as unknown as ReturnType<typeof vi.fn>;

// ─── Helpers ───────────────────────────────────────────────────────────────

function runSummary(overrides?: Partial<RunSummary>): RunSummary {
  return {
    runId: 'run-1',
    cwd: '/tmp/work',
    workflowName: 'default',
    taskPrompt: 'do something',
    status: 'running',
    currentPhaseId: 'exec',
    startedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Seed the store with a runs list. */
function seedRuns(runs: RunSummary[]): void {
  act(() => {
    useWorkflowStore.getState().setRuns(runs);
  });
}

function resetStore(): void {
  useWorkflowStore.setState({
    agentsById: {},
    tasksById: {},
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    sidebar: { title: '', indicator: '' },
    status: 'running',
    taskPrompt: '',
    error: undefined,
    failedPhase: undefined,
    seq: 0,
    stats: { totalTokens: 0, agentCount: 0 },
    workflowEventLog: [],
    selectedPhaseId: null,
    selectedTaskId: null,
    selectedStepIndex: null,
    userPinnedPhase: false,
    userPinnedStep: false,
    runs: [],
    selectedRunId: null,
    runLogs: {},
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

// ── 1. Renders active runs list ──────────────────────────────────────────

describe('RunsFrame – renders active runs list', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    mockSend.mockClear();
    setStoreSendFn(mockSend);
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('shows all N entries when given N runs', () => {
    seedRuns([
      runSummary({ runId: 'run-1', workflowName: 'alpha' }),
      runSummary({ runId: 'run-2', workflowName: 'beta' }),
      runSummary({ runId: 'run-3', workflowName: 'gamma' }),
    ]);

    const { container } = render(<RunsFrame />);

    const entries = container.querySelectorAll('.runs-frame__entry');
    expect(entries).toHaveLength(3);
  });

  it('renders a single run entry', () => {
    seedRuns([runSummary({ runId: 'run-1', workflowName: 'solo' })]);

    const { container } = render(<RunsFrame />);

    const entries = container.querySelectorAll('.runs-frame__entry');
    expect(entries).toHaveLength(1);
  });
});

// ── 2. Each entry shows metadata ────────────────────────────────────────

describe('RunsFrame – entry metadata', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    mockSend.mockClear();
    setStoreSendFn(mockSend);
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('displays workflowName for each run', () => {
    seedRuns([
      runSummary({ runId: 'run-1', workflowName: 'deploy-pipeline' }),
      runSummary({ runId: 'run-2', workflowName: 'test-suite' }),
    ]);

    const { container } = render(<RunsFrame />);

    expect(container.textContent).toContain('deploy-pipeline');
    expect(container.textContent).toContain('test-suite');
  });

  it('displays truncated taskPrompt (max 50 chars)', () => {
    const shortPrompt = 'short task';
    const longPrompt = 'a'.repeat(80); // >50 chars → truncated
    seedRuns([
      runSummary({ runId: 'run-1', taskPrompt: shortPrompt }),
      runSummary({ runId: 'run-2', taskPrompt: longPrompt }),
    ]);

    const { container } = render(<RunsFrame />);

    // Short prompt displayed in full
    expect(container.textContent).toContain(shortPrompt);
    // Long prompt is truncated (should not contain the full 80-char string)
    expect(container.textContent).not.toContain(longPrompt);
    // Should show truncated version with ellipsis or similar indicator
    const entries = container.querySelectorAll('.runs-frame__entry');
    expect(entries[1].textContent).toContain('…');
  });

  it('displays status badge for each run', () => {
    seedRuns([
      runSummary({ runId: 'run-1', status: 'running' }),
      runSummary({ runId: 'run-2', status: 'complete' }),
      runSummary({ runId: 'run-3', status: 'failed' }),
    ]);

    const { container } = render(<RunsFrame />);

    const badges = container.querySelectorAll('.runs-frame__status');
    expect(badges).toHaveLength(3);
    expect(badges[0]).toHaveTextContent('running');
    expect(badges[1]).toHaveTextContent('complete');
    expect(badges[2]).toHaveTextContent('failed');
  });

  it('displays currentPhaseId when present', () => {
    seedRuns([
      runSummary({ runId: 'run-1', currentPhaseId: 'scouting' }),
      runSummary({ runId: 'run-2', currentPhaseId: 'execution' }),
    ]);

    const { container } = render(<RunsFrame />);

    expect(container.textContent).toContain('scouting');
    expect(container.textContent).toContain('execution');
  });
});

// ── 3. Green indicator for running runs ──────────────────────────────────

describe('RunsFrame – green indicator for running runs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    mockSend.mockClear();
    setStoreSendFn(mockSend);
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('shows a green indicator on runs with status "running"', () => {
    seedRuns([
      runSummary({ runId: 'run-1', status: 'running' }),
      runSummary({ runId: 'run-2', status: 'complete' }),
      runSummary({ runId: 'run-3', status: 'failed' }),
    ]);

    const { container } = render(<RunsFrame />);

    const entries = container.querySelectorAll('.runs-frame__entry');

    // Running run should have a green indicator
    const indicator1 = entries[0].querySelector('.runs-frame__indicator');
    expect(indicator1).toBeInTheDocument();
    expect(indicator1).toHaveClass('runs-frame__indicator--active');

    // Complete run should NOT have the active indicator
    const indicator2 = entries[1].querySelector('.runs-frame__indicator');
    expect(indicator2).not.toHaveClass('runs-frame__indicator--active');

    // Failed run should NOT have the active indicator
    const indicator3 = entries[2].querySelector('.runs-frame__indicator');
    expect(indicator3).not.toHaveClass('runs-frame__indicator--active');
  });

  it('all running runs get green indicator, regardless of position', () => {
    seedRuns([
      runSummary({ runId: 'run-1', status: 'complete' }),
      runSummary({ runId: 'run-2', status: 'running' }),
      runSummary({ runId: 'run-3', status: 'running' }),
    ]);

    const { container } = render(<RunsFrame />);

    const entries = container.querySelectorAll('.runs-frame__entry');
    expect(entries[0].querySelector('.runs-frame__indicator')).not.toHaveClass('runs-frame__indicator--active');
    expect(entries[1].querySelector('.runs-frame__indicator')).toHaveClass('runs-frame__indicator--active');
    expect(entries[2].querySelector('.runs-frame__indicator')).toHaveClass('runs-frame__indicator--active');
  });
});

// ── 4. Click selects run ────────────────────────────────────────────────

describe('RunsFrame – click selects run', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    mockSend.mockClear();
    setStoreSendFn(mockSend);
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('clicking an entry calls selectRun and updates selectedRunId', () => {
    seedRuns([
      runSummary({ runId: 'run-1', workflowName: 'alpha' }),
      runSummary({ runId: 'run-2', workflowName: 'beta' }),
    ]);

    const selectRunSpy = vi.spyOn(useWorkflowStore.getState(), 'selectRun');

    const { container } = render(<RunsFrame />);

    const entries = container.querySelectorAll('.runs-frame__entry');
    fireEvent.click(entries[1]);

    expect(selectRunSpy).toHaveBeenCalledTimes(1);
    expect(selectRunSpy).toHaveBeenCalledWith('run-2');
    expect(useWorkflowStore.getState().selectedRunId).toBe('run-2');

    selectRunSpy.mockRestore();
  });

  it('clicking the same run entry again re-selects it', () => {
    seedRuns([runSummary({ runId: 'run-1', workflowName: 'alpha' })]);

    const selectRunSpy = vi.spyOn(useWorkflowStore.getState(), 'selectRun');

    const { container } = render(<RunsFrame />);

    const entries = container.querySelectorAll('.runs-frame__entry');
    fireEvent.click(entries[0]);
    fireEvent.click(entries[0]);

    expect(selectRunSpy).toHaveBeenCalledTimes(2);
    expect(selectRunSpy).toHaveBeenCalledWith('run-1');
    expect(useWorkflowStore.getState().selectedRunId).toBe('run-1');

    selectRunSpy.mockRestore();
  });

  it('selected run entry gets a selected modifier class', () => {
    seedRuns([
      runSummary({ runId: 'run-1', workflowName: 'alpha' }),
      runSummary({ runId: 'run-2', workflowName: 'beta' }),
    ]);

    const { container } = render(<RunsFrame />);

    // No run selected initially
    const entries = container.querySelectorAll('.runs-frame__entry');
    expect(entries[0]).not.toHaveClass('runs-frame__entry--selected');
    expect(entries[1]).not.toHaveClass('runs-frame__entry--selected');

    // Click run-2
    fireEvent.click(entries[1]);

    // Now run-2 should be selected
    expect(entries[1]).toHaveClass('runs-frame__entry--selected');
    expect(entries[0]).not.toHaveClass('runs-frame__entry--selected');
  });
});

// ── 5. Cancel button ────────────────────────────────────────────────────

describe('RunsFrame – cancel button', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    mockSend.mockClear();
    setStoreSendFn(mockSend);
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('each running run has a Cancel button', () => {
    seedRuns([
      runSummary({ runId: 'run-1', status: 'running' }),
      runSummary({ runId: 'run-2', status: 'complete' }),
      runSummary({ runId: 'run-3', status: 'failed' }),
    ]);

    const { container } = render(<RunsFrame />);

    const entries = container.querySelectorAll('.runs-frame__entry');

    // Running run should have a Cancel button
    const cancel1 = entries[0].querySelector('.runs-frame__cancel');
    expect(cancel1).toBeInTheDocument();

    // Complete run should NOT have a Cancel button
    const cancel2 = entries[1].querySelector('.runs-frame__cancel');
    expect(cancel2).not.toBeInTheDocument();

    // Failed run should NOT have a Cancel button
    const cancel3 = entries[2].querySelector('.runs-frame__cancel');
    expect(cancel3).not.toBeInTheDocument();
  });

  it('clicking Cancel on a running run shows Confirm? state', () => {
    seedRuns([runSummary({ runId: 'run-1', status: 'running' })]);

    const { container } = render(<RunsFrame />);

    const cancelBtn = container.querySelector('.runs-frame__cancel') as HTMLButtonElement;
    expect(cancelBtn).toBeInTheDocument();
    expect(cancelBtn).toHaveTextContent('Cancel');

    fireEvent.click(cancelBtn);

    expect(mockSend).not.toHaveBeenCalled();
    expect(cancelBtn).toHaveTextContent('Confirm?');
    expect(cancelBtn).toHaveClass('runs-frame__cancel--confirm');
  });

  it('clicking Confirm? sends cancel_run message via WebSocket', () => {
    seedRuns([runSummary({ runId: 'run-1', status: 'running' })]);

    const { container } = render(<RunsFrame />);

    const cancelBtn = container.querySelector('.runs-frame__cancel') as HTMLButtonElement;
    expect(cancelBtn).toBeInTheDocument();

    // First click → Confirm?
    fireEvent.click(cancelBtn);
    expect(mockSend).not.toHaveBeenCalled();

    // Second click → sends cancel_run
    fireEvent.click(cancelBtn);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({ type: 'cancel_run', runId: 'run-1' });
  });

  it('Cancel button for each running run targets the correct runId', () => {
    seedRuns([
      runSummary({ runId: 'run-1', status: 'running', workflowName: 'alpha' }),
      runSummary({ runId: 'run-2', status: 'running', workflowName: 'beta' }),
    ]);

    const { container } = render(<RunsFrame />);

    const cancelBtns = container.querySelectorAll('.runs-frame__cancel');
    expect(cancelBtns).toHaveLength(2);

    // Click Cancel → Confirm? → click again to send
    fireEvent.click(cancelBtns[1]);
    fireEvent.click(cancelBtns[1]);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({ type: 'cancel_run', runId: 'run-2' });
  });

  it('Cancel button is disabled when WebSocket is disconnected', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: false, hasConnectedOnce: true });

    seedRuns([runSummary({ runId: 'run-1', status: 'running' })]);

    const { container } = render(<RunsFrame />);

    const cancelBtn = container.querySelector('.runs-frame__cancel') as HTMLButtonElement;
    expect(cancelBtn).toBeInTheDocument();
    expect(cancelBtn).toBeDisabled();

    fireEvent.click(cancelBtn);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Cancel click does not change selectedRunId', () => {
    seedRuns([runSummary({ runId: 'run-1', status: 'running' })]);

    const { container } = render(<RunsFrame />);

    const cancelBtn = container.querySelector('.runs-frame__cancel') as HTMLButtonElement;
    fireEvent.click(cancelBtn);
    fireEvent.click(cancelBtn);

    // Cancel should not select the run
    expect(useWorkflowStore.getState().selectedRunId).toBeNull();
  });
});

// ── 6. Empty state ──────────────────────────────────────────────────────

describe('RunsFrame – empty state', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    mockSend.mockClear();
    setStoreSendFn(mockSend);
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('shows placeholder/empty message when no runs exist', () => {
    seedRuns([]);

    const { container } = render(<RunsFrame />);

    // Should show an empty/placeholder message
    expect(container.textContent).toContain('No active runs');
    // Should not have any run entries
    expect(container.querySelectorAll('.runs-frame__entry')).toHaveLength(0);
  });

  it('shows placeholder when store has no runs at all (initial state)', () => {
    // Don't seed — runs starts as []
    const { container } = render(<RunsFrame />);

    expect(container.textContent).toContain('No active runs');
  });
});

// ── 7. Store actions ────────────────────────────────────────────────────

describe('workflow-store – cancelRun action', () => {
  beforeEach(() => {
    resetStore();
    mockSend.mockClear();
    setStoreSendFn(mockSend);
  });

  it('store exposes a cancelRun action that sends cancel_run message', () => {
    const store = useWorkflowStore.getState();

    // cancelRun should exist on the store
    expect(store).toHaveProperty('cancelRun');
  });

  it('cancelRun sends cancel_run via the wired send function', () => {
    useWorkflowStore.getState().cancelRun('run-xyz');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({ type: 'cancel_run', runId: 'run-xyz' });
  });

  it('cancelRun is a no-op when sendFn is not set', () => {
    setStoreSendFn(null);
    // Should not throw
    useWorkflowStore.getState().cancelRun('run-xyz');
    expect(mockSend).not.toHaveBeenCalled();
    // Re-wire for other tests
    setStoreSendFn(mockSend);
  });
});

describe('workflow-store – runs list updates from ServerMessage', () => {
  beforeEach(() => {
    resetStore();
  });

  it('setRuns replaces runs list (simulating receiving `runs` ServerMessage)', () => {
    const runs: RunSummary[] = [
      runSummary({ runId: 'run-1', workflowName: 'alpha' }),
      runSummary({ runId: 'run-2', workflowName: 'beta' }),
    ];

    useWorkflowStore.getState().setRuns(runs);
    expect(useWorkflowStore.getState().runs).toHaveLength(2);
    expect(useWorkflowStore.getState().runs[0].workflowName).toBe('alpha');
    expect(useWorkflowStore.getState().runs[1].workflowName).toBe('beta');
  });

  it('selectRun sets selectedRunId and resets projection selection', () => {
    const store = useWorkflowStore.getState();
    store.setRuns([runSummary({ runId: 'run-1' }), runSummary({ runId: 'run-2' })]);

    store.selectRun('run-2');
    const s = useWorkflowStore.getState();
    expect(s.selectedRunId).toBe('run-2');
    expect(s.selectedPhaseId).toBeNull();
    expect(s.selectedTaskId).toBeNull();
    expect(s.selectedStepIndex).toBeNull();
  });
});

// ── 8. App integration ──────────────────────────────────────────────────

describe('RunsFrame – App integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    mockSend.mockClear();
    setStoreSendFn(mockSend);
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('App renders RunsFrame as part of the layout', async () => {
    const { App } = await import('../App');
    const { container } = render(<App />);

    // RunsFrame should be rendered in the App
    const runsFrame = container.querySelector('.runs-frame');
    expect(runsFrame).toBeInTheDocument();
  });

  it('when a run is selected, its projection is shown in the main view', async () => {
    seedRuns([runSummary({ runId: 'run-1', workflowName: 'alpha', taskPrompt: 'build something' })]);

    // Select run-1
    act(() => {
      useWorkflowStore.getState().selectRun('run-1');
    });

    // Simulate receiving a snapshot for run-1
    act(() => {
      useWorkflowStore.getState().applySnapshot(
        'run-1',
        {
          seq: 1,
          taskPrompt: 'build something',
          phases: [{ id: 'p1', label: 'Plan', icon: '📋', taskIds: ['t1'] }],
          currentPhaseId: 'p1',
          completedPhaseIds: [],
          tasks: { t1: { id: 't1', title: 'Task 1', status: 'active', phaseId: 'p1', steps: [], dependencies: [] } },
          agents: {},
          sidebar: { title: 'build', indicator: 'green' },
          status: 'running',
          stats: { totalTokens: 0, agentCount: 0 },
          runLog: [],
        },
        1,
      );
    });

    const { App } = await import('../App');
    const { container } = render(<App />);

    // The main view should show the projection (EventLog, PhaseBar, etc.)
    const eventLog = container.querySelector('.event-log');
    expect(eventLog).toBeInTheDocument();
    const phaseBar = container.querySelector('.phase-bar');
    expect(phaseBar).toBeInTheDocument();
  });

  it('when no run is selected, main view shows placeholder', async () => {
    seedRuns([]);
    // No run selected (selectedRunId = null)

    const { App } = await import('../App');
    const { container } = render(<App />);

    // Main view should show a placeholder (EventLog and PhaseBar should still be present
    // but empty — no projection data). The key is that no projection data renders.
    const main = container.querySelector('main');
    expect(main).toBeInTheDocument();
  });
});
