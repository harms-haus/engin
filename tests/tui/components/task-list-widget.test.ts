import { visibleWidth } from '@earendil-works/pi-tui';
import type { TaskEntity } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import { TaskListWidget } from '../../../packages/tui/src/components/task-list-widget.js';
import { dim, statusColor, statusIcon, stripAnsi, yellow } from '../../../packages/tui/src/theme.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';

const WIDTH = 40;

/** Build a minimal TaskEntity with defaults. */
function makeTask(
  overrides: Partial<TaskEntity> & { id: string; title: string; status: TaskEntity['status'] },
): TaskEntity {
  return {
    phaseId: 'p1',
    steps: [],
    dependencies: [],
    activeStepIndex: undefined,
    startedAt: undefined,
    completedAt: undefined,
    ...overrides,
  };
}

/**
 * Expected column prefix for a non-selected task row in the new table layout:
 *   dim(id) + 2-space gap + statusIcon + 2-space gap + status-colored title
 */
function rowStart(task: TaskEntity): string {
  return dim(task.id) + '  ' + statusIcon(task.status) + '  ' + statusColor(task.status)(task.title);
}

/**
 * True when `plain` (an ANSI-free substring of `row`) is rendered inside an
 * active bold (\x1b[1m) region: a `\x1b[1m` must appear after the most recent
 * SGR reset (\x1b[0m) preceding `plain`. Selection bolding is applied
 * per-cell, so this confirms the emphasis survives each cell's ANSI reset
 * (the icon and title are bold, not just the leading dim ID).
 */
function isWithinBold(row: string, plain: string): boolean {
  const idx = row.indexOf(plain);
  if (idx < 0) return false;
  const before = row.slice(0, idx);
  return before.lastIndexOf('\x1b[1m') > before.lastIndexOf('\x1b[0m');
}

/** Create N simple ready tasks with ids `${prefix}1`..`${prefix}N` (registration order). */
function makeManyTasks(count: number, prefix = 't'): TaskEntity[] {
  const tasks: TaskEntity[] = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    tasks.push(makeTask({ id: `${prefix}${n}`, title: `Task ${n}`, status: 'ready' }));
  }
  return tasks;
}

