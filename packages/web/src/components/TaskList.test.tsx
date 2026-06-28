/**
 * Tests for TaskList – phase-filtered task list with click-to-select.
 *
 * Verifies:
 * - Filters tasks by selectedPhaseId
 * - Lists tasks in creation/registration order (NOT grouped by status)
 * - Status colors via CSS variables (active→current, complete→completed, ready→ready,
 *   blocked→blocked, failed→error, cancelled→muted)
 * - Session count display: "N session(s)"
 * - Click handler calls selectTask(task.id)
 * - Selected task gets CSS class 'task-list__task--selected'
 * - Empty state when phase has no tasks
 * - Connecting state when no snapshot has arrived
 */

import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEntity, TaskEntity } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';

// ─── Constants ────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskEntity> & { id: string }): TaskEntity {
  return {
    title: overrides.id,
    phaseId: 'phase-1',
    status: 'ready',
    dependencies: [],
    startedAt: undefined,
    completedAt: undefined,
    ...overrides,
  };
}

/** Seed the store with tasks and phases via applySnapshot. */
function seedStore(
  tasks: Record<string, TaskEntity>,
  selectedPhaseId: string | null = 'phase-1',
  sessions: Record<string, SessionEntity> = {},
): void {
  useWorkflowStore.getState().applySnapshot(
    RUN_ID,
    {
      seq: 1,
      taskPrompt: '',

      phases: [{ id: 'phase-1', label: 'Phase 1', icon: '📋', taskIds: Object.keys(tasks) }] as any,
      currentPhaseId: 'phase-1',
      completedPhaseIds: [],
      tasks,
      sessions,
      sidebar: { title: '', indicator: '' },
      status: 'running',
      stats: { totalTokens: 0, sessionCount: 0 },
      runLog: [],
    },
    1,
  );
  // Select the phase so follow rules settle
  useWorkflowStore.getState().selectPhase(selectedPhaseId);
}

/** Seed the store wrapped in act() so React flushes the re-render. */
function seedStoreAct(
  tasks: Record<string, TaskEntity>,
  selectedPhaseId: string | null = 'phase-1',
  sessions: Record<string, SessionEntity> = {},
): void {
  act(() => {
    seedStore(tasks, selectedPhaseId, sessions);
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
          sessions: {},
          sidebar: { title: '', indicator: '' },
          status: 'running',
          stats: { totalTokens: 0, sessionCount: 0 },
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
      't-parked': makeTask({ id: 't-parked', title: 'Parked', phaseId: 'phase-1', status: 'parked' }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const taskRows = container.querySelectorAll('.task-list__task');
    const titles = Array.from(taskRows).map((row) => row.querySelector('.task-list__title')?.textContent);

    // Expected order: the registration/insertion order of the tasks map
    expect(titles).toEqual(['Blocked', 'Active', 'Ready', 'Complete', 'Failed', 'Cancelled', 'Parked']);
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

  it('uses "var(--task-parked)" for parked tasks', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'Parked', phaseId: 'phase-1', status: 'parked' }),
    };
    seedStoreAct(tasks, 'phase-1');
    const { container } = render(<TaskList />);
    const taskRow = container.querySelector('.task-list__task') as HTMLElement;
    expect(taskRow?.style.borderLeftColor).toBe('var(--task-parked)');
  });
});

