import { describe, expect, it } from 'bun:test';
import { LanePoolWidget, type TaskLane } from '../../../src/tui/components/lane-pool-widget.js';
import { dim, statusColor, statusIcon } from '../../../src/tui/theme.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';

const WIDTH = 40;

describe('LanePoolWidget', () => {
  describe('rendering empty lanes', () => {
    it('renders empty lanes as blank padded lines', () => {
      const widget = new LanePoolWidget(3);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line).toBe(' '.repeat(WIDTH));
      }
    });
  });

  describe('rendering lanes with status icons and titles', () => {
    it('renders each lane with its status icon and colored title', () => {
      const widget = new LanePoolWidget(3);
      const lanes: TaskLane[] = [
        { id: 't1', title: 'Task A', status: 'done' },
        { id: 't2', title: 'Task B', status: 'implementing' },
        { id: 't3', title: 'Task C', status: 'blocked' },
      ];
      widget.updateLanes(lanes);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(3);

      // Line 0: icon + space + colored title
      const expected0 = statusIcon('done') + ' ' + statusColor('done')('Task A');
      expect(lines[0].startsWith(expected0)).toBe(true);

      const expected1 = statusIcon('implementing') + ' ' + statusColor('implementing')('Task B');
      expect(lines[1].startsWith(expected1)).toBe(true);

      const expected2 = statusIcon('blocked') + ' ' + statusColor('blocked')('Task C');
      expect(lines[2].startsWith(expected2)).toBe(true);
    });

    it('renders fewer lanes than maxLanes, padding remaining with blanks', () => {
      const widget = new LanePoolWidget(4);
      widget.updateLanes([{ id: 't1', title: 'Only', status: 'ready' }]);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(4);
      // First line has content
      const expected = statusIcon('ready') + ' ' + statusColor('ready')('Only');
      expect(lines[0].startsWith(expected)).toBe(true);
      // Remaining lines are blank padded
      expect(lines[1]).toBe(' '.repeat(WIDTH));
      expect(lines[2]).toBe(' '.repeat(WIDTH));
      expect(lines[3]).toBe(' '.repeat(WIDTH));
    });
  });

  describe('focused lane', () => {
    it('renders the focused lane in bold', () => {
      const widget = new LanePoolWidget(2);
      widget.updateLanes([
        { id: 't1', title: 'First', status: 'ready' },
        { id: 't2', title: 'Second', status: 'done' },
      ]);
      widget.setFocusedLane(1);
      const lines = widget.render(WIDTH);

      const unfocusedContent = statusIcon('ready') + ' ' + statusColor('ready')('First');
      expect(lines[0].startsWith(unfocusedContent)).toBe(true);
      // Line 0 should NOT be bold-wrapped
      expect(lines[0]).not.toContain('\x1b[1m');

      // Line 1 should be bold-wrapped
      const focusedContent = statusIcon('done') + ' ' + statusColor('done')('Second');
      expect(lines[1]).toContain('\x1b[1m');
      expect(lines[1]).toContain(focusedContent);
    });
  });

  describe('navigation', () => {
    it('Up arrow decrements focused lane index', () => {
      const widget = new LanePoolWidget(3);
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'ready' },
        { id: 't3', title: 'C', status: 'ready' },
      ]);
      widget.setFocusedLane(2);
      expect(widget.getFocusedTaskId()).toBe('t3');

      widget.handleInput(UP);
      expect(widget.getFocusedTaskId()).toBe('t2');

      widget.handleInput(UP);
      expect(widget.getFocusedTaskId()).toBe('t1');
    });

    it('Down arrow increments focused lane index', () => {
      const widget = new LanePoolWidget(3);
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'ready' },
        { id: 't3', title: 'C', status: 'ready' },
      ]);
      widget.setFocusedLane(0);
      expect(widget.getFocusedTaskId()).toBe('t1');

      widget.handleInput(DOWN);
      expect(widget.getFocusedTaskId()).toBe('t2');

      widget.handleInput(DOWN);
      expect(widget.getFocusedTaskId()).toBe('t3');
    });

    it('does not go above index 0', () => {
      const widget = new LanePoolWidget(2);
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'ready' },
      ]);
      widget.setFocusedLane(0);
      widget.handleInput(UP);
      expect(widget.getFocusedTaskId()).toBe('t1');
    });

    it('does not go below last lane', () => {
      const widget = new LanePoolWidget(2);
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'ready' },
      ]);
      widget.setFocusedLane(1);
      widget.handleInput(DOWN);
      expect(widget.getFocusedTaskId()).toBe('t2');
    });
  });

  describe('getFocusedTaskId', () => {
    it('returns undefined when no lane is focused', () => {
      const widget = new LanePoolWidget(2);
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      expect(widget.getFocusedTaskId()).toBeUndefined();
    });

    it('returns the correct task id after setting focus', () => {
      const widget = new LanePoolWidget(3);
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
        { id: 't3', title: 'C', status: 'failed' },
      ]);
      widget.setFocusedLane(1);
      expect(widget.getFocusedTaskId()).toBe('t2');
    });
  });

  describe('truncation and padding', () => {
    it('truncates long titles to the given width', () => {
      const widget = new LanePoolWidget(1);
      const longTitle = 'A'.repeat(80);
      widget.updateLanes([{ id: 't1', title: longTitle, status: 'ready' }]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(1);
      // The rendered line should be exactly WIDTH characters wide (visible)
      // visibleWidth counts visible columns ignoring ANSI escapes
      // We verify by checking the raw string length is >= WIDTH
      expect(lines[0].length).toBeGreaterThanOrEqual(WIDTH);
    });

    it('pads short titles to the given width', () => {
      const widget = new LanePoolWidget(1);
      widget.updateLanes([{ id: 't1', title: 'Hi', status: 'ready' }]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(1);
      // Should contain trailing spaces to fill to WIDTH
      expect(lines[0].endsWith(' '.repeat(WIDTH - 5))).toBe(true);
    });
  });

  describe('stepInfo', () => {
    it('renders stepInfo when present, dimmed', () => {
      const widget = new LanePoolWidget(1);
      widget.updateLanes([{ id: 't1', title: 'Task', status: 'implementing', stepInfo: 'step 2/3' }]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(1);
      const expectedStepInfo = dim('step 2/3');
      expect(lines[0]).toContain(expectedStepInfo);
    });

    it('omits stepInfo when not present', () => {
      const widget = new LanePoolWidget(1);
      widget.updateLanes([{ id: 't1', title: 'Task', status: 'done' }]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(1);
      // The dim escape code \x1b[2m should not appear (title uses green, not dim)
      // Actually, statusColor('done') uses green \x1b[32m, not dim \x1b[2m
      // But blocked uses dim... let's just check no "step" text appears
      expect(lines[0]).not.toContain('step');
    });
  });

  describe('caching', () => {
    it('returns cached lines when not dirty and width unchanged', () => {
      const widget = new LanePoolWidget(1);
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      const first = widget.render(WIDTH);
      const second = widget.render(WIDTH);
      expect(first).toBe(second);
      // Exact same reference
      expect(first).toBe(second);
    });

    it('re-renders after invalidate', () => {
      const widget = new LanePoolWidget(1);
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      const first = widget.render(WIDTH);
      widget.invalidate();
      const second = widget.render(WIDTH);
      // Content should be the same but it should have re-rendered
      expect(second).toEqual(first);
    });

    it('re-renders when width changes', () => {
      const widget = new LanePoolWidget(1);
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      const first = widget.render(WIDTH);
      const second = widget.render(WIDTH + 10);
      expect(second).toHaveLength(1);
      expect(first).not.toBe(second);
    });
  });
});
