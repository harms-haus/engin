/**
 * Tests for PhaseBar – clickable phase tabs.
 *
 * Verifies:
 * - Renders each phase with icon + label
 * - Applies completed CSS class for completed phases
 * - Applies current CSS class for the current phase
 * - Applies selected CSS class for the selected phase
 * - Click handler calls selectPhase with phase id
 * - Tabs have role="button" and tabIndex={0} for keyboard accessibility
 * - Empty phase list renders an empty bar
 */

import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseEntity } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';

// Must import AFTER store reset state is established
import { PhaseBar } from './PhaseBar';

// ─── Constants ────────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePhase(overrides: Partial<PhaseEntity> & { id: string }): PhaseEntity {
  return {
    label: overrides.id,
    icon: '📋',
    taskIds: [],
    ...overrides,
  };
}

/** Seed the store with phases and selection state via applySnapshot. */
function seedStore(
  phases: PhaseEntity[],
  currentPhaseId = '',
  completedPhaseIds: string[] = [],
  selectedPhaseId: string | null = null,
): void {
  useWorkflowStore.getState().applySnapshot(
    RUN_ID,
    {
      seq: 1,
      taskPrompt: '',
      phases,
      currentPhaseId,
      completedPhaseIds,
      tasks: {},
      sessions: {},
      sidebar: { title: '', indicator: '' },
      status: 'running',
      stats: { totalTokens: 0, sessionCount: 0 },
      runLog: [],
    },
    1,
  );
  if (selectedPhaseId !== null) {
    useWorkflowStore.getState().selectPhase(selectedPhaseId);
  }
}

/** Seed the store wrapped in act() so React flushes the re-render. */
function seedStoreAct(
  phases: PhaseEntity[],
  currentPhaseId = '',
  completedPhaseIds: string[] = [],
  selectedPhaseId: string | null = null,
): void {
  act(() => {
    seedStore(phases, currentPhaseId, completedPhaseIds, selectedPhaseId);
  });
}

/** Reset the store to initial state. */
function resetStore(): void {
  useWorkflowStore.setState({
    sessionsById: {},
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
    stats: { totalTokens: 0, sessionCount: 0 },
    workflowEventLog: [],
    selectedPhaseId: null,
    selectedTaskId: null,
    userPinnedPhase: false,
    runs: [],
    selectedRunId: RUN_ID,
    runLogs: {},
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PhaseBar – rendering', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('renders an empty bar when there are no phases', () => {
    seedStoreAct([]);

    const { container } = render(<PhaseBar />);

    const bar = container.querySelector('.phase-bar');
    expect(bar).toBeInTheDocument();
    expect(bar?.children).toHaveLength(0);
  });

  it('renders each phase with its icon and label', () => {
    const phases = [
      makePhase({ id: 'plan', label: 'Plan', icon: '📋' }),
      makePhase({ id: 'exec', label: 'Execute', icon: '⚡' }),
      makePhase({ id: 'review', label: 'Review', icon: '✅' }),
    ];
    seedStoreAct(phases);

    const { container } = render(<PhaseBar />);

    const tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs).toHaveLength(3);

    expect(tabs[0]).toHaveTextContent('📋Plan');
    expect(tabs[1]).toHaveTextContent('⚡Execute');
    expect(tabs[2]).toHaveTextContent('✅Review');
  });

  it('applies --completed class to completed phases', () => {
    const phases = [
      makePhase({ id: 'plan', label: 'Plan' }),
      makePhase({ id: 'exec', label: 'Execute' }),
      makePhase({ id: 'review', label: 'Review' }),
    ];
    seedStoreAct(phases, 'exec', ['plan', 'review']);

    const { container } = render(<PhaseBar />);

    const tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs[0]).toHaveClass('phase-bar__tab--completed');
    expect(tabs[1]).not.toHaveClass('phase-bar__tab--completed');
    expect(tabs[2]).toHaveClass('phase-bar__tab--completed');
  });

  it('applies --current class to the current phase', () => {
    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    seedStoreAct(phases, 'exec');

    const { container } = render(<PhaseBar />);

    const tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs[0]).not.toHaveClass('phase-bar__tab--current');
    expect(tabs[1]).toHaveClass('phase-bar__tab--current');
  });

  it('applies --selected class to the selected phase (completed phase)', () => {
    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    // Selecting a completed phase is allowed to differ from current
    seedStoreAct(phases, 'exec', ['plan'], 'plan');

    const { container } = render(<PhaseBar />);

    const tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs[0]).toHaveClass('phase-bar__tab--selected');
    expect(tabs[1]).not.toHaveClass('phase-bar__tab--selected');
  });

  it('applies --selected class when selected phase equals current phase', () => {
    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    // Selected phase same as current — allowed
    seedStoreAct(phases, 'exec', [], 'exec');

    const { container } = render(<PhaseBar />);

    const tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs[0]).not.toHaveClass('phase-bar__tab--selected');
    expect(tabs[1]).toHaveClass('phase-bar__tab--selected');
  });

  it('applies both --current and --selected when the current phase is also selected', () => {
    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    seedStoreAct(phases, 'exec', [], 'exec');

    const { container } = render(<PhaseBar />);

    const tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs[1]).toHaveClass('phase-bar__tab--current');
    expect(tabs[1]).toHaveClass('phase-bar__tab--selected');
  });

  it('applies both --completed and --selected when a completed phase is selected', () => {
    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    seedStoreAct(phases, 'exec', ['plan'], 'plan');

    const { container } = render(<PhaseBar />);

    const tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs[0]).toHaveClass('phase-bar__tab--completed');
    expect(tabs[0]).toHaveClass('phase-bar__tab--selected');
    expect(tabs[1]).not.toHaveClass('phase-bar__tab--completed');
    expect(tabs[1]).not.toHaveClass('phase-bar__tab--selected');
  });
});