describe('TaskList – session count display', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('shows session count for a task with sessions', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Active Task',
        phaseId: 'phase-1',
        status: 'active',
      }),
    };
    const sessions: Record<string, SessionEntity> = {
      s1: {
        uid: 's1',
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'executor',
        attempt: 1,
      },
      s2: {
        uid: 's2',
        agentId: 'a2',
        profile: 'reviewer',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'reviewer',
        attempt: 1,
      },
    };

    seedStoreAct(tasks, 'phase-1', sessions);

    const { container } = render(<TaskList />);
    expect(container.textContent).toContain('2 sessions');
  });

  it('shows "1 session" for a task with a single session', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'First Task',
        phaseId: 'phase-1',
        status: 'active',
      }),
    };
    const sessions: Record<string, SessionEntity> = {
      s1: {
        uid: 's1',
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'executor',
        attempt: 1,
      },
    };

    seedStoreAct(tasks, 'phase-1', sessions);

    const { container } = render(<TaskList />);
    expect(container.textContent).toContain('1 session');
  });

  it('does not show session count when task has no sessions', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Ready Task',
        phaseId: 'phase-1',
        status: 'ready',
      }),
    };

    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.querySelector('.task-list__sessions')).not.toBeInTheDocument();
  });

  it('shows session count only for the task it belongs to', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Task 1',
        phaseId: 'phase-1',
        status: 'active',
      }),
    };
    // Sessions with a different taskId
    const sessions: Record<string, SessionEntity> = {
      s1: {
        uid: 's1',
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'phase-1',
        taskId: 'other-task',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'executor',
        attempt: 1,
      },
    };

    seedStoreAct(tasks, 'phase-1', sessions);

    const { container } = render(<TaskList />);
    expect(container.querySelector('.task-list__sessions')).not.toBeInTheDocument();
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

  it('wraps session count in a span with class task-list__sessions', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Active',
        phaseId: 'phase-1',
        status: 'active',
      }),
    };
    const sessions: Record<string, SessionEntity> = {
      s1: {
        uid: 's1',
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'executor',
        attempt: 1,
      },
    };

    seedStoreAct(tasks, 'phase-1', sessions);

    const { container } = render(<TaskList />);
    const sessionsSpan = container.querySelector('.task-list__sessions');
    expect(sessionsSpan).toBeInTheDocument();
    expect(sessionsSpan?.textContent).toContain('1 session');
  });
});

// ─── Elapsed time display ─────────────────────────────────────────────────
// Verified against formatElapsed output for fixed startedAt→completedAt diffs.
// Completed tasks use the completedAt branch, so no live interval is created.

describe('TaskList – elapsed time display', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('does not render elapsed when startedAt is undefined', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({ id: 't-1', title: 'No Start', phaseId: 'phase-1', status: 'ready' }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.querySelector('.task-list__elapsed')).not.toBeInTheDocument();
  });

  it('renders elapsed for a completed task using startedAt/completedAt diff', () => {
    // diff = 42000ms → '42s'
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Done',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:42.000Z',
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const elapsed = container.querySelector('.task-list__elapsed');
    expect(elapsed).toBeInTheDocument();
    expect(elapsed?.textContent).toBe('42s');
  });

  it('renders "<1s" for a sub-second completed duration', () => {
    // diff = 500ms → '<1s'
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Quick',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:00.500Z',
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.querySelector('.task-list__elapsed')?.textContent).toBe('<1s');
  });

  it('renders "1m30s" for a 90-second completed duration', () => {
    // diff = 90000ms → '1m30s'
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Longer',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:01:30.000Z',
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.querySelector('.task-list__elapsed')?.textContent).toBe('1m30s');
  });

  it('renders elapsed inline within the single-line task body next to the title', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Done',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:42.000Z',
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const body = container.querySelector('.task-list__body');
    expect(body?.querySelector('.task-list__title')).toBeInTheDocument();
    expect(body?.querySelector('.task-list__elapsed')).toBeInTheDocument();
  });
});

// ─── useElapsed live timer (fake timers) ──────────────────────────────────
// Running tasks (completedAt undefined) set up a 1s interval that re-derives
// elapsed from Date.now(). Fake timers drive the clock deterministically.

