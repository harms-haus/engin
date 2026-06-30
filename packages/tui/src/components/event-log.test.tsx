/**
 * Tests for EventLog (Ink-based component).
 *
 * Covers:
 *   - Rendering the last N lines (autoScroll tail-follow)
 *   - PgUp/PgDn scrolling and indicator
 *   - Home/End navigation
 *   - CRITICAL: autoscroll drift fix (C2) — pinned viewport stays stable
 *     when new lines arrive
 *   - New lines auto-scroll to bottom when autoScroll=true
 *   - Line wrapping (handled by Ink's <Text wrap="wrap">)
 */

import { Layer, OverlayHost } from '@harms-haus/ink-overlay';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderWithHost, sendKey, stripAnsi, type RenderResult } from '../test-harness.js';
import { EventLog, type EventLogProps } from './event-log.js';

// ─── Key aliases (mapped via sendKey in test-harness) ─────────────────────────

const PGUP = 'pgUp';
const PGDN = 'pgDn';
const HOME = 'home';
const END = 'end';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Microtask boundary so React / Ink flush pending updates. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Build an array of labelled lines, e.g. makeLines(5) => ['L1', 'L2', …]. */
function makeLines(count: number, prefix = 'L'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

/**
 * Render EventLog inside an OverlayHost, returning a rerender that preserves
 * the host wrapper. Without this, Ink's rerender replaces the entire tree,
 * stripping the OverlayHost that useInputCaptureState requires.
 */
function renderEventLog(props: EventLogProps): RenderResult {
  const result = renderWithHost(<EventLog {...props} />);
  const originalRerender = result.rerender;
  return {
    ...result,
    rerender: (newEl: React.ReactElement) => {
      originalRerender(<OverlayHost>{newEl}</OverlayHost>);
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('EventLog (React/Ink)', () => {
  // ─── Rendering: last N lines (autoScroll tail-follow) ───────────────

  describe('autoScroll tail-follow', () => {
    it('renders the last maxLines lines when autoScroll is true (default)', () => {
      const inputLines = makeLines(10);
      const { lastFrame, unmount } = renderWithHost(<EventLog lines={inputLines} maxLines={5} />);

      const text = stripAnsi(lastFrame() ?? '');
      // The newest 5 lines should be visible (L6–L10)
      expect(text).toContain('L6');
      expect(text).toContain('L7');
      expect(text).toContain('L8');
      expect(text).toContain('L9');
      expect(text).toContain('L10');
      // Older lines L1–L5 should NOT be visible
      const outputLines = text.split('\n');
      expect(outputLines).not.toContain('L1');
      expect(outputLines).not.toContain('L2');
      expect(outputLines).not.toContain('L3');
      expect(outputLines).not.toContain('L4');
      expect(outputLines).not.toContain('L5');
      // No scroll indicator when at bottom
      expect(text).not.toContain('more lines below');

      unmount();
    });

    it('shows all lines when there are fewer than maxLines', () => {
      const lines = makeLines(3);
      const { lastFrame, unmount } = renderWithHost(<EventLog lines={lines} maxLines={10} />);

      const text = stripAnsi(lastFrame() ?? '');
      expect(text).toContain('L1');
      expect(text).toContain('L2');
      expect(text).toContain('L3');
      // No scroll indicator since all content fits
      expect(text).not.toContain('more lines below');

      unmount();
    });

    it('shows nothing when lines are empty', () => {
      const { lastFrame, unmount } = renderWithHost(<EventLog lines={[]} maxLines={5} />);

      const text = stripAnsi(lastFrame() ?? '');
      expect(text).not.toContain('more lines below');
      // Render produces empty output for no lines
      expect(text?.trim() ?? '').toBe('');

      unmount();
    });
  });

  // ─── PgUp scrolls + shows indicator ────────────────────────────────

  describe('PgUp scrolling', () => {
    it('PgUp scrolls up and shows the scroll indicator', async () => {
      const lines = makeLines(20);
      const { lastFrame, stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={5} />);

      // Ensure initial render is flushed
      await tick();

      sendKey(stdin, PGUP);
      await tick();

      const text = stripAnsi(lastFrame() ?? '');
      // Indicator should be visible
      expect(text).toContain('more lines below');
      // After one pageUp (pageSize = 4), topLineIndex goes from 15 to 11
      // visible: lines[11..14] = L12, L13, L14, L15
      expect(text).toContain('L12');
      expect(text).toContain('L13');
      expect(text).toContain('L14');
      expect(text).toContain('L15');
      // L16-L20 should NOT be visible (scrolled up)
      expect(text).not.toContain('L16');
      expect(text).not.toContain('L17');

      unmount();
    });

    it('consecutive PgUp moves further back, clamped at the top', async () => {
      const lines = makeLines(20);
      const { lastFrame, stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={5} />);

      await tick();

      // Send PgUp 10 times (guaranteed to hit top)
      for (let i = 0; i < 10; i++) {
        sendKey(stdin, PGUP);
      }
      await tick();

      const text = stripAnsi(lastFrame() ?? '');
      // At the top: topLineIndex = 0
      // visible: lines[0..3] = L1, L2, L3, L4
      expect(text).toContain('L1');
      expect(text).toContain('L2');
      expect(text).toContain('L3');
      expect(text).toContain('L4');
      // Indicator shows lines below
      expect(text).toContain('more lines below');

      unmount();
    });
  });

  // ─── PgDown scrolls down ───────────────────────────────────────────

  describe('PgDown scrolling', () => {
    it('PgDown scrolls down toward the bottom', async () => {
      const lines = makeLines(20);
      const { lastFrame, stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={5} />);

      await tick();

      // First scroll up 3 times
      for (let i = 0; i < 3; i++) {
        sendKey(stdin, PGUP);
      }
      await tick();

      // After 3 PgUps (pageSize=4): topLineIndex = 15-12 = 3
      // visible: lines[3..6] = L4, L5, L6, L7
      const beforeText = stripAnsi(lastFrame() ?? '');
      expect(beforeText).toContain('L4');
      expect(beforeText).toContain('L5');

      // Now PgDown once: topLineIndex = 3 + 4 = 7
      // visible: lines[7..10] = L8, L9, L10, L11
      sendKey(stdin, PGDN);
      await tick();

      const text = stripAnsi(lastFrame() ?? '');
      expect(text).toContain('L8');
      expect(text).toContain('L9');
      expect(text).toContain('L10');
      expect(text).toContain('L11');
      expect(text).not.toContain('L4');

      unmount();
    });

    it('PgDown re-enables autoScroll when reaching the bottom', async () => {
      const lines = makeLines(10);
      const { lastFrame, stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={3} />);

      await tick();

      // Start at bottom: topLineIndex = 7, showing L8, L9, L10
      // PgUp once: topLineIndex = 7-2=5, showing L6, L7
      sendKey(stdin, PGUP);
      await tick();

      expect(stripAnsi(lastFrame() ?? '')).not.toContain('L10');

      // PgDown: topLineIndex = 5+2=7 (bottom)
      sendKey(stdin, PGDN);
      await tick();

      // Now should be at bottom: showing L8, L9, L10
      const text = stripAnsi(lastFrame() ?? '');
      expect(text).toContain('L8');
      expect(text).toContain('L9');
      expect(text).toContain('L10');
      // Since autoScroll is now true, the indicator should be gone
      expect(text).not.toContain('more lines below');

      unmount();
    });
  });

  // ─── Home pins to top ──────────────────────────────────────────────

  describe('Home navigation', () => {
    it('Home jumps to the top and disables autoScroll', async () => {
      const lines = makeLines(20);
      const { lastFrame, stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={5} />);

      await tick();

      sendKey(stdin, HOME);
      await tick();

      const text = stripAnsi(lastFrame() ?? '');
      // At top: topLineIndex = 0, showing L1..L4 (contentSlots=4 due to indicator)
      expect(text).toContain('L1');
      expect(text).toContain('L2');
      expect(text).toContain('L3');
      expect(text).toContain('L4');
      // Indicator present (autoScroll=false)
      expect(text).toContain('more lines below');
      // Newer lines not visible
      expect(text).not.toContain('L19');
      expect(text).not.toContain('L20');

      unmount();
    });
  });

  // ─── End follows tail ──────────────────────────────────────────────

  describe('End navigation', () => {
    it('End jumps to the bottom and re-enables autoScroll', async () => {
      const lines = makeLines(20);
      const { lastFrame, stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={5} />);

      await tick();

      // First scroll up
      sendKey(stdin, PGUP);
      await tick();

      expect(stripAnsi(lastFrame() ?? '')).toContain('more lines below');

      // Now End to bottom
      sendKey(stdin, END);
      await tick();

      const text = stripAnsi(lastFrame() ?? '');
      // At bottom: showing L16..L20 (contentSlots=5, no indicator)
      expect(text).toContain('L16');
      expect(text).toContain('L17');
      expect(text).toContain('L18');
      expect(text).toContain('L19');
      expect(text).toContain('L20');
      // No indicator
      expect(text).not.toContain('more lines below');

      unmount();
    });
  });

  // ─── CRITICAL: Autoscroll drift fix (C2) ───────────────────────────

  describe('autoscroll drift fix (C2)', () => {
    it('when pinned, adding lines does NOT shift the viewport content', async () => {
      const initialLines = makeLines(8);
      const { lastFrame, rerender, stdin, unmount } = renderEventLog({
        lines: initialLines,
        maxLines: 3,
      });

      await tick();

      // Bottom: topLineIndex = 5, showing L6, L7, L8
      // PgUp once: topLineIndex = 5-2=3, showing L4, L5
      sendKey(stdin, PGUP);
      await tick();

      // Capture the pinned content
      const frameBefore = stripAnsi(lastFrame() ?? '');
      expect(frameBefore).toContain('L4');
      expect(frameBefore).toContain('L5');
      expect(frameBefore).toContain('more lines below');
      expect(frameBefore).not.toContain('L6');

      // Rerender with 3 more lines appended
      rerender(<EventLog lines={[...initialLines, 'L9', 'L10', 'L11']} maxLines={3} />);
      await tick();

      // The pinned content should NOT have shifted:
      // topLineIndex stays at 3, so visible is still L4, L5
      const frameAfter = stripAnsi(lastFrame() ?? '');
      expect(frameAfter).toContain('L4');
      expect(frameAfter).toContain('L5');
      // L8 and newer are still below the viewport
      expect(frameAfter).not.toContain('L8');
      expect(frameAfter).not.toContain('L9');
      expect(frameAfter).not.toContain('L10');
      expect(frameAfter).not.toContain('L11');
      // Indicator count should have increased (more lines below now)
      expect(frameAfter).toContain('more lines below');

      unmount();
    });

    it('when pinned with a wrapping line, the logical viewport stays stable', async () => {
      const lines = [
        'L1',
        'L2',
        'L3',
        'L4',
        'x'.repeat(300), // L5 — long wrapping line
        'L6',
        'L7',
        'L8',
        'L9',
        'L10',
      ];
      const { lastFrame, rerender, stdin, unmount } = renderEventLog({
        lines,
        maxLines: 3,
      });

      await tick();

      // Bottom: topLineIndex = 7, showing L8, L9, L10
      // PgUp once: topLineIndex = 7-2=5, showing L6, L7
      sendKey(stdin, PGUP);
      await tick();

      const frameBefore = stripAnsi(lastFrame() ?? '');
      expect(frameBefore).toContain('L6');
      expect(frameBefore).toContain('L7');
      expect(frameBefore).not.toContain('L8');

      // Append 3 more lines
      rerender(<EventLog lines={[...lines, 'L11', 'L12', 'L13']} maxLines={3} />);
      await tick();

      // Pinned content (L6, L7) should still be visible
      const frameAfter = stripAnsi(lastFrame() ?? '');
      expect(frameAfter).toContain('L6');
      expect(frameAfter).toContain('L7');
      // L8-L13 are below the viewport
      expect(frameAfter).not.toContain('L8');
      expect(frameAfter).not.toContain('L11');
      expect(frameAfter).not.toContain('L13');

      unmount();
    });

    it('autoScroll=true keeps scroll at bottom when lines are appended', async () => {
      const lines = makeLines(5);
      const { lastFrame, rerender, unmount } = renderEventLog({
        lines,
        maxLines: 3,
      });

      await tick();

      // Bottom: topLineIndex = 2, showing L3, L4, L5
      const frameBefore = stripAnsi(lastFrame() ?? '');
      expect(frameBefore).toContain('L3');
      expect(frameBefore).toContain('L4');
      expect(frameBefore).toContain('L5');

      // Append 3 more lines while autoScroll is still true
      rerender(<EventLog lines={[...lines, 'L6', 'L7', 'L8']} maxLines={3} />);
      await tick();

      const text = stripAnsi(lastFrame() ?? '');
      // Now showing the newest 3 lines: L6, L7, L8
      expect(text).toContain('L6');
      expect(text).toContain('L7');
      expect(text).toContain('L8');
      // L3-L5 are scrolled out of view
      expect(text).not.toContain('L3');
      expect(text).not.toContain('L4');
      expect(text).not.toContain('L5');
      // No indicator (at bottom)
      expect(text).not.toContain('more lines below');

      unmount();
    });
  });

  // ─── New lines auto-scroll when autoScroll=true ────────────────────

  describe('autoScroll on new lines', () => {
    it('new lines appear at the bottom when autoScroll is true', async () => {
      const lines = makeLines(5);
      const { lastFrame, rerender, unmount } = renderEventLog({
        lines,
        maxLines: 5,
      });

      await tick();

      // All 5 lines visible
      expect(stripAnsi(lastFrame() ?? '')).toContain('L1');
      expect(stripAnsi(lastFrame() ?? '')).toContain('L5');

      // Append a new line
      rerender(<EventLog lines={[...lines, 'L6']} maxLines={5} />);
      await tick();

      const text = stripAnsi(lastFrame() ?? '');
      // L6 is visible at the bottom; L1 scrolled off
      expect(text).toContain('L6');
      expect(text).not.toContain('L1');

      unmount();
    });

    it('autoScroll can be re-enabled by End after being disabled by PgUp', async () => {
      const lines = makeLines(10);
      const { lastFrame, rerender, stdin, unmount } = renderEventLog({
        lines,
        maxLines: 3,
      });

      await tick();

      // Disable autoScroll by scrolling up
      sendKey(stdin, PGUP);
      await tick();
      expect(stripAnsi(lastFrame() ?? '')).toContain('more lines below');

      // Re-enable with End
      sendKey(stdin, END);
      await tick();

      // Now at bottom: showing L8, L9, L10
      const afterEnd = stripAnsi(lastFrame() ?? '');
      expect(afterEnd).toContain('L8');
      expect(afterEnd).toContain('L9');
      expect(afterEnd).toContain('L10');
      expect(afterEnd).not.toContain('more lines below');

      // Append 2 more lines — autoScroll should keep us at bottom
      rerender(<EventLog lines={[...lines, 'L11', 'L12']} maxLines={3} />);
      await tick();

      const text = stripAnsi(lastFrame() ?? '');
      // New tail is L10, L11, L12
      expect(text).toContain('L10');
      expect(text).toContain('L11');
      expect(text).toContain('L12');
      expect(text).not.toContain('L8');
      expect(text).not.toContain('L9');

      unmount();
    });
  });

  // ─── Rendering: wrapped lines (Ink handles wrapping) ──────────────

  describe('line wrapping (handled by Ink)', () => {
    it('wraps long lines using Ink <Text wrap="wrap">', () => {
      const longLine = 'z'.repeat(300);
      const lines = ['A', longLine, 'B'];
      const { lastFrame, unmount } = renderWithHost(<EventLog lines={lines} maxLines={5} />);

      // The full content should be rendered (no '…' truncation)
      const text = stripAnsi(lastFrame() ?? '');
      // All content present
      expect(text).toContain('A');
      expect(text).toContain('B');
      // The long line's characters are all present (wrapping distributes them)
      const totalZ = (text.match(/z/g) ?? []).length;
      expect(totalZ).toBe(300);
      // No truncation ellipsis
      expect(text).not.toContain('…');

      unmount();
    });

    it('wraps word-boundary text and keeps lines within width', () => {
      const sentence = 'the quick brown fox jumps over the lazy dog repeatedly';
      const { lastFrame, unmount } = renderWithHost(<EventLog lines={[sentence]} maxLines={5} />);

      const text = stripAnsi(lastFrame() ?? '');
      // The sentence is rendered in full
      expect(text).toContain('the quick brown fox jumps over the lazy dog');
      // No hard truncation
      expect(text).not.toContain('…');

      unmount();
    });
  });

  // ─── Key ignored when no match ─────────────────────────────────────

  describe('unmatched keys', () => {
    it('ignores unrelated key presses without error', async () => {
      const lines = makeLines(10);
      const { stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={5} />);

      await tick();

      // Send an unrelated key — should not throw or affect state
      expect(() => {
        sendKey(stdin, 'up'); // up arrow
      }).not.toThrow();

      await tick();
      // Component should still be rendering
      expect(() => {
        sendKey(stdin, 'enter');
      }).not.toThrow();

      await tick();

      unmount();
    });
  });

  // ─── Input capture gating ─────────────────────────────────────────

  describe('input capture gating', () => {
    it('PgUp/PgDn do NOT scroll when a capturing overlay is open', async () => {
      const lines = makeLines(20);
      const { lastFrame, stdin, unmount } = renderWithHost(
        <>
          <Layer open capture>
            {/* Minimal overlay content — Layer registers as capturing */}
          </Layer>
          <EventLog lines={lines} maxLines={5} />
        </>,
      );

      // Need multiple ticks for the capture chain to propagate:
      // 1. Layer.useEffect → registerLayer → host bumpVersion
      // 2. Host re-render → LayerRenderer renders FocusTrap
      // 3. FocusTrap.useEffect → captureEnter → setCaptureDepth(1)
      // 4. InputDispatcher re-render → isCaptured = true
      await tick();
      await tick();
      await tick();
      await tick();

      // Default: at bottom showing L16–L20
      const frameBefore = stripAnsi(lastFrame() ?? '');
      expect(frameBefore).toContain('L16');
      expect(frameBefore).toContain('L17');
      expect(frameBefore).toContain('L18');
      expect(frameBefore).toContain('L19');
      expect(frameBefore).toContain('L20');

      // Try PgUp — should be blocked by the capturing overlay
      sendKey(stdin, PGUP);
      await tick();

      const frameAfter = stripAnsi(lastFrame() ?? '');
      // Viewport should NOT have scrolled (still showing bottom)
      expect(frameAfter).toContain('L16');
      expect(frameAfter).toContain('L20');
      // Older lines that PgUp would reveal should NOT be visible
      expect(frameAfter).not.toContain('L12');
      expect(frameAfter).not.toContain('L13');
      // No scroll indicator (autoScroll still true)
      expect(frameAfter).not.toContain('more lines below');

      unmount();
    });
  });

  // ── j/k vim-style line scrolling ─────────────────────────────────
  describe('j/k scrolling', () => {
    it('k scrolls up one line (older) and shows the indicator', async () => {
      const lines = makeLines(20);
      const { lastFrame, stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={5} />);

      await tick();
      // Tail initially: lines[15..19] = L16..L20
      sendKey(stdin, 'k');
      await tick();

      const text = stripAnsi(lastFrame() ?? '');
      // One line up: topLineIndex 15 → 14, visible lines[14..17] = L15..L18
      expect(text).toContain('L15');
      expect(text).toContain('L18');
      // L19/L20 are now below the viewport (hidden) → indicator shown
      expect(text).toContain('more lines below');
      expect(text).not.toContain('L20');

      unmount();
    });

    it('j scrolls down one line (newer) and re-enables autoScroll at bottom', async () => {
      const lines = makeLines(20);
      const { lastFrame, stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={5} />);

      await tick();
      // Scroll up a few lines first.
      for (let i = 0; i < 3; i++) sendKey(stdin, 'k');
      await tick();
      // topLineIndex 15 → 12, visible L13..L16
      expect(stripAnsi(lastFrame() ?? '')).toContain('more lines below');

      // j back down one line: topLineIndex 12 → 13, visible L14..L17
      sendKey(stdin, 'j');
      await tick();
      const mid = stripAnsi(lastFrame() ?? '');
      expect(mid).toContain('L14');
      expect(mid).toContain('L17');
      // Still scrolled up (not at bottom) → indicator remains
      expect(mid).toContain('more lines below');

      // j all the way back to the bottom re-enables autoScroll (indicator gone)
      for (let i = 0; i < 5; i++) sendKey(stdin, 'j');
      await tick();
      const atBottom = stripAnsi(lastFrame() ?? '');
      expect(atBottom).toContain('L20');
      expect(atBottom).not.toContain('more lines below');

      unmount();
    });

    it('k clamps at the oldest line (top), j clamps at the newest (bottom)', async () => {
      const lines = makeLines(10);
      const { lastFrame, stdin, unmount } = renderWithHost(<EventLog lines={lines} maxLines={3} />);

      await tick();
      // Spam k — clamps at topLineIndex 0 (L1 visible), never negative.
      for (let i = 0; i < 20; i++) sendKey(stdin, 'k');
      await tick();
      const top = stripAnsi(lastFrame() ?? '');
      expect(top).toContain('L1');
      expect(top).toContain('more lines below');

      // Spam j — clamps at bottom, re-enables autoScroll.
      for (let i = 0; i < 20; i++) sendKey(stdin, 'j');
      await tick();
      const bottom = stripAnsi(lastFrame() ?? '');
      expect(bottom).toContain('L10');
      expect(bottom).not.toContain('more lines below');

      unmount();
    });
  });

  // ── bottom-anchoring ───────────────────────────────────────────────
  describe('bottom-anchoring', () => {
    it('packs content to the bottom of the frame when fewer lines than maxLines', () => {
      // 3 lines in a 6-row frame: blank rows must be ABOVE the content so
      // the newest line sits on the bottom row of the frame (not floating at
      // the top with blank space below).
      const lines = ['L1', 'L2', 'L3'];
      const { lastFrame, unmount } = renderWithHost(<EventLog lines={lines} maxLines={6} />);

      const frame = stripAnsi(lastFrame() ?? '');
      const allRows = frame.split('\n');
      // The EventLog occupies the first `maxLines` rows of the terminal.
      const rows = allRows.slice(0, 6);
      expect(rows.length).toBe(6);
      // Leading rows are blank (top padding), trailing rows hold the content
      expect(rows[0].trim()).toBe('');
      expect(rows[1].trim()).toBe('');
      expect(rows[2].trim()).toBe('');
      expect(rows[3]).toContain('L1');
      expect(rows[4]).toContain('L2');
      // Newest (L3) on the BOTTOM row of the frame
      expect(rows[5]).toContain('L3');

      unmount();
    });
  });
});
