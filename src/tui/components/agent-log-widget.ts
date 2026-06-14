import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { AgentRegistry } from '../../tracking/agent-registry.js';
import { type AgentLogEntry, type AgentRecord } from '../../tracking/agent-registry.js';
import { cyan, dim, green, red } from '../theme.js';

// Re-export AgentLogEntry for backward compatibility
export type { AgentLogEntry } from '../../tracking/agent-registry.js';

// ─── Type Icon Map ───────────────────────────────────────────────────────────

const typeIconMap: Record<AgentLogEntry['type'], string> = {
  text: '💬',
  thinking: '🧠',
  tool_call_start: '🔧',
  tool_call_end: '✅',
  error: '⚠️',
  decision: '🤝',
};

const typeColorMap: Record<AgentLogEntry['type'], ((s: string) => string) | null> = {
  text: null,
  thinking: dim,
  tool_call_start: cyan,
  tool_call_end: green,
  error: red,
  decision: null,
};

// ─── Pad helper ──────────────────────────────────────────────────────────────

const padToWidth = (line: string, width: number): string => {
  return truncateToWidth(line, width, undefined, true);
};

// ─── AgentLogWidget ──────────────────────────────────────────────────────────

export class AgentLogWidget implements Component {
  private _registry: AgentRegistry | null = null;
  private _phases: string[] = [];
  private _currentPhaseIndex = -1;
  private _selectedAgentIndex = 0;
  private _userNavigated = false;

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

  setRegistry(registry: AgentRegistry): void {
    this._registry = registry;
    this.dirty = true;
  }

  setCurrentPhase(phase: string): void {
    const idx = this._phases.indexOf(phase);
    if (idx >= 0) {
      this._currentPhaseIndex = idx;
    } else {
      this._phases.push(phase);
      this._currentPhaseIndex = this._phases.length - 1;
    }
    this._selectedAgentIndex = 0;
    this._scrollOffset = 0;
    this._userNavigated = false;
    this.dirty = true;
  }

  setPhases(phases: string[]): void {
    this._phases = [...phases];
    if (this._currentPhaseIndex >= this._phases.length) {
      this._currentPhaseIndex = this._phases.length > 0 ? this._phases.length - 1 : -1;
    }
    // If current phase index is -1 and phases exist, set to first
    if (this._currentPhaseIndex < 0 && this._phases.length > 0) {
      this._currentPhaseIndex = 0;
    }
    this.dirty = true;
  }

  hasPhases(): boolean {
    return this._phases.length > 0;
  }

  getCurrentPhase(): string | null {
    if (this._currentPhaseIndex >= 0 && this._currentPhaseIndex < this._phases.length) {
      return this._phases[this._currentPhaseIndex];
    }
    return null;
  }

  toggleExpand(): void {
    this._expanded = !this._expanded;
    this._scrollOffset = 0;
    this._userNavigated = false;
    this.dirty = true;
  }

  isExpanded(): boolean {
    return this._expanded;
  }

  getExpandedLineCount(): number {
    return this._expanded ? this._expandedLineCount : this._collapsedLines;
  }

  getSelectedAgentUid(): string | null {
    // EFF-3: compute agents once and reuse for both selection + lookup.
    const agents = this.getAgentsInCurrentPhase();
    this.ensureSelection(agents);
    if (agents.length === 0) return null;
    return agents[this._selectedAgentIndex]?.uid ?? null;
  }