describe('TaskListWidget', () => {
  describe('rendering empty tasks', () => {
    it('renders zero lines when no tasks are set', () => {
      const widget = new TaskListWidget();
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(0);
    });
  });

  describe('getVisibleTaskCount', () => {
    it('returns 0 when no tasks are set', () => {
      const widget = new TaskListWidget();
      expect(widget.getVisibleTaskCount()).toBe(0);
    });

    it('returns the number of tasks set via updateTasks', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
      ]);
      expect(widget.getVisibleTaskCount()).toBe(2);
    });

    it('updates when tasks change', () => {
      const widget = new TaskListWidget();
      expect(widget.getVisibleTaskCount()).toBe(0);
      widget.updateTasks([makeTask({ id: 't1', title: 'A', status: 'ready' })]);
      expect(widget.getVisibleTaskCount()).toBe(1);
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
        makeTask({ id: 't3', title: 'C', status: 'failed' }),
      ]);
      expect(widget.getVisibleTaskCount()).toBe(3);
    });
  });

  describe('rendering tasks with status icons and titles', () => {
    it('renders each task row starting with dim(id), icon, and colored title columns', () => {
      const widget = new TaskListWidget();
      const tasks: TaskEntity[] = [
        makeTask({ id: 't1', title: 'Task A', status: 'complete' }),
        makeTask({ id: 't2', title: 'Task B', status: 'active' }),
        makeTask({ id: 't3', title: 'Task C', status: 'blocked' }),
      ];
      widget.updateTasks(tasks);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(3);

      // Creation order: complete (t1), active (t2), blocked (t3)
      // New table prefix: dim(id) + '  ' + icon + '  ' + statusColor(title)
      expect(lines[0].startsWith(rowStart(tasks[0]))).toBe(true);
      expect(lines[1].startsWith(rowStart(tasks[1]))).toBe(true);
      expect(lines[2].startsWith(rowStart(tasks[2]))).toBe(true);
    });

    it('renders only actual tasks with no blank padding', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'Only', status: 'ready' })]);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(1);
      // Stripped of ANSI the row is exactly: id + 2 spaces + icon + 2 spaces + title
      // (step and deps columns are omitted since unused)
      expect(stripAnsi(lines[0])).toBe('t1  ' + statusIcon('ready') + '  Only');
    });
  });

  describe('table column layout', () => {
    it('separates the ID, icon, and title columns with exactly 2-space gaps', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'Solo', status: 'ready' })]);
      const lines = widget.render(WIDTH);
      expect(stripAnsi(lines[0])).toBe('t1  ' + statusIcon('ready') + '  Solo');
    });

    it('omits the step and dependencies columns entirely when no task uses them', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
      ]);
      const lines = widget.render(WIDTH);
      // No trailing step/deps columns → rows contain no 'step'/'deps' segments
      expect(lines[0]).not.toContain('step');
      expect(lines[0]).not.toContain('deps');
      expect(lines[1]).not.toContain('step');
      expect(lines[1]).not.toContain('deps');
    });

    it('pads shorter cells to align with the widest column', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'BBBB', status: 'ready' }),
      ]);
      const lines = widget.render(WIDTH);
      // Title column width = 4 (max). 'A' is padded to 4 with trailing spaces.
      expect(stripAnsi(lines[0])).toBe('t1  ' + statusIcon('ready') + '  A   ');
      expect(stripAnsi(lines[1])).toBe('t2  ' + statusIcon('ready') + '  BBBB');
    });

    it('shows the step column for active multi-step tasks', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({
          id: 't1',
          title: 'Run',
          status: 'active',
          steps: [
            { name: 'plan', index: 0 },
            { name: 'do', index: 1 },
          ],
          activeStepIndex: 0,
        }),
      ]);
      const lines = widget.render(WIDTH);
      // Step is its own column (2-space gap), NOT appended to the title with ' - '.
      expect(stripAnsi(lines[0])).toBe('t1  ' + statusIcon('active') + '  Run  step 1/2: plan');
      expect(lines[0]).toContain(dim('step 1/2: plan'));
    });

    it('active task with a single step does not show step progress (requires > 1 step)', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({
          id: 't1',
          title: 'Run',
          status: 'active',
          steps: [{ name: 'only', index: 0 }],
          activeStepIndex: 0,
          startedAt: Date.now() - 5000,
        }),
      ]);
      const lines = widget.render(WIDTH);
      // steps.length === 1 is not > 1, so the step column is omitted.
      expect(stripAnsi(lines[0])).toBe('t1  ' + statusIcon('active') + '  Run - 5s');
      expect(lines[0]).not.toContain('step');
    });

    it('shows the dependencies column only when a task has dependencies', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'Done',
          status: 'complete',
          startedAt: 1000,
          completedAt: new Date(6000).toISOString(),
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(WIDTH);
      // t1 is the last row (creation order). Step column omitted, deps column present.
      // dep1 is complete → rendered with dim. No 'deps:' prefix anywhere.
      // t1 (width 2) is padded to the ID column width (4, from 'dep1'),
      // so there are 4 spaces between 't1' and the icon (2 pad + 2 gap).
      expect(stripAnsi(lines[1])).toBe('t1    ' + statusIcon('complete') + '  Done - 5s  dep1');
      expect(lines[1]).toContain(dim('dep1'));
      expect(lines[1]).not.toContain('deps:');
    });

    it('never emits a "deps:" prefix (dependencies are a bare column)', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'Mine',
          status: 'ready',
          dependencies: ['dep1', 'dep2'],
        }),
      ]);
      const lines = widget.render(WIDTH);
      for (const line of lines) {
        expect(line).not.toContain('deps:');
        expect(line).not.toContain(' - deps');
      }
    });
  });

  describe('selected task', () => {
    it('wraps the entire selected row in bold (\\x1b[1m at start of line)', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
      ]);
      // Creation order: ready (t1) at index 0, complete (t2) at index 1
      widget.setSelectedTaskId('t2');
      const lines = widget.render(WIDTH);

      // Line 0 is NOT bold and starts with its plain column prefix
      expect(lines[0].startsWith('\x1b[1m')).toBe(false);
      expect(lines[0]).not.toContain('\x1b[1m');
      expect(lines[0].startsWith(rowStart(makeTask({ id: 't1', title: 'First', status: 'ready' })))).toBe(true);

      // Line 1: every column cell is individually bolded so the emphasis
      // survives each cell's ANSI reset — the icon AND title (not just the
      // dim ID) carry the bold attribute. Stripped of ANSI the layout is unchanged.
      expect(lines[1].startsWith('\x1b[1m')).toBe(true);
      expect(isWithinBold(lines[1], statusIcon('complete'))).toBe(true);
      expect(isWithinBold(lines[1], 'Second')).toBe(true);
      expect(stripAnsi(lines[1])).toBe(
        stripAnsi(rowStart(makeTask({ id: 't2', title: 'Second', status: 'complete' }))),
      );
    });
  });

  describe('navigation', () => {
    it('Up arrow decrements selected task index', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'ready' }),
        makeTask({ id: 't3', title: 'C', status: 'ready' }),
      ]);
      widget.setSelectedTaskId('t3');
      expect(widget.getSelectedTaskId()).toBe('t3');

      widget.handleInput(UP);
      expect(widget.getSelectedTaskId()).toBe('t2');

      widget.handleInput(UP);
      expect(widget.getSelectedTaskId()).toBe('t1');
    });

    it('Down arrow increments selected task index', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'ready' }),
        makeTask({ id: 't3', title: 'C', status: 'ready' }),
      ]);
      widget.setSelectedTaskId('t1');
      expect(widget.getSelectedTaskId()).toBe('t1');

      widget.handleInput(DOWN);
      expect(widget.getSelectedTaskId()).toBe('t2');

      widget.handleInput(DOWN);
      expect(widget.getSelectedTaskId()).toBe('t3');
    });

    it('does not go above index 0', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'ready' }),
      ]);
      widget.setSelectedTaskId('t1');
      widget.handleInput(UP);
      expect(widget.getSelectedTaskId()).toBe('t1');
    });

    it('does not go below last task', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'ready' }),
      ]);
      widget.setSelectedTaskId('t2');
      widget.handleInput(DOWN);
      expect(widget.getSelectedTaskId()).toBe('t2');
    });
  });

  describe('getSelectedTaskId', () => {
    it('returns null when no task is selected', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'A', status: 'ready' })]);
      expect(widget.getSelectedTaskId()).toBeNull();
    });

    it('returns the correct task id after setting selection', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
        makeTask({ id: 't3', title: 'C', status: 'failed' }),
      ]);
      widget.setSelectedTaskId('t2');
      expect(widget.getSelectedTaskId()).toBe('t2');
    });
  });

  describe('getSelectedTask', () => {
    it('returns the selected task object', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
        makeTask({ id: 't3', title: 'C', status: 'active' }),
      ]);
      widget.setSelectedTaskId('t1');
      const task = widget.getSelectedTask();
      expect(task).toBeDefined();
      expect(task!.id).toBe('t1');
      expect(task!.title).toBe('A');
      expect(task!.status).toBe('ready');
    });

    it('returns undefined when no task is selected', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'A', status: 'ready' })]);
      expect(widget.getSelectedTask()).toBeUndefined();
    });
  });

  describe('setSelectedTaskId', () => {
    it('selects the task with the given ID', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
        makeTask({ id: 't3', title: 'C', status: 'active' }),
      ]);
      widget.setSelectedTaskId('t2');
      expect(widget.getSelectedTaskId()).toBe('t2');
      expect(widget.getSelectedTask()?.title).toBe('B');
    });

    it('is a no-op for non-existent ID', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
      ]);
      widget.setSelectedTaskId('t1');
      expect(widget.getSelectedTaskId()).toBe('t1');
      widget.setSelectedTaskId('nonexistent');
      expect(widget.getSelectedTaskId()).toBe('t1');
    });

    it('accepts null to clear selection', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
      ]);
      widget.setSelectedTaskId('t1');
      expect(widget.getSelectedTaskId()).toBe('t1');
      widget.setSelectedTaskId(null);
      expect(widget.getSelectedTaskId()).toBeNull();
    });
  });

  describe('truncation and row width', () => {
    it('truncates a row that exceeds the given width (with ellipsis)', () => {
      const widget = new TaskListWidget();
      const longTitle = 'A'.repeat(80);
      widget.updateTasks([makeTask({ id: 't1', title: longTitle, status: 'ready' })]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(1);
      // The full table row (87 visible cols) exceeds WIDTH, so the row is truncated to WIDTH.
      expect(visibleWidth(lines[0])).toBeLessThanOrEqual(WIDTH);
      expect(lines[0]).toContain('…');
    });

    it('does not pad the row out to the full terminal width', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'Hi', status: 'ready' })]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(1);
      // The row's visible width is the natural table width (id + icon + title + gaps),
      // which is much less than WIDTH — the row is NOT padded to fill WIDTH.
      expect(visibleWidth(lines[0])).toBeLessThan(WIDTH);
      expect(stripAnsi(lines[0])).toBe('t1  ' + statusIcon('ready') + '  Hi');
    });

    it('does not let an off-screen task widen columns and truncate visible deps (viewport-scoped widths)', () => {
      // Regression: column widths were computed from ALL tasks, so a single
      // off-screen task with a long title widened the title column for every
      // visible row, truncating the deps column on an 80-col terminal.
      const widget = new TaskListWidget();
      const tasks: TaskEntity[] = [];
      for (let i = 0; i < 25; i++) {
        const n = i + 1;
        tasks.push(
          makeTask({
            id: `t${n}`,
            // Task #20 (index 19) is below the fold at offset 0 and not rendered.
            title: n === 20 ? 'X'.repeat(50) : `Task ${n}`,
            status: 'ready',
            dependencies: n === 1 ? ['dependency-1', 'dependency-2', 'dependency-3'] : [],
          }),
        );
      }
      widget.updateTasks(tasks);
      const lines = widget.render(80);

      // The first visible task (t1) has deps. Its deps column must render in
      // full (not truncated with '…') because the off-screen long title no
      // longer widens the title column for the visible viewport window.
      const t1Row = lines.find((l) => stripAnsi(l).startsWith('t1'))!;
      expect(t1Row).toBeDefined();
      expect(stripAnsi(t1Row)).toContain('dependency-3');
      expect(stripAnsi(t1Row)).not.toContain('…');
      expect(visibleWidth(t1Row)).toBeLessThanOrEqual(80);
    });
  });

  describe('caching', () => {
    it('returns cached lines when not dirty and width unchanged', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'A', status: 'ready' })]);
      const first = widget.render(WIDTH);
      const second = widget.render(WIDTH);
      expect(first).toBe(second);
      // Exact same reference
      expect(first).toBe(second);
    });

    it('re-renders after invalidate', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'A', status: 'ready' })]);
      const first = widget.render(WIDTH);
      widget.invalidate();
      const second = widget.render(WIDTH);
      // Content should be the same but it should have re-rendered
      expect(second).toEqual(first);
    });

    it('re-renders when width changes', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'A', status: 'ready' })]);
      const first = widget.render(WIDTH);
      const second = widget.render(WIDTH + 10);
      expect(second).toHaveLength(1);
      expect(first).not.toBe(second);
    });
  });

  describe('ordering', () => {
    it('tasks are listed in creation/registration order, NOT grouped by status', () => {
      const widget = new TaskListWidget();
      const tasks: TaskEntity[] = [
        makeTask({ id: 't1', title: 'Complete Task', status: 'complete' }),
        makeTask({ id: 't2', title: 'Blocked Task', status: 'blocked' }),
        makeTask({ id: 't3', title: 'Active Task', status: 'active' }),
        makeTask({ id: 't4', title: 'Ready Task', status: 'ready' }),
      ];
      widget.updateTasks(tasks);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(4);

      // Order is exactly the insertion/registration order, regardless of status.
      // Each row begins with dim(id) + gap + icon + gap + colored title.
      expect(lines[0].startsWith(rowStart(tasks[0]))).toBe(true);
      expect(lines[1].startsWith(rowStart(tasks[1]))).toBe(true);
      expect(lines[2].startsWith(rowStart(tasks[2]))).toBe(true);
      expect(lines[3].startsWith(rowStart(tasks[3]))).toBe(true);
    });

    it('failed, cancelled, and complete appear in creation order, not grouped', () => {
      const widget = new TaskListWidget();
      const tasks: TaskEntity[] = [
        makeTask({ id: 't1', title: 'Failed', status: 'failed' }),
        makeTask({ id: 't2', title: 'Cancelled', status: 'cancelled' }),
        makeTask({ id: 't3', title: 'Complete', status: 'complete' }),
        makeTask({ id: 't4', title: 'Active', status: 'active' }),
      ];
      widget.updateTasks(tasks);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(4);
      // Creation order preserved: failed, cancelled, complete, active
      expect(lines[0].startsWith(rowStart(tasks[0]))).toBe(true);
      expect(lines[1].startsWith(rowStart(tasks[1]))).toBe(true);
      expect(lines[2].startsWith(rowStart(tasks[2]))).toBe(true);
      expect(lines[3].startsWith(rowStart(tasks[3]))).toBe(true);
    });

    it('newly registered tasks are appended at the bottom', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
      ]);
      let lines = widget.render(WIDTH);
      expect(lines[0].startsWith(rowStart(makeTask({ id: 't1', title: 'First', status: 'ready' })))).toBe(true);
      expect(lines[1].startsWith(rowStart(makeTask({ id: 't2', title: 'Second', status: 'complete' })))).toBe(true);

      // A later-registered active task is appended, not promoted to the top
      widget.updateTasks([
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
        makeTask({ id: 't3', title: 'Third', status: 'active' }),
      ]);
      lines = widget.render(WIDTH);
      expect(lines[0].startsWith(rowStart(makeTask({ id: 't1', title: 'First', status: 'ready' })))).toBe(true);
      expect(lines[1].startsWith(rowStart(makeTask({ id: 't2', title: 'Second', status: 'complete' })))).toBe(true);
      expect(lines[2].startsWith(rowStart(makeTask({ id: 't3', title: 'Third', status: 'active' })))).toBe(true);
    });
  });

  describe('stale selection cleanup', () => {
    it('selected task ID cleared when task is removed', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
        makeTask({ id: 't3', title: 'C', status: 'blocked' }),
      ]);
      widget.setSelectedTaskId('t3');
      expect(widget.getSelectedTaskId()).toBe('t3');

      // Remove t3 from the task list
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
      ]);
      expect(widget.getSelectedTaskId()).toBeNull();
    });

    it('keeps selection if task still exists after update', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'A', status: 'ready' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
      ]);
      widget.setSelectedTaskId('t1');
      expect(widget.getSelectedTaskId()).toBe('t1');

      widget.updateTasks([
        makeTask({ id: 't1', title: 'A (updated)', status: 'active' }),
        makeTask({ id: 't2', title: 'B', status: 'complete' }),
        makeTask({ id: 't3', title: 'C', status: 'ready' }),
      ]);
      expect(widget.getSelectedTaskId()).toBe('t1');
    });
  });

  describe('selection tracking by task ID', () => {
    it('selected task tracks by ID after task list changes', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'Task A', status: 'ready' }),
        makeTask({ id: 't2', title: 'Task B', status: 'complete' }),
      ]);
      widget.setSelectedTaskId('t2');
      expect(widget.getSelectedTaskId()).toBe('t2');

      // Add an active task — appended at the end (creation order)
      widget.updateTasks([
        makeTask({ id: 't1', title: 'Task A', status: 'ready' }),
        makeTask({ id: 't2', title: 'Task B', status: 'complete' }),
        makeTask({ id: 't3', title: 'Task C', status: 'active' }),
      ]);

      // Selection should still be on t2 (index 1 in creation order)
      expect(widget.getSelectedTaskId()).toBe('t2');
      const lines = widget.render(WIDTH);
      // t2 (complete) is bolded per-cell at creation-order index 1: the icon
      // and title (not just the ID) carry the bold attribute.
      expect(lines[1].startsWith('\x1b[1m')).toBe(true);
      expect(isWithinBold(lines[1], statusIcon('complete'))).toBe(true);
      expect(isWithinBold(lines[1], 'Task B')).toBe(true);
      expect(stripAnsi(lines[1])).toBe(
        stripAnsi(rowStart(makeTask({ id: 't2', title: 'Task B', status: 'complete' }))),
      );
      // Other lines should not be bold
      expect(lines[0]).not.toContain('\x1b[1m');
      expect(lines[2]).not.toContain('\x1b[1m');
    });
  });

  describe('status-dependent row formats', () => {
    describe('active tasks with step annotation', () => {
      it('active task with activeStepIndex and multiple steps renders step in its own column', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'My Task',
            status: 'active',
            steps: [
              { name: 'setup', index: 0 },
              { name: 'review', index: 1 },
              { name: 'deploy', index: 2 },
            ],
            activeStepIndex: 1,
            startedAt: Date.now() - 5000,
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // Step annotation appears in its own column (dim-wrapped)
        expect(line).toContain(dim('step 2/3: review'));
        // No status-keyword fallback text
        expect(line).not.toContain(dim('active'));
        // Elapsed time still shown in the title column
        expect(line).toContain('5s');
        expect(line).toContain('My Task');
        // The step is separated from the title by a 2-space gap, not ' - '
        const stripped = stripAnsi(line);
        expect(stripped).toContain('5s  step 2/3: review');
        expect(stripped).not.toContain(' - step');
      });

      it('active task without activeStepIndex shows no step column', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'My Task',
            status: 'active',
            steps: [
              { name: 'setup', index: 0 },
              { name: 'run', index: 1 },
            ],
            activeStepIndex: undefined,
            startedAt: Date.now() - 5000,
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // No step annotation and no status-text fallback
        expect(line).not.toContain('step');
        expect(line).not.toContain(dim('active'));
        // Elapsed still shown in title column
        expect(line).toContain('5s');
        expect(line).toContain('My Task');
        // Only one ' - ' separator (title - elapsed); step is gone entirely
        const stripped = stripAnsi(line);
        expect((stripped.match(/ - /g) || []).length).toBe(1);
      });

      it('active task with activeStepIndex out of bounds shows no step column', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Out of bounds',
            status: 'active',
            steps: [{ name: 'setup', index: 0 }],
            activeStepIndex: 5, // out of bounds
            startedAt: Date.now() - 3000,
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // steps.length === 1 (not > 1) AND index out of bounds → no step column
        expect(line).not.toContain('step');
        expect(line).not.toContain(dim('active'));
        expect(line).toContain('3s');
      });

      it('active task without startedAt shows title and step column but no elapsed', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'No Elapsed',
            status: 'active',
            steps: [
              { name: 'plan', index: 0 },
              { name: 'execute', index: 1 },
            ],
            activeStepIndex: 0,
            // no startedAt
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // Step shown in its own column
        expect(line).toContain(dim('step 1/2: plan'));
        expect(line).toContain('No Elapsed');
        // No ' - ' separators: title has no elapsed, step is a separate column
        const stripped = stripAnsi(line);
        expect((stripped.match(/ - /g) || []).length).toBe(0);
        expect(stripped).not.toMatch(/\d+[smh]/);
        // Step column separated from title by a 2-space gap
        expect(stripped).toContain('No Elapsed  step 1/2: plan');
      });
    });

    describe('ready/blocked tasks (no elapsed, no step)', () => {
      it('ready task shows ONLY id, icon, and title', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Ready Task',
            status: 'ready',
            startedAt: Date.now() - 5000,
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain('Ready Task');
        const stripped = stripAnsi(line);
        // No dash separators and no elapsed pattern
        expect(stripped).not.toMatch(/ - /);
        expect(stripped).not.toMatch(/\d+[smh]/);
        // Row is exactly id + gap + icon + gap + title (step/deps omitted)
        expect(stripped).toBe('t1  ' + statusIcon('ready') + '  Ready Task');
      });

      it('blocked task shows ONLY id, icon, and title', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Blocked Task',
            status: 'blocked',
            startedAt: Date.now() - 10000,
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain('Blocked Task');
        const stripped = stripAnsi(line);
        expect(stripped).not.toMatch(/ - /);
        expect(stripped).not.toMatch(/\d+[smh]/);
        expect(stripped).toBe('t1  ' + statusIcon('blocked') + '  Blocked Task');
      });
    });

    describe('complete/failed/cancelled tasks (icon, title, and elapsed but no status text)', () => {
      it('complete task shows icon, title, and elapsed but NOT status text', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Complete Task',
            status: 'complete',
            startedAt: 1000,
            completedAt: new Date(6000).toISOString(),
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain('Complete Task');
        // Elapsed (5s from 1000ms to 6000ms) lives in the title column
        expect(line).toContain('5s');
        const stripped = stripAnsi(line);
        expect(stripped).not.toMatch(/ - complete( -|$)/);
        // Exactly ONE dash separator (title - elapsed)
        expect((stripped.match(/ - /g) || []).length).toBe(1);
      });

      it('failed task shows icon, title, and elapsed but NOT status text', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Failed Task',
            status: 'failed',
            startedAt: 2000,
            completedAt: new Date(7000).toISOString(),
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain('Failed Task');
        expect(line).toContain('5s');
        expect(line).not.toContain(dim('failed'));
        const stripped = stripAnsi(line);
        expect((stripped.match(/ - /g) || []).length).toBe(1);
      });

      it('cancelled task shows icon, title, and elapsed but NOT status text', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Cancelled Task',
            status: 'cancelled',
            startedAt: 2000,
            completedAt: new Date(7000).toISOString(),
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain('Cancelled Task');
        expect(line).toContain('5s');
        expect(line).not.toContain(dim('cancelled'));
      });

      it('complete task without startedAt shows only id, icon, and title', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Complete No Time',
            status: 'complete',
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain('Complete No Time');
        const stripped = stripAnsi(line);
        expect(stripped).not.toMatch(/ - /);
        expect(stripped).not.toMatch(/\d+[smh]/);
        expect(stripped).toBe('t1  ' + statusIcon('complete') + '  Complete No Time');
      });
    });

    describe('completedAt freezes elapsed', () => {
      it('completedAt freezes elapsed for complete tasks', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Frozen',
            status: 'complete',
            startedAt: 1000,
            completedAt: new Date(6000).toISOString(),
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('5s');
      });

      it('complete task without completedAt shows wall-clock elapsed', () => {
        const widget = new TaskListWidget();
        const startTime = Date.now() - 10000; // 10 seconds ago
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Wall Clock',
            status: 'complete',
            startedAt: startTime,
            // no completedAt — uses Date.now()
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('10s');
      });
    });
  });

  describe('dependency column rendering', () => {
    /** Wide enough to avoid row truncation of the deps column. */
    const DEPS_WIDTH = 120;

    it('task with no dependencies shows no deps column', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({
          id: 't1',
          title: 'Solo',
          status: 'active',
          startedAt: Date.now() - 5000,
          dependencies: [],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('deps:');
      // No bare deps column text either
      expect(stripAnsi(lines[0])).toBe('t1  ' + statusIcon('active') + '  Solo - 5s');
    });

    it('task with dependencies where all are complete renders each dep dim', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'complete' }),
        makeTask({ id: 'dep2', title: 'Dep 2', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'active',
          startedAt: Date.now() - 5000,
          dependencies: ['dep1', 'dep2'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      // No 'deps:' prefix — deps are a bare column
      expect(line).not.toContain('deps:');
      // Complete deps → dim-wrapped
      expect(line).toContain(dim('dep1'));
      expect(line).toContain(dim('dep2'));
      // Neither dep is yellow-wrapped (old behavior removed)
      expect(line).not.toContain(yellow('dep1'));
      expect(line).not.toContain(yellow('dep2'));
      // Joined with ', '
      expect(line).toContain(dim('dep1') + ', ' + dim('dep2'));
    });

    it('task with a dependency that is active renders that dep id as plain text (no ANSI)', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({
          id: 'dep1',
          title: 'Dep 1',
          status: 'active',
          startedAt: Date.now() - 2000,
        }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'active',
          startedAt: Date.now() - 5000,
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      expect(line).not.toContain('deps:');
      // Blocking dep (active) → plain text, no dim/yellow wrapping
      expect(line).toContain('dep1');
      expect(line).not.toContain(dim('dep1'));
      expect(line).not.toContain(yellow('dep1'));
    });

    it('task with a ready dependency renders that dep id as plain text (no ANSI)', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'ready' }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'active',
          startedAt: Date.now() - 5000,
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      expect(line).not.toContain('deps:');
      expect(line).toContain('dep1');
      expect(line).not.toContain(dim('dep1'));
      expect(line).not.toContain(yellow('dep1'));
    });

    it('task with a blocked dependency renders that dep id as plain text (no ANSI)', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'blocked' }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'active',
          startedAt: Date.now() - 5000,
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      expect(line).not.toContain('deps:');
      expect(line).toContain('dep1');
      expect(line).not.toContain(dim('dep1'));
      expect(line).not.toContain(yellow('dep1'));
    });

    it('mixed deps: one complete (dim) + one incomplete (plain), comma-space joined', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'complete' }),
        makeTask({ id: 'dep2', title: 'Dep 2', status: 'active', startedAt: Date.now() - 1000 }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'active',
          startedAt: Date.now() - 5000,
          dependencies: ['dep1', 'dep2'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      expect(line).not.toContain('deps:');
      // Complete dep → dim
      expect(line).toContain(dim('dep1'));
      expect(line).not.toContain(yellow('dep1'));
      // Active (blocking) dep → plain text
      expect(line).toContain('dep2');
      expect(line).not.toContain(dim('dep2'));
      expect(line).not.toContain(yellow('dep2'));
      // Joined with ', ': dim(dep1) + ', ' + plain 'dep2'
      expect(line).toContain(dim('dep1') + ', ' + 'dep2');
    });

    it('dependency id not present in current task list renders as plain text (no ANSI)', () => {
      const widget = new TaskListWidget();
      // dep1 is NOT in the task list at all
      widget.updateTasks([
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'ready',
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[0];
      expect(line).not.toContain('deps:');
      // Unknown dep → plain text (no ANSI), not dim
      expect(line).toContain('dep1');
      expect(line).not.toContain(dim('dep1'));
      expect(line).not.toContain(yellow('dep1'));
    });

    it('deps column appears after the elapsed-time segment in the row', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'complete',
          startedAt: 1000,
          completedAt: new Date(6000).toISOString(),
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      const stripped = stripAnsi(line);
      const elapsedIdx = stripped.indexOf('5s');
      const depsIdx = stripped.indexOf('dep1');
      expect(elapsedIdx).toBeGreaterThanOrEqual(0);
      expect(depsIdx).toBeGreaterThanOrEqual(0);
      expect(depsIdx).toBeGreaterThan(elapsedIdx);
    });

    it('ready task with dependencies shows deps column but no elapsed', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'ready',
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      expect(line).not.toContain('deps:');
      // dep1 complete → dim
      expect(line).toContain(dim('dep1'));
      const stripped = stripAnsi(line);
      // Ready shows no elapsed and no ' - ' separators; deps are a bare column
      expect(stripped).not.toMatch(/ - /);
      expect(stripped).not.toMatch(/\d+[smh]/);
      // deps column (dim dep1) follows the title via a 2-space gap.
      // t1 (width 2) is padded to the ID column width (4, from 'dep1'),
      // so there are 4 spaces between 't1' and the icon (2 pad + 2 gap).
      expect(stripped).toBe('t1    ' + statusIcon('ready') + '  My Task  dep1');
    });

    it('blocked task with dependencies shows deps column (blocking dep as plain text)', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'ready' }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'blocked',
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      expect(line).not.toContain('deps:');
      // dep1 is ready (blocking) → plain text, not yellow/dim
      expect(line).toContain('dep1');
      expect(line).not.toContain(yellow('dep1'));
      expect(line).not.toContain(dim('dep1'));
      // blocked shows no elapsed
      const stripped = stripAnsi(line);
      expect(stripped).not.toMatch(/\d+[smh]/);
    });

    it('deps for failed task with dependencies appear after elapsed', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'failed',
          startedAt: 2000,
          completedAt: new Date(7000).toISOString(),
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      expect(line).toContain(dim('dep1'));
      const stripped = stripAnsi(line);
      const elapsedIdx = stripped.indexOf('5s');
      const depsIdx = stripped.indexOf('dep1');
      expect(elapsedIdx).toBeGreaterThanOrEqual(0);
      expect(depsIdx).toBeGreaterThan(elapsedIdx);
    });

    it('deps for cancelled task with dependencies appear after elapsed', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 'dep1', title: 'Dep 1', status: 'complete' }),
        makeTask({
          id: 't1',
          title: 'My Task',
          status: 'cancelled',
          startedAt: 2000,
          completedAt: new Date(7000).toISOString(),
          dependencies: ['dep1'],
        }),
      ]);
      const lines = widget.render(DEPS_WIDTH);
      const line = lines[lines.length - 1];
      expect(line).toContain(dim('dep1'));
      const stripped = stripAnsi(line);
      const elapsedIdx = stripped.indexOf('5s');
      const depsIdx = stripped.indexOf('dep1');
      expect(elapsedIdx).toBeGreaterThanOrEqual(0);
      expect(depsIdx).toBeGreaterThan(elapsedIdx);
    });
  });

  describe('viewport capping and edge-scrolling', () => {
    /** Width large enough that no task row gets truncated. */
    const WIDE = 60;

    /** True when a rendered line is a directional scroll indicator (top or bottom). */
    function isIndicator(line: string): boolean {
      const stripped = stripAnsi(line).trim();
      return /^↑ \d+ more above \(↑\/↓\)$/.test(stripped) || /^↓ \d+ more below \(↑\/↓\)$/.test(stripped);
    }

    /** Extract the task id from a rendered row, or null for indicators/blank lines. */
    function taskIdFromLine(line: string): string | null {
      const stripped = stripAnsi(line);
      if (stripped === '' || isIndicator(line)) return null;
      const match = stripped.match(/^([a-z]+\d+)/);
      return match ? match[1] : null;
    }

    /** First task id rendered (skipping indicators/blank padding lines). */
    function firstTaskId(lines: string[]): string | null {
      for (const line of lines) {
        const id = taskIdFromLine(line);
        if (id !== null) return id;
      }
      return null;
    }

    /** All task ids rendered, in order (skipping indicators/blank padding lines). */
    function renderedTaskIds(lines: string[]): string[] {
      const ids: string[] = [];
      for (const line of lines) {
        const id = taskIdFromLine(line);
        if (id !== null) ids.push(id);
      }
      return ids;
    }

    describe('20-line cap', () => {
      it('caps rendered output at exactly 20 lines when there are more than 20 tasks', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        const lines = widget.render(WIDE);
        expect(lines).toHaveLength(20);
      });

      it('shows a bottom indicator and hides tasks below the fold (25 tasks, offset 0)', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        const lines = widget.render(WIDE);
        // 19 task rows + 1 bottom indicator = 20 lines
        expect(lines).toHaveLength(20);
        expect(isIndicator(lines[0])).toBe(false);
        expect(isIndicator(lines[19])).toBe(true);
        // First 19 lines are task rows for indices 0..18 (t1..t19)
        const ids = renderedTaskIds(lines);
        expect(ids).toHaveLength(19);
        expect(ids[0]).toBe('t1');
        expect(ids[ids.length - 1]).toBe('t19');
        // Tasks below the fold are not rendered
        expect(ids).not.toContain('t20');
        expect(ids).not.toContain('t25');
      });

      it('does not cap or add indicators when there are fewer than 20 tasks', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(15));
        const lines = widget.render(WIDE);
        expect(lines).toHaveLength(15);
        for (const line of lines) {
          expect(isIndicator(line)).toBe(false);
        }
      });

      it('renders exactly 20 tasks with no indicators at the boundary (length <= max)', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(20));
        const lines = widget.render(WIDE);
        expect(lines).toHaveLength(20);
        for (const line of lines) {
          expect(isIndicator(line)).toBe(false);
        }
      });

      it('caps at 20 lines with a bottom indicator for 21 tasks (first size past the cap)', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(21));
        const lines = widget.render(WIDE);
        expect(lines).toHaveLength(20);
        expect(isIndicator(lines[0])).toBe(false);
        expect(isIndicator(lines[19])).toBe(true);
      });

      it('getVisibleTaskCount reports the total task count even when rendering is capped', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        // Total count is unaffected by the viewport cap
        expect(widget.getVisibleTaskCount()).toBe(25);
        const lines = widget.render(WIDE);
        expect(lines).toHaveLength(20);
      });
    });

    describe('scroll indicators', () => {
      it('shows a top indicator when scrolled down to the last task', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        widget.setSelectedTaskId('t25');
        const lines = widget.render(WIDE);
        expect(lines).toHaveLength(20);
        // Scrolled down → first line is the top indicator
        expect(isIndicator(lines[0])).toBe(true);
        // The last task (t25) is rendered; the first task (t1) is not
        const ids = renderedTaskIds(lines);
        expect(ids).toContain('t25');
        expect(ids).not.toContain('t1');
      });

      it('does not scroll when programmatically selecting an already-visible task', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        widget.setSelectedTaskId('t5'); // index 4, within the initial viewport
        const lines = widget.render(WIDE);
        expect(isIndicator(lines[0])).toBe(false);
        // Re-applying the same selection is a no-op for scrolling
        widget.setSelectedTaskId('t5');
        const lines2 = widget.render(WIDE);
        expect(isIndicator(lines2[0])).toBe(false);
      });
    });

    describe('edge-scrolling on navigation', () => {
      it('scrolls down when navigating past the bottom of the viewport', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        widget.setSelectedTaskId('t1'); // index 0

        // Initial viewport: offset 0 → no top indicator, bottom indicator present
        let lines = widget.render(WIDE);
        expect(isIndicator(lines[0])).toBe(false);
        expect(isIndicator(lines[lines.length - 1])).toBe(true);

        // Press DOWN 18 times → index 18, still within the initial viewport (rows 0..18)
        for (let i = 0; i < 18; i++) widget.handleInput(DOWN);
        expect(widget.getSelectedTaskId()).toBe('t19');
        lines = widget.render(WIDE);
        // Still at the top — no top indicator yet
        expect(isIndicator(lines[0])).toBe(false);

        // One more DOWN → index 19 scrolls the viewport down
        widget.handleInput(DOWN);
        expect(widget.getSelectedTaskId()).toBe('t20');
        lines = widget.render(WIDE);
        // Top indicator now present → the viewport scrolled
        expect(isIndicator(lines[0])).toBe(true);
      });

      it('scrolls up when navigating past the top of the viewport', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        widget.setSelectedTaskId('t25'); // scroll to the bottom (index 24)

        // Navigate up to the top of the viewport (index 6 = first visible row)
        for (let i = 0; i < 18; i++) widget.handleInput(UP); // 24 → 6
        expect(widget.getSelectedTaskId()).toBe('t7');
        let lines = widget.render(WIDE);
        // First visible task is t7 (top of the scrolled viewport)
        expect(firstTaskId(lines)).toBe('t7');
        expect(isIndicator(lines[0])).toBe(true);

        // One more UP → index 5 scrolls the viewport up
        widget.handleInput(UP);
        expect(widget.getSelectedTaskId()).toBe('t6');
        lines = widget.render(WIDE);
        // First visible task is now t6 → the viewport scrolled up
        expect(firstTaskId(lines)).toBe('t6');
      });

      it('scrolling all the way back up removes the top indicator', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        widget.setSelectedTaskId('t25'); // bottom → top indicator present
        expect(isIndicator(widget.render(WIDE)[0])).toBe(true);

        // Press UP until reaching the first task
        for (let i = 0; i < 24; i++) widget.handleInput(UP);
        expect(widget.getSelectedTaskId()).toBe('t1');
        const lines = widget.render(WIDE);
        // Back at the top: top indicator gone, bottom indicator present
        expect(isIndicator(lines[0])).toBe(false);
        expect(isIndicator(lines[lines.length - 1])).toBe(true);
        expect(firstTaskId(lines)).toBe('t1');
      });

      it('keeps the rendered height at 20 lines across different scroll positions', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        // Top
        expect(widget.render(WIDE)).toHaveLength(20);
        // Scrolled to the bottom
        widget.setSelectedTaskId('t25');
        expect(widget.render(WIDE)).toHaveLength(20);
        // Somewhere in the middle (already within the scrolled viewport)
        widget.setSelectedTaskId('t13');
        expect(widget.render(WIDE)).toHaveLength(20);
      });
    });

    describe('scroll reset on task set change', () => {
      it('resets the viewport to the top when task IDs change', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        widget.setSelectedTaskId('t25'); // scroll to the bottom
        expect(isIndicator(widget.render(WIDE)[0])).toBe(true);

        // Switch to a completely different set of task IDs
        widget.updateTasks(makeManyTasks(25, 'u'));
        const lines = widget.render(WIDE);
        // Scroll offset reset → first line is a task row, not an indicator
        expect(isIndicator(lines[0])).toBe(false);
        expect(firstTaskId(lines)).toBe('u1');
      });

      it('does NOT reset the viewport when task IDs are unchanged (status-only update)', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        widget.setSelectedTaskId('t25'); // scroll to the bottom
        expect(isIndicator(widget.render(WIDE)[0])).toBe(true);

        // Re-update with the same IDs (e.g. a status refresh) — offset preserved
        const refreshed = makeManyTasks(25).map((t, i) => ({
          ...t,
          status: (i % 2 === 0 ? 'complete' : 'ready') as TaskEntity['status'],
        }));
        widget.updateTasks(refreshed);
        const lines = widget.render(WIDE);
        // Still scrolled down → top indicator still present
        expect(isIndicator(lines[0])).toBe(true);
      });
    });

    describe('navigation clamping still works with many tasks', () => {
      it('clamps up navigation at the first task', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        widget.setSelectedTaskId('t1');
        widget.handleInput(UP);
        expect(widget.getSelectedTaskId()).toBe('t1');
      });

      it('clamps down navigation at the last task', () => {
        const widget = new TaskListWidget();
        widget.updateTasks(makeManyTasks(25));
        widget.setSelectedTaskId('t25');
        widget.handleInput(DOWN);
        expect(widget.getSelectedTaskId()).toBe('t25');
      });
    });
  });
});
