/**
 * AgentLog — Ink-based agent log component.
 *
 * Port of the old pi-tui Component-based AgentLogWidget into a proper
 * React/Ink component with the session-based tab bar, expand/collapse,
 * scroll controls, and the renderSessionTabBar overflow windowing
 * algorithm preserved verbatim.
 */

import type { LogEntry, SessionEntity } from '@engin/shared';
import { formatTokenCount } from '@engin/shared';
import { formatToolCall } from '@engin/shared/format-tool-call';
import { useInputCaptureState } from '@harms-haus/ink-overlay';
import { Box, Text, useInput, useStdout } from 'ink';
import { ControlledScrollView } from 'ink-scroll-view';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Re-export LogEntry as AgentLogEntry for backward compatibility
export type { LogEntry as AgentLogEntry } from '@engin/shared';

// ─── Type Icon Map ───────────────────────────────────────────────────────────

const typeIconMap: Record<LogEntry['type'], string> = {
  text: '💬',
  thinking: '🧠',
  tool_call: '🔧',
  tool_call_start: '🔧',
  tool_call_end: '✅',
  error: '⚠️',
  decision: '🤝',
  render: '📋',
};

/**
 * Map log entry types to Ink `<Text>` color prop values.
 * `undefined` means no explicit color.
 * `dimColor` is set for thinking entries.
 */
const typeColorProp: Record<LogEntry['type'], string | undefined> = {
  text: undefined,
  thinking: undefined,
  tool_call: 'cyan',
  tool_call_start: 'cyan',
  tool_call_end: 'green',
  error: 'red',
  decision: undefined,
  render: undefined,
};

const typeDimmed: Record<LogEntry['type'], boolean> = {
  text: false,
  thinking: true,
  tool_call: false,
  tool_call_start: false,
  tool_call_end: false,
  error: false,
  decision: false,
  render: false,
};

// ─── Props ───────────────────────────────────────────────────────────────────

export interface AgentLogProps {
  sessions: SessionEntity[];
  selectedSessionId: string | null;
  expanded: boolean;
  collapsedLines: number;
  expandedLines: number;
}

// ─── RenderLine helper type ──────────────────────────────────────────────────

interface RenderLine {
  text: string;
  color: string | undefined;
  dimColor: boolean;
}

// ─── AgentLog ────────────────────────────────────────────────────────────────

