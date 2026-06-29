import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { LogEntry, SessionEntity } from '@engin/shared';
import { formatTokenCount } from '@engin/shared';
import { formatToolCall } from '@engin/shared/format-tool-call';
import { bold, cyan, dim, green, red, underline } from '../theme.js';

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

const typeColorMap: Record<LogEntry['type'], ((s: string) => string) | null> = {
  text: null,
  thinking: dim,
  tool_call: cyan,
  tool_call_start: cyan,
  tool_call_end: green,
  error: red,
  decision: null,
  render: null,
};

// ─── Pad helper ──────────────────────────────────────────────────────────────

const padToWidth = (line: string, width: number): string => {
  return truncateToWidth(line, width, undefined, true);
};

// ─── AgentLogWidget ──────────────────────────────────────────────────────────

export class AgentLogWidget implements Component {
  private _agents: SessionEntity[] = [];

  // Session-based state (B9). The tab bar renders session labels.
  private _sessions: SessionEntity[] = [];
  private _selectedSessionId: string | null = null;
  private _activeSessionId: string | null = null;

  private readonly _collapsedLines: number;
  private _expanded = false;
  private _scrollOffset = 0;
  private readonly _expandedLineCount = 40;

  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private _lastTotalEntryLines = 0;

  constructor(maxLines = 20) {
    this._collapsedLines = maxLines;
  }

  // ─── Public API ──────────────────────────────────────────────────────

  setAgents(agents: SessionEntity[]): void {
    this._agents = agents;
    this.dirty = true;
  }

  // ─── Session API (B9) ──────────────────────────────────────────────

  /** Set the session list (sessions filtered by task) for rendering session tabs. */
  setSessions(sessions: SessionEntity[]): void {
    this._sessions = [...sessions];
    this.dirty = true;
  }

  /** Set the currently selected session by uid. */
  setSelectedSessionId(uid: string | null): void {
    this._selectedSessionId = uid;
    if (!this._expanded) {
      this._scrollOffset = 0;
    }
    this.dirty = true;
  }

  /** Set the active (in-progress) session by uid. */
  setActiveSessionId(uid: string): void {
    this._activeSessionId = uid;
    this.dirty = true;
  }

  /** Get the currently selected session uid. */
  getSelectedSessionId(): string | null {
    return this._selectedSessionId;
  }

  toggleExpand(): void {
    this._expanded = !this._expanded;
    this._scrollOffset = 0;
    this.dirty = true;
  }

  isExpanded(): boolean {
    return this._expanded;
  }

  getExpandedLineCount(): number {
    return this._expanded ? this._expandedLineCount : this._collapsedLines;
  }

