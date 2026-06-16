/**
 * Tests for TaskList – phase-filtered task list with click-to-select.
 *
 * Verifies:
 * - Filters tasks by selectedPhaseId
 * - Lists tasks in creation/registration order (NOT grouped by status)
 * - Status colors via CSS variables (active→current, complete→completed, ready→ready,
 *   blocked→blocked, failed→error, cancelled→muted)
 * - Active step display: "step X/Y: stepName"
 * - Click handler calls selectTask(task.id)
 * - Selected task gets CSS class 'task-list__task--selected'
 * - Empty state when phase has no tasks
 * - Connecting state when no snapshot has arrived
 */

import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskEntity } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';

// ─── Constants ────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskEntity> & { id: string }): TaskEntity {
  return {
    title: overrides.id,
    phaseId: 'phase-1',
    status: 'ready',
    steps: [],
    dependencies: [],
    ...overrides,
  };
}

/** Seed the store with tasks and phases via applySnapshot. */
function seedStore(tasks: Record<string, TaskEntity>, selectedPhaseId: string | null = 'phase-1'): void {
  useWorkflowStore.getState().applySnapshot(
    RUN_ID,
    {
      seq: 1,
      taskPrompt: '',

      phases: [{ id: 'phase-1', label: 'Phase 1', icon: '📋', taskIds: Object.keys(tasks) }] as any,
      currentPhaseId: 'phase-1',
      completedPhaseIds: [],
      tasks,
      agents: {},
      sidebar: { title: '', indicator: '' },
      status: 'running',
      stats: { totalTokens: 0, agentCount: 0 },
      runLog: [],
    },
    1,
  );
  // Select the phase so follow rules settle
  useWorkflowStore.getState().selectPhase(selectedPhaseId);
}

/** Seed the store wrapped in act() so React flushes the re-render. */
function seedStoreAct(tasks: Record<string, TaskEntity>, selectedPhaseId: string | null = 'phase-1'): void {
  act(() => {
    seedStore(tasks, selectedPhaseId);
  });
}

/** Reset the store to initial state. */
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
    selectedRunId: RUN_ID,
    runLogs: {},
  });
}

// Must import AFTER store reset state is established
import { TaskList } from './TaskList';

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('TaskList – empty / connecting states', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('shows "Connecting to workflow…" when no snapshot has arrived (seq=0)', () => {
    // Store is in initial state — seq=0, no snapshot
    const { container } = render(<TaskList />);
    expect(container.textContent).toContain('Connecting to workflow…');
  });

  it('shows "No tasks in this phase" when snapshot arrived but selected phase has no tasks', () => {
    act(() => {
      seedStore({}, 'phase-1');
    });

    const { container } = render(<TaskList />);
    expect(container.textContent).toContain('No tasks in this phase');
  });

  it('shows "No phase selected" when selectedPhaseId is null after snapshot', () => {
    act(() => {
      useWorkflowStore.getState().applySnapshot(
        RUN_ID,
        {
          seq: 1,
          taskPrompt: '',
          phases: [],
          currentPhaseId: '',
          completedPhaseIds: [],
          tasks: {},
          agents: {},
          sidebar: { title: '', indicator: '' },
          status: 'running',
          stats: { totalTokens: 0, agentCount: 0 },
          runLog: [],
        },
        1,
      );
    });

    const { container } = render(<TaskList />);
    expect(container.textContent).toContain('No phase selected');
  });

  it('applies CSS class "task-list--empty" when empty', () => {
    act(() => {
      seedStore({}, 'phase-1');
    });

    const { container } = render(<TaskList />);
    const emptyDiv = container.querySelector('.task-list--empty');
    expect(emptyDiv).toBeInTheDocument();
    expect(emptyDiv?.textContent).toContain('No tasks in this phase');
  });
});