describe('TaskList – useElapsed live timer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at "<1s" for a freshly started running task', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Running',
        phaseId: 'phase-1',
        status: 'active',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.querySelector('.task-list__elapsed')?.textContent).toBe('<1s');
  });

  it('updates elapsed every second as the clock advances', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Running',
        phaseId: 'phase-1',
        status: 'active',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('.task-list__elapsed')?.textContent).toBe('1s');

    act(() => {
      vi.advanceTimersByTime(41_000);
    });
    expect(container.querySelector('.task-list__elapsed')?.textContent).toBe('42s');
  });

  it('stops updating once the task completes (running interval is cleared)', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Running',
        phaseId: 'phase-1',
        status: 'active',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);

    // While running, elapsed tracks the advancing clock.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(container.querySelector('.task-list__elapsed')?.textContent).toBe('5s');

    // Complete the task at a fixed completedAt (diff = 42000ms → '42s').
    act(() => {
      useWorkflowStore.setState((s) => {
        s.tasksById['t-1'].status = 'complete';
        s.tasksById['t-1'].completedAt = '1970-01-01T00:00:42.000Z';
      });
    });
    expect(container.querySelector('.task-list__elapsed')?.textContent).toBe('42s');

    // Advancing the clock further must NOT change the now-fixed elapsed value.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.querySelector('.task-list__elapsed')?.textContent).toBe('42s');
  });

  it('renders title, sessions, elapsed, and deps together in a single body for an active task', () => {
    const tasks: Record<string, TaskEntity> = {
      'dep-a': makeTask({ id: 'dep-a', title: 'Dep A', phaseId: 'phase-2', status: 'complete' }),
      't-1': makeTask({
        id: 't-1',
        title: 'Active Task',
        phaseId: 'phase-1',
        status: 'active',
        startedAt: 0,
        dependencies: ['dep-a'],
      }),
    };
    const sessions: Record<string, SessionEntity> = {
      s1: {
        uid: 's1',
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'executor',
        attempt: 1,
      },
    };
    seedStoreAct(tasks, 'phase-1', sessions);

    const { container } = render(<TaskList />);
    const body = container.querySelector('.task-list__body');
    expect(body?.querySelector('.task-list__title')?.textContent).toBe('Active Task');
    expect(body?.querySelector('.task-list__sessions')?.textContent).toContain('1 session');
    expect(body?.querySelector('.task-list__elapsed')?.textContent).toBe('<1s');
    expect(body?.querySelector('.task-list__deps')).toBeInTheDocument();
  });
});

// ─── useElapsed interval lifecycle (real timers + spies) ──────────────────
// Asserts setInterval/clearInterval usage directly. Real timers keep the spy
// semantics straightforward; the scheduled interval is cleared on unmount.