describe('PhaseBar – click behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('calls selectPhase with the phase id when a tab is clicked', () => {
    const selectPhaseSpy = vi.spyOn(useWorkflowStore.getState(), 'selectPhase');

    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    seedStoreAct(phases);

    const { container } = render(<PhaseBar />);

    const tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs).toHaveLength(2);

    fireEvent.click(tabs[1]);
    expect(selectPhaseSpy).toHaveBeenCalledWith('exec');
  });

  it('updates selected class when a different phase is clicked multiple times', () => {
    const phases = [
      makePhase({ id: 'plan', label: 'Plan' }),
      makePhase({ id: 'exec', label: 'Execute' }),
      makePhase({ id: 'review', label: 'Review' }),
    ];
    // Mark all as completed so any click selection persists (otherwise reconcileSelection
    // resets non-current selections that aren't completed)
    seedStoreAct(phases, 'exec', ['plan', 'exec', 'review']);

    const { container } = render(<PhaseBar />);

    let tabs = container.querySelectorAll('.phase-bar__tab');
    // Initially the current phase (exec) is auto-selected by the phase-follow rules
    expect(tabs[0]).not.toHaveClass('phase-bar__tab--selected');
    expect(tabs[1]).toHaveClass('phase-bar__tab--selected');
    expect(tabs[2]).not.toHaveClass('phase-bar__tab--selected');

    // Click "plan" (completed, so selection sticks)
    fireEvent.click(tabs[0]);

    tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs[0]).toHaveClass('phase-bar__tab--selected');
    expect(tabs[1]).not.toHaveClass('phase-bar__tab--selected');
    expect(tabs[2]).not.toHaveClass('phase-bar__tab--selected');

    // Click "review" (completed, so selection sticks)
    fireEvent.click(tabs[2]);

    tabs = container.querySelectorAll('.phase-bar__tab');
    expect(tabs[0]).not.toHaveClass('phase-bar__tab--selected');
    expect(tabs[1]).not.toHaveClass('phase-bar__tab--selected');
    expect(tabs[2]).toHaveClass('phase-bar__tab--selected');
  });
});

describe('PhaseBar – accessibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('renders tabs as native <button> elements', () => {
    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    seedStoreAct(phases);

    const { container } = render(<PhaseBar />);

    const tabs = container.querySelectorAll('.phase-bar__tab');
    tabs.forEach((tab) => {
      expect(tab.tagName).toBe('BUTTON');
    });
  });

  it('activates phase via click on a focused tab (Enter/Space handled natively by <button>)', () => {
    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    seedStoreAct(phases);

    const { container } = render(<PhaseBar />);

    const tab = container.querySelectorAll('.phase-bar__tab')[1];
    // In a real browser, Enter/Space on a <button> fires its click event.
    // Verify the button's click handler fires as expected.
    fireEvent.click(tab);
    expect(useWorkflowStore.getState().selectedPhaseId).toBe('exec');
  });

  it('activates phase via click on a different focused tab', () => {
    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    seedStoreAct(phases);

    const { container } = render(<PhaseBar />);

    const tab = container.querySelectorAll('.phase-bar__tab')[0];
    fireEvent.click(tab);
    expect(useWorkflowStore.getState().selectedPhaseId).toBe('plan');
  });
});

describe('PhaseBar – integrates with store actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('selectPhase is called with completed phase id and store updates reflect', () => {
    const phases = [makePhase({ id: 'plan', label: 'Plan' }), makePhase({ id: 'exec', label: 'Execute' })];
    // Mark 'plan' as completed so the selection sticks
    seedStoreAct(phases, 'exec', ['plan']);

    const { container } = render(<PhaseBar />);

    // Click "plan"
    const tab = container.querySelectorAll('.phase-bar__tab')[0];
    fireEvent.click(tab);

    // Store should have selectedPhaseId = 'plan'
    expect(useWorkflowStore.getState().selectedPhaseId).toBe('plan');
  });
});
