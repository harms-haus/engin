/* eslint-disable no-control-regex -- tests intentionally match ANSI escape codes */
import type { TaskEntity } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import { TaskListWidget } from '../../../packages/tui/src/components/task-list-widget.js';
import { dim, statusColor, statusIcon } from '../../../packages/tui/src/theme.js';

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
    it('renders each task with its status icon and colored title', () => {
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
      const expected0 = statusIcon('complete') + ' ' + statusColor('complete')('Task A');
      expect(lines[0].startsWith(expected0)).toBe(true);

      const expected1 = statusIcon('active') + ' ' + statusColor('active')('Task B');
      expect(lines[1].startsWith(expected1)).toBe(true);

      const expected2 = statusIcon('blocked') + ' ' + statusColor('blocked')('Task C');
      expect(lines[2].startsWith(expected2)).toBe(true);
    });

    it('renders only actual tasks with no blank padding', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'Only', status: 'ready' })]);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(1);
      const expected = statusIcon('ready') + ' ' + statusColor('ready')('Only');
      expect(lines[0].startsWith(expected)).toBe(true);
    });
  });

  describe('selected task', () => {
    it('renders the selected task in bold', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
      ]);
      // Creation order: ready (t1) at index 0, complete (t2) at index 1
      widget.setSelectedTaskId('t2');
      const lines = widget.render(WIDTH);

      const unfocusedContent = statusIcon('ready') + ' ' + statusColor('ready')('First');
      expect(lines[0].startsWith(unfocusedContent)).toBe(true);
      // Line 0 should NOT be bold-wrapped
      expect(lines[0]).not.toContain('\x1b[1m');

      // Line 1 should be bold-wrapped
      const focusedContent = statusIcon('complete') + ' ' + statusColor('complete')('Second');
      expect(lines[1]).toContain('\x1b[1m');
      expect(lines[1]).toContain(focusedContent);
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
      // Sorted: ready(t1)=0, complete(t2)=1, failed(t3)=2
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
      // Creation order: t1 (ready), t2 (complete), t3 (active)
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

  describe('truncation and padding', () => {
    it('truncates long titles to the given width', () => {
      const widget = new TaskListWidget();
      const longTitle = 'A'.repeat(80);
      widget.updateTasks([makeTask({ id: 't1', title: longTitle, status: 'ready' })]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(1);
      // The rendered line should be at least WIDTH characters wide (visible)
      expect(lines[0].length).toBeGreaterThanOrEqual(WIDTH);
    });

    it('pads short titles to the given width', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([makeTask({ id: 't1', title: 'Hi', status: 'ready' })]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(1);
      // Should contain trailing spaces to fill to WIDTH
      expect(lines[0].endsWith(' '.repeat(WIDTH - 5))).toBe(true);
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
      widget.updateTasks([
        makeTask({ id: 't1', title: 'Complete Task', status: 'complete' }),
        makeTask({ id: 't2', title: 'Blocked Task', status: 'blocked' }),
        makeTask({ id: 't3', title: 'Active Task', status: 'active' }),
        makeTask({ id: 't4', title: 'Ready Task', status: 'ready' }),
      ]);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(4);

      // Order is exactly the insertion/registration order, regardless of status
      const expected0 = statusIcon('complete') + ' ' + statusColor('complete')('Complete Task');
      expect(lines[0].startsWith(expected0)).toBe(true);

      const expected1 = statusIcon('blocked') + ' ' + statusColor('blocked')('Blocked Task');
      expect(lines[1].startsWith(expected1)).toBe(true);

      const expected2 = statusIcon('active') + ' ' + statusColor('active')('Active Task');
      expect(lines[2].startsWith(expected2)).toBe(true);

      const expected3 = statusIcon('ready') + ' ' + statusColor('ready')('Ready Task');
      expect(lines[3].startsWith(expected3)).toBe(true);
    });

    it('failed, cancelled, and complete appear in creation order, not grouped', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'Failed', status: 'failed' }),
        makeTask({ id: 't2', title: 'Cancelled', status: 'cancelled' }),
        makeTask({ id: 't3', title: 'Complete', status: 'complete' }),
        makeTask({ id: 't4', title: 'Active', status: 'active' }),
      ]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(4);
      // Creation order preserved: failed, cancelled, complete, active
      expect(lines[0].startsWith(statusIcon('failed') + ' ' + statusColor('failed')('Failed'))).toBe(true);
      expect(lines[1].startsWith(statusIcon('cancelled') + ' ' + statusColor('cancelled')('Cancelled'))).toBe(true);
      expect(lines[2].startsWith(statusIcon('complete') + ' ' + statusColor('complete')('Complete'))).toBe(true);
      expect(lines[3].startsWith(statusIcon('active') + ' ' + statusColor('active')('Active'))).toBe(true);
    });

    it('newly registered tasks are appended at the bottom', () => {
      const widget = new TaskListWidget();
      widget.updateTasks([
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
      ]);
      let lines = widget.render(WIDTH);
      expect(lines[0].startsWith(statusIcon('ready') + ' ' + statusColor('ready')('First'))).toBe(true);
      expect(lines[1].startsWith(statusIcon('complete') + ' ' + statusColor('complete')('Second'))).toBe(true);

      // A later-registered active task is appended, not promoted to the top
      widget.updateTasks([
        makeTask({ id: 't1', title: 'First', status: 'ready' }),
        makeTask({ id: 't2', title: 'Second', status: 'complete' }),
        makeTask({ id: 't3', title: 'Third', status: 'active' }),
      ]);
      lines = widget.render(WIDTH);
      expect(lines[0].startsWith(statusIcon('ready') + ' ' + statusColor('ready')('First'))).toBe(true);
      expect(lines[1].startsWith(statusIcon('complete') + ' ' + statusColor('complete')('Second'))).toBe(true);
      expect(lines[2].startsWith(statusIcon('active') + ' ' + statusColor('active')('Third'))).toBe(true);
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
      // Creation order: ready(t1) idx 0, complete(t2) idx 1, blocked(t3) idx 2
      widget.setSelectedTaskId('t3'); // blocked
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
      // Creation order: ready(t1) index 0, complete(t2) index 1
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
      // t2 (complete) should be bold at creation-order index 1
      const focusedContent = statusIcon('complete') + ' ' + statusColor('complete')('Task B');
      expect(lines[1]).toContain('\x1b[1m');
      expect(lines[1]).toContain(focusedContent);
      // Other lines should not be bold
      expect(lines[0]).not.toContain('\x1b[1m');
      expect(lines[2]).not.toContain('\x1b[1m');
    });
  });

  describe('status-dependent row formats', () => {
    describe('active tasks with step annotation', () => {
      it('active task with activeStepIndex and steps renders step annotation', () => {
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
        // Should contain the step annotation "step 2/3: review"
        expect(line).toContain(dim('step 2/3: review'));
        // Should NOT contain the dimmed status keyword
        expect(line).not.toContain(dim('active'));
        // Should contain elapsed time
        expect(line).toContain('5s');
        // Should contain the title
        expect(line).toContain('My Task');
      });

      it('active task without activeStepIndex falls back to status text', () => {
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
        // Should fall back to dim status text
        expect(line).toContain(dim('active'));
        // Should contain elapsed
        expect(line).toContain('5s');
        // Should contain title
        expect(line).toContain('My Task');
        // Should have two dashes: icon+title - status - elapsed
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        const dashCount = (stripped.match(/ - /g) || []).length;
        expect(dashCount).toBe(2);
      });

      it('active task with activeStepIndex out of bounds falls back to status text', () => {
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
        // Should fall back to dim status text
        expect(line).toContain(dim('active'));
      });

      it('active task without startedAt shows icon, title, and step annotation but no elapsed', () => {
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
        // Should show step annotation
        expect(line).toContain(dim('step 1/2: plan'));
        // Should contain the title
        expect(line).toContain('No Elapsed');
        // Should have exactly one dash separator (title - step annotation)
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect((stripped.match(/ - /g) || []).length).toBe(1);
        // Should NOT show elapsed time pattern in stripped content
        expect(stripped).not.toMatch(/\d+[smh]/);
      });
    });

    describe('ready/blocked tasks (no status text or elapsed)', () => {
      it('ready task shows ONLY icon and title', () => {
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
        // Should contain the title
        expect(line).toContain('Ready Task');
        // Should NOT contain dash separators (check stripped to avoid ANSI)
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect(stripped).not.toMatch(/ - /);
        // Should NOT contain elapsed pattern in stripped content
        expect(stripped).not.toMatch(/\d+[smh]/);
        // The stripped content should be just icon + space + title (plus padding)
        const icon = statusIcon('ready');
        expect(stripped.startsWith(icon + ' ' + 'Ready Task')).toBe(true);
      });

      it('blocked task shows ONLY icon and title', () => {
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
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect(stripped).not.toMatch(/ - /);
        expect(stripped).not.toMatch(/\d+[smh]/);
        const icon = statusIcon('blocked');
        expect(stripped.startsWith(icon + ' ' + 'Blocked Task')).toBe(true);
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
        // Should contain the title
        expect(line).toContain('Complete Task');
        // Should contain elapsed (5s from 1000ms to 6000ms)
        expect(line).toContain('5s');
        // Should NOT contain the status word "complete" as dimmed status text
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect(stripped).not.toMatch(/ - complete( -|$)/);
        // Should have exactly ONE dash separator (title - elapsed)
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
        // Should NOT contain the dim status word "failed"
        expect(line).not.toContain(dim('failed'));
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
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
        // Should NOT contain the dim status word "cancelled"
        expect(line).not.toContain(dim('cancelled'));
      });

      it('complete task without startedAt shows only icon and title', () => {
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
        // No dash separators (check stripped to avoid ANSI)
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect(stripped).not.toMatch(/ - /);
        // No elapsed pattern in stripped content
        expect(stripped).not.toMatch(/\d+[smh]/);
        const icon = statusIcon('complete');
        expect(stripped.startsWith(icon + ' ' + 'Complete No Time')).toBe(true);
      });
    });

    describe('completedAt freezes elapsed', () => {
      it('completedAt freezes elapsed for complete tasks', () => {
        const widget = new TaskListWidget();
        // A complete task with completedAt should show frozen elapsed until completedAt
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
        const line = lines[0];
        // Should show 5s (6000 - 1000 = 5000ms)
        expect(line).toContain('5s');
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
        const line = lines[0];
        // Should show elapsed based on Date.now() - startedAt, which is ~10s
        expect(line).toContain('10s');
      });
    });
  });
});