export function AgentLog({
  sessions,
  selectedSessionId,
  expanded,
  collapsedLines,
  expandedLines: expandedLinesProp,
}: AgentLogProps) {
  // ── Overlay-aware input gating ─────────────────────────────────────
  const isCaptured = useInputCaptureState();

  // ── State ──────────────────────────────────────────────────────────
  const [scrollOffset, setScrollOffset] = useState(0);
  const prevSelectedRef = useRef<string | null>(selectedSessionId);

  // Reset scrollOffset when selectedSessionId changes AND not expanded
  // Also reset on expanded toggle
  useEffect(() => {
    if (!expanded) {
      setScrollOffset(0);
    }
  }, [expanded]);

  useEffect(() => {
    if (prevSelectedRef.current !== selectedSessionId) {
      prevSelectedRef.current = selectedSessionId;
      if (!expanded) {
        setScrollOffset(0);
      }
    }
  }, [selectedSessionId, expanded]);

  // ── Derived values ─────────────────────────────────────────────────

  const totalLines = expanded ? expandedLinesProp : collapsedLines;
  const entrySlots = totalLines - 2; // header + tab bar

  const selectedSession = useMemo(
    () => sessions.find((s) => s.uid === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  // ── Build all entry render lines ───────────────────────────────────

  const allEntryLines = useMemo(() => {
    const lines: RenderLine[] = [];

    if (!selectedSession) return lines;

    for (const entry of selectedSession.log) {
      if (entry.type === 'tool_call_end') continue;

      const color = typeColorProp[entry.type];
      const dimColor = typeDimmed[entry.type];
      const useFormatter = entry.type === 'tool_call_start' || entry.type === 'tool_call';
      const text = useFormatter
        ? formatToolCall(
            String(entry.metadata?.toolName ?? entry.content),
            (entry.metadata?.arguments as Record<string, unknown> | undefined) ?? {},
          )
        : entry.content;
      const icon = useFormatter ? '' : `${typeIconMap[entry.type]} `;
      const prefix = `  ${icon}`;

      // Split by newlines, each sub-line is a separate render line
      const subLines = text.split('\n');
      for (let si = 0; si < subLines.length; si++) {
        const linePrefix = si === 0 ? prefix : '    ';
        lines.push({ text: `${linePrefix}${subLines[si]}`, color, dimColor });
      }
    }

    return lines;
    // ── Memo key (performance, H5) ───────────────────────────────
    // Session objects get a new reference on every high-frequency update tick.
    // Keying on `selectedSession` (the object) would force a full O(n) rebuild
    // (iterating every entry, calling formatToolCall, splitting by \n) on every
    // tick. Instead, key on a cheaper stable signal: the session uid + the log
    // array length + the last entry's id.
    //
    // Assumption: session.log is APPEND-ONLY in this projection — entries are
    // never edited or reordered, only appended. Under that assumption:
    //   - A pure append changes log.length and the last entry's id, triggering
    //     exactly one rebuild (which is correct — there's a new entry to render).
    //   - A reference-only change (same uid, same length, same last id) reuses
    //     the memoized lines array, skipping the full O(n) rebuild.
    //   - If an existing entry were ever edited in place, its id would change,
    //     forcing a rebuild — so this remains correct if that assumption is
    //     later relaxed.
  }, [selectedSession?.uid, selectedSession?.log.length, selectedSession?.log.at(-1)?.id]);

  const totalEntryLineCount = allEntryLines.length;

  // Scroll indicator: derived from the RAW scrollOffset (not clamped) so the
  // decision is independent of contentSlots, breaking the circular dependency
  // between showScrollIndicator → contentSlots → maxScrollOffset → clamp.
  // If the user has scrolled up at all, the indicator shows and takes 1 slot.
  const showScrollIndicator = expanded && scrollOffset > 0;
  const contentSlots = showScrollIndicator ? entrySlots - 1 : entrySlots;

  // Clamp scrollOffset — maxScrollOffset uses the ADJUSTED contentSlots (L4
  // off-by-one fix) so the oldest entry is reachable even when the indicator
  // is visible (occupying one of the entrySlots).
  const maxScrollOffset = Math.max(0, totalEntryLineCount - contentSlots);
  const clampedScrollOffset = Math.min(scrollOffset, maxScrollOffset);

  // Visible window
  // scrollOffset convention: 0 = at bottom (newest), positive = scrolled up
  const windowStart = Math.max(0, totalEntryLineCount - contentSlots - clampedScrollOffset);
  const visibleLines = allEntryLines.slice(windowStart, windowStart + contentSlots);

  // ── Scroll offset helpers ──────────────────────────────────────────

  const scrollUp = useCallback(
    (amount: number) => {
      setScrollOffset((prev) => {
        const newOffset = prev + amount;
        return Math.min(newOffset, maxScrollOffset);
      });
    },
    [maxScrollOffset],
  );

  const scrollDown = useCallback((amount: number) => {
    setScrollOffset((prev) => Math.max(0, prev - amount));
  }, []);

  // ── Input handling ─────────────────────────────────────────────────
  //
  // Only active when expanded and not captured by an overlay.

  const isInputActive = !isCaptured && expanded;

  useInput(
    (input: string, key: Record<string, boolean | undefined>) => {
      if (key.shift && key.upArrow) {
        scrollUp(10);
      } else if (key.shift && key.downArrow) {
        scrollDown(10);
      } else if (key.upArrow) {
        scrollUp(1);
      } else if (key.downArrow) {
        scrollDown(1);
      }
    },
    { isActive: isInputActive },
  );

  // ── No session selected ────────────────────────────────────────────

  if (!selectedSession) {
    return (
      <Box flexDirection="column" height={totalLines}>
        <Text dimColor> No session selected</Text>
        {Array.from({ length: entrySlots }, (_, i) => (
          <Box key={i} height={1} />
        ))}
        <SessionTabBar sessions={sessions} selectedSessionId={selectedSessionId} />
      </Box>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" height={totalLines}>
      {/* ─── HEADER ──────────────────────────────────────────────── */}
      <AgentLogHeader session={selectedSession} expanded={expanded} />

      {/* ─── ENTRIES ──────────────────────────────────────────────── */}
      {showScrollIndicator && <Text dimColor> ↓ {clampedScrollOffset} more lines below (↑/↓ scroll)</Text>}
      <Box height={contentSlots} flexDirection="column">
        <ControlledScrollView scrollOffset={0}>
          {visibleLines.map((line, i) => (
            <Text key={windowStart + i} wrap="wrap" color={line.color} dimColor={line.dimColor}>
              {line.text}
            </Text>
          ))}
        </ControlledScrollView>
      </Box>

      {/* ─── TAB BAR ──────────────────────────────────────────────── */}
      <SessionTabBar sessions={sessions} selectedSessionId={selectedSessionId} />
    </Box>
  );
}

// ─── AgentLogHeader ─────────────────────────────────────────────────────────

function AgentLogHeader({ session, expanded }: { session: SessionEntity; expanded: boolean }) {
  const title = session.taskTitle || session.profile || session.uid;

  // Cumulative-consumption multiple
  const ctxMultiple = session.contextWindow
    ? Math.round(((session.inputTokens + session.outputTokens) / session.contextWindow) * 100) / 100
    : null;

  let leftRaw = `  ${title} (profile: ${session.profile}) • ${session.toolCallCount} tool calls • ↑${formatTokenCount(session.inputTokens)} • ↓${formatTokenCount(session.outputTokens)}`;
  if (ctxMultiple !== null) {
    leftRaw += ` • ctx ${ctxMultiple}×`;
  }

  const controlsRaw = expanded ? '\u2191\u2193scroll x10\u21e7\u2191\u2193 space collapse' : 'Tab session space expand';

  // Use space-between layout so controls stay on the right.
  // The left side uses wrap="truncate-end" to avoid pushing controls off-screen.
  return (
    <Box flexDirection="row" justifyContent="space-between" minHeight={1}>
      <Text dimColor wrap="truncate-end">
        {leftRaw}
      </Text>
      <Text dimColor>{controlsRaw}</Text>
    </Box>
  );
}

// ─── SessionTabBar ──────────────────────────────────────────────────────────
//
// Ported from the old AgentLogWidget.renderSessionTabBar algorithm.
// The overflow windowing logic is preserved: greedy centered window on the
// selected session with dimmed …+N / +N… indicators.

export const SessionTabBar = memo(function SessionTabBar({
  sessions,
  selectedSessionId,
  width,
}: {
  sessions: SessionEntity[];
  selectedSessionId: string | null;
  /** Optional explicit width. Defaults to stdout.columns (terminal width). */
  width?: number;
}) {
  const { stdout } = useStdout();
  const effectiveWidth = width ?? stdout.columns ?? 100;

  const lead = '  ';
  const sep = ' | ';
  const leadW = visibleWidth(lead);
  const sepW = visibleWidth(sep);

  if (sessions.length === 0) {
    return <Text dimColor>{lead}no sessions</Text>;
  }

  // Build per-session data
  const items = sessions.map((session) => {
    const isSelected = session.uid === selectedSessionId;
    const label = session.runnerRole ?? session.profile;
    const labelW = visibleWidth(label);
    return { label, labelW, isSelected, uid: session.uid };
  });

  const n = items.length;
  const fullWidth = leadW + items.reduce((sum, it) => sum + it.labelW, 0) + sepW * (n - 1);

  // Fast path: everything fits, render the full bar.
  if (fullWidth <= effectiveWidth) {
    return (
      <Box>
        <Text dimColor>{lead}</Text>
        {items.map((it, i) => (
          <React.Fragment key={it.uid}>
            {i > 0 && <Text dimColor>{sep}</Text>}
            {it.isSelected ? (
              <Text bold underline>
                {it.label}
              </Text>
            ) : (
              <Text>{it.label}</Text>
            )}
          </React.Fragment>
        ))}
      </Box>
    );
  }

  // ── Overflow: center the window on the SELECTED session ──────────
  const selIdx = items.findIndex((it) => it.isSelected);
  const anchor = selIdx >= 0 ? selIdx : n - 1;

  const leftInd = (lo: number): string => (lo > 0 ? `\u2026+${lo}` : '');
  const rightInd = (hi: number): string => (hi < n - 1 ? `+${n - 1 - hi}\u2026` : '');
  const indW = (ind: string): number => (ind === '' ? 0 : visibleWidth(ind) + sepW);

  const fits = (lo: number, hi: number): boolean => {
    let w = leadW;
    for (let i = lo; i <= hi; i++) w += items[i].labelW;
    w += sepW * (hi - lo);
    w += indW(leftInd(lo));
    w += indW(rightInd(hi));
    return w <= effectiveWidth;
  };

  let lo = anchor;
  let hi = anchor;
  for (;;) {
    let expanded = false;
    const leftHidden = lo;
    const rightHidden = n - 1 - hi;
    const tryRight = rightHidden >= leftHidden;
    const expandRight = (): boolean => (hi + 1 < n && fits(lo, hi + 1) ? ((hi += 1), true) : false);
    const expandLeft = (): boolean => (lo - 1 >= 0 && fits(lo - 1, hi) ? ((lo -= 1), true) : false);
    const order: (() => boolean)[] = tryRight ? [expandRight, expandLeft] : [expandLeft, expandRight];
    for (const attempt of order) {
      if (attempt()) {
        expanded = true;
        break;
      }
    }
    if (!expanded) break;
  }

  // Assemble the final bar from the computed window.
  const segmentNodes: React.ReactNode[] = [];

  const li = leftInd(lo);
  const ri = rightInd(hi);

  if (li !== '') {
    segmentNodes.push(
      <Text key="li" dimColor>
        {li}
      </Text>,
    );
  }

  for (let i = lo; i <= hi; i++) {
    const it = items[i];
    segmentNodes.push(
      it.isSelected ? (
        <Text key={it.uid} bold underline>
          {it.label}
        </Text>
      ) : (
        <Text key={it.uid}>{it.label}</Text>
      ),
    );
  }

  if (ri !== '') {
    segmentNodes.push(
      <Text key="ri" dimColor>
        {ri}
      </Text>,
    );
  }

  // Interleave separators
  const rendered: React.ReactNode[] = [];
  for (let i = 0; i < segmentNodes.length; i++) {
    if (i > 0) {
      rendered.push(
        <Text key={`s-${i}`} dimColor>
          {sep}
        </Text>,
      );
    }
    rendered.push(segmentNodes[i]);
  }

  return (
    <Box>
      <Text dimColor>{lead}</Text>
      {rendered}
    </Box>
  );
});

// ─── visibleWidth helper (ported from pi-tui, simplified for emoji) ──────────

/**
 * Compute the visible display width of a string.
 * Accounts for wide characters (CJK, emoji) that occupy 2 columns.
 */
export function visibleWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK / wide character ranges
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x2e99) ||
      (cp >= 0x2e9b && cp <= 0x2ef3) ||
      (cp >= 0x2f00 && cp <= 0x2fd5) ||
      (cp >= 0x2ff0 && cp <= 0x2fff) ||
      (cp >= 0x3000 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x3096) ||
      (cp >= 0x3099 && cp <= 0x30ff) ||
      (cp >= 0x3105 && cp <= 0x312d) ||
      (cp >= 0x3131 && cp <= 0x318e) ||
      (cp >= 0x3190 && cp <= 0x31ba) ||
      (cp >= 0x31c0 && cp <= 0x31e3) ||
      (cp >= 0x31f0 && cp <= 0x321e) ||
      (cp >= 0x3220 && cp <= 0x3247) ||
      (cp >= 0x3250 && cp <= 0x32fe) ||
      (cp >= 0x3300 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa48c) ||
      (cp >= 0xa490 && cp <= 0xa4c6) ||
      (cp >= 0xa960 && cp <= 0xa97c) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xd7b0 && cp <= 0xd7c6) ||
      (cp >= 0xd7cb && cp <= 0xd7fb) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6b) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1b000 && cp <= 0x1b0ff) ||
      (cp >= 0x1b100 && cp <= 0x1b12f) ||
      // Emoji ranges — every clause MUST have an upper bound so no open-ended
      // match swallows later codepoints (e.g. 0x1fa00+, which is width-1 here).
      (cp >= 0x1f004 && cp <= 0x1f004) ||
      (cp >= 0x1f0cf && cp <= 0x1f0ff) ||
      (cp >= 0x1f18e && cp <= 0x1f18e) ||
      (cp >= 0x1f191 && cp <= 0x1f251) ||
      (cp >= 0x1f300 && cp <= 0x1f5ff) ||
      (cp >= 0x1f600 && cp <= 0x1f64f) ||
      (cp >= 0x1f680 && cp <= 0x1f6ff) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x1fa70 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd)
    ) {
      width += 2;
    } else if (cp >= 0x20 && cp <= 0x7e) {
      width += 1;
    } else if (cp >= 0xa0) {
      width += 1;
    }
    // control chars (< 0x20) are ignored
  }
  return width;
}
