import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { AgentEntity, LogEntry, StepEntity } from '@engin/shared';
import { formatToolCall } from '../format-tool-call.js';
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

// ─── Shared step-cycling helper ──────────────────────────────────────────────

/**
 * Compute the next step index in the given direction, cycling only through
 * steps that have an `agentKey`.  Returns the *unchanged* `currentIndex` when
 * no agent steps exist (so callers can no-op).
 *
 * Used by both AgentLogWidget (collapsed tab bar) and Dashboard (top-level
 * keyboard routing) so the algorithm lives in exactly one place.
 */
export function computeNextAgentStepIndex(
  steps: { agentKey?: string }[],
  currentIndex: number,
  direction: 'forward' | 'backward',
): number {
  const agentStepIndices = steps.map((s, i) => (s.agentKey !== undefined ? i : -1)).filter((i) => i >= 0);

  if (agentStepIndices.length === 0) return currentIndex;

  const currentPos = agentStepIndices.indexOf(currentIndex);
  if (direction === 'forward') {
    const nextPos = (currentPos + 1) % agentStepIndices.length;
    return agentStepIndices[nextPos];
  } else {
    const prevPos = (currentPos - 1 + agentStepIndices.length) % agentStepIndices.length;
    return agentStepIndices[prevPos];
  }
}

// ─── AgentLogWidget ──────────────────────────────────────────────────────────

export class AgentLogWidget implements Component {
  private _agents: AgentEntity[] = [];
  private _steps: StepEntity[] = [];
  private _selectedStepIndex = 0;
  private _activeStepIndex = 0;
  private _userPinnedStep = false;

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

  setAgents(agents: AgentEntity[]): void {
    this._agents = agents;
    this.dirty = true;
  }

  setSteps(steps: StepEntity[]): void {
    this._steps = [...steps];
    if (this._steps.length > 0) {
      // Clamp selectedStepIndex
      if (this._selectedStepIndex >= this._steps.length) {
        this._selectedStepIndex = this._steps.length - 1;
      }
    } else {
      this._selectedStepIndex = 0;
    }
    this.dirty = true;
  }

  setSelectedStepIndex(index: number): void {
    if (index >= -1 && index < this._steps.length) {
      this._selectedStepIndex = index;
      this._scrollOffset = 0;
      this._userPinnedStep = true;
      this.dirty = true;
    }
  }

  setSelectedAgentUid(uid: string | null): void {
    if (uid === null) {
      this._selectedStepIndex = -1;
      this.dirty = true;
      return;
    }
    // Find step whose agentKey matches this uid
    const idx = this._steps.findIndex((s) => s.agentKey === uid);
    if (idx >= 0) {
      this._selectedStepIndex = idx;
      this._scrollOffset = 0;
      this._userPinnedStep = true;
      this.dirty = true;
    }
  }

  setActiveStepIndex(index: number): void {
    this._activeStepIndex = index;
    this.dirty = true;
  }

  toggleExpand(): void {
    this._expanded = !this._expanded;
    this._scrollOffset = 0;
    this._userPinnedStep = false;
    this.dirty = true;
  }

  isExpanded(): boolean {
    return this._expanded;
  }

  getExpandedLineCount(): number {
    return this._expanded ? this._expandedLineCount : this._collapsedLines;
  }

  getSelectedAgentUid(): string | null {
    if (this._selectedStepIndex < 0 || this._selectedStepIndex >= this._steps.length) {
      return null;
    }
    return this._steps[this._selectedStepIndex]?.agentKey ?? null;
  }

