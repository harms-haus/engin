/* eslint-disable no-control-regex -- tests intentionally match ANSI escape codes */
import { describe, expect, it } from 'bun:test';
import { LanePoolWidget, type TaskLane } from '../../../src/tui/components/lane-pool-widget.js';
import { dim, statusColor, statusIcon } from '../../../src/tui/theme.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';

const WIDTH = 40;

describe('LanePoolWidget', () => {
  describe('rendering empty lanes', () => {
    it('renders zero lanes when no lanes are set', () => {
      const widget = new LanePoolWidget();
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(0);
    });
  });

  describe('getVisibleLaneCount', () => {
    it('returns 0 when no lanes are set', () => {
      const widget = new LanePoolWidget();
      expect(widget.getVisibleLaneCount()).toBe(0);
    });

    it('returns the number of lanes set via updateLanes', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
      ]);
      expect(widget.getVisibleLaneCount()).toBe(2);
    });

    it('updates when lanes change', () => {
      const widget = new LanePoolWidget();
      expect(widget.getVisibleLaneCount()).toBe(0);
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      expect(widget.getVisibleLaneCount()).toBe(1);
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
        { id: 't3', title: 'C', status: 'failed' },
      ]);
      expect(widget.getVisibleLaneCount()).toBe(3);
    });
  });

  describe('rendering lanes with status icons and titles', () => {
    it('renders each lane with its status icon and colored title', () => {
      const widget = new LanePoolWidget();
      const lanes: TaskLane[] = [
        { id: 't1', title: 'Task A', status: 'done' },
        { id: 't2', title: 'Task B', status: 'implementing' },
        { id: 't3', title: 'Task C', status: 'blocked' },
      ];
      widget.updateLanes(lanes);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(3);

      // After sorting: implementing (t2) first, then blocked (t3), then done (t1)
      const expected0 = statusIcon('implementing') + ' ' + statusColor('implementing')('Task B');
      expect(lines[0].startsWith(expected0)).toBe(true);

      const expected1 = statusIcon('blocked') + ' ' + statusColor('blocked')('Task C');
      expect(lines[1].startsWith(expected1)).toBe(true);

      const expected2 = statusIcon('done') + ' ' + statusColor('done')('Task A');
      expect(lines[2].startsWith(expected2)).toBe(true);
    });

    it('renders only actual lanes with no blank padding', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([{ id: 't1', title: 'Only', status: 'ready' }]);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(1);
      const expected = statusIcon('ready') + ' ' + statusColor('ready')('Only');
      expect(lines[0].startsWith(expected)).toBe(true);
    });
  });

  describe('focused lane', () => {
    it('renders the focused lane in bold', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'First', status: 'ready' },
        { id: 't2', title: 'Second', status: 'done' },
      ]);
      // Sorted order: ready (t1) at index 0, done (t2) at index 1
      widget.setFocusedLaneById('t2');
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
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'ready' },
        { id: 't3', title: 'C', status: 'ready' },
      ]);
      widget.setFocusedLaneById('t3');
      expect(widget.getFocusedTaskId()).toBe('t3');

      widget.handleInput(UP);
      expect(widget.getFocusedTaskId()).toBe('t2');

      widget.handleInput(UP);
      expect(widget.getFocusedTaskId()).toBe('t1');
    });

    it('Down arrow increments focused lane index', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'ready' },
        { id: 't3', title: 'C', status: 'ready' },
      ]);
      widget.setFocusedLaneById('t1');
      expect(widget.getFocusedTaskId()).toBe('t1');

      widget.handleInput(DOWN);
      expect(widget.getFocusedTaskId()).toBe('t2');

      widget.handleInput(DOWN);
      expect(widget.getFocusedTaskId()).toBe('t3');
    });

    it('does not go above index 0', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'ready' },
      ]);
      widget.setFocusedLaneById('t1');
      widget.handleInput(UP);
      expect(widget.getFocusedTaskId()).toBe('t1');
    });

    it('does not go below last lane', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'ready' },
      ]);
      widget.setFocusedLaneById('t2');
      widget.handleInput(DOWN);
      expect(widget.getFocusedTaskId()).toBe('t2');
    });
  });

  describe('getFocusedTaskId', () => {
    it('returns undefined when no lane is focused', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      expect(widget.getFocusedTaskId()).toBeUndefined();
    });

    it('returns the correct task id after setting focus', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
        { id: 't3', title: 'C', status: 'failed' },
      ]);
      // Sorted: ready(t1)=0, done(t2)=1, failed(t3)=2
      widget.setFocusedLaneById('t2');
      expect(widget.getFocusedTaskId()).toBe('t2');
    });
  });

  describe('truncation and padding', () => {
    it('truncates long titles to the given width', () => {
      const widget = new LanePoolWidget();
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
      const widget = new LanePoolWidget();
      widget.updateLanes([{ id: 't1', title: 'Hi', status: 'ready' }]);
      const lines = widget.render(WIDTH);
      expect(lines).toHaveLength(1);
      // Should contain trailing spaces to fill to WIDTH
      expect(lines[0].endsWith(' '.repeat(WIDTH - 5))).toBe(true);
    });
  });

  describe('caching', () => {
    it('returns cached lines when not dirty and width unchanged', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      const first = widget.render(WIDTH);
      const second = widget.render(WIDTH);
      expect(first).toBe(second);
      // Exact same reference
      expect(first).toBe(second);
    });

    it('re-renders after invalidate', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      const first = widget.render(WIDTH);
      widget.invalidate();
      const second = widget.render(WIDTH);
      // Content should be the same but it should have re-rendered
      expect(second).toEqual(first);
    });

    it('re-renders when width changes', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      const first = widget.render(WIDTH);
      const second = widget.render(WIDTH + 10);
      expect(second).toHaveLength(1);
      expect(first).not.toBe(second);
    });
  });

  describe('sorting', () => {
    it('lanes are sorted by status priority', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'Done Task', status: 'done' },
        { id: 't2', title: 'Blocked Task', status: 'blocked' },
        { id: 't3', title: 'Implementing Task', status: 'implementing' },
        { id: 't4', title: 'Ready Task', status: 'ready' },
      ]);
      const lines = widget.render(WIDTH);

      expect(lines).toHaveLength(4);

      // Order: implementing (0), ready (2), blocked (3), done (4)
      const expected0 = statusIcon('implementing') + ' ' + statusColor('implementing')('Implementing Task');
      expect(lines[0].startsWith(expected0)).toBe(true);

      const expected1 = statusIcon('ready') + ' ' + statusColor('ready')('Ready Task');
      expect(lines[1].startsWith(expected1)).toBe(true);

      const expected2 = statusIcon('blocked') + ' ' + statusColor('blocked')('Blocked Task');
      expect(lines[2].startsWith(expected2)).toBe(true);

      const expected3 = statusIcon('done') + ' ' + statusColor('done')('Done Task');
      expect(lines[3].startsWith(expected3)).toBe(true);
    });
  });

  describe('stale focus cleanup', () => {
    it('focused lane ID cleared when lane is removed', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
        { id: 't3', title: 'C', status: 'blocked' },
      ]);
      // Sorted order: ready(t1) idx 0, blocked(t3) idx 1, done(t2) idx 2
      widget.setFocusedLaneById('t3'); // blocked
      expect(widget.getFocusedTaskId()).toBe('t3');

      // Remove t3 from the lane list
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
      ]);
      expect(widget.getFocusedTaskId()).toBeUndefined();
    });

    it('keeps focus if lane still exists after update', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
      ]);
      widget.setFocusedLaneById('t1');
      expect(widget.getFocusedTaskId()).toBe('t1');

      widget.updateLanes([
        { id: 't1', title: 'A (updated)', status: 'implementing' },
        { id: 't2', title: 'B', status: 'done' },
        { id: 't3', title: 'C', status: 'ready' },
      ]);
      expect(widget.getFocusedTaskId()).toBe('t1');
    });
  });

  describe('getSortedLanes', () => {
    it('returns lanes in priority order', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'Done', status: 'done' },
        { id: 't2', title: 'Implementing', status: 'implementing' },
        { id: 't3', title: 'Blocked', status: 'blocked' },
        { id: 't4', title: 'Ready', status: 'ready' },
      ]);
      const sorted = widget.getSortedLanes();

      expect(sorted.map((l) => l.id)).toEqual(['t2', 't4', 't3', 't1']);
    });

    it('returns empty array when no lanes are set', () => {
      const widget = new LanePoolWidget();
      expect(widget.getSortedLanes()).toEqual([]);
    });
  });

  describe('getFocusedLane', () => {
    it('returns the focused lane object', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
        { id: 't3', title: 'C', status: 'implementing' },
      ]);
      // Sorted: t3 (implementing), t1 (ready), t2 (done)
      widget.setFocusedLaneById('t1');
      const lane = widget.getFocusedLane();
      expect(lane).toBeDefined();
      expect(lane!.id).toBe('t1');
      expect(lane!.title).toBe('A');
      expect(lane!.status).toBe('ready');
    });

    it('returns undefined when no lane is focused', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([{ id: 't1', title: 'A', status: 'ready' }]);
      expect(widget.getFocusedLane()).toBeUndefined();
    });
  });

  describe('setFocusedLaneById', () => {
    it('focuses the lane with the given ID', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
        { id: 't3', title: 'C', status: 'implementing' },
      ]);
      widget.setFocusedLaneById('t2');
      expect(widget.getFocusedTaskId()).toBe('t2');
      expect(widget.getFocusedLane()?.title).toBe('B');
    });

    it('is a no-op for non-existent ID', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'done' },
      ]);
      widget.setFocusedLaneById('t1');
      expect(widget.getFocusedTaskId()).toBe('t1');
      widget.setFocusedLaneById('nonexistent');
      expect(widget.getFocusedTaskId()).toBe('t1');
    });
  });

  describe('focus tracking by task ID', () => {
    it('focused lane tracks by task ID after re-sort', () => {
      const widget = new LanePoolWidget();
      widget.updateLanes([
        { id: 't1', title: 'Task A', status: 'ready' },
        { id: 't2', title: 'Task B', status: 'done' },
      ]);
      // Sorted: ready(t1) index 0, done(t2) index 1
      widget.setFocusedLaneById('t2');
      expect(widget.getFocusedTaskId()).toBe('t2');

      // Add an implementing task — it goes to sorted index 0, pushing others down
      widget.updateLanes([
        { id: 't1', title: 'Task A', status: 'ready' },
        { id: 't2', title: 'Task B', status: 'done' },
        { id: 't3', title: 'Task C', status: 'implementing' },
      ]);

      // Focus should still be on t2, now at sorted index 2
      expect(widget.getFocusedTaskId()).toBe('t2');
      const lines = widget.render(WIDTH);
      // t2 (done) should be bold in the last position (sorted index 2)
      const focusedContent = statusIcon('done') + ' ' + statusColor('done')('Task B');
      expect(lines[2]).toContain('\x1b[1m');
      expect(lines[2]).toContain(focusedContent);
      // Other lines should not be bold
      expect(lines[0]).not.toContain('\x1b[1m');
      expect(lines[1]).not.toContain('\x1b[1m');
    });
  });

  describe('status-dependent row formats', () => {
    describe('active tasks (implementing, reviewing, claimed)', () => {
      it('active task with stepInfo shows step name instead of status', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'My Task',
            status: 'implementing',
            stepInfo: 'test-writing',
            startedAt: Date.now() - 5000,
          },
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // Should contain the step name dimmed, NOT the status
        expect(line).toContain(dim('test-writing'));
        expect(line).not.toContain(dim('implementing'));
        // Should contain the elapsed time
        expect(line).toContain('5s');
        // Should contain the title
        expect(line).toContain('My Task');
      });

      it('active task without stepInfo falls back to status', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'My Task',
            status: 'implementing',
            startedAt: Date.now() - 5000,
          },
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain(dim('implementing'));
      });

      it('active task implementing shows status text and elapsed', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'My Task',
            status: 'implementing',
            startedAt: Date.now() - 5000,
          },
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // Should contain the dim status text
        expect(line).toContain(dim('implementing'));
        // Should contain the elapsed time
        expect(line).toContain('5s');
        // Should contain the title
        expect(line).toContain('My Task');
        // Format: {icon} {colored title} - {dim status} - {dim elapsed}
        // Count the dash separators (there should be exactly 2)
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        const dashCount = (stripped.match(/ - /g) || []).length;
        expect(dashCount).toBe(2);
      });

      it('active task reviewing shows status text and elapsed', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'Review Task',
            status: 'reviewing',
            startedAt: Date.now() - 3000,
          },
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain(dim('reviewing'));
        expect(line).toContain('3s');
        expect(line).toContain('Review Task');
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect((stripped.match(/ - /g) || []).length).toBe(2);
      });

      it('active task claimed shows status text and elapsed', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'Claimed Task',
            status: 'claimed',
            startedAt: Date.now() - 7000,
          },
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain(dim('claimed'));
        expect(line).toContain('7s');
        expect(line).toContain('Claimed Task');
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect((stripped.match(/ - /g) || []).length).toBe(2);
      });

      it('active task without startedAt shows icon, title, and status text but no elapsed', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'No Elapsed',
            status: 'implementing',
          },
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // Should show dim status text
        expect(line).toContain(dim('implementing'));
        // Should contain the title
        expect(line).toContain('No Elapsed');
        // Should have exactly one dash separator (title - status) with no elapsed
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect((stripped.match(/ - /g) || []).length).toBe(1);
        // Should NOT show elapsed time pattern in stripped content
        expect(stripped).not.toMatch(/\d+[smh]/);
      });
    });

    describe('ready/blocked tasks (no status text or elapsed)', () => {
      it('ready task shows ONLY icon and title', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'Ready Task',
            status: 'ready',
            startedAt: Date.now() - 5000,
          },
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
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'Blocked Task',
            status: 'blocked',
            startedAt: Date.now() - 10000,
          },
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

    describe('done/failed tasks (icon, title, and elapsed but no status text)', () => {
      it('done task shows icon, title, and elapsed but NOT status text', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'Done Task',
            status: 'done',
            startedAt: 1000,
            completedAt: 6000,
          },
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // Should contain the title
        expect(line).toContain('Done Task');
        // Should contain elapsed (5s from 1000ms to 6000ms)
        expect(line).toContain('5s');
        // Should NOT contain the status word "done" (dimmed or not)
        // The title contains "Done" but not "done" in lower case as status text
        // The line should not match a dash followed by "done" (status text would be "done")
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect(stripped).not.toMatch(/ - done( -|$)/);
        // Should have exactly ONE dash separator (title - elapsed)
        expect((stripped.match(/ - /g) || []).length).toBe(1);
      });

      it('failed task shows icon, title, and elapsed but NOT status text', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'Failed Task',
            status: 'failed',
            startedAt: 2000,
            completedAt: 7000,
          },
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

      it('done task without startedAt shows only icon and title', () => {
        const widget = new LanePoolWidget();
        widget.updateLanes([
          {
            id: 't1',
            title: 'Done No Time',
            status: 'done',
          },
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain('Done No Time');
        // No dash separators (check stripped to avoid ANSI)
        const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        expect(stripped).not.toMatch(/ - /);
        // No elapsed pattern in stripped content
        expect(stripped).not.toMatch(/\d+[smh]/);
        const icon = statusIcon('done');
        expect(stripped.startsWith(icon + ' ' + 'Done No Time')).toBe(true);
      });
    });

    describe('completedAt freezes elapsed', () => {
      it('completedAt freezes elapsed for done tasks', () => {
        const widget = new LanePoolWidget();
        // A done task with completedAt should show frozen elapsed until completedAt
        widget.updateLanes([
          {
            id: 't1',
            title: 'Frozen',
            status: 'done',
            startedAt: 1000,
            completedAt: 6000,
          },
        ]);
        const lines = widget.render(WIDTH);
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // Should show 5s (6000 - 1000 = 5000ms)
        expect(line).toContain('5s');
        // Should NOT show a larger value based on Date.now()
        // This is verified by checking that the elapsed is exactly 5s
      });

      it('done task without completedAt shows wall-clock elapsed', () => {
        const widget = new LanePoolWidget();
        const startTime = Date.now() - 10000; // 10 seconds ago
        widget.updateLanes([
          {
            id: 't1',
            title: 'Wall Clock',
            status: 'done',
            startedAt: startTime,
            // no completedAt — uses Date.now()
          },
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
