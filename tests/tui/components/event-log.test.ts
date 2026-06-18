/* eslint-disable no-control-regex -- tests intentionally match ANSI escape codes */
import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'bun:test';
import { EventLog } from '../../../packages/tui/src/components/event-log.js';

// Real terminal escape sequences that matchesKey() recognises.
const PGUP = '\x1b[5~';
const PGDN = '\x1b[6~';
const HOME = '\x1b[H';
const END = '\x1b[F';

/** Strip ANSI escape codes for plain-text content assertions. */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

/** True when a rendered row's trimmed content is non-empty. */
function isContentRow(row: string): boolean {
  return row.trim().length > 0;
}

describe('EventLog', () => {
  // ─── Construction & defaults ─────────────────────────────────────────

  describe('construction & defaults', () => {
    it('starts empty with zero totalLines', () => {
      const log = new EventLog();
      expect(log.totalLines).toBe(0);
      expect(log.isScrolledUp).toBe(false);
    });

    it('accepts a maxLines argument', () => {
      const log = new EventLog(7);
      log.addLine('hi');
      expect(log.render(80).length).toBe(7);
    });

    it('default call site shape: new EventLog() with no args', () => {
      // Mirrors the single call site in workflow-tui.ts.
      const log = new EventLog();
      expect(() => log.render(80)).not.toThrow();
    });
  });

  // ─── addLine & totalLines (unbounded storage) ───────────────────────

  describe('addLine & totalLines', () => {
    it('increases totalLines by one per added logical line', () => {
      const log = new EventLog();
      expect(log.totalLines).toBe(0);
      log.addLine('line 1');
      expect(log.totalLines).toBe(1);
      log.addLine('line 2');
      expect(log.totalLines).toBe(2);
      log.addLine('line 3');
      expect(log.totalLines).toBe(3);
    });

    it('retains every line with no ring-buffer cap (unbounded growth)', () => {
      const log = new EventLog();
      const N = 6000; // exceeds the old 5000-line ring buffer
      for (let i = 0; i < N; i++) {
        log.addLine(`entry-${i}`);
      }
      expect(log.totalLines).toBe(N);
      // First and last logical lines are both present (none dropped).
      const all = (log as unknown as { lines: string[] }).lines;
      expect(all.length).toBe(N);
      expect(all[0]).toBe('entry-0');
      expect(all[N - 1]).toBe(`entry-${N - 1}`);
    });
  });

  // ─── lines getter ────────────────────────────────────────────────────

  describe('lines getter', () => {
    it('returns every stored logical line in insertion order, as-is', () => {
      const log = new EventLog();
      log.addLine('alpha');
      log.addLine('beta\nmulti'); // embedded newline is preserved verbatim
      log.addLine('gamma');
      const all = (log as unknown as { lines: string[] }).lines;
      expect(all.length).toBe(log.totalLines);
      expect(all[0]).toBe('alpha');
      expect(all[1]).toBe('beta\nmulti');
      expect(all[2]).toBe('gamma');
    });
  });

  // ─── render: line count & padding ───────────────────────────────────

  describe('render: line count & padding', () => {
    it('always returns exactly maxLines lines', () => {
      const log = new EventLog(5);
      log.addLine('only one line');
      const rendered = log.render(80);
      expect(rendered.length).toBe(5);
      // Content sits at the bottom; top rows are blank padding.
      for (let i = 0; i < 4; i++) {
        expect(rendered[i]).toBe(' '.repeat(80));
      }
      expect(rendered[4].trim()).toBe('only one line');
    });

    it('pads every output row to exactly the requested width', () => {
      const log = new EventLog(3);
      log.addLine('a');
      log.addLine('b');
      log.addLine('c');
      const rendered = log.render(30);
      expect(rendered.length).toBe(3);
      for (const row of rendered) {
        expect(visibleWidth(row)).toBe(30);
      }
    });

    it('returns exactly maxLines when content overflows', () => {
      const log = new EventLog(3);
      log.addLine('line 1');
      log.addLine('line 2');
      log.addLine('line 3');
      log.addLine('line 4');
      log.addLine('line 5');
      const rendered = log.render(80);
      expect(rendered.length).toBe(3);
    });
  });

  // ─── render: WRAPPING (no hard truncation) ──────────────────────────
  //
  // Verification scenario #1: add 3 lines where one is 300 chars at width 40;
  // render(40) and assert the long line is split into multiple rows (no '…'
  // truncation) and total returned lines === maxLines.

  describe('render: line wrapping', () => {
    it('wraps a long line into multiple rows instead of hard-truncating', () => {
      const longLine = 'x'.repeat(300);
      const log = new EventLog(20);
      log.addLine('line 1');
      log.addLine(longLine);
      log.addLine('line 3');

      const rendered = log.render(40);

      // Exactly maxLines rows are returned.
      expect(rendered.length).toBe(20);

      // No ellipsis truncation marker anywhere.
      expect(rendered.some((r) => r.includes('…'))).toBe(false);

      // The 300-char line wraps to ceil(300/40) = 8 rendered rows.
      const expectedWrapCount = wrapTextWithAnsi(longLine, 40).length;
      const xRows = rendered.filter((r) => r.trim().length > 0 && r.trim()[0] === 'x');
      expect(xRows.length).toBe(expectedWrapCount);
      expect(expectedWrapCount).toBeGreaterThan(1);

      // No characters are lost: every 'x' survives across the wrapped rows.
      const totalX = rendered.map(stripAnsi).join('').replace(/[^x]/g, '').length;
      expect(totalX).toBe(300);

      // 'line 1' appears before the wrapped block, 'line 3' after it.
      const firstContentIdx = rendered.findIndex(isContentRow);
      expect(rendered[firstContentIdx].trim()).toBe('line 1');
      expect(rendered[rendered.length - 1].trim()).toBe('line 3');
    });

    it('wraps word-boundary text and keeps each row within width', () => {
      const log = new EventLog(20);
      const sentence = 'the quick brown fox jumps over the lazy dog repeatedly';
      log.addLine(sentence);
      const rendered = log.render(20);
      for (const row of rendered) {
        expect(visibleWidth(row)).toBe(20);
      }
      // The sentence occupies more than one rendered row.
      const contentRows = rendered.filter(isContentRow);
      expect(contentRows.length).toBeGreaterThan(1);
      expect(rendered.some((r) => r.includes('…'))).toBe(false);
    });

    it('uses maxLines rows even when wrapped content exactly fills them', () => {
      // 300 chars @ width 40 => 8 wrapped rows + 2 short lines = 10 rendered.
      const log = new EventLog(10);
      log.addLine('line 1');
      log.addLine('y'.repeat(300));
      log.addLine('line 3');
      const rendered = log.render(40);
      expect(rendered.length).toBe(10);
      expect(rendered.some((r) => r.includes('…'))).toBe(false);
    });
  });

  // ─── render: visible window (last maxLines rendered lines) ──────────

  describe('render: visible window', () => {
    it('shows the newest maxLines rendered lines at the bottom when not scrolled', () => {
      const log = new EventLog(3);
      for (let i = 1; i <= 5; i++) log.addLine(`line ${i}`);
      const rendered = log.render(80);
      expect(rendered.length).toBe(3);
      expect(rendered[0].trim()).toBe('line 3');
      expect(rendered[1].trim()).toBe('line 4');
      expect(rendered[2].trim()).toBe('line 5');
    });

    it('counts wrapped sub-lines towards the visible window', () => {
      // A wrapped logical line consumes multiple viewport rows, so older
      // single-line entries get pushed out of view. Here the 3 wrapped
      // sub-lines of the 'w' line exactly fill the 3-row viewport.
      const log = new EventLog(3);
      log.addLine('A');
      log.addLine('B');
      log.addLine('C');
      log.addLine('w'.repeat(100)); // wraps to 3 rows @ width 40
      const rendered = log.render(40);
      expect(rendered.length).toBe(3);
      // The last 3 rendered rows are the wrapped 'w' sub-lines; A/B/C scrolled off.
      expect(rendered.every((r) => r.trim()[0] === 'w')).toBe(true);
      expect(rendered.some((r) => r.includes('A'))).toBe(false);
      expect(rendered.some((r) => r.includes('B'))).toBe(false);
      expect(rendered.some((r) => r.includes('C'))).toBe(false);
    });
  });

  // ─── Scroll indicator ───────────────────────────────────────────────

  describe('scroll indicator', () => {
    it('prepends a dim indicator as the first row when scrolled up', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80); // populate rendered-line total
      log.handleInput(HOME); // scroll to top
      const rendered = log.render(80);

      expect(rendered.length).toBe(5);
      const indicator = rendered[0];
      // Dim styling.
      expect(indicator).toContain('\x1b[2m');
      // Content + key hints.
      expect(stripAnsi(indicator)).toContain('↑');
      expect(stripAnsi(indicator)).toContain('PgUp');
      expect(stripAnsi(indicator)).toContain('PgDn');
      // Only maxLines-1 content rows below the indicator.
      const contentRows = rendered.slice(1).filter(isContentRow);
      expect(contentRows.length).toBe(4);
    });

    it('reflects the current scrollOffset in the indicator text', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80);
      log.handleInput(HOME);
      // Rendered total = 20, maxLines = 5 => max offset = 15.
      expect(stripAnsi(log.render(80)[0])).toContain('15');
    });

    it('omits the indicator when not scrolled (full content slots used)', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      const rendered = log.render(80);
      expect(rendered[0].trim()).toBe('line 16');
      expect(rendered.some((r) => r.includes('↑'))).toBe(false);
    });
  });

  // ─── handleInput: rendered-line scroll model ────────────────────────

  describe('handleInput (rendered-line scroll units)', () => {
    it('pageUp increases scrollOffset by max(1, maxLines-1), sets autoScroll false', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80); // rendered total = 20

      log.handleInput(PGUP);
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(4);
      expect((log as unknown as { autoScroll: boolean }).autoScroll).toBe(false);
      expect(log.isScrolledUp).toBe(true);
    });

    it('pageUp clamps at the maximum rendered offset', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80);
      // max offset = 20 - 5 = 15; page size = 4 => 4,8,12,15,15,...
      for (let n = 0; n < 10; n++) log.handleInput(PGUP);
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(15);
    });

    it('pageDown decreases scrollOffset and re-enables autoScroll at the bottom', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80);
      log.handleInput(HOME); // offset = 15
      log.handleInput(PGDN); // 15 - 4 = 11
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(11);
      expect((log as unknown as { autoScroll: boolean }).autoScroll).toBe(false);

      // Walk down to 0.
      log.handleInput(PGDN); // 7
      log.handleInput(PGDN); // 3
      log.handleInput(PGDN); // max(0, 3-4) = 0
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(0);
      expect((log as unknown as { autoScroll: boolean }).autoScroll).toBe(true);
      expect(log.isScrolledUp).toBe(false);
    });

    it('home jumps to the top (max rendered offset) and disables autoScroll', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80);
      log.handleInput(HOME);
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(15);
      expect((log as unknown as { autoScroll: boolean }).autoScroll).toBe(false);
    });

    it('end jumps to the bottom (offset 0) and re-enables autoScroll', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80);
      log.handleInput(HOME);
      expect(log.isScrolledUp).toBe(true);
      log.handleInput(END);
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(0);
      expect((log as unknown as { autoScroll: boolean }).autoScroll).toBe(true);
      expect(log.isScrolledUp).toBe(false);
    });

    it('home uses the rendered-line total (wrapped lines count)', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 4; i++) log.addLine(`line ${i}`);
      log.addLine('w'.repeat(100)); // wraps to 3 rows @ width 40 => total 7
      log.render(40);
      log.handleInput(HOME);
      // max offset = 7 - 5 = 2
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(2);
    });

    it('ignores unrelated input without throwing or changing state', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80);
      const before = (log as unknown as { scrollOffset: number }).scrollOffset;
      expect(() => log.handleInput('x')).not.toThrow();
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(before);
      expect(log.isScrolledUp).toBe(false);
    });

    it('does not throw when scrolling before any render has occurred', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      expect(() => log.handleInput(HOME)).not.toThrow();
      expect(() => log.handleInput(PGUP)).not.toThrow();
      expect(() => log.render(80)).not.toThrow();
    });
  });

  // ─── Autoscroll drift fix in addLine ────────────────────────────────
  //
  // Verification scenario #2: scroll up (home) then addLine while autoScroll
  // is false => scrollOffset increases by the wrapped line count and the same
  // content stays pinned.

  describe('autoscroll drift fix', () => {
    it('autoScroll=true keeps scrollOffset at 0 (view sticks to newest)', () => {
      const log = new EventLog(3);
      log.addLine('line 1');
      log.addLine('line 2');
      log.addLine('line 3');
      log.render(80);
      log.addLine('line 4'); // autoScroll still true
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(0);
      const rendered = log.render(80);
      expect(rendered[0].trim()).toBe('line 2');
      expect(rendered[2].trim()).toBe('line 4');
    });

    it('when pinned (autoScroll=false), addLine bumps offset by the wrapped row count and pins content', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 10; i++) log.addLine(`L${i}`);
      log.render(40); // rendered total = 10, cachedWidth = 40
      log.handleInput(HOME); // offset = 10 - 5 = 5

      const before = log.render(40).slice(); // snapshot pinned content
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(5);
      // Pinned window (below the indicator) shows L2..L5.
      expect(before[1].trim()).toBe('L2');
      expect(before[4].trim()).toBe('L5');

      // Add a short line: wraps to 1 row @ width 40.
      log.addLine('NEW');
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(6);

      const after = log.render(40);
      // Same content stays pinned; only the indicator count changed.
      expect(after[1].trim()).toBe('L2');
      expect(after[2].trim()).toBe('L3');
      expect(after[3].trim()).toBe('L4');
      expect(after[4].trim()).toBe('L5');
    });

    it('when pinned, addLine of a long wrapping line bumps offset by its wrapped row count', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 10; i++) log.addLine(`L${i}`);
      log.render(40); // rendered total = 10
      log.handleInput(HOME); // offset = 5
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(5);

      const longLine = 'z'.repeat(100); // wraps to 3 rows @ width 40
      const expectedRows = Math.max(1, wrapTextWithAnsi(longLine, 40).length);
      expect(expectedRows).toBe(3);

      const pinnedBefore = log
        .render(40)
        .slice(1)
        .map((r) => r.trim());

      log.addLine(longLine);

      // Offset grew by exactly the wrapped row count.
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(5 + expectedRows);

      // Pinned content is unchanged.
      const pinnedAfter = log
        .render(40)
        .slice(1)
        .map((r) => r.trim());
      expect(pinnedAfter).toEqual(pinnedBefore);
    });

    it('uses cached width (or 80 fallback) when computing the wrapped row count on add', () => {
      // No prior render => cachedWidth is unset, so width 80 is used.
      const log = new EventLog(5);
      for (let i = 1; i <= 6; i++) log.addLine(`L${i}`);
      log.render(80);
      log.handleInput(HOME); // offset = 6 - 5 = 1

      // A line that wraps to 2 rows at width 80.
      const line = 'word '.repeat(40); // ~200 chars => >1 row at width 80
      const rowsAt80 = Math.max(1, wrapTextWithAnsi(line, 80).length);
      log.addLine(line);
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(1 + rowsAt80);
    });
  });

  // ─── setMaxLines ────────────────────────────────────────────────────

  describe('setMaxLines', () => {
    it('changes the number of returned rows', () => {
      const log = new EventLog(5);
      log.addLine('a');
      log.setMaxLines(3);
      expect(log.render(80).length).toBe(3);
    });

    it('clamps scrollOffset to the rendered-line maximum after a render', () => {
      const log = new EventLog(10);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80); // rendered total = 20
      (log as unknown as { scrollOffset: number }).scrollOffset = 18;
      (log as unknown as { autoScroll: boolean }).autoScroll = false;

      log.setMaxLines(5); // max offset becomes 20 - 5 = 15
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(15);
    });

    it('clamps scrollOffset to 0 when maxLines exceeds the rendered total', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      log.render(80); // rendered total = 20
      (log as unknown as { scrollOffset: number }).scrollOffset = 3;
      (log as unknown as { autoScroll: boolean }).autoScroll = false;

      log.setMaxLines(30); // max(0, 20 - 30) = 0
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(0);
    });

    it('does not set scrollOffset below 0', () => {
      const log = new EventLog(5);
      log.addLine('one line');
      log.render(80);
      log.setMaxLines(10);
      expect((log as unknown as { scrollOffset: number }).scrollOffset).toBe(0);
    });

    it('invalidates the render cache', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 5; i++) log.addLine(`line ${i}`);
      const first = log.render(80);
      log.setMaxLines(5); // same value, but must still invalidate
      const second = log.render(80);
      expect(second).not.toBe(first);
      expect(second).toEqual(first);
    });
  });

  // ─── Caching ────────────────────────────────────────────────────────

  describe('caching', () => {
    it('returns the cached array reference for the same width', () => {
      const log = new EventLog(3);
      log.addLine('a');
      log.addLine('b');
      const first = log.render(40);
      const second = log.render(40);
      expect(first).toBe(second);
    });

    it('re-renders when the width changes', () => {
      const log = new EventLog(3);
      log.addLine('hello world');
      const at40 = log.render(40);
      const at80 = log.render(80);
      expect(at40).not.toBe(at80);
      expect(visibleWidth(at40[2])).toBe(40);
      expect(visibleWidth(at80[2])).toBe(80);
    });

    it('re-renders after addLine (cache invalidated)', () => {
      const log = new EventLog(3);
      log.addLine('a');
      const first = log.render(40);
      log.addLine('b');
      const second = log.render(40);
      expect(second).not.toBe(first);
      expect(second[2].trim()).toBe('b');
    });

    it('re-renders after handleInput (cache invalidated)', () => {
      const log = new EventLog(5);
      for (let i = 1; i <= 20; i++) log.addLine(`line ${i}`);
      const first = log.render(80);
      log.handleInput(HOME);
      const second = log.render(80);
      expect(second).not.toBe(first);
    });
  });

  // ─── invalidate ─────────────────────────────────────────────────────

  describe('invalidate', () => {
    it('forces the next render to recompute (fresh array, equal content)', () => {
      const log = new EventLog(3);
      log.addLine('a');
      const first = log.render(40);
      log.invalidate();
      const second = log.render(40);
      expect(second).not.toBe(first);
      expect(second).toEqual(first);
    });
  });
});
