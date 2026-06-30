import type { TaskEntity } from '@engin/shared';
import { afterEach, describe, expect, it } from 'bun:test';
import { __resetClockForTesting } from '../hooks/use-clock.js';
import { renderTest, stripAnsi } from '../test-harness.js';
import { statusIconMap } from '../theme.js';
import { TaskList, type TaskListProps } from './task-list.js';

// The shared clock is a module-level singleton; reset it after each test so
// the next test re-initializes `now` to a fresh Date.now() (otherwise later
// tests drift by up to ~1s per preceding test, breaking live-elapsed asserts).
afterEach(() => {
  __resetClockForTesting();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal TaskEntity with defaults. */
function makeTask(
  overrides: Partial<TaskEntity> & { id: string; title: string; status: TaskEntity['status'] },
): TaskEntity {
  const task: TaskEntity = {
    phaseId: 'p1',
    dependencies: [],
    startedAt: undefined,
    completedAt: undefined,
    ...overrides,
  };
  if (task.activeStartedAt === undefined && task.status === 'active' && typeof task.startedAt === 'number') {
    task.activeStartedAt = task.startedAt;
  }
  if (task.elapsedMs === undefined && typeof task.startedAt === 'number') {
    if (task.status === 'active') {
      task.elapsedMs = 0;
    } else if (task.completedAt !== undefined) {
      task.elapsedMs = Math.max(0, Date.parse(task.completedAt) - task.startedAt);
    } else if (task.status === 'parked') {
      task.elapsedMs = Date.now() - task.startedAt;
    } else {
      task.elapsedMs = Date.now() - task.startedAt;
    }
  }
  return task;
}

/**
 * Compact display label for the task at 1-based registration index.
 */
function idLabel(indexOneBased: number, count = 99): string {
  const width = Math.max(2, String(count).length);
  return 't-' + String(indexOneBased).padStart(width, '0');
}

/** Create N simple ready tasks with ids `${prefix}1`..`${prefix}N`. */
function makeManyTasks(count: number, prefix = 't'): TaskEntity[] {
  const tasks: TaskEntity[] = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    tasks.push(makeTask({ id: `${prefix}${n}`, title: `Task ${n}`, status: 'ready' }));
  }
  return tasks;
}

/** Default props for a basic task list. */
const defaultProps: TaskListProps = {
  tasks: [],
  selectedTaskId: null,
  sessionCounts: {},
};

/**
 * Render TaskList and return the lines from the first frame.
 * For tests that depend on effects (viewport scroll, auto-scroll),
 * use renderWithEffects() instead.
 */
function renderStatic(props: TaskListProps): string[] {
  const { lastFrame, unmount } = renderTest(<TaskList {...props} />);
  const frame = lastFrame() ?? '';
  unmount();
  return frame.split('\n');
}

/**
 * Render TaskList and force a re-render to flush pending effects.
 * Returns lines from the second (effect-processed) frame.
 */
function renderWithEffects(props: TaskListProps): { lines: string[]; unmount: () => void } {
  const result = renderTest(<TaskList {...props} />);
  // Re-render with the same props to flush effects
  result.rerender(<TaskList {...props} />);
  const frame = result.lastFrame() ?? '';
  return { lines: frame.split('\n'), unmount: result.unmount };
}

/** Check if a line is a viewport indicator. */
function isIndicator(line: string): boolean {
  const stripped = stripAnsi(line).trim();
  return /^↑ \d+ more above \(↑\/↓\)$/.test(stripped) || /^↓ \d+ more below \(↑\/↓\)$/.test(stripped);
}

/** Extract the compact task label (e.g. `t-01`) from a rendered row. */
function taskLabelFromLine(line: string): string | null {
  const stripped = stripAnsi(line);
  if (stripped === '' || isIndicator(line)) return null;
  const match = stripped.match(/(t-\d+)/);
  return match ? match[1] : null;
}

/** First task label rendered (skipping indicators/blank lines). */
function firstTaskLabel(lines: string[]): string | null {
  for (const line of lines) {
    const id = taskLabelFromLine(line);
    if (id !== null) return id;
  }
  return null;
}

/** All task labels rendered in order (skipping indicators/blank lines). */
function renderedTaskLabels(lines: string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    const id = taskLabelFromLine(line);
    if (id !== null) ids.push(id);
  }
  return ids;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TaskList (Ink)', () => {
  describe('rendering empty tasks', () => {
    it('renders nothing when no tasks are given', () => {
      const lines = renderStatic({ ...defaultProps });
      // All lines should be empty/whitespace
      for (const line of lines) {
        expect(stripAnsi(line).trim()).toBe('');
      }
    });
  });

  describe('rendering tasks with status icons and titles', () => {
    it('renders each task row with icon, id, and title', () => {
      const tasks: TaskEntity[] = [
        makeTask({ id: 't1', title: 'Task A', status: 'complete' }),
        makeTask({ id: 't2', title: 'Task B', status: 'active' }),
        makeTask({ id: 't3', title: 'Task C', status: 'blocked' }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      // Find rows containing each task
      const taskLines = lines.filter((l) => {
        const s = stripAnsi(l);
        return s.includes('Task A') || s.includes('Task B') || s.includes('Task C');
      });
      expect(taskLines).toHaveLength(3);

      const t1Line = stripAnsi(taskLines.find((l) => l.includes('Task A'))!);
      expect(t1Line).toContain(statusIconMap.complete);
      expect(t1Line).toContain(idLabel(1, 3));
      expect(t1Line).toContain('Task A');

      const t2Line = stripAnsi(taskLines.find((l) => l.includes('Task B'))!);
      expect(t2Line).toContain(statusIconMap.active);
      expect(t2Line).toContain(idLabel(2, 3));
      expect(t2Line).toContain('Task B');

      const t3Line = stripAnsi(taskLines.find((l) => l.includes('Task C'))!);
      expect(t3Line).toContain(statusIconMap.blocked);
      expect(t3Line).toContain(idLabel(3, 3));
      expect(t3Line).toContain('Task C');
    });

    it('rows are ordered in creation/registration order', () => {
      const tasks: TaskEntity[] = [
        makeTask({ id: 't1', title: 'First', status: 'complete' }),
        makeTask({ id: 't2', title: 'Second', status: 'active' }),
        makeTask({ id: 't3', title: 'Third', status: 'ready' }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const labels = renderedTaskLabels(lines);
      expect(labels).toEqual([idLabel(1, 3), idLabel(2, 3), idLabel(3, 3)]);
    });
  });

  describe('column layout', () => {
    it('separates columns with at least 2-space gaps', () => {
      const tasks = [makeTask({ id: 't1', title: 'Solo', status: 'ready' })];
      const lines = renderStatic({ ...defaultProps, tasks });

      const stripped = stripAnsi(lines[0]);
      // Icon, id, and title separated by appropriate spacing
      expect(stripped).toContain(statusIconMap.ready);
      expect(stripped).toContain(idLabel(1, 1));
      expect(stripped).toContain('Solo');
      // No deps: or step: prefixes
      expect(stripped).not.toContain('deps:');
      expect(stripped).not.toContain('step:');
    });

    it('omits step and deps columns when no task uses them', () => {
      const tasks = [
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      for (const line of lines) {
        const stripped = stripAnsi(line);
        expect(stripped).not.toContain('session');
        // Only one task id label per row (no deps)
        const labels = stripped.match(/t-\d+/g) || [];
        expect(labels.length).toBe(1);
      }
    });

    it('shows the session-count column for active tasks with sessions', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Run',
          status: 'active',
          startedAt: Date.now() - 5000,
        }),
      ];
      const lines = renderStatic({
        ...defaultProps,
        tasks,
        sessionCounts: { t1: 2 },
      });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).toContain('2 sessions');
      expect(stripped).toContain('Run');
      // Title + elapsed appear on the same line (no wrapping).
      expect(stripped).toContain('5s');
    });

    it('shows the dependencies column only when a task has dependencies', () => {
      const tasks = [
        makeTask({ id: 'dep1', title: 'Dep', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'Done',
          status: 'complete',
          startedAt: 1000,
          completedAt: new Date(6000).toISOString(),
          dependencies: ['dep1'],
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const t1Line = stripAnsi(lines.find((l) => l.includes('Done'))!);
      expect(t1Line).toContain(idLabel(1, 2));
      expect(t1Line).toContain(idLabel(2, 2));
      expect(t1Line).not.toContain('deps:');
    });
  });

  describe('selected task', () => {
    it('renders selected task line with expected visual content', () => {
      const tasks = [
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
      ];
      const lines = renderStatic({
        ...defaultProps,
        tasks,
        selectedTaskId: 't2',
      });

      const selectedLine = stripAnsi(lines.find((l) => l.includes('Second'))!);
      expect(selectedLine).toContain(statusIconMap.complete);
      expect(selectedLine).toContain(idLabel(2, 2));
      expect(selectedLine).toContain('Second');
    });

    it('keeps selected task format unchanged (no extra markers)', () => {
      const tasks = [
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
      ];
      const lines = renderStatic({
        ...defaultProps,
        tasks,
        selectedTaskId: 't2',
      });

      const selectedLine = stripAnsi(lines.find((l) => l.includes('Second'))!);
      expect(selectedLine).toContain(statusIconMap.complete);
      expect(selectedLine).toContain(idLabel(2, 2));
      expect(selectedLine).toContain('Second');
    });
  });

  describe('status icons', () => {
    it('renders each status with the correct status icon', () => {
      const tasks: TaskEntity[] = [
        makeTask({ id: 't1', title: 'A', status: 'active' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
        makeTask({ id: 't3', title: 'C', status: 'failed' }),
        makeTask({ id: 't4', title: 'D', status: 'cancelled' }),
        makeTask({ id: 't5', title: 'E', status: 'ready' }),
        makeTask({ id: 't6', title: 'F', status: 'blocked' }),
        makeTask({ id: 't7', title: 'G', status: 'parked' }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      for (const task of tasks) {
        const line = stripAnsi(lines.find((l) => l.includes(task.title))!);
        expect(line).toContain(statusIconMap[task.status]);
      }
    });
  });

  describe('session progress column', () => {
    it('shows ●N/M progress when sessionPlan is set', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Plan Task',
          status: 'active',
          sessionPlan: [
            { role: 'coder', profile: 'default' },
            { role: 'reviewer', profile: 'default' },
          ],
          startedAt: Date.now() - 3000,
        }),
      ];
      const lines = renderStatic({
        ...defaultProps,
        tasks,
        sessionCounts: { t1: 1 },
      });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).toContain('●1/2');
      expect(stripped).toContain('Plan Task');
      // Elapsed appears on the same line as the title.
      expect(stripped).toContain('3s');
    });

    it('shows N sessions when no sessionPlan but sessionCount > 0', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Count Task',
          status: 'active',
          startedAt: Date.now() - 3000,
        }),
      ];
      const lines = renderStatic({
        ...defaultProps,
        tasks,
        sessionCounts: { t1: 3 },
      });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).toContain('3 sessions');
    });

    it('shows no session column for non-active/parked tasks', () => {
      const tasks = [makeTask({ id: 't1', title: 'Ready Task', status: 'ready' })];
      const lines = renderStatic({
        ...defaultProps,
        tasks,
        sessionCounts: { t1: 5 },
      });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).not.toContain('session');
      expect(stripped).toContain(statusIconMap.ready);
      expect(stripped).toContain(idLabel(1, 1));
      expect(stripped).toContain('Ready Task');
    });

    it('shows no session column when sessionCount is 0', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Zero Task',
          status: 'active',
          startedAt: Date.now() - 3000,
        }),
      ];
      const lines = renderStatic({
        ...defaultProps,
        tasks,
        sessionCounts: { t1: 0 },
      });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).not.toContain('session');
    });

    it('shows session progress for parked tasks', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Parked Plan',
          status: 'parked',
          sessionPlan: [
            { role: 'coder', profile: 'default' },
            { role: 'reviewer', profile: 'default' },
            { role: 'executor', profile: 'default' },
          ],
          startedAt: Date.now() - 5000,
        }),
      ];
      const lines = renderStatic({
        ...defaultProps,
        tasks,
        sessionCounts: { t1: 2 },
      });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).toContain('●2/3');
      // Elapsed appears on the same line as the title.
      expect(stripped).toContain('5s');
    });
  });

  describe('dependencies column rendering', () => {
    it('task with no dependencies shows no deps column', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Solo',
          status: 'active',
          startedAt: Date.now() - 5000,
          dependencies: [],
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const stripped = stripAnsi(lines[0]);
      // Only one task id label (no deps)
      expect((stripped.match(/t-\d+/g) || []).length).toBe(1);
      expect(stripped).not.toContain('deps:');
    });

    it('dependency id not present in task list renders as raw id', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'ready',
          dependencies: ['dep1'],
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const stripped = stripAnsi(lines[0]);
      // dep1 not in task list, so no t-NN label for it → raw "dep1"
      expect(stripped).toContain('dep1');
    });

    it('task with dependency shows dep label after title', () => {
      const tasks = [
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'Done',
          status: 'complete',
          startedAt: 1000,
          completedAt: new Date(6000).toISOString(),
          dependencies: ['dep1'],
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const t1Line = stripAnsi(lines.find((l) => l.includes('Done'))!);
      expect(t1Line).toContain(idLabel(1, 2));
      // deps includes t-01
      expect(t1Line).toContain(idLabel(1, 2));
    });

    it('never emits a "deps:" prefix', () => {
      const tasks = [
        makeTask({ id: 'dep1', title: 'Dep', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'Mine',
          status: 'ready',
          dependencies: ['dep1', 'dep2'],
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      for (const line of lines) {
        const stripped = stripAnsi(line);
        expect(stripped).not.toContain('deps:');
      }
    });
  });

  describe('elapsed time', () => {
    it('active task shows live elapsed', () => {
      const startedAt = Date.now() - 5000;
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Active Task',
          status: 'active',
          startedAt,
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).toContain('Active Task');
      // Title + elapsed appear on the same line.
      expect(stripped).toContain('5s');
    });

    it('complete task shows frozen elapsed (using completedAt)', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Complete Task',
          status: 'complete',
          startedAt: 1000,
          completedAt: new Date(6000).toISOString(),
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).toContain('Complete Task');
      // Frozen elapsed appears on the same line as the title.
      expect(stripped).toContain('5s');
    });

    it('ready task shows no elapsed', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Ready Task',
          status: 'ready',
          startedAt: Date.now() - 5000,
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).toContain('Ready Task');
      expect(stripped).not.toMatch(/\d+[smh]/);
      // Only icon, id, title
      expect(stripped).toBe(statusIconMap.ready + '  ' + idLabel(1, 1) + '  Ready Task');
    });

    it('parked task shows frozen elapsed', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'Parked Task',
          status: 'parked',
          startedAt: Date.now() - 5000,
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).toContain('Parked Task');
      // Frozen elapsed appears on the same line as the title.
      expect(stripped).toContain('5s');
    });

    it('active task without startedAt shows no elapsed', () => {
      const tasks = [
        makeTask({
          id: 't1',
          title: 'No Elapsed',
          status: 'active',
          // no startedAt
        }),
      ];
      const lines = renderStatic({ ...defaultProps, tasks });

      const stripped = stripAnsi(lines[0]);
      expect(stripped).toContain('No Elapsed');
      expect(stripped).not.toMatch(/\d+[smh]/);
    });
  });

  describe('viewport capping (20-line cap)', () => {
    it('caps rendered output at 20 lines when there are more than 20 tasks', () => {
      const tasks = makeManyTasks(25);
      const lines = renderStatic({ ...defaultProps, tasks });
      // 19 task rows + 1 indicator = 20
      expect(lines).toHaveLength(20);
    });

    it('shows a bottom indicator when there are more tasks below', () => {
      const tasks = makeManyTasks(25);
      const lines = renderStatic({ ...defaultProps, tasks });
      expect(lines).toHaveLength(20);
      const lastLine = lines[lines.length - 1];
      expect(isIndicator(lastLine)).toBe(true);
      expect(stripAnsi(lastLine)).toContain('more below');
    });

    it('shows no indicators when there are fewer than 20 tasks', () => {
      const tasks = makeManyTasks(15);
      const lines = renderStatic({ ...defaultProps, tasks });
      expect(lines).toHaveLength(15);
      for (const line of lines) {
        expect(isIndicator(line)).toBe(false);
      }
    });

    it('shows no indicators at the boundary (exactly 20 tasks)', () => {
      const tasks = makeManyTasks(20);
      const lines = renderStatic({ ...defaultProps, tasks });
      expect(lines).toHaveLength(20);
      for (const line of lines) {
        expect(isIndicator(line)).toBe(false);
      }
    });
  });

  describe('viewport edge-scrolling with effects', () => {
    it('shows a top indicator when scrolled to bottom (via ensureVisible)', () => {
      const tasks = makeManyTasks(25);
      const { lines, unmount } = renderWithEffects({
        ...defaultProps,
        tasks,
        selectedTaskId: 't25',
      });

      expect(lines).toHaveLength(20);
      // When scrolled down, expect a top indicator
      // (The effect ensures t25 is visible, which requires scrolling)
      expect(isIndicator(lines[0])).toBe(true);
      expect(stripAnsi(lines[0])).toContain('more above');
      unmount();
    });

    it('scrolls down to show the last task', () => {
      const tasks = makeManyTasks(25);
      const { lines, unmount } = renderWithEffects({
        ...defaultProps,
        tasks,
        selectedTaskId: 't25',
      });
      const labels = renderedTaskLabels(lines);
      expect(labels).toContain(idLabel(25, 25));
      unmount();
    });

    it('scrolls up to show selected task at top when above viewport', () => {
      const tasks = makeManyTasks(25);
      const { lines, unmount } = renderWithEffects({
        ...defaultProps,
        tasks,
        selectedTaskId: 't5',
      });
      const labels = renderedTaskLabels(lines);
      expect(labels).toContain(idLabel(5, 25));
      unmount();
    });
  });

  describe('auto-scroll and scroll-reset behavior', () => {
    it('auto-scrolls when tasks transition ready→active below viewport', () => {
      const tasks = makeManyTasks(25);
      const initialProps: TaskListProps = { ...defaultProps, tasks };

      const result = renderTest(<TaskList {...initialProps} />);
      // Flush mount effects (set prevStatusesRef, no scroll change yet)
      result.rerender(<TaskList {...initialProps} />);

      // Initial state: at top, no top indicator
      const initLines = (result.lastFrame() ?? '').split('\n');
      expect(initLines.some((l) => l.includes('more above'))).toBe(false);
      expect(firstTaskLabel(initLines)).toBe(idLabel(1, 25));

      // Transition tasks 20-24 (indices 19-23) from ready → active
      const now = Date.now();
      const activeTasks = tasks.map((t, i) =>
        i >= 19 ? ({ ...t, status: 'active' as const, startedAt: now } as TaskEntity) : t,
      );
      const activeProps: TaskListProps = { ...defaultProps, tasks: activeTasks };

      // Trigger auto-scroll effect
      result.rerender(<TaskList {...activeProps} />);
      // Flush pending state update from auto-scroll
      result.rerender(<TaskList {...activeProps} />);

      const afterLines = (result.lastFrame() ?? '').split('\n');

      // Viewport should have scrolled down — top indicator should appear
      expect(afterLines.some((l) => isIndicator(l) && l.includes('more above'))).toBe(true);
      // First visible task should no longer be t-01 (scrolled past it)
      expect(firstTaskLabel(afterLines)).not.toBe(idLabel(1, 25));

      result.unmount();
    });

    it('auto-scrolls when tasks transition ready→parked below viewport', () => {
      const tasks = makeManyTasks(25);
      const initialProps: TaskListProps = { ...defaultProps, tasks };

      const result = renderTest(<TaskList {...initialProps} />);
      result.rerender(<TaskList {...initialProps} />);

      const initLines = (result.lastFrame() ?? '').split('\n');
      expect(initLines.some((l) => l.includes('more above'))).toBe(false);

      // Transition tasks 20-24 (indices 19-23) from ready → parked
      const now = Date.now();
      const parkedTasks = tasks.map((t, i) =>
        i >= 19 ? ({ ...t, status: 'parked' as const, startedAt: now } as TaskEntity) : t,
      );
      const parkedProps: TaskListProps = { ...defaultProps, tasks: parkedTasks };

      result.rerender(<TaskList {...parkedProps} />);
      result.rerender(<TaskList {...parkedProps} />);

      const afterLines = (result.lastFrame() ?? '').split('\n');

      expect(afterLines.some((l) => isIndicator(l) && l.includes('more above'))).toBe(true);
      expect(firstTaskLabel(afterLines)).not.toBe(idLabel(1, 25));

      result.unmount();
    });

    it('resets scrollOffset to 0 when task set IDs change', () => {
      // Initial: 25 tasks, select last one → viewport scrolls to show it
      const result = renderTest(<TaskList {...defaultProps} tasks={makeManyTasks(25, 'A')} selectedTaskId="A25" />);
      // Flush ensureVisible effect (scrolls down to show A25)
      result.rerender(<TaskList {...defaultProps} tasks={makeManyTasks(25, 'A')} selectedTaskId="A25" />);

      const beforeLines = (result.lastFrame() ?? '').split('\n');
      expect(beforeLines.some((l) => isIndicator(l) && l.includes('more above'))).toBe(true);

      // Replace with completely different task set (different IDs), no selection
      result.rerender(<TaskList {...defaultProps} tasks={makeManyTasks(25, 'B')} selectedTaskId={null} />);
      // Flush reset effect
      result.rerender(<TaskList {...defaultProps} tasks={makeManyTasks(25, 'B')} selectedTaskId={null} />);

      const afterLines = (result.lastFrame() ?? '').split('\n');
      // Should be back at top — no top indicator, first visible is B-01 (label t-01)
      expect(afterLines.some((l) => isIndicator(l) && l.includes('more above'))).toBe(false);
      expect(firstTaskLabel(afterLines)).toBe(idLabel(1, 25));

      result.unmount();
    });
  });
});
