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
    this.dirty = true;
  }

  isExpanded(): boolean {
    return this._expanded;
  }

  getExpandedLineCount(): number {
    return this._expanded ? this._expandedLineCount : this._collapsedLines;
  }

  getSelectedAgentUid(): string | null {
    const agents = this.getAgentsInCurrentPhase();
    if (agents.length === 0) return null;
    if (this._selectedAgentIndex >= agents.length) {
      this._selectedAgentIndex = 0;
    }
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

  /** Clamp selected agent index to valid range. */
  private ensureSelection(): void {
    const agents = this.getAgentsInCurrentPhase();
    if (agents.length > 0 && this._selectedAgentIndex >= agents.length) {
      this._selectedAgentIndex = 0;
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    this.ensureSelection();

    const totalLines = this.getExpandedLineCount();
    const lines: string[] = [];

    const agents = this.getAgentsInCurrentPhase();
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

      const gap = Math.max(1, width - visibleWidth(leftRaw) - visibleWidth(controlsRaw));
      const header = dim(leftRaw) + ' '.repeat(gap) + dim(controlsRaw);
      lines.push(padToWidth(header, width));

      // ─── ENTRIES (lines 1 to totalLines-1) ───────────────────
      const entrySlots = this.getEntrySlots(); // totalLines - 1
      const accumulationTarget =
        this._expanded && this._scrollOffset > 0 ? entrySlots + this._scrollOffset : entrySlots;

      const renderedLines: string[] = [];
      let totalEntryLineCount = 0;

      for (let ei = selectedAgent.entries.length - 1; ei >= 0; ei--) {
        const entry = selectedAgent.entries[ei];
        const icon = typeIconMap[entry.type];
        const colorFn = typeColorMap[entry.type];
        const prefix = `  ${icon} `;
        const prefixLen = visibleWidth(prefix);
        const remainingWidth = Math.max(0, width - prefixLen);

        const subLines = entry.content.split('\n');
        let thisEntryLineCount = 0;
        const entryRenderedLines: string[] = [];

        for (let si = subLines.length - 1; si >= 0; si--) {
          const wrapped = wrapTextWithAnsi(subLines[si], remainingWidth);
          thisEntryLineCount += wrapped.length;
          if (renderedLines.length < accumulationTarget) {
            for (let wi = wrapped.length - 1; wi >= 0; wi--) {
              const linePrefix = si === 0 && wi === 0 ? prefix : ' '.repeat(prefixLen);
              const raw = `${linePrefix}${wrapped[wi]}`;
              const colored = colorFn ? colorFn(raw) : raw;
              entryRenderedLines.push(padToWidth(colored, width));
            }
          }
        }
        totalEntryLineCount += thisEntryLineCount;

        if (entryRenderedLines.length > 0) {
          entryRenderedLines.reverse();
          renderedLines.unshift(...entryRenderedLines);
          if (renderedLines.length > accumulationTarget) {
            renderedLines.splice(0, renderedLines.length - accumulationTarget);
          }
        }
      }

      this._lastTotalEntryLines = totalEntryLineCount;

      // Apply scroll offset when expanded and scrolled up
      let visibleEntryLines = renderedLines;
      if (this._expanded && this._scrollOffset > 0) {
        const maxScrollOffset = Math.max(0, renderedLines.length - entrySlots);
        this._scrollOffset = Math.min(this._scrollOffset, maxScrollOffset);

        if (this._scrollOffset >= renderedLines.length) {
          visibleEntryLines = [];
        } else if (this._scrollOffset > 0) {
          visibleEntryLines = renderedLines.slice(0, renderedLines.length - this._scrollOffset);
        }
      }

      // Add visible entry lines to output
      for (const line of visibleEntryLines) {
        lines.push(line);
      }

      // Pad remaining entry slots (no footer)
      while (lines.length < totalLines) {
        lines.push(padToWidth('', width));
      }

      // Scroll indicator (replaces first content line after header)
      if (this._expanded && this._scrollOffset > 0 && visibleEntryLines.length > 0 && lines.length > 1) {
        const scrollLine = `  up arrow ${this._scrollOffset} more lines`;
        lines[1] = padToWidth(dim(scrollLine), width);
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

    // ─── Phase cycling (up/down) ──────────────────────────────
    if (matchesKey(data, 'up')) {
      if (this._phases.length === 0) return;
      this._currentPhaseIndex = this._currentPhaseIndex <= 0 ? this._phases.length - 1 : this._currentPhaseIndex - 1;
      this._selectedAgentIndex = 0;
      this._scrollOffset = 0;
      this.dirty = true;
      return;
    }
    if (matchesKey(data, 'down')) {
      if (this._phases.length === 0) return;
      this._currentPhaseIndex = this._currentPhaseIndex >= this._phases.length - 1 ? 0 : this._currentPhaseIndex + 1;
      this._selectedAgentIndex = 0;
      this._scrollOffset = 0;
      this.dirty = true;
      return;
    }

    // ─── Agent cycling (left/right) ───────────────────────────
    const agents = this.getAgentsInCurrentPhase();
    if (agents.length <= 1) return;

    if (matchesKey(data, 'left')) {
      this._selectedAgentIndex = this._selectedAgentIndex <= 0 ? agents.length - 1 : this._selectedAgentIndex - 1;
      this._scrollOffset = 0;
      this.dirty = true;
      return;
    }
    if (matchesKey(data, 'right')) {
      this._selectedAgentIndex = this._selectedAgentIndex >= agents.length - 1 ? 0 : this._selectedAgentIndex + 1;
      this._scrollOffset = 0;
      this.dirty = true;
      return;
    }
  }
}