describe('TaskList – task filtering and rendering', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('renders only tasks belonging to the selected phase', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Task A', phaseId: 'phase-1', status: 'active' }),
      't-2': makeTask({ id: 't-2', title: 'Task B', phaseId: 'phase-2', status: 'ready' }),
      't-3': makeTask({ id: 't-3', title: 'Task C', phaseId: 'phase-1', status: 'blocked' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const taskRows = container.querySelectorAll('.task-list__task');
    expect(taskRows).toHaveLength(2);

    expect(container.textContent).toContain('Task A');
    expect(container.textContent).toContain('Task C');
    expect(container.textContent).not.toContain('Task B');
  });

  it('renders all tasks when switching to a phase with no tasks', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Task A', phaseId: 'phase-1', status: 'active' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container, rerender } = render(<TaskList />);
    expect(container.querySelectorAll('.task-list__task')).toHaveLength(1);

    // Switch to a different phase with no tasks — set state directly to bypass
    // phase-follow rules that would auto-revert to currentPhaseId
    act(() => {
      useWorkflowStore.setState({ selectedPhaseId: 'phase-2', selectedTaskId: null });
    });
    rerender(<TaskList />);

    const emptyDiv = container.querySelector('.task-list--empty');
    expect(emptyDiv).toBeInTheDocument();
    expect(emptyDiv?.textContent).toContain('No tasks in this phase');
  });

  it('renders task rows with proper CSS structure', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Task 1', phaseId: 'phase-1', status: 'active' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);

    // Root container
    expect(container.querySelector('.task-list')).toBeInTheDocument();

    // Task row
    const taskRow = container.querySelector('.task-list__task');
    expect(taskRow).toBeInTheDocument();

    // Title element
    const title = container.querySelector('.task-list__title');
    expect(title).toBeInTheDocument();
    expect(title?.textContent).toContain('Task 1');
  });
});

describe('TaskList – creation/registration order', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('lists tasks in registration order, NOT grouped by status', () => {
    const tasks: Record<string, TaskEntity> = {
      't-blocked': makeTask({ id: 't-blocked', title: 'Blocked', phaseId: 'phase-1', status: 'blocked' }),
      't-active': makeTask({ id: 't-active', title: 'Active', phaseId: 'phase-1', status: 'active' }),
      't-ready': makeTask({ id: 't-ready', title: 'Ready', phaseId: 'phase-1', status: 'ready' }),
      't-complete': makeTask({ id: 't-complete', title: 'Complete', phaseId: 'phase-1', status: 'complete' }),
      't-failed': makeTask({ id: 't-failed', title: 'Failed', phaseId: 'phase-1', status: 'failed' }),
      't-cancelled': makeTask({ id: 't-cancelled', title: 'Cancelled', phaseId: 'phase-1', status: 'cancelled' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const taskRows = container.querySelectorAll('.task-list__task');
    const titles = Array.from(taskRows).map((row) => row.querySelector('.task-list__title')?.textContent);

    // Expected order: the registration/insertion order of the tasks map
    expect(titles).toEqual(['Blocked', 'Active', 'Ready', 'Complete', 'Failed', 'Cancelled']);
  });

  it('renders a single task correctly', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'My Task', phaseId: 'phase-1', status: 'active' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const taskRows = container.querySelectorAll('.task-list__task');
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].querySelector('.task-list__title')?.textContent).toBe('My Task');
  });
});