describe('TaskList – useElapsed interval lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets up a 1000ms interval for a running task', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Running',
        phaseId: 'phase-1',
        status: 'active',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    render(<TaskList />);

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it('clears the interval when the task row is unmounted', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Running',
        phaseId: 'phase-1',
        status: 'active',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { unmount } = render(<TaskList />);
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('does not set up an interval for a completed task', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Done',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:42.000Z',
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    render(<TaskList />);

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('clears the running interval when the task transitions to completed', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Running',
        phaseId: 'phase-1',
        status: 'active',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    render(<TaskList />);
    clearIntervalSpy.mockClear();

    act(() => {
      useWorkflowStore.setState((s) => {
        s.tasksById['t-1'].status = 'complete';
        s.tasksById['t-1'].completedAt = '1970-01-01T00:00:42.000Z';
      });
    });

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});

// ─── Dependency display ────────────────────────────────────────────────────
// Dependency tasks live in phase-2 so they are present in the store (for the
// status lookup) but are NOT rendered — only the phase-1 task row renders.

describe('TaskList – dependency display', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('does not render deps when dependencies is empty', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'No Deps',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:01.000Z',
        dependencies: [],
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    expect(container.querySelector('.task-list__deps')).not.toBeInTheDocument();
  });

  it('renders a deps span prefixed with "deps:"', () => {
    const tasks: Record<string, TaskEntity> = {
      'dep-a': makeTask({ id: 'dep-a', title: 'Dep A', phaseId: 'phase-2', status: 'complete' }),
      't-1': makeTask({
        id: 't-1',
        title: 'Main',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:01.000Z',
        dependencies: ['dep-a'],
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const deps = container.querySelector('.task-list__deps');
    expect(deps).toBeInTheDocument();
    expect(deps?.textContent).toContain('deps:');
  });

  it('wraps a completed dependency in task-list__dep--done', () => {
    const tasks: Record<string, TaskEntity> = {
      'dep-a': makeTask({ id: 'dep-a', title: 'Dep A', phaseId: 'phase-2', status: 'complete' }),
      't-1': makeTask({
        id: 't-1',
        title: 'Main',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:01.000Z',
        dependencies: ['dep-a'],
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const done = container.querySelector('.task-list__dep--done');
    expect(done).toBeInTheDocument();
    expect(done?.textContent).toContain('dep-a');
    expect(container.querySelector('.task-list__dep--pending')).not.toBeInTheDocument();
  });

  it('wraps a found-but-incomplete dependency in task-list__dep--pending', () => {
    const tasks: Record<string, TaskEntity> = {
      'dep-a': makeTask({ id: 'dep-a', title: 'Dep A', phaseId: 'phase-2', status: 'active' }),
      't-1': makeTask({
        id: 't-1',
        title: 'Main',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:01.000Z',
        dependencies: ['dep-a'],
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const pending = container.querySelector('.task-list__dep--pending');
    expect(pending).toBeInTheDocument();
    expect(pending?.textContent).toContain('dep-a');
    expect(container.querySelector('.task-list__dep--done')).not.toBeInTheDocument();
  });

  it('wraps a missing (not-found) dependency in task-list__dep--pending', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Main',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:01.000Z',
        dependencies: ['ghost'],
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const pending = container.querySelector('.task-list__dep--pending');
    expect(pending).toBeInTheDocument();
    expect(pending?.textContent).toContain('ghost');
  });

  it('joins multiple dependencies with comma-space and classes by status', () => {
    const tasks: Record<string, TaskEntity> = {
      'dep-done': makeTask({ id: 'dep-done', title: 'Done Dep', phaseId: 'phase-2', status: 'complete' }),
      'dep-pending': makeTask({ id: 'dep-pending', title: 'Pending Dep', phaseId: 'phase-2', status: 'ready' }),
      't-1': makeTask({
        id: 't-1',
        title: 'Main',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:01.000Z',
        dependencies: ['dep-done', 'dep-pending', 'ghost'],
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const deps = container.querySelector('.task-list__deps');
    // Normalize any JSX-introduced whitespace before comparing.
    expect(deps?.textContent?.replace(/\s+/g, ' ').trim()).toBe('deps: dep-done, dep-pending, ghost');

    const done = container.querySelectorAll('.task-list__dep--done');
    const pending = container.querySelectorAll('.task-list__dep--pending');
    expect(done).toHaveLength(1);
    expect(done[0].textContent).toContain('dep-done');
    expect(pending).toHaveLength(2);
    expect(Array.from(pending).map((d) => d.textContent?.trim())).toEqual(['dep-pending', 'ghost']);
  });

  it('renders deps inline within the single-line task body', () => {
    const tasks: Record<string, TaskEntity> = {
      'dep-a': makeTask({ id: 'dep-a', title: 'Dep A', phaseId: 'phase-2', status: 'complete' }),
      't-1': makeTask({
        id: 't-1',
        title: 'Main',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:01.000Z',
        dependencies: ['dep-a'],
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const body = container.querySelector('.task-list__body');
    expect(body?.querySelector('.task-list__title')).toBeInTheDocument();
    expect(body?.querySelector('.task-list__deps')).toBeInTheDocument();
  });
});

// ─── Session plan progress (M) ────────────────────────────────────────────
// When a task declares a sessionPlan and is active/parked, the session label
// renders ●{done}/{total} progress instead of the raw count.

describe('TaskList – session plan progress', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('renders ●{done}/{total} for an active task with a sessionPlan', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Active',
        phaseId: 'phase-1',
        status: 'active',
        sessionPlan: [
          { role: 'executor', profile: 'coder' },
          { role: 'reviewer', profile: 'reviewer' },
          { role: 'executor', profile: 'coder' },
        ],
      }),
    };
    const sessions: Record<string, SessionEntity> = {
      s1: {
        uid: 's1',
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'executor',
        attempt: 1,
      },
    };

    seedStoreAct(tasks, 'phase-1', sessions);

    const { container } = render(<TaskList />);
    const sessionsSpan = container.querySelector('.task-list__sessions');
    expect(sessionsSpan?.textContent).toContain('\u25CF1/3');
  });

  it('renders ●{done}/{total} for a parked task with a sessionPlan', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Parked',
        phaseId: 'phase-1',
        status: 'parked',
        sessionPlan: [
          { role: 'executor', profile: 'coder' },
          { role: 'reviewer', profile: 'reviewer' },
        ],
      }),
    };
    const sessions: Record<string, SessionEntity> = {
      s1: {
        uid: 's1',
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'executor',
        attempt: 1,
      },
      s2: {
        uid: 's2',
        agentId: 'a2',
        profile: 'reviewer',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: false,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'reviewer',
        attempt: 1,
      },
    };

    seedStoreAct(tasks, 'phase-1', sessions);

    const { container } = render(<TaskList />);
    const sessionsSpan = container.querySelector('.task-list__sessions');
    expect(sessionsSpan?.textContent).toContain('\u25CF2/2');
  });

  it('falls back to raw session count for an active task without a sessionPlan', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Active',
        phaseId: 'phase-1',
        status: 'active',
      }),
    };
    const sessions: Record<string, SessionEntity> = {
      s1: {
        uid: 's1',
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'executor',
        attempt: 1,
      },
    };

    seedStoreAct(tasks, 'phase-1', sessions);

    const { container } = render(<TaskList />);
    const sessionsSpan = container.querySelector('.task-list__sessions');
    expect(sessionsSpan?.textContent).toContain('1 session');
    expect(sessionsSpan?.textContent).not.toContain('\u25CF');
  });

  it('falls back to raw session count for a completed task with a sessionPlan', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Done',
        phaseId: 'phase-1',
        status: 'complete',
        startedAt: 0,
        completedAt: '1970-01-01T00:00:01.000Z',
        sessionPlan: [
          { role: 'executor', profile: 'coder' },
          { role: 'reviewer', profile: 'reviewer' },
        ],
      }),
    };
    const sessions: Record<string, SessionEntity> = {
      s1: {
        uid: 's1',
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'phase-1',
        taskId: 't-1',
        active: false,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        runnerRole: 'executor',
        attempt: 1,
      },
    };

    seedStoreAct(tasks, 'phase-1', sessions);

    const { container } = render(<TaskList />);
    const sessionsSpan = container.querySelector('.task-list__sessions');
    expect(sessionsSpan?.textContent).toContain('1 session');
    expect(sessionsSpan?.textContent).not.toContain('\u25CF');
  });
});

