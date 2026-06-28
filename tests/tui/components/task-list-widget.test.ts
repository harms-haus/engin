import { visibleWidth } from '@earendil-works/pi-tui';
import type { TaskEntity } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import { TaskListWidget } from '../../../packages/tui/src/components/task-list-widget.js';
import { dim, statusColor, statusIcon, yellow } from '../../../packages/tui/src/theme.js';

/** Strip ANSI escape sequences (CSI and OSC) — local helper to avoid importing dead theme export. */
function stripAnsi(str: string): string {
  if (!str.includes('\x1b')) return str;
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

const UP = '\x1b[A';
const DOWN = '\x1b[B';

const WIDTH = 40;

/** Build a minimal TaskEntity with defaults.
 *
 *  Derives the new timing fields (`elapsedMs`, `activeStartedAt`) from legacy
 *  `startedAt`/`completedAt` when the test doesn't set them explicitly —
 *  mirroring what the evolve layer produces so legacy fixtures render the
 *  expected elapsed values under the active-only timer model:
 *    • active   → activeStartedAt = startedAt, elapsedMs = 0 (ticks live)
 *    • parked   → elapsedMs = now - startedAt (frozen at construction)
 *    • terminal → elapsedMs = completedAt - startedAt (or now if no completedAt)
 */
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
      // parked (with a completedAt) or terminal: use the explicit end time.
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
 * Compact display label mirroring the widget, for the task at 1-based registration index.
 * e.g. index 1 → 't-01', index 10 → 't-10'.
 */
function idLabel(indexOneBased: number, count = 99): string {
  const width = Math.max(2, String(count).length);
  return 't-' + String(indexOneBased).padStart(width, '0');
}

/**
 * Expected leading columns (icon + id + title) for a non-selected task row in
 * the new table layout. The status icon is the FIRST column, so it precedes
 * the dimmed id label. Used for tasks without dependencies, so the deps
 * column (which sits after the title when present) is omitted.
 *   status icon + 2-space gap + dim(label) + 2-space gap + status-colored title
 */
function rowStart(task: TaskEntity, indexOneBased: number, count = 99): string {
  return (
    statusIcon(task.status) + '  ' + dim(idLabel(indexOneBased, count)) + '  ' + statusColor(task.status)(task.title)
  );
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
    it('renders each task row starting with icon, dim(id), and colored title columns (icon now leading)', () => {
      const widget = new TaskListWidget();
      const tasks: TaskEntity[] = [
        makeTask({ id: 't1', title: 'Task A', status: 'complete' }),
        makeTask({ id: 't2', title: 'Task B', status: 'active' }),
        makeTask({ id: 't3', title: 'Task C', status: 'blocked' }),
      ];
      widget.updateTasks(tasks);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(3);

      // Creation order: complete (t1→t-01), active (t2→t-02), blocked (t3→t-03)
      // New table prefix: status icon + '  ' + dim(label) + '  ' + statusColor(title);
      // the status icon is now the FIRST column, so it is part of this prefix.
      expect(lines[0].startsWith(rowStart(tasks[0], 1, 3))).toBe(true);
      expect(lines[1].startsWith(rowStart(tasks[1], 2, 3))).toBe(true);
      expect(lines[2].startsWith(rowStart(tasks[2], 3, 3))).toBe(true);
    });

    it('renders only actual tasks with no blank padding', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'Only', status: 'ready' })]);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(1);
      // Stripped of ANSI the row is exactly: icon + 2 spaces + id + 2 spaces + title
      // (step and deps columns are omitted since unused; icon is now the FIRST column)
      expect(stripAnsi(lines[0])).toBe(statusIcon('ready') + '  t-01  Only');
    });
  });

  describe('table column layout', () => {
    it('separates the ID, icon, and title columns with exactly 2-space gaps', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'Solo', status: 'ready' })]);
      const lines = widget.render(WIDTH);
      expect(stripAnsi(lines[0])).toBe(statusIcon('ready') + '  t-01  Solo');
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
      expect(stripAnsi(lines[0])).toBe(statusIcon('ready') + '  t-01  A   ');
      expect(stripAnsi(lines[1])).toBe(statusIcon('ready') + '  t-02  BBBB');
    });

    it('shows the session-count column for active tasks with sessions', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({
          id: 't1',
          title: 'Run',
          status: 'active',
        }),
      ]);
      widget.setSessionCounts({ t1: 2 });
      const lines = widget.render(WIDTH);
      // Session-count column (2-space gap), NOT appended to the title with ' - '.
      // Format is `${N} session(s)` (dim-wrapped).
      expect(stripAnsi(lines[0])).toBe(statusIcon('active') + '  t-01  Run  2 sessions');
      expect(lines[0]).toContain(dim('2 sessions'));
    });

    it('active task with a single step does not show step progress (requires > 1 step)', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({
          id: 't1',
          title: 'Run',
          status: 'active',

          startedAt: Date.now() - 5000,
        }),
      ]);
      const lines = widget.render(WIDTH);
      // steps.length === 1 is not > 1, so the step column is omitted.
      expect(stripAnsi(lines[0])).toBe(statusIcon('active') + '  t-01  Run - 5s');
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
      // dep1 is index 0 (label t-01, width 4), t1 is index 1 (label t-02, width 4).
      // Both labels have equal width, so there is no extra padding — just the normal 2-space gap.
      expect(stripAnsi(lines[1])).toBe(statusIcon('complete') + '  t-02  Done - 5s  t-01');
      expect(lines[1]).toContain(dim('t-01'));
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
      expect(lines[0].startsWith(rowStart(makeTask({ id: 't1', title: 'First', status: 'ready' }), 1, 2))).toBe(true);

      // Line 1: every column cell is individually bolded so the emphasis
      // survives each cell's ANSI reset — the icon AND title (not just the
      // dim ID) carry the bold attribute. Stripped of ANSI the layout is unchanged.
      expect(lines[1].startsWith('\x1b[1m')).toBe(true);
      expect(isWithinBold(lines[1], statusIcon('complete'))).toBe(true);
      expect(isWithinBold(lines[1], 'Second')).toBe(true);
      expect(stripAnsi(lines[1])).toBe(
        stripAnsi(rowStart(makeTask({ id: 't2', title: 'Second', status: 'complete' }), 2, 2)),
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
      // The row's visible width is the natural table width (icon + id + title + gaps),
      // which is much less than WIDTH — the row is NOT padded to fill WIDTH.
      expect(visibleWidth(lines[0])).toBeLessThan(WIDTH);
      expect(stripAnsi(lines[0])).toBe(statusIcon('ready') + '  t-01  Hi');
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
      // (The row now leads with the status icon, so match the id token directly.)
      const t1Row = lines.find((l) => stripAnsi(l).includes('  t-01  '))!;
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
      // Each row begins with icon + gap + dim(id) + gap + colored title.
      expect(lines[0].startsWith(rowStart(tasks[0], 1, 4))).toBe(true);
      expect(lines[1].startsWith(rowStart(tasks[1], 2, 4))).toBe(true);
      expect(lines[2].startsWith(rowStart(tasks[2], 3, 4))).toBe(true);
      expect(lines[3].startsWith(rowStart(tasks[3], 4, 4))).toBe(true);
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
      expect(lines[0].startsWith(rowStart(tasks[0], 1, 4))).toBe(true);
      expect(lines[1].startsWith(rowStart(tasks[1], 2, 4))).toBe(true);
      expect(lines[2].startsWith(rowStart(tasks[2], 3, 4))).toBe(true);
      expect(lines[3].startsWith(rowStart(tasks[3], 4, 4))).toBe(true);
    });

    it('newly registered tasks are appended at the bottom', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
      ]);
      let lines = widget.render(WIDTH);
      expect(lines[0].startsWith(rowStart(makeTask({ id: 't1', title: 'First', status: 'ready' }), 1, 2))).toBe(true);
      expect(lines[1].startsWith(rowStart(makeTask({ id: 't2', title: 'Second', status: 'complete' }), 2, 2))).toBe(
        true,
      );

      // A later-registered active task is appended, not promoted to the top
      widget.updateTasks([
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
        makeTask({ id: 't3', title: 'Third', status: 'active' }),
      ]);
      lines = widget.render(WIDTH);
      expect(lines[0].startsWith(rowStart(makeTask({ id: 't1', title: 'First', status: 'ready' }), 1, 3))).toBe(true);
      expect(lines[1].startsWith(rowStart(makeTask({ id: 't2', title: 'Second', status: 'complete' }), 2, 3))).toBe(
        true,
      );
      expect(lines[2].startsWith(rowStart(makeTask({ id: 't3', title: 'Third', status: 'active' }), 3, 3))).toBe(true);
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
        stripAnsi(rowStart(makeTask({ id: 't2', title: 'Task B', status: 'complete' }), 2, 3)),
      );
      // Other lines should not be bold
      expect(lines[0]).not.toContain('\x1b[1m');
      expect(lines[2]).not.toContain('\x1b[1m');
    });
  });

  describe('status-dependent row formats', () => {
    describe('active tasks with session annotation', () => {
      it('active task with sessions renders session count in its own column', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'My Task',
            status: 'active',
            startedAt: Date.now() - 5000,
          }),
        ]);
        widget.setSessionCounts({ t1: 2 });
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // Session count annotation appears in its own column (dim-wrapped)
        expect(line).toContain(dim('2 sessions'));
        // Elapsed time still shown in the title column
        expect(line).toContain('5s');
        expect(line).toContain('My Task');
        // The session count is separated from the title by a 2-space gap, not ' - '
        const stripped = stripAnsi(line);
        expect(stripped).toContain('5s  2 sessions');
        expect(stripped).not.toContain(' - step');
      });

      it('active task without session counts shows no session-count column', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'My Task',
            status: 'active',
            startedAt: Date.now() - 5000,
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // No session count annotation (no setSessionCounts call)
        expect(line).not.toContain('session');
        // Elapsed still shown in title column
        expect(line).toContain('5s');
        expect(line).toContain('My Task');
        // Only one ' - ' separator (title - elapsed); session count column is gone entirely
        const stripped = stripAnsi(line);
        expect((stripped.match(/ - /g) || []).length).toBe(1);
      });

      it('active task with zero session counts shows no session-count column', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Zero Sessions',
            status: 'active',
            startedAt: Date.now() - 3000,
          }),
        ]);
        widget.setSessionCounts({ t1: 0 });
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // 0 session count → no column emitted
        expect(line).not.toContain('session');
        expect(line).toContain('3s');
      });

      it('active task without startedAt shows title and session-count column but no elapsed', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'No Elapsed',
            status: 'active',
            // no startedAt
          }),
        ]);
        widget.setSessionCounts({ t1: 1 });
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // Session count shown in its own column
        expect(line).toContain(dim('1 session'));
        expect(line).toContain('No Elapsed');
        // No ' - ' separators: title has no elapsed, session count is a separate column
        const stripped = stripAnsi(line);
        expect((stripped.match(/ - /g) || []).length).toBe(0);
        expect(stripped).not.toMatch(/\d+[smh]/);
        // Session count column separated from title by a 2-space gap
        expect(stripped).toContain('No Elapsed  1 session');
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
        // Row is exactly icon + gap + id + gap + title (step/deps omitted)
        expect(stripped).toBe(statusIcon('ready') + '  t-01  Ready Task');
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
        expect(stripped).toBe(statusIcon('blocked') + '  t-01  Blocked Task');
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
        expect(stripped).toBe(statusIcon('complete') + '  t-01  Complete No Time');
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

    describe('parked tasks (in-progress, paused)', () => {
      it('parked task with startedAt shows elapsed time', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Parked Task',
            status: 'parked',
            startedAt: Date.now() - 5000,
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain('Parked Task');
        expect(line).toContain('5s');
        const stripped = stripAnsi(line);
        expect((stripped.match(/ - /g) || []).length).toBe(1);
      });

      it('parked task without startedAt shows no elapsed', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Parked No Time',
            status: 'parked',
          }),
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain('Parked No Time');
        const stripped = stripAnsi(line);
        expect(stripped).not.toMatch(/ - /);
        expect(stripped).not.toMatch(/\d+[smh]/);
        expect(stripped).toBe(statusIcon('parked') + '  t-01  Parked No Time');
      });

      it('parked task with sessionPlan shows ●N/M progress', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
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
        ]);
        widget.setSessionCounts({ t1: 2 });
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain(dim('●2/3'));
        expect(line).toContain('5s');
        expect(line).toContain('Parked Plan');
      });

      it('parked task with sessions shows session count when no sessionPlan', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'PSess',
            status: 'parked',
            startedAt: Date.now() - 5000,
          }),
        ]);
        widget.setSessionCounts({ t1: 3 });
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain(dim('3 sessions'));
        expect(line).toContain('5s');
        expect(line).toContain('PSess');
      });

      it('parked task with zero session counts shows no session-count column', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({
            id: 't1',
            title: 'Parked Zero',
            status: 'parked',
            startedAt: Date.now() - 3000,
          }),
        ]);
        widget.setSessionCounts({ t1: 0 });
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).not.toContain('session');
        expect(line).toContain('3s');
      });

      it('parked task with dependencies shows deps column', () => {
        const widget = new TaskListWidget();
        widget.updateTasks([
          makeTask({ id: 'dep1', title: 'Dep 1', status: 'complete' }),
          makeTask({
            id: 't1',
            title: 'Parked Deps',
            status: 'parked',
            startedAt: 1000,
            completedAt: new Date(6000).toISOString(),
            dependencies: ['dep1'],
          }),
        ]);
        const lines = widget.render(120);
        const line = lines[lines.length - 1];
        expect(line).toContain('Parked Deps');
        // dep1 is complete → rendered dim
        expect(line).toContain(dim('t-01'));
        const stripped = stripAnsi(line);
        expect(stripped).toContain('t-01');
        // deps appear after elapsed (5s = 6000-1000)
        const elapsedIdx = stripped.indexOf('5s');
        const depsIdx = stripped.indexOf('t-01');
        expect(elapsedIdx).toBeGreaterThanOrEqual(0);
        expect(depsIdx).toBeGreaterThan(elapsedIdx);
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
      expect(stripAnsi(lines[0])).toBe(statusIcon('active') + '  t-01  Solo - 5s');
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
      // dep1 is complete → dim-wrapped, dep2 is complete → dim-wrapped
      expect(line).toContain(dim('t-01'));
      expect(line).toContain(dim('t-02'));
      // Neither dep is yellow-wrapped (old behavior removed)
      expect(line).not.toContain(yellow('t-01'));
      expect(line).not.toContain(yellow('t-02'));
      // Joined with ', '
      expect(line).toContain(dim('t-01') + ', ' + dim('t-02'));
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
      expect(line).toContain('t-01');
      expect(line).not.toContain(dim('t-01'));
      expect(line).not.toContain(yellow('t-01'));
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
      expect(line).toContain('t-01');
      expect(line).not.toContain(dim('t-01'));
      expect(line).not.toContain(yellow('t-01'));
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
      expect(line).toContain('t-01');
      expect(line).not.toContain(yellow('t-01'));
      expect(line).not.toContain(dim('t-01'));
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
      expect(line).toContain(dim('t-01'));
      expect(line).not.toContain(yellow('t-01'));
      // Active (blocking) dep → plain text
      expect(line).toContain('t-02');
      expect(line).not.toContain(dim('t-02'));
      expect(line).not.toContain(yellow('t-02'));
      // Joined with ', ': dim(t-01) + ', ' + plain 't-02'
      expect(line).toContain(dim('t-01') + ', ' + 't-02');
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
      const depsIdx = stripped.indexOf('t-01');
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
      // dep1 is index 0 (label t-01, complete) → dim
      expect(line).toContain(dim('t-01'));
      const stripped = stripAnsi(line);
      // Ready shows no elapsed and no ' - ' separators; deps are a bare column
      expect(stripped).not.toMatch(/ - /);
      expect(stripped).not.toMatch(/\d+[smh]/);
      // dep1 (label t-01, width 4) and t1 (label t-02, width 4) have equal width,
      // so there is no extra padding — just the normal 2-space gap.
      expect(stripped).toBe(statusIcon('ready') + '  t-02  My Task  t-01');
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
      expect(line).toContain('t-01');
      expect(line).not.toContain(yellow('t-01'));
      expect(line).not.toContain(dim('t-01'));
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
      expect(line).toContain(dim('t-01'));
      const stripped = stripAnsi(line);
      const elapsedIdx = stripped.indexOf('5s');
      const depsIdx = stripped.indexOf('t-01');
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
      expect(line).toContain(dim('t-01'));
      const stripped = stripAnsi(line);
      const elapsedIdx = stripped.indexOf('5s');
      const depsIdx = stripped.indexOf('t-01');
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
      // Rows now lead with the status icon, so the id is no longer anchored to
      // the start; take the first `t-NN` token (the id column precedes deps).
      const match = stripped.match(/(t-\d+)/);
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
        expect(ids[0]).toBe('t-01');
        expect(ids[ids.length - 1]).toBe('t-19');
        // Tasks below the fold are not rendered
        expect(ids).not.toContain('t-20');
        expect(ids).not.toContain('t-25');
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
        expect(ids).toContain('t-25');
        expect(ids).not.toContain('t-01');
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
        expect(firstTaskId(lines)).toBe('t-07');
        expect(isIndicator(lines[0])).toBe(true);

        // One more UP → index 5 scrolls the viewport up
        widget.handleInput(UP);
        expect(widget.getSelectedTaskId()).toBe('t6');
        lines = widget.render(WIDE);
        // First visible task is now t6 → the viewport scrolled up
        expect(firstTaskId(lines)).toBe('t-06');
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
        expect(firstTaskId(lines)).toBe('t-01');
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
        expect(firstTaskId(lines)).toBe('t-01');
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

  describe('auto-scroll to fit running tasks', () => {
    /** Width large enough that no task row gets truncated. */
    const WIDE = 60;

    /** True when a rendered line is a directional scroll indicator (top or bottom). */
    function isIndicator(line: string): boolean {
      const stripped = stripAnsi(line).trim();
      return /^↑ \d+ more above \(↑\/↓\)$/.test(stripped) || /^↓ \d+ more below \(↑\/↓\)$/.test(stripped);
    }

    /** Extract the compact task label (e.g. `t-01`) from a rendered row, else null. */
    function taskIdFromLine(line: string): string | null {
      const stripped = stripAnsi(line);
      if (stripped === '' || isIndicator(line)) return null;
      // Rows now lead with the status icon, so the id is no longer anchored to
      // the start; take the first `t-NN` token (the id column precedes deps).
      const match = stripped.match(/(t-\d+)/);
      return match ? match[1] : null;
    }

    /** First compact task label rendered (skipping indicators/blank padding lines). */
    function firstTaskId(lines: string[]): string | null {
      for (const line of lines) {
        const id = taskIdFromLine(line);
        if (id !== null) return id;
      }
      return null;
    }

    /** All compact task labels rendered, in order (skipping indicators/blank padding). */
    function renderedTaskIds(lines: string[]): string[] {
      const ids: string[] = [];
      for (const line of lines) {
        const id = taskIdFromLine(line);
        if (id !== null) ids.push(id);
      }
      return ids;
    }

    /** How many of `labels` are present in the rendered output. */
    function countVisible(lines: string[], labels: string[]): number {
      const ids = new Set(renderedTaskIds(lines));
      return labels.filter((l) => ids.has(l)).length;
    }

    it('does not scroll when no task newly becomes active (status-only refresh)', () => {
      const widget = new TaskListWidget();
      widget.updateTasks(makeManyTasks(25));
      // Scroll to the bottom so the viewport is well past the top.
      widget.setSelectedTaskId('t25');
      const before = widget.render(WIDE);
      expect(isIndicator(before[0])).toBe(true); // scrolled down → top indicator present
      const beforeFirst = firstTaskId(before);
      expect(beforeFirst).not.toBe('t-01'); // not sitting at the top

      // Re-update with identical ids and identical statuses (no transition to active).
      widget.updateTasks(makeManyTasks(25));
      const after = widget.render(WIDE);
      // Viewport unchanged: still scrolled down with the same first visible row.
      expect(isIndicator(after[0])).toBe(true);
      expect(firstTaskId(after)).toBe(beforeFirst);
    });

    it('scrolls to fit active tasks when a task starts (transitions to active)', () => {
      const widget = new TaskListWidget();
      // 25 tasks; first two are already active (visible at offset 0).
      const initial = makeManyTasks(25).map((t, i) =>
        i < 2 ? { ...t, status: 'active' as const, startedAt: 1000 } : t,
      );
      widget.updateTasks(initial);
      // Scroll down past the active cluster so it sits above the viewport.
      widget.setSelectedTaskId('t25');
      const scrolled = widget.render(WIDE);
      expect(isIndicator(scrolled[0])).toBe(true); // top indicator → scrolled down
      expect(renderedTaskIds(scrolled)).not.toContain('t-01'); // active t-01 is off-screen

      // A third task (registration index 2) transitions ready → active.
      const updated = initial.map((t, i) => (i === 2 ? { ...t, status: 'active' as const, startedAt: 2000 } : t));
      widget.updateTasks(updated);
      const lines = widget.render(WIDE);

      // Auto-scroll brings the active cluster back into view at offset 0:
      // first row is a task (no top indicator) starting at t-01.
      expect(isIndicator(lines[0])).toBe(false);
      expect(firstTaskId(lines)).toBe('t-01');
      // The active tasks are t-01, t-02, t-03 (indices 0,1,2). Only a viewport
      // starting at offset 0 can show all three, so this is the maximum
      // achievable count of visible running tasks.
      expect(countVisible(lines, ['t-01', 't-02', 't-03'])).toBe(3);
    });

    it('keeps the current offset when the active tasks already fit in the viewport', () => {
      const widget = new TaskListWidget();
      // 25 tasks; first three are active and already visible at offset 0.
      const initial = makeManyTasks(25).map((t, i) =>
        i < 3 ? { ...t, status: 'active' as const, startedAt: 1000 } : t,
      );
      widget.updateTasks(initial);
      const before = widget.render(WIDE);
      expect(isIndicator(before[0])).toBe(false); // offset 0 → no top indicator
      expect(firstTaskId(before)).toBe('t-01');

      // A task already within the viewport (index 5) transitions to active.
      // The current offset (0) already maximizes the visible active-task count,
      // so the tie-break keeps it (no jitter).
      const updated = initial.map((t, i) => (i === 5 ? { ...t, status: 'active' as const, startedAt: 2000 } : t));
      widget.updateTasks(updated);
      const after = widget.render(WIDE);

      expect(isIndicator(after[0])).toBe(false);
      expect(firstTaskId(after)).toBe('t-01'); // unchanged
    });

    it('resets the viewport to the top on a phase switch, even with active tasks in the new phase', () => {
      const widget = new TaskListWidget();
      // Phase 1: 25 tasks, scrolled to the bottom.
      widget.updateTasks(makeManyTasks(25));
      widget.setSelectedTaskId('t25');
      expect(isIndicator(widget.render(WIDE)[0])).toBe(true); // scrolled down

      // Switch to a different phase (all-new ids). The new phase has active tasks
      // near the bottom (out of the initial viewport), yet the offset must reset
      // to 0: auto-scroll only fires for a task that *transitions* to active,
      // and on a fresh phase load no task transitions.
      const phase2 = makeManyTasks(25, 'u').map((t, i) =>
        i >= 22 ? { ...t, status: 'active' as const, startedAt: 1000 } : t,
      );
      widget.updateTasks(phase2);
      const lines = widget.render(WIDE);

      // Scroll offset reset to 0: first row is a task (not an indicator) at t-01.
      expect(isIndicator(lines[0])).toBe(false);
      expect(firstTaskId(lines)).toBe('t-01');
    });

    it('scrolls to fit parked tasks when a task transitions to parked', () => {
      const widget = new TaskListWidget();
      // 25 tasks; first two are already parked (visible at offset 0).
      const initial = makeManyTasks(25).map((t, i) =>
        i < 2 ? { ...t, status: 'parked' as const, startedAt: 1000 } : t,
      );
      widget.updateTasks(initial);
      // Scroll down past the parked cluster so they sit above the viewport.
      widget.setSelectedTaskId('t25');
      const scrolled = widget.render(WIDE);
      expect(isIndicator(scrolled[0])).toBe(true); // top indicator → scrolled down
      expect(renderedTaskIds(scrolled)).not.toContain('t-01'); // parked t-01 is off-screen

      // A third task (registration index 2) transitions ready → parked.
      const updated = initial.map((t, i) => (i === 2 ? { ...t, status: 'parked' as const, startedAt: 2000 } : t));
      widget.updateTasks(updated);
      const lines = widget.render(WIDE);

      // Auto-scroll brings the parked cluster back into view at offset 0:
      // first row is a task (no top indicator) starting at t-01.
      expect(isIndicator(lines[0])).toBe(false);
      expect(firstTaskId(lines)).toBe('t-01');
      // The parked tasks are t-01, t-02, t-03 (indices 0,1,2). Only a viewport
      // starting at offset 0 can show all three, so this is the maximum
      // achievable count of visible running tasks.
      expect(countVisible(lines, ['t-01', 't-02', 't-03'])).toBe(3);
    });

    it('counts parked tasks together with active tasks for auto-scroll optimization', () => {
      const widget = new TaskListWidget();
      // 25 tasks; one active (index 0) and one parked (index 1) at the top.
      const initial = makeManyTasks(25).map((t, i) => {
        if (i === 0) return { ...t, status: 'active' as const, startedAt: 1000 };
        if (i === 1) return { ...t, status: 'parked' as const, startedAt: 2000 };
        return t;
      });
      widget.updateTasks(initial);
      // Scroll down so both are off-screen.
      widget.setSelectedTaskId('t25');
      const scrolled = widget.render(WIDE);
      expect(isIndicator(scrolled[0])).toBe(true);
      expect(renderedTaskIds(scrolled)).not.toContain('t-01');
      expect(renderedTaskIds(scrolled)).not.toContain('t-02');

      // A third task (index 8, within mid-range) transitions to active.
      const updated = initial.map((t, i) => (i === 8 ? { ...t, status: 'active' as const, startedAt: 3000 } : t));
      widget.updateTasks(updated);
      const lines = widget.render(WIDE);

      // Auto-scroll maximizes visible in-progress (active + parked) tasks:
      // offset 0 shows t-01 (active), t-02 (parked), and t-09 (newly active)
      // = 3 in-progress tasks in the window. This is the maximum.
      expect(isIndicator(lines[0])).toBe(false);
      expect(firstTaskId(lines)).toBe('t-01');
      expect(countVisible(lines, ['t-01', 't-02', 't-09'])).toBe(3);
    });
  });
});
