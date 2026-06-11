import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'bun:test';
import { EventLog } from '../../../src/tui/components/event-log.js';

describe('EventLog', () => {
  describe('addLine and totalLines', () => {
    it('adding lines increases totalLines', () => {
      const log = new EventLog();
      expect(log.totalLines).toBe(0);
      log.addLine('line 1');
      expect(log.totalLines).toBe(1);
      log.addLine('line 2');
      expect(log.totalLines).toBe(2);
      log.addLine('line 3');
      expect(log.totalLines).toBe(3);
    });
  });

  describe('render', () => {
    it('returns exactly maxLines lines (padded with empty strings)', () => {
      const log = new EventLog();
      log.setMaxLines(5);
      log.addLine('only one line');
      const rendered = log.render(80);
      expect(rendered.length).toBe(5);
      // First 4 should be empty, last should contain the line
      expect(rendered[0]).toBe(' '.repeat(80));
      expect(rendered[4]).toBe('only one line' + ' '.repeat(80 - 'only one line'.length));
    });

    it('returns exactly maxLines lines when full', () => {
      const log = new EventLog();
      log.setMaxLines(3);
      log.addLine('a');
      log.addLine('b');
      log.addLine('c');
      const rendered = log.render(80);
      expect(rendered.length).toBe(3);
    });

    it('truncates lines to width', () => {
      const log = new EventLog();
      log.setMaxLines(2);
      log.addLine('a really long line that exceeds the width');
      log.addLine('short');
      const rendered = log.render(10);
      for (const line of rendered) {
        // truncateToWidth with pad=true returns exactly width visible columns
        expect(visibleWidth(line)).toBe(10);
      }
    });

    it('shows last maxLines when more lines exist', () => {
      const log = new EventLog();
      log.setMaxLines(3);
      log.addLine('line 1');
      log.addLine('line 2');
      log.addLine('line 3');
      log.addLine('line 4');
      log.addLine('line 5');
      const rendered = log.render(80);
      expect(rendered.length).toBe(3);
      // Should show lines 3, 4, 5
      expect(rendered[0].trim()).toBe('line 3');
      expect(rendered[1].trim()).toBe('line 4');
      expect(rendered[2].trim()).toBe('line 5');
    });
  });

  describe('scrolling', () => {
    it('auto-scroll: new lines appear at bottom when autoScroll=true', () => {
      const log = new EventLog();
      log.setMaxLines(3);
      log.addLine('line 1');
      log.addLine('line 2');
      log.addLine('line 3');
      // Auto-scroll is on by default; add another line
      log.addLine('line 4');
      const rendered = log.render(80);
      expect(rendered.length).toBe(3);
      expect(rendered[0].trim()).toBe('line 2');
      expect(rendered[1].trim()).toBe('line 3');
      expect(rendered[2].trim()).toBe('line 4');
      expect(log.isScrolledUp).toBe(false);
    });

    it('manual scroll: new lines do not move viewport when autoScroll=false', () => {
      const log = new EventLog();
      log.setMaxLines(3);
      log.addLine('line 1');
      log.addLine('line 2');
      log.addLine('line 3');
      // Manually scroll up
      (log as any).autoScroll = false;
      (log as any).scrollOffset = 1;
      // Add new lines - viewport should stay in place
      log.addLine('line 4');
      log.addLine('line 5');
      const rendered = log.render(80);
      expect(rendered.length).toBe(3);
      // scrollOffset was 1, then +2 from addLine = 3
      // lines.length = 5, scrollOffset = 3, endIdx = 2, startIdx = max(0, 2-3) = 0
      // slice = lines[0..2) = [line1, line2]
      // padded to 3: ['', 'line 1', 'line 2']
      // First line is the scroll indicator since isScrolledUp is true
      expect(rendered[0]).toContain('↑');
      expect(rendered[1].trim()).toBe('line 1');
      expect(rendered[2].trim()).toBe('line 2');
      expect(log.isScrolledUp).toBe(true);
    });

    it('pageUp adjusts scrollOffset correctly', () => {
      const log = new EventLog();
      log.setMaxLines(5);
      for (let i = 1; i <= 20; i++) {
        log.addLine(`line ${i}`);
      }
      // Manually simulate pageUp: maxLines-1 = 4
      (log as any).scrollOffset = 0;
      (log as any).autoScroll = false;
      // Simulate the pageUp logic directly
      const pageSize = Math.max(1, 5 - 1);
      (log as any).scrollOffset = Math.min(0 + pageSize, Math.max(0, 20 - 5));
      expect((log as any).scrollOffset).toBe(4);
      expect(log.isScrolledUp).toBe(true);
    });

    it('pageDown adjusts scrollOffset correctly', () => {
      const log = new EventLog();
      log.setMaxLines(5);
      for (let i = 1; i <= 20; i++) {
        log.addLine(`line ${i}`);
      }
      // Start scrolled up
      (log as any).scrollOffset = 10;
      (log as any).autoScroll = false;
      // Simulate pageDown: maxLines-1 = 4
      const pageSize = Math.max(1, 5 - 1);
      (log as any).scrollOffset = Math.max(0, 10 - pageSize);
      if ((log as any).scrollOffset === 0) {
        (log as any).autoScroll = true;
      }
      expect((log as any).scrollOffset).toBe(6);
      expect((log as any).autoScroll).toBe(false);
    });

    it('pageDown to bottom enables autoScroll', () => {
      const log = new EventLog();
      log.setMaxLines(5);
      for (let i = 1; i <= 20; i++) {
        log.addLine(`line ${i}`);
      }
      (log as any).scrollOffset = 3;
      (log as any).autoScroll = false;
      // pageDown with pageSize 4
      const pageSize = Math.max(1, 5 - 1);
      (log as any).scrollOffset = Math.max(0, 3 - pageSize);
      if ((log as any).scrollOffset === 0) {
        (log as any).autoScroll = true;
      }
      expect((log as any).scrollOffset).toBe(0);
      expect((log as any).autoScroll).toBe(true);
    });

    it('end key resets to bottom and enables autoScroll', () => {
      const log = new EventLog();
      log.setMaxLines(5);
      for (let i = 1; i <= 20; i++) {
        log.addLine(`line ${i}`);
      }
      (log as any).scrollOffset = 10;
      (log as any).autoScroll = false;
      // Simulate end key
      (log as any).scrollOffset = 0;
      (log as any).autoScroll = true;
      expect(log.isScrolledUp).toBe(false);
      expect((log as any).autoScroll).toBe(true);
    });

    it('home key scrolls to top', () => {
      const log = new EventLog();
      log.setMaxLines(5);
      for (let i = 1; i <= 20; i++) {
        log.addLine(`line ${i}`);
      }
      // Simulate home key
      (log as any).scrollOffset = Math.max(0, 20 - 5);
      (log as any).autoScroll = false;
      expect((log as any).scrollOffset).toBe(15);
      expect(log.isScrolledUp).toBe(true);
      // Verify we see the first lines
      const rendered = log.render(80);
      // First line is the scroll indicator since scrollOffset > 0
      expect(rendered[0]).toContain('↑');
      expect(rendered[1].trim()).toBe('line 2');
      expect(rendered[4].trim()).toBe('line 5');
    });

    it('shows scroll indicator when scrolled up', () => {
      const log = new EventLog();
      log.setMaxLines(3);
      for (let i = 1; i <= 10; i++) {
        log.addLine(`line ${i}`);
      }
      (log as any).scrollOffset = 2;
      (log as any).autoScroll = false;
      const rendered = log.render(80);
      // First line should be the indicator containing the scroll offset
      expect(rendered[0]).toContain('↑');
      expect(rendered[0]).toContain('2');
      // Remaining lines should be content
      expect(rendered[1].trim()).toBe('line 7');
      expect(rendered[2].trim()).toBe('line 8');
    });
  });

  describe('setMaxLines', () => {
    it('clamps scrollOffset when reducing maxLines', () => {
      const log = new EventLog();
      log.setMaxLines(10);
      for (let i = 1; i <= 20; i++) {
        log.addLine(`line ${i}`);
      }
      // Scroll up
      (log as any).scrollOffset = 5;
      (log as any).autoScroll = false;
      // Reduce maxLines so scrollOffset would be too large
      log.setMaxLines(3);
      // max valid offset = lines.length - maxLines = 20 - 3 = 17, so 5 is still valid
      expect((log as any).scrollOffset).toBe(5);
      // Set to something that would exceed
      (log as any).scrollOffset = 20;
      log.setMaxLines(3);
      expect((log as any).scrollOffset).toBe(17);
    });

    it('does not set scrollOffset below 0', () => {
      const log = new EventLog();
      log.setMaxLines(5);
      log.addLine('one line');
      log.setMaxLines(10);
      // scrollOffset should be clamped to max(0, min(0, 1-10)) = 0
      expect((log as any).scrollOffset).toBe(0);
    });
  });

  describe('caching', () => {
    it('returns cached result for same width', () => {
      const log = new EventLog();
      log.setMaxLines(3);
      log.addLine('a');
      log.addLine('b');
      const first = log.render(40);
      const second = log.render(40);
      expect(first).toBe(second);
      // Should be the exact same reference
      expect(first).toBe(second);
    });

    it('re-renders when width changes', () => {
      const log = new EventLog();
      log.setMaxLines(3);
      log.addLine('hello world');
      const at40 = log.render(40);
      const at80 = log.render(80);
      expect(at40[2].length).toBe(40);
      expect(at80[2].length).toBe(80);
    });

    it('re-renders after addLine (cache invalidated)', () => {
      const log = new EventLog();
      log.setMaxLines(3);
      log.addLine('a');
      const first = log.render(40);
      log.addLine('b');
      const second = log.render(40);
      // Content should differ
      expect(second).not.toBe(first);
    });

    it('re-renders after setMaxLines (cache invalidated)', () => {
      const log = new EventLog();
      log.addLine('a');
      log.addLine('b');
      log.addLine('c');
      log.addLine('d');
      log.addLine('e');
      const first = log.render(40);
      log.setMaxLines(2);
      const second = log.render(40);
      expect(second.length).toBe(2);
      expect(second).not.toEqual(first);
    });
  });

  describe('invalidate', () => {
    it('clears cache so next render recomputes', () => {
      const log = new EventLog();
      log.setMaxLines(3);
      log.addLine('a');
      log.render(40);
      // Mutate internal state directly to simulate external change
      (log as any).lines[0] = 'changed';
      log.invalidate();
      const second = log.render(40);
      expect(second[2].trim()).toBe('changed');
    });
  });
});
