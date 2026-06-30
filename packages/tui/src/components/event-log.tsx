/**
 * EventLog — Ink-based event log component.
 *
 * Converts the old pi-tui Component-based EventLog into a proper React/Ink
 * component. The autoscroll drift fix (C2) tracks a LOGICAL LINE INDEX
 * (topLineIndex) as the pin anchor. When autoScroll is false and new lines
 * arrive, topLineIndex stays unchanged so the pinned viewport content does
 * not shift.
 *
 * Input is gated via a simple boolean (isInputActive prop or direct useInput
 * call). In the full TUI tree the parent may wrap this component in an
 * overlay-aware input gate; here we use useInput directly.
 */

import { useInputCaptureState } from '@harms-haus/ink-overlay';
import { Box, Text, useInput, type Key } from 'ink';
import { useCallback, useEffect, useState } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EventLogProps {
  /** Pre-formatted log lines (oldest first, newest last). */
  lines: string[];
  /** Maximum logical lines visible at once (minus one for the scroll indicator when scrolled up). */
  maxLines: number;
}

// ─── EventLog ────────────────────────────────────────────────────────────────

export function EventLog({ lines, maxLines }: EventLogProps) {
  // ── Overlay-aware input gating ─────────────────────────────────────

  const isCaptured = useInputCaptureState();

  // ── State ──────────────────────────────────────────────────────────

  const [autoScroll, setAutoScroll] = useState(true);

  // Logical-line index of the first visible line in the viewport.
  // When autoScroll is true this tracks the tail; when false it is
  // the user-selected pin anchor (stable across line-array growth).
  const [topLineIndex, setTopLineIndex] = useState<number>(() => Math.max(0, lines.length - maxLines));

  // ── Follow tail when autoScroll is active ──────────────────────────
  //
  // Design constraint C2 (autoscroll drift fix): when autoScroll is
  // false, topLineIndex is NOT modified here — it stays stable so the
  // pinned viewport does not shift as new lines arrive.

  useEffect(() => {
    if (autoScroll) {
      const bottom = Math.max(0, lines.length - maxLines);
      setTopLineIndex(bottom);
    }
    // When autoScroll is false, clamp topLineIndex in case lines
    // shrank (e.g., TuiStore cap eviction).
    else {
      setTopLineIndex((prev) => {
        const maxValid = Math.max(0, lines.length - 1);
        return Math.min(prev, maxValid);
      });
    }
    // lines.length and autoScroll are the triggers; topLineIndex is
    // intentionally excluded to avoid a circular update.
  }, [lines.length, autoScroll, maxLines]);

  // ── Input handling ─────────────────────────────────────────────────
  //
  // PgUp:     scroll up (earlier lines), disable autoScroll
  // PgDown:   scroll down (later lines), re-enable autoScroll at bottom
  // Home:     jump to the oldest line, disable autoScroll
  // End:      jump to the newest line, re-enable autoScroll

  const handleInput = useCallback(
    (input: string, key: Key) => {
      const pageSize = Math.max(1, maxLines - 1);

      // j/k — vim-style line scrolling. j = toward newer (down), k = toward
      // older (up). Falls through to the page handlers below for PgUp/PgDn.
      if (input === 'k') {
        setAutoScroll(false);
        setTopLineIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (input === 'j') {
        setTopLineIndex((prev) => {
          const bottom = Math.max(0, lines.length - maxLines);
          const next = Math.min(bottom, prev + 1);
          if (next >= bottom) {
            queueMicrotask(() => setAutoScroll(true));
          }
          return next;
        });
        return;
      }

      if (key.pageUp) {
        setAutoScroll(false);
        setTopLineIndex((prev) => Math.max(0, prev - pageSize));
      } else if (key.pageDown) {
        setTopLineIndex((prev) => {
          const bottom = Math.max(0, lines.length - maxLines);
          const next = Math.min(bottom, prev + pageSize);
          if (next >= bottom) {
            // Schedule autoScroll enable outside the updater so React
            // can batch both state changes into a single render pass.
            queueMicrotask(() => setAutoScroll(true));
          }
          return next;
        });
      } else if (key.home) {
        setAutoScroll(false);
        setTopLineIndex(0);
      } else if (key.end) {
        const bottom = Math.max(0, lines.length - maxLines);
        setAutoScroll(true);
        setTopLineIndex(bottom);
      }
    },
    [lines.length, maxLines],
  );

  useInput(handleInput, { isActive: !isCaptured });

  // ── Compute visible window ─────────────────────────────────────────

  const isScrolledUp = !autoScroll;
  const contentSlots = isScrolledUp ? maxLines - 1 : maxLines;
  const visibleEnd = Math.min(lines.length, topLineIndex + contentSlots);
  const visibleLines = lines.slice(topLineIndex, visibleEnd);
  const linesBelow = lines.length - visibleEnd;

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" height={maxLines} justifyContent="flex-end">
      {isScrolledUp && <Text dimColor>↓ {linesBelow} more lines below (j/k scroll)</Text>}
      {visibleLines.map((line, i) => (
        <Text key={topLineIndex + i} wrap="wrap">
          {line}
        </Text>
      ))}
    </Box>
  );
}
