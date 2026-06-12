import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { cyan, dim, green, red } from '../theme.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentLogEntry {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'decision';
  content: string;
}

export interface AgentData {
  entries: AgentLogEntry[];
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  taskTitle: string;
  profile: string;
  phase?: string;
}

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
  // truncateToWidth with pad=true handles both truncation and padding
  return truncateToWidth(line, width, undefined, true);
};

// ─── AgentLogWidget ──────────────────────────────────────────────────────────

export class AgentLogWidget implements Component {
  private static readonly MAX_CACHED_AGENTS = 100;
  private agents = new Map<string, AgentData>();
  private completedAgentIds = new Set<string>();
  private currentAgentId: string | null = null;
  private maxLines: number;
  private maxEntries = 200;
  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  // ─── Phase data model ────────────────────────────────────────────

  private _currentPhase: string | null = null;
  private _availablePhases: string[] = [];
  private _startedPhases = new Set<string>();
  private _startedPhasesList: string[] = [];
  private _agentsByPhase = new Map<string, string[]>();

  // ─── Expand / collapse / scroll ──────────────────────────────────

  private _expanded = false;
  private _scrollOffset = 0;
  private readonly _expandedLineCount: number = 40;

  /** Track last computed total entry lines count for scroll clamping. */
  private _lastTotalEntryLines = 0;

  constructor(maxLines = 20) {
    this.maxLines = maxLines;
  }