// ─── Parked elapsed timer freeze (F4 Web) ─────────────────────────────────
// Parked tasks should not start a 1s interval and should display a paused
// indicator with a de-emphasis CSS class.

describe('TaskList – parked elapsed freeze', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('does not set up an interval for a parked task', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Parked',
        phaseId: 'phase-1',
        status: 'parked',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    render(<TaskList />);

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('applies task-list__elapsed--paused class for a parked task', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Parked',
        phaseId: 'phase-1',
        status: 'parked',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const elapsed = container.querySelector('.task-list__elapsed');
    expect(elapsed).toBeInTheDocument();
    expect(elapsed).toHaveClass('task-list__elapsed--paused');
  });

  it('shows a pause indicator prefix for a parked task', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Parked',
        phaseId: 'phase-1',
        status: 'parked',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const elapsed = container.querySelector('.task-list__elapsed');
    // The pause indicator (⏸ U+23F8) should be present
    expect(elapsed?.textContent).toContain('\u23F8');
  });

  it('does NOT apply paused class for an active task', () => {
    const tasks: Record<string, TaskEntity> = {
      't-1': makeTask({
        id: 't-1',
        title: 'Active',
        phaseId: 'phase-1',
        status: 'active',
        startedAt: 0,
      }),
    };
    seedStoreAct(tasks, 'phase-1');

    const { container } = render(<TaskList />);
    const elapsed = container.querySelector('.task-list__elapsed');
    expect(elapsed).toBeInTheDocument();
    expect(elapsed).not.toHaveClass('task-list__elapsed--paused');
  });
});