describe('TaskList – status colors via CSS', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('uses "var(--task-current)" for active tasks', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Active', phaseId: 'phase-1', status: 'active' }),
    };
    seedStoreAct(tasks, 'phase-1');
    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task') as HTMLElement;
    expect(taskRow?.style.borderLeftColor).toBe('var(--task-current)');
  });

  it('uses "var(--task-completed)" for complete tasks', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Complete', phaseId: 'phase-1', status: 'complete' }),
    };
    seedStoreAct(tasks, 'phase-1');
    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task') as HTMLElement;
    expect(taskRow?.style.borderLeftColor).toBe('var(--task-completed)');
  });

  it('uses "var(--task-ready)" for ready tasks', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Ready', phaseId: 'phase-1', status: 'ready' }),
    };
    seedStoreAct(tasks, 'phase-1');
    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task') as HTMLElement;
    expect(taskRow?.style.borderLeftColor).toBe('var(--task-ready)');
  });

  it('uses "var(--task-blocked)" for blocked tasks', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Blocked', phaseId: 'phase-1', status: 'blocked' }),
    };
    seedStoreAct(tasks, 'phase-1');
    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task') as HTMLElement;
    expect(taskRow?.style.borderLeftColor).toBe('var(--task-blocked)');
  });

  it('uses "var(--error)" for failed tasks', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Failed', phaseId: 'phase-1', status: 'failed' }),
    };
    seedStoreAct(tasks, 'phase-1');
    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task') as HTMLElement;
    expect(taskRow?.style.borderLeftColor).toBe('var(--error)');
  });

  it('uses "var(--text-muted)" for cancelled tasks', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Cancelled', phaseId: 'phase-1', status: 'cancelled' }),
    };
    seedStoreAct(tasks, 'phase-1');
    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task') as HTMLElement;
    expect(taskRow?.style.borderLeftColor).toBe('var(--text-muted)');
  });

  it('uses "var(--text-muted)" for unknown status', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Unknown', phaseId: 'phase-1', status: 'unknown' as any }),
    };
    seedStoreAct(tasks, 'phase-1');
    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task') as HTMLElement;
    expect(taskRow?.style.borderLeftColor).toBe('var(--text-muted)');
  });
});

describe('TaskList – active step display', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('shows step progress for an active task with activeStepIndex', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Active Task',
        phaseId: 'phase-1',
        status: 'active',
        steps: [
          { name: 'plan', index: 0 },
          { name: 'code', index: 1 },
          { name: 'test', index: 2 },
        ],
        activeStepIndex: 1,
      }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.textContent).toContain('step 2/3: code');
  });

  it('shows step 1/N when activeStepIndex is 0', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'First Step',
        phaseId: 'phase-1',
        status: 'active',
        steps: [
          { name: 'init', index: 0 },
          { name: 'finalize', index: 1 },
        ],
        activeStepIndex: 0,
      }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.textContent).toContain('step 1/2: init');
  });

  it('shows step N/N when activeStepIndex is the last step', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Last Step',
        phaseId: 'phase-1',
        status: 'active',
        steps: [
          { name: 'a', index: 0 },
          { name: 'b', index: 1 },
          { name: 'c', index: 2 },
        ],
        activeStepIndex: 2,
      }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.textContent).toContain('step 3/3: c');
  });

  it('does not show step info when task is not active', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Ready Task',
        phaseId: 'phase-1',
        status: 'ready',
        steps: [{ name: 'only', index: 0 }],
        activeStepIndex: 0,
      }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.textContent).not.toContain('step ');
  });

  it('does not show step info when activeStepIndex is undefined', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'No Step',
        phaseId: 'phase-1',
        status: 'active',
        steps: [{ name: 'only', index: 0 }],
      }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.textContent).not.toContain('step ');
  });
});