  selectAgent(agentId: string, profile: string): void {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, AgentLogWidget.createAgentData(profile));
      this.evictIfNeeded();
    }
    this.currentAgentId = agentId;
    // Update profile on existing data
    const data = this.agents.get(agentId);
    if (data) {
      data.profile = profile;
      // If _currentPhase is set and the agent data does not have a phase, auto-assign
      if (this._currentPhase && !data.phase) {
        data.phase = this._currentPhase;
        this._addAgentToPhase(agentId, this._currentPhase);
      }
    }
    this.dirty = true;
  }

  clearAgent(): void {
    this.currentAgentId = null;
    this.dirty = true;
  }

  addEntry(entry: AgentLogEntry, agentId?: string): void {
    const targetId = agentId ?? this.currentAgentId;
    if (!targetId) return;
    const data = this.getOrCreateAgent(targetId);
    data.entries.push(entry);
    if (data.entries.length > this.maxEntries) {
      // NOTE: shift() is O(n) but maxEntries (200) is small enough that this
      // is negligible. A circular buffer would add complexity without meaningful
      // benefit at this scale.
      data.entries.shift();
    }
    this.invalidate();
  }

  /**
   * Transfer all data (entries, stats) from one agent to another,
   * then remove the source agent. Used to merge a placeholder agent
   * (e.g. manually spawned with taskId as agentId) into the real
   * lane-based agent when the LanePool takes over.
   */
  transferAgent(fromId: string, toId: string): void {
    const from = this.agents.get(fromId);
    if (!from) return;
    const to = this.getOrCreateAgent(toId);
    // Prepend source entries to destination
    to.entries = [...from.entries, ...to.entries];
    // Accumulate stats
    to.toolCallCount += from.toolCallCount;
    to.inputTokens += from.inputTokens;
    to.outputTokens += from.outputTokens;
    // Keep the title/profile if the destination doesn't have one yet
    if (!to.taskTitle && from.taskTitle) to.taskTitle = from.taskTitle;
    if (!to.profile && from.profile) to.profile = from.profile;
    // Remove source
    this.agents.delete(fromId);
    this.completedAgentIds.delete(fromId);
    // Fix current selection if it was pointing at the source
    if (this.currentAgentId === fromId) {
      this.currentAgentId = toId;
    }
    this.dirty = true;
  }

  private getOrCreateAgent(agentId: string): AgentData {
    let data = this.agents.get(agentId);
    if (!data) {
      data = AgentLogWidget.createAgentData();
      this.agents.set(agentId, data);
      this.evictIfNeeded();
    }
    return data;
  }

  private static createAgentData(profile = '', phase?: string): AgentData {
    return {
      entries: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
      profile,
      phase,
    };
  }

  /** Evict the oldest non-current agent when the cache exceeds the limit. */
  private evictIfNeeded(): void {
    if (this.agents.size <= AgentLogWidget.MAX_CACHED_AGENTS) return;
    for (const [id] of this.agents) {
      if (id !== this.currentAgentId) {
        this.agents.delete(id);
        this.completedAgentIds.delete(id);
        return;
      }
    }
  }

  // ─── Phase data model API ────────────────────────────────────────────

  private _addAgentToPhase(agentId: string, phase: string): void {
    let agents = this._agentsByPhase.get(phase);
    if (!agents) {
      agents = [];
      this._agentsByPhase.set(phase, agents);
    }
    if (!agents.includes(agentId)) {
      agents.push(agentId);
    }
    if (!this._startedPhases.has(phase)) {
      this._startedPhases.add(phase);
      this._startedPhasesList.push(phase);
    }
    this.dirty = true;
  }

  setCurrentPhase(phase: string): void {
    if (phase === this._currentPhase) return;
    this._currentPhase = phase;
    const agents = this._agentsByPhase.get(phase);
    if (agents && agents.length > 0) {
      this.currentAgentId = agents[0];
    }
    this.dirty = true;
  }

  setAvailablePhases(phases: string[]): void {
    this._availablePhases = [...phases];
    const phaseSet = new Set(phases);
    // Remove started phases not in the new set
    for (const phase of this._startedPhasesList) {
      if (!phaseSet.has(phase)) {
        this._startedPhases.delete(phase);
      }
    }
    this._startedPhasesList = this._startedPhasesList.filter((p) => phaseSet.has(p));
    // Remove agentsByPhase entries not in the new set
    for (const phase of this._agentsByPhase.keys()) {
      if (!phaseSet.has(phase)) {
        this._agentsByPhase.delete(phase);
      }
    }
    this.dirty = true;
  }

  addStartedPhase(phase: string): void {
    if (!this._startedPhases.has(phase)) {
      this._startedPhases.add(phase);
      this._startedPhasesList.push(phase);
      this.dirty = true;
    }
  }

  getStartedPhases(): string[] {
    return [...this._startedPhasesList];
  }

  getAvailablePhases(): string[] {
    return [...this._availablePhases];
  }

  getCurrentPhase(): string | null {
    return this._currentPhase;
  }

  getAgentsForPhase(phase: string): string[] {
    return [...(this._agentsByPhase.get(phase) ?? [])];
  }

  selectAgentInPhase(agentId: string, phase: string, profile: string): void {
    const data = this.getOrCreateAgent(agentId);
    this.currentAgentId = agentId;
    data.profile = profile;
    data.phase = phase;
    this._addAgentToPhase(agentId, phase);
    this.dirty = true;
  }

  // ─── Expand/collapse API ──────────────────────────────────────────

  toggleExpand(): void {
    this._expanded = !this._expanded;
    this._scrollOffset = 0;
    this.dirty = true;
  }

  isExpanded(): boolean {
    return this._expanded;
  }

  getExpandedLineCount(): number {
    return this._expanded ? this._expandedLineCount : this.maxLines;
  }

  markAgentComplete(agentId: string): void {
    this.completedAgentIds.add(agentId);
    this.dirty = true;
  }

  getCurrentAgentId(): string | null {
    return this.currentAgentId;
  }

  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  updateStats(
    agentId: string,
    partial: {
      toolCallCount?: number;
      inputTokens?: number;
      outputTokens?: number;
      taskTitle?: string;
      profile?: string;
      phase?: string;
    },
  ): void {
    let data = this.agents.get(agentId);
    if (!data) {
      data = AgentLogWidget.createAgentData();
      this.agents.set(agentId, data);
      this.evictIfNeeded();
    }
    if (partial.toolCallCount !== undefined) {
      data.toolCallCount += partial.toolCallCount;
    }
    if (partial.inputTokens !== undefined) {
      data.inputTokens += partial.inputTokens;
    }
    if (partial.outputTokens !== undefined) {
      data.outputTokens += partial.outputTokens;
    }
    if (partial.taskTitle !== undefined) {
      data.taskTitle = partial.taskTitle;
    }
    if (partial.profile !== undefined) {
      data.profile = partial.profile;
    }
    if (partial.phase !== undefined) {
      data.phase = partial.phase;
      this._addAgentToPhase(agentId, partial.phase);
    }
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const totalLines = this.getExpandedLineCount();

    if (!this.currentAgentId) {
      // No agent selected: header + empty lines
      lines.push(padToWidth(dim('  No agent selected'), width));
      for (let i = 1; i < totalLines; i++) {
        lines.push(padToWidth('', width));
      }
    } else {
      const data = this.agents.get(this.currentAgentId);
      if (!data) {
        // Should not happen since currentAgentId is set only via selectAgent
        for (let i = 0; i < totalLines; i++) {
          lines.push(padToWidth('', width));
        }
        this.cachedLines = lines;
        this.cachedWidth = width;
        this.dirty = false;
        return lines;
      }
      const title = data.taskTitle || data.profile || this.currentAgentId;

      // Header line
      const header = `  ${title} (profile: ${data.profile}) • ${data.toolCallCount} tool calls • ↑${data.inputTokens} • ↓${data.outputTokens}`;
      lines.push(padToWidth(dim(header), width));

      // Compute slot counts based on totalLines
      const visibleCount = totalLines - 1;
      const totalAgents = this.agents.size;
      const hasFooter = totalAgents > 1;
      const entrySlots = hasFooter ? visibleCount - 1 : visibleCount;

      // Build rendered entry lines. When expanded and scrolled, we need
      // to accumulate more lines than entrySlots to support scrolling.
      const accumulationTarget =
        this._expanded && this._scrollOffset > 0 ? entrySlots + this._scrollOffset : entrySlots;

      const renderedLines: string[] = [];
      let totalEntryLineCount = 0;
      for (let ei = data.entries.length - 1; ei >= 0; ei--) {
        const entry = data.entries[ei];
        const icon = typeIconMap[entry.type];
        const colorFn = typeColorMap[entry.type];
        const prefix = `  ${icon} `;
        const prefixLen = visibleWidth(prefix);
        const remainingWidth = Math.max(0, width - prefixLen);

        const subLines = entry.content.split('\n');

        // Count sub-lines in this entry for total tracking
        let thisEntryLineCount = 0;

        const entryRenderedLines: string[] = [];
        for (let si = subLines.length - 1; si >= 0; si--) {
          const wrapped = wrapTextWithAnsi(subLines[si], remainingWidth);
          thisEntryLineCount += wrapped.length;
          // Only build the actual lines if we still need them for display
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

        // Only prepend lines if we built them (still within accumulation target)
        if (entryRenderedLines.length > 0) {
          entryRenderedLines.reverse();
          renderedLines.unshift(...entryRenderedLines);
          if (renderedLines.length > accumulationTarget) {
            renderedLines.splice(0, renderedLines.length - accumulationTarget);
          }
        }
      }

      // Store total entry lines for scroll clamping in handleInput
      this._lastTotalEntryLines = totalEntryLineCount;

      // Apply scroll offset when expanded and scrolled up
      let visibleEntryLines = renderedLines;
      if (this._expanded && this._scrollOffset > 0) {
        // Clamp scroll offset to valid range
        const maxScrollOffset = Math.max(0, renderedLines.length - entrySlots);
        this._scrollOffset = Math.min(this._scrollOffset, maxScrollOffset);

        if (this._scrollOffset >= renderedLines.length) {
          // All entry lines scrolled away – show all empty
          visibleEntryLines = [];
        } else if (this._scrollOffset > 0) {
          // Skip the last _scrollOffset lines (newest at bottom), keep the older ones
          visibleEntryLines = renderedLines.slice(0, renderedLines.length - this._scrollOffset);
        }
      }

      // Add visible entry lines to output
      for (const line of visibleEntryLines) {
        lines.push(line);
      }

      // Pad remaining entry slots so footer ends up at the bottom
      const targetBeforeFooter = hasFooter ? totalLines - 1 : totalLines;
      while (lines.length < targetBeforeFooter) {
        lines.push(padToWidth('', width));
      }

      // Scroll indicator (replaces the first content line after header)
      if (this._expanded && this._scrollOffset > 0 && visibleEntryLines.length > 0 && lines.length > 1) {
        const scrollLine = `  up arrow ${this._scrollOffset} more lines`;
        // Replace the first content line (index 1, right after header)
        lines[1] = padToWidth(dim(scrollLine), width);
      }

      // ─── Footer (only for multi-agent) ───────────────────────────
      if (hasFooter) {
        const agentIds = Array.from(this.agents.keys());
        const currentIdx = agentIds.indexOf(this.currentAgentId);
        const footerParts: string[] = [];

        // Always: agent navigation hint
        footerParts.push(`left/right switch agent (${currentIdx + 1}/${totalAgents})`);

        // Phase navigation hint (if multiple started phases)
        const startedPhases = this.getStartedPhases();
        if (startedPhases.length > 1) {
          const phaseIdx = startedPhases.indexOf(this._currentPhase ?? '');
          const phaseName = this._currentPhase ?? '';
          footerParts.push(`Ctrl+left/right switch phase [${phaseName}] (${phaseIdx + 1}/${startedPhases.length})`);
        }

        // Expand/collapse hints
        if (this._expanded) {
          footerParts.push('up/down scroll, Space collapse');
        } else if (totalAgents > 1) {
          footerParts.push('Space expand');
        }

        const footer = `  ${footerParts.join(' ')}`;
        lines.push(padToWidth(dim(footer), width));
      }
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.dirty = false;
    return lines;
  }

  handleInput(data: string): void {
    // ─── Scroll when expanded ────────────────────────────────────────
    if (this._expanded) {
      if (matchesKey(data, 'up')) {
        // Compute max scroll offset using last known total entry lines
        const visibleCount = this.getExpandedLineCount() - 1;
        const totalAgents = this.agents.size;
        const hasFooter = totalAgents > 1;
        const entrySlots = hasFooter ? visibleCount - 1 : visibleCount;
        const maxScrollOffset = Math.max(0, this._lastTotalEntryLines - entrySlots);
        this._scrollOffset = Math.min(this._scrollOffset + 1, maxScrollOffset);
        this.dirty = true;
        return;
      } else if (matchesKey(data, 'down')) {
        this._scrollOffset = Math.max(0, this._scrollOffset - 1);
        this.dirty = true;
        return;
      }
    }

    // ─── Phase navigation ────────────────────────────────────────────
    if (matchesKey(data, Key.ctrl('left')) || matchesKey(data, Key.ctrl('right'))) {
      const startedPhases = this.getStartedPhases();
      if (startedPhases.length <= 1) return;

      const currentIdx = startedPhases.indexOf(this._currentPhase ?? '');
      let newIdx: number;
      if (matchesKey(data, Key.ctrl('right'))) {
        // Advance to next started phase (wrap from last to first)
        newIdx = currentIdx >= startedPhases.length - 1 ? 0 : currentIdx + 1;
      } else {
        // Go to previous started phase (wrap from first to last)
        newIdx = currentIdx <= 0 ? startedPhases.length - 1 : currentIdx - 1;
      }
      const newPhase = startedPhases[newIdx];
      if (newPhase) {
        this.setCurrentPhase(newPhase);
        this.dirty = true;
      }
      return;
    }

    // ─── Agent navigation (scoped to current phase) ──────────────────
    let agentIds: string[];
    if (this._currentPhase && this._agentsByPhase.has(this._currentPhase)) {
      agentIds = this.getAgentsForPhase(this._currentPhase);
    } else {
      agentIds = this.getAgentIds();
    }

    if (agentIds.length <= 1) return;

    const currentIdx = agentIds.indexOf(this.currentAgentId ?? '');

    if (matchesKey(data, 'left')) {
      const nextIdx = currentIdx <= 0 ? agentIds.length - 1 : currentIdx - 1;
      const nextAgent = agentIds[nextIdx];
      if (nextAgent) {
        this.currentAgentId = nextAgent;
        this.dirty = true;
      }
    } else if (matchesKey(data, 'right')) {
      const nextIdx = currentIdx >= agentIds.length - 1 ? 0 : currentIdx + 1;
      const nextAgent = agentIds[nextIdx];
      if (nextAgent) {
        this.currentAgentId = nextAgent;
        this.dirty = true;
      }
    }
  }
}