  invalidate(): void {
    this.dirty = true;
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  /** Get the agent entity for the selected step, or null if none. */
  private getSelectedAgent(): AgentEntity | null {
    const agentKey = this.getSelectedAgentUid();
    if (!agentKey) return null;
    return this._agents.find((a) => a.uid === agentKey) ?? null;
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
      // ─── No agent for selected step — show dimmed placeholder ─────
      const stepName =
        this._selectedStepIndex >= 0 && this._selectedStepIndex < this._steps.length
          ? this._steps[this._selectedStepIndex].name
          : 'unknown';
      lines.push(padToWidth(dim(`  No agent for step "${stepName}"`), width));
      const entrySlots = this.getEntrySlots();
      for (let i = 0; i < entrySlots; i++) {
        lines.push(padToWidth('', width));
      }
      // Tab bar
      lines.push(this.renderTabBar(width));
    } else {
      // ─── HEADER (line 0) ─────────────────────────────────────
      const title = selectedAgent.taskTitle || selectedAgent.profile || selectedAgent.uid;
      const leftRaw = `  ${title} (profile: ${selectedAgent.profile}) • ${selectedAgent.toolCallCount} tool calls • ↑${selectedAgent.inputTokens} • ↓${selectedAgent.outputTokens}`;

      let controlsRaw: string;
      if (this._expanded) {
        controlsRaw = '↑↓scroll x10⇧↑↓ space collapse';
      } else {
        controlsRaw = 'Tab step space expand';
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

  /** Render the step/agent tab bar (bottom line of the widget). */
  private renderTabBar(width: number): string {
    if (this._steps.length === 0) {
      return padToWidth(dim('  no steps'), width);
    }

    const parts: string[] = [];
    for (let i = 0; i < this._steps.length; i++) {
      const step = this._steps[i];
      const isSelected = i === this._selectedStepIndex;
      const hasAgent = step.agentKey !== undefined;

      // Determine positional marker based on activeStepIndex
      let marker: string;
      if (i < this._activeStepIndex) {
        marker = '✓'; // done
      } else if (i === this._activeStepIndex) {
        marker = '▶'; // active
      } else {
        marker = '○'; // pending
      }

      const label = `${i + 1} ${step.name} ${marker}`;

      let styled: string;
      if (!hasAgent) {
        // Steps without an agentKey are dimmed
        styled = dim(label);
      } else if (isSelected) {
        // Selected step: bold + underline
        styled = bold(underline(label));
      } else {
        styled = label;
      }
      parts.push(styled);
    }

    const tabBar = '  ' + parts.join(' | ');
    return padToWidth(tabBar, width);
  }

  // ─── Input handling ─────────────────────────────────────────────────

  handleInput(data: string): void {
    // ─── Expanded scroll controls ──────────────────────────────
    if (this._expanded) {
      if (matchesKey(data, 'up')) {
        const entrySlots = this.getEntrySlots();
        const maxScrollOffset = Math.max(0, this._lastTotalEntryLines - entrySlots);
        this._scrollOffset = Math.min(this._scrollOffset + 1, maxScrollOffset);
        this._userPinnedStep = true;
        this.dirty = true;
        return;
      }
      if (matchesKey(data, 'down')) {
        this._scrollOffset = Math.max(0, this._scrollOffset - 1);
        this._userPinnedStep = true;
        this.dirty = true;
        return;
      }
      if (matchesKey(data, Key.shift('up'))) {
        const entrySlots = this.getEntrySlots();
        const maxScrollOffset = Math.max(0, this._lastTotalEntryLines - entrySlots);
        this._scrollOffset = Math.min(this._scrollOffset + 10, maxScrollOffset);
        this._userPinnedStep = true;
        this.dirty = true;
        return;
      }
      if (matchesKey(data, Key.shift('down'))) {
        this._scrollOffset = Math.max(0, this._scrollOffset - 10);
        this._userPinnedStep = true;
        this.dirty = true;
        return;
      }
    }

    // ─── Tab/Shift+Tab cycle steps that have agentKey ─────────
    if (matchesKey(data, 'tab') || matchesKey(data, Key.shift('tab'))) {
      const dir = matchesKey(data, 'tab') ? 'forward' : 'backward';
      const nextIndex = computeNextAgentStepIndex(this._steps, this._selectedStepIndex, dir);
      if (nextIndex === this._selectedStepIndex) return; // no agent steps
      this._selectedStepIndex = nextIndex;
      this._scrollOffset = 0;
      this._userPinnedStep = true;
      this.dirty = true;
      return;
    }

    // NOTE: Up/Down when collapsed are NOT handled here (Dashboard routes to TaskListWidget)
    // NOTE: Left/Right are NOT handled here (they go to PhaseBar)
  }
}