describe('TaskList – click-to-select', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('calls selectTask with the task id when a task row is clicked', () => {
    const selectTaskSpy = vi.spyOn(useWorkflowStore.getState(), 'selectTask');

    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Click Me', phaseId: 'phase-1', status: 'ready' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task')!;

    fireEvent.click(taskRow);

    expect(selectTaskSpy).toHaveBeenCalledTimes(1);
    expect(selectTaskSpy).toHaveBeenCalledWith('t-1');
  });

  it('calls selectTask when Enter key is pressed on a focused task button', () => {
    const selectTaskSpy = vi.spyOn(useWorkflowStore.getState(), 'selectTask');

    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Keyboard Me', phaseId: 'phase-1', status: 'ready' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const taskButton = container.querySelector('.task-list__task') as HTMLButtonElement;

    fireEvent.keyDown(taskButton, { key: 'Enter' });

    expect(selectTaskSpy).toHaveBeenCalledTimes(1);
    expect(selectTaskSpy).toHaveBeenCalledWith('t-1');
  });

  it('calls selectTask with different ids for different tasks', () => {
    const selectTaskSpy = vi.spyOn(useWorkflowStore.getState(), 'selectTask');

    const tasks: Record<string, TaskEntity> = {
      't-a': makeTask({ id: 't-a', title: 'Task A', phaseId: 'phase-1', status: 'active' }),
      't-b': makeTask({ id: 't-b', title: 'Task B', phaseId: 'phase-1', status: 'ready' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const taskRows = container.querySelectorAll('.task-list__task');

    // Click the second task
    fireEvent.click(taskRows[1]);
    expect(selectTaskSpy).toHaveBeenCalledWith('t-b');

    // Click the first task
    fireEvent.click(taskRows[0]);
    expect(selectTaskSpy).toHaveBeenCalledWith('t-a');
  });
});

describe('TaskList – selected task highlighting', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('applies "task-list__task--selected" class to the selected task', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Task 1', phaseId: 'phase-1', status: 'active' }),
      't-2': makeTask({ id: 't-2', title: 'Task 2', phaseId: 'phase-1', status: 'ready' }),
    };

    seedStoreAct(tasks, 'phase-1');

    // Set selectedTaskId to t-2
    act(() => {
      useWorkflowStore.getState().selectTask('t-2');
    });

    const { container, rerender } = render(<TaskList />);
    const taskRows = container.querySelectorAll('.task-list__task');

    // t-2 should have the selected class
    expect(taskRows[1]).toHaveClass('task-list__task--selected');
    // t-1 should NOT have the selected class
    expect(taskRows[0]).not.toHaveClass('task-list__task--selected');
  });

  it('highlight follows when selection changes', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Task 1', phaseId: 'phase-1', status: 'active' }),
      't-2': makeTask({ id: 't-2', title: 'Task 2', phaseId: 'phase-1', status: 'ready' }),
    };

    seedStoreAct(tasks, 'phase-1');

    // Start with t-1 selected (follow rule picks first active)
    const { container, rerender } = render(<TaskList />);
    let taskRows = container.querySelectorAll('.task-list__task');
    expect(taskRows[0]).toHaveClass('task-list__task--selected');
    expect(taskRows[1]).not.toHaveClass('task-list__task--selected');

    // Select t-2
    act(() => {
      useWorkflowStore.getState().selectTask('t-2');
    });
    rerender(<TaskList />);

    taskRows = container.querySelectorAll('.task-list__task');
    expect(taskRows[0]).not.toHaveClass('task-list__task--selected');
    expect(taskRows[1]).toHaveClass('task-list__task--selected');
  });

  it('no task is highlighted when selectedTaskId is null', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Task 1', phaseId: 'phase-1', status: 'active' }),
    };

    seedStoreAct(tasks, 'phase-1');

    // Force selectedTaskId to null via setState to bypass follow rules
    act(() => {
      useWorkflowStore.setState({ selectedTaskId: null });
    });

    const { container } = render(<TaskList />);
    const taskRows = container.querySelectorAll('.task-list__task');
    taskRows.forEach((row) => {
      expect(row).not.toHaveClass('task-list__task--selected');
    });
  });
});

describe('TaskList – accessibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('adds aria-label to each task row with title and status', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'My Task', phaseId: 'phase-1', status: 'active' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task');
    expect(taskRow).toHaveAttribute('aria-label', 'My Task — active');
  });

  it('renders task buttons instead of roles for keyboard accessibility', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Task 1', phaseId: 'phase-1', status: 'active' }),
      't-2': makeTask({ id: 't-2', title: 'Task 2', phaseId: 'phase-1', status: 'ready' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const list = container.querySelector('.task-list');
    expect(list).toBeInTheDocument();
    expect(list).not.toHaveAttribute('role');

    const items = container.querySelectorAll('button.task-list__task');
    expect(items).toHaveLength(2);
  });

  it('wraps step info in a span with class task-list__step', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Active',
        phaseId: 'phase-1',
        status: 'active',
        steps: [{ name: 'code', index: 0 }],
        activeStepIndex: 0,
      }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const stepSpan = container.querySelector('.task-list__step');
    expect(stepSpan).toBeInTheDocument();
    expect(stepSpan?.textContent).toContain('step 1/1: code');
  });
});