  invalidate(): void {
    this.dirty = true;
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  /** Return all agent records in the current phase. */
  private getAgentsInCurrentPhase(): AgentRecord[] {
    if (!this._registry) return [];
    const phase = this.getCurrentPhase();
    if (!phase) return [];
    return this._registry.getAgentsByPhase(phase);
  }

  /** Number of entry render lines available (no footer). */
  private getEntrySlots(): number {
    return this.getExpandedLineCount() - 1;
  }

  /** Clamp selected agent index to valid range, auto-switch if completed. */
  private ensureSelection(agents?: AgentRecord[]): void {
    // EFF-3: accept a precomputed agent list to avoid a duplicate lookup.
    const list = agents ?? this.getAgentsInCurrentPhase();
    if (list.length > 0 && this._selectedAgentIndex >= list.length) {
      this._selectedAgentIndex = 0;
    }
    // Auto-switch away from completed agent if user hasn't manually navigated
    if (!this._userNavigated && list.length > 0) {
      const selected = list[this._selectedAgentIndex];
      if (selected && selected.status === 'completed') {
        const firstActive = list.findIndex((a) => a.status === 'active');
        if (firstActive >= 0) {
          this._selectedAgentIndex = firstActive;
          this.dirty = true;
        }
      }
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    // EFF-3: compute the agent list ONCE and reuse for selection + header.
    const agents = this.getAgentsInCurrentPhase();
    this.ensureSelection(agents);

    const totalLines = this.getExpandedLineCount();
    const lines: string[] = [];

    const selectedAgent =
      agents.length > 0 && this._selectedAgentIndex < agents.length ? agents[this._selectedAgentIndex] : null;

    if (!selectedAgent) {
      // No agent selected in current phase
      lines.push(padToWidth(dim('  No agent selected'), width));
      for (let i = 1; i < totalLines; i++) {
        lines.push(padToWidth('', width));
      }
    } else {
      // ─── HEADER (line 0) ─────────────────────────────────────
      const title = selectedAgent.taskTitle || selectedAgent.profile || selectedAgent.uid;
      const leftRaw = `  ${title} (profile: ${selectedAgent.profile}) • ${selectedAgent.toolCallCount} tool calls • ↑${selectedAgent.inputTokens} • ↓${selectedAgent.outputTokens}`;

      let controlsRaw: string;
      if (this._expanded) {
        controlsRaw = '↑↓scroll x10⇧↑↓ space collapse';
      } else {
        controlsRaw = '↑↓phase ←→agent space expand';
      }

      // N/M agent indicator (1-indexed)
      const indicatorRaw =
        agents.length <= 1 ? '' : `[${Math.min(this._selectedAgentIndex, agents.length - 1) + 1}/${agents.length}] `;

      // FIX H1: reserve tail width for the indicator + controls so a very long
      // title is truncated with an ellipsis on the title side instead of
      // pushing them off the right edge. Only truncate when the title side
      // alone would overflow the line (normal headers stay fully intact).
      const controlsW = visibleWidth(controlsRaw);
      const indicatorW = visibleWidth(indicatorRaw);
      let leftFinal: string;
      if (visibleWidth(leftRaw) > width - indicatorW - 1) {
        const leftMax = Math.max(10, width - controlsW - indicatorW - 2); // -2 for the gap separators
        leftFinal = truncateToWidth(leftRaw, leftMax, '…', true);
      } else {
        leftFinal = leftRaw;
      }
      const gap = Math.max(1, width - visibleWidth(leftFinal) - indicatorW - controlsW);
      // FIX L1: dim the indicator so it matches the otherwise all-dim header.
      const header = dim(leftFinal) + ' '.repeat(gap) + dim(indicatorRaw) + dim(controlsRaw);
      lines.push(padToWidth(header, width));

      // ─── ACCUMULATE entry lines (oldest→newest) ────────────────
      // EFF-2: iterate oldest→newest and push so `pending` is chronological
      // (index 0 = oldest line, newest at the end).
      // EFF-1: wrapTextWithAnsi is called for EVERY entry (required to count
      // _lastTotalEntryLines), but the expensive padToWidth + colorFn +
      // template pass is deferred to the visible window below. We also bound
      // the buffer to the newest `renderNeeded` lines so off-screen tail lines
      // are never stored.
      const entrySlots = this.getEntrySlots(); // totalLines - 1
      const hasIndicator = this._expanded && this._scrollOffset > 0;
      const contentSlots = hasIndicator ? entrySlots - 1 : entrySlots;
      const renderNeeded = contentSlots + this._scrollOffset + 1; // +1 line of slack

      const pending: { text: string; prefix: string; colorFn: ((s: string) => string) | null }[] = [];
      let totalEntryLineCount = 0;

      for (const entry of selectedAgent.entries) {
        const icon = typeIconMap[entry.type];
        const colorFn = typeColorMap[entry.type];
        const prefix = `  ${icon} `;
        const prefixLen = visibleWidth(prefix);
        const remainingWidth = Math.max(0, width - prefixLen);

        const subLines = entry.content.split('\n');
        for (let si = 0; si < subLines.length; si++) {
          const wrapped = wrapTextWithAnsi(subLines[si], remainingWidth);
          totalEntryLineCount += wrapped.length;
          for (let wi = 0; wi < wrapped.length; wi++) {
            const linePrefix = si === 0 && wi === 0 ? prefix : ' '.repeat(prefixLen);
            pending.push({ text: wrapped[wi], prefix: linePrefix, colorFn });
            // Keep only the newest renderNeeded plain lines (drop oldest from front).
            if (pending.length > renderNeeded) pending.shift();
          }
        }
      }

      this._lastTotalEntryLines = totalEntryLineCount;

      // ─── SCROLL / VISIBLE WINDOW ────────────────────────────
      // Clamp scrollOffset (consistent with handleInput's baseline).
      const maxScrollOffset = Math.max(0, totalEntryLineCount - entrySlots);
      this._scrollOffset = Math.min(this._scrollOffset, maxScrollOffset);

      // Newest contentSlots lines, shifted up by scrollOffset.
      const startIdx = Math.max(0, pending.length - contentSlots - this._scrollOffset);

      // ─── ASSEMBLE OUTPUT ────────────────────────────────────
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

      // Pad remaining to totalLines
      while (lines.length < totalLines) {
        lines.push(padToWidth('', width));
      }
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.dirty = false;
    return lines;
  }

  // ─── Input handling ─────────────────────────────────────────────────

  handleInput(data: string): void {
    // ─── Expanded scroll controls ──────────────────────────────
    if (this._expanded) {
      if (matchesKey(data, 'up')) {
        const entrySlots = this.getEntrySlots();
        const maxScrollOffset = Math.max(0, this._lastTotalEntryLines - entrySlots);
        this._scrollOffset = Math.min(this._scrollOffset + 1, maxScrollOffset);
        // FIX M1: scrolling counts as engagement — don't auto-switch away.
        this._userNavigated = true;
        this.dirty = true;
        return;
      }
      if (matchesKey(data, 'down')) {
        this._scrollOffset = Math.max(0, this._scrollOffset - 1);
        // FIX M1: scrolling counts as engagement — don't auto-switch away.
        this._userNavigated = true;
        this.dirty = true;
        return;
      }
      if (matchesKey(data, Key.shift('up'))) {
        const entrySlots = this.getEntrySlots();
        const maxScrollOffset = Math.max(0, this._lastTotalEntryLines - entrySlots);
        this._scrollOffset = Math.min(this._scrollOffset + 10, maxScrollOffset);
        // FIX M1: scrolling counts as engagement — don't auto-switch away.
        this._userNavigated = true;
        this.dirty = true;
        return;
      }
      if (matchesKey(data, Key.shift('down'))) {
        this._scrollOffset = Math.max(0, this._scrollOffset - 10);
        // FIX M1: scrolling counts as engagement — don't auto-switch away.
        this._userNavigated = true;
        this.dirty = true;
        return;
      }
    }

    // ─── Phase cycling (up/down) ──────────────────────────────
    if (matchesKey(data, 'up')) {
      if (this._phases.length === 0) return;
      this._currentPhaseIndex = this._currentPhaseIndex <= 0 ? this._phases.length - 1 : this._currentPhaseIndex - 1;
      this._selectedAgentIndex = 0;
      this._scrollOffset = 0;
      this._userNavigated = false;
      this.dirty = true;
      return;
    }
    if (matchesKey(data, 'down')) {
      if (this._phases.length === 0) return;
      this._currentPhaseIndex = this._currentPhaseIndex >= this._phases.length - 1 ? 0 : this._currentPhaseIndex + 1;
      this._selectedAgentIndex = 0;
      this._scrollOffset = 0;
      this._userNavigated = false;
      this.dirty = true;
      return;
    }

    // ─── Agent cycling (left/right) ───────────────────────────
    const agents = this.getAgentsInCurrentPhase();
    if (agents.length <= 1) return;

    if (matchesKey(data, 'left')) {
      this._selectedAgentIndex = this._selectedAgentIndex <= 0 ? agents.length - 1 : this._selectedAgentIndex - 1;
      this._scrollOffset = 0;
      this._userNavigated = true;
      this.dirty = true;
      return;
    }
    if (matchesKey(data, 'right')) {
      this._selectedAgentIndex = this._selectedAgentIndex >= agents.length - 1 ? 0 : this._selectedAgentIndex + 1;
      this._scrollOffset = 0;
      this._userNavigated = true;
      this.dirty = true;
      return;
    }
  }
}