  invalidate(): void {
    this.dirty = true;
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  /** Get the session entity for the selected session, or null if none. */
  private getSelectedAgent(): SessionEntity | null {
    const sessionId = this.getSelectedSessionId();
    if (!sessionId) return null;
    return this._agents.find((a) => a.uid === sessionId) ?? null;
  }

  /** Number of entry render lines available (after reserving header + tab bar). */
  private getEntrySlots(): number {
    // totalLines = header (1) + entry slots + tab bar (1)
    return this.getExpandedLineCount() - 2;
  }

  // ─── Render ──────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const totalLines = this.getExpandedLineCount();
    const lines: string[] = [];

    const selectedAgent = this.getSelectedAgent();

    if (!selectedAgent) {
      // ─── No session selected — show dimmed placeholder ─────
      lines.push(padToWidth(dim('  No session selected'), width));
      const entrySlots = this.getEntrySlots();
      for (let i = 0; i < entrySlots; i++) {
        lines.push(padToWidth('', width));
      }
      // Tab bar
      lines.push(this.renderTabBar(width));
    } else {
      // ─── HEADER (line 0) ─────────────────────────────────────
      const title = selectedAgent.taskTitle || selectedAgent.profile || selectedAgent.uid;
      // Cumulative-consumption multiple of the per-request context window.
      // inputTokens + outputTokens are CUMULATIVE totals across all turns, while
      // contextWindow is a per-request model cap, so this is NOT a bounded fill
      // percentage (it can exceed 1×). Rendering as `N×` (rather than `N%`)
      // avoids implying a bounded fill gauge.
      const ctxMultiple = selectedAgent.contextWindow
        ? Math.round(((selectedAgent.inputTokens + selectedAgent.outputTokens) / selectedAgent.contextWindow) * 100) /
          100
        : null;
      let leftRaw = `  ${title} (profile: ${selectedAgent.profile}) • ${selectedAgent.toolCallCount} tool calls • ↑${formatTokenCount(selectedAgent.inputTokens)} • ↓${formatTokenCount(selectedAgent.outputTokens)}`;
      if (ctxMultiple !== null) {
        leftRaw += ` • ctx ${ctxMultiple}×`;
      }

      let controlsRaw: string;
      if (this._expanded) {
        controlsRaw = '↑↓scroll x10⇧↑↓ space collapse';
      } else {
        controlsRaw = 'Tab session space expand';
      }

      // Reserve tail width for controls so a very long title is truncated
      const controlsW = visibleWidth(controlsRaw);
      let leftFinal: string;
      if (visibleWidth(leftRaw) > width - controlsW - 1) {
        const leftMax = Math.max(10, width - controlsW - 2);
        leftFinal = truncateToWidth(leftRaw, leftMax, '…', true);
      } else {
        leftFinal = leftRaw;
      }
      const gap = Math.max(1, width - visibleWidth(leftFinal) - controlsW);
      const header = dim(leftFinal) + ' '.repeat(gap) + dim(controlsRaw);
      lines.push(padToWidth(header, width));

      // ─── ACCUMULATE entry lines (oldest→newest) ────────────────
      const entrySlots = this.getEntrySlots();
      const hasIndicator = this._expanded && this._scrollOffset > 0;
      const contentSlots = hasIndicator ? entrySlots - 1 : entrySlots;
      const renderNeeded = contentSlots + this._scrollOffset + 1;

      const pending: { text: string; prefix: string; colorFn: ((s: string) => string) | null }[] = [];
      let totalEntryLineCount = 0;

      for (const entry of selectedAgent.log) {
        if (entry.type === 'tool_call_end') continue;
        const colorFn = typeColorMap[entry.type];
        const useFormatter = entry.type === 'tool_call_start' || entry.type === 'tool_call';
        const text = useFormatter
          ? formatToolCall(
              String(entry.metadata?.toolName ?? entry.content),
              (entry.metadata?.arguments as Record<string, unknown> | undefined) ?? {},
            )
          : entry.content;
        const prefix = useFormatter ? '  ' : `  ${typeIconMap[entry.type]} `;
        const prefixLen = visibleWidth(prefix);
        const remainingWidth = Math.max(0, width - prefixLen);

        const subLines = text.split('\n');
        for (let si = 0; si < subLines.length; si++) {
          const wrapped = wrapTextWithAnsi(subLines[si], remainingWidth);
          totalEntryLineCount += wrapped.length;
          for (let wi = 0; wi < wrapped.length; wi++) {
            const linePrefix = si === 0 && wi === 0 ? prefix : ' '.repeat(prefixLen);
            pending.push({ text: wrapped[wi], prefix: linePrefix, colorFn });
            if (pending.length > renderNeeded) pending.shift();
          }
        }
      }

      this._lastTotalEntryLines = totalEntryLineCount;

      // Clamp scrollOffset
      const maxScrollOffset = Math.max(0, totalEntryLineCount - entrySlots);
      this._scrollOffset = Math.min(this._scrollOffset, maxScrollOffset);

      const startIdx = Math.max(0, pending.length - contentSlots - this._scrollOffset);

      // Scroll indicator
      if (hasIndicator) {
        const scrollLine = `  up arrow ${this._scrollOffset} more lines`;
        lines.push(padToWidth(dim(scrollLine), width));
      }

      for (let i = startIdx; i < pending.length && i < startIdx + contentSlots; i++) {
        const p = pending[i];
        const raw = `${p.prefix}${p.text}`;
        const colored = p.colorFn ? p.colorFn(raw) : raw;
        lines.push(padToWidth(colored, width));
      }

      // Pad remaining to fill entry area (before tab bar)
      while (lines.length < totalLines - 1) {
        lines.push(padToWidth('', width));
      }

      // ─── TAB BAR (last line) ──────────────────────────────────
      lines.push(this.renderTabBar(width));
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.dirty = false;
    return lines;
  }

  /** Render the session tab bar (bottom line of the widget). */
  private renderTabBar(width: number): string {
    return this.renderSessionTabBar(width);
  }

  // ─── Input handling ─────────────────────────────────────────────────

  handleInput(data: string): void {
    // ─── Expanded scroll controls ──────────────────────────────
    if (this._expanded) {
      if (matchesKey(data, 'up')) {
        const entrySlots = this.getEntrySlots();
        const maxScrollOffset = Math.max(0, this._lastTotalEntryLines - entrySlots);
        this._scrollOffset = Math.min(this._scrollOffset + 1, maxScrollOffset);
        this.dirty = true;
        return;
      }
      if (matchesKey(data, 'down')) {
        this._scrollOffset = Math.max(0, this._scrollOffset - 1);
        this.dirty = true;
        return;
      }
      if (matchesKey(data, Key.shift('up'))) {
        const entrySlots = this.getEntrySlots();
        const maxScrollOffset = Math.max(0, this._lastTotalEntryLines - entrySlots);
        this._scrollOffset = Math.min(this._scrollOffset + 10, maxScrollOffset);
        this.dirty = true;
        return;
      }
      if (matchesKey(data, Key.shift('down'))) {
        this._scrollOffset = Math.max(0, this._scrollOffset - 10);
        this.dirty = true;
        return;
      }
    }

    // ─── Tab/Shift+Tab cycle sessions ───────────────
    if (matchesKey(data, 'tab') || matchesKey(data, Key.shift('tab'))) {
      if (this._sessions.length === 0) return;
      const dir = matchesKey(data, 'tab') ? 1 : -1;
      const idx = this._selectedSessionId ? this._sessions.findIndex((s) => s.uid === this._selectedSessionId) : -1;
      const nextIdx = idx === -1 ? 0 : (idx + dir + this._sessions.length) % this._sessions.length;
      this._selectedSessionId = this._sessions[nextIdx].uid;
      this._scrollOffset = 0;
      this.dirty = true;
      return;
    }

    // NOTE: Up/Down when collapsed are NOT handled here (Dashboard routes to TaskListWidget)
    // NOTE: Left/Right are NOT handled here (they go to PhaseBar)
  }

  /** Render the session tab bar (bottom line of the widget) — B9. */
  private renderSessionTabBar(width: number): string {
    const lead = '  ';
    const sep = ' | ';
    const leadW = visibleWidth(lead);
    const sepW = visibleWidth(sep);

    if (this._sessions.length === 0) {
      return padToWidth(`${lead}${dim('no sessions')}`, width);
    }

    // Build per-session data: visible label width + styled rendering.
    const items = this._sessions.map((session) => {
      const isSelected = session.uid === this._selectedSessionId;
      const label = session.runnerRole ?? session.profile;
      const styled = isSelected ? bold(underline(label)) : label;
      return { styled, labelW: visibleWidth(label), selected: isSelected };
    });

    const n = items.length;
    const fullWidth = leadW + items.reduce((sum, it) => sum + it.labelW, 0) + sepW * (n - 1);

    // Fast path: everything fits, render the full bar.
    if (fullWidth <= width) {
      return padToWidth(lead + items.map((it) => it.styled).join(sep), width);
    }

    // ── Overflow: center the window on the SELECTED session ──────────
    // Sessions are appended oldest→newest (left→right). When the bar
    // overflows we keep a contiguous window centered on the selected
    // session so its bold+underline highlight is ALWAYS visible, and emit
    // dimmed `…+N` / `+N…` indicators showing how many sessions are hidden
    // on each side. If nothing is selected, anchor on the newest (rightmost).
    const selIdx = items.findIndex((it) => it.selected);
    const anchor = selIdx >= 0 ? selIdx : n - 1;

    // Indicator strings (empty when nothing is hidden on that side).
    const leftInd = (lo: number): string => (lo > 0 ? `…+${lo}` : '');
    const rightInd = (hi: number): string => (hi < n - 1 ? `+${n - 1 - hi}…` : '');
    const indW = (ind: string): number => (ind === '' ? 0 : visibleWidth(ind) + sepW);

    // Does the window [lo, hi] (plus indicators) fit within `width`?
    const fits = (lo: number, hi: number): boolean => {
      let w = leadW;
      for (let i = lo; i <= hi; i++) w += items[i].labelW;
      w += sepW * (hi - lo);
      w += indW(leftInd(lo));
      w += indW(rightInd(hi));
      return w <= width;
    };

    // Greedily expand the window outward from the anchor, preferring the
    // side with more hidden sessions so the view stays roughly balanced
    // around the selection (and biases toward showing newer sessions).
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
    const segments: string[] = [];
    const li = leftInd(lo);
    const ri = rightInd(hi);
    if (li !== '') segments.push(dim(li));
    for (let i = lo; i <= hi; i++) segments.push(items[i].styled);
    if (ri !== '') segments.push(dim(ri));

    const tabBar = lead + segments.join(sep);
    // Safety net: if even the anchored session alone is wider than `width`
    // (extremely narrow terminal), truncate rather than overflow the column.
    return padToWidth(truncateToWidth(tabBar, width, undefined, false), width);
  }
}
