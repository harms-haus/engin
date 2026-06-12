import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
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

  private static createAgentData(profile = ''): AgentData {
    return {
      entries: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
      profile,
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

    if (!this.currentAgentId) {
      // No agent selected: header + empty lines
      lines.push(padToWidth(dim('  No agent selected'), width));
      for (let i = 1; i < this.maxLines; i++) {
        lines.push(padToWidth('', width));
      }
    } else {
      const data = this.agents.get(this.currentAgentId);
      if (!data) {
        // Should not happen since currentAgentId is set only via selectAgent
        for (let i = 0; i < this.maxLines; i++) {
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

      // Render all entries into actual terminal lines (splitting on \n)
      const visibleCount = this.maxLines - 1;
      // Reserve 1 line for footer if multiple agents
      const totalAgents = this.agents.size;
      const hasFooter = totalAgents > 1;
      const entrySlots = hasFooter ? visibleCount - 1 : visibleCount;

      // Reverse iteration: process entries from newest to oldest, stopping
      // once enough visible lines are accumulated. This avoids processing all
      // entries when only the last few are visible.
      const renderedLines: string[] = [];
      for (let ei = data.entries.length - 1; ei >= 0 && renderedLines.length < entrySlots; ei--) {
        const entry = data.entries[ei];
        const icon = typeIconMap[entry.type];
        const colorFn = typeColorMap[entry.type];
        const prefix = `  ${icon} `;
        const prefixLen = visibleWidth(prefix);
        const remainingWidth = Math.max(0, width - prefixLen);

        const subLines = entry.content.split('\n');

        // Process sub-lines in reverse to fill from bottom
        const entryRenderedLines: string[] = [];
        for (let si = subLines.length - 1; si >= 0; si--) {
          const wrapped = wrapTextWithAnsi(subLines[si], remainingWidth);
          // Process wrapped lines in reverse
          for (let wi = wrapped.length - 1; wi >= 0; wi--) {
            const linePrefix = si === 0 && wi === 0 ? prefix : ' '.repeat(prefixLen);
            const raw = `${linePrefix}${wrapped[wi]}`;
            const colored = colorFn ? colorFn(raw) : raw;
            entryRenderedLines.push(padToWidth(colored, width));
          }
        }
        // Reverse the entry's lines to get correct order, then prepend
        entryRenderedLines.reverse();
        renderedLines.unshift(...entryRenderedLines);
        // Trim if we collected more than needed
        if (renderedLines.length > entrySlots) {
          renderedLines.splice(0, renderedLines.length - entrySlots);
        }
      }

      for (const line of renderedLines) {
        lines.push(line);
      }

      // Pad remaining entry slots so footer ends up at the bottom
      const targetBeforeFooter = hasFooter ? this.maxLines - 1 : this.maxLines;
      while (lines.length < targetBeforeFooter) {
        lines.push(padToWidth('', width));
      }

      // Footer for multi-agent navigation (always at the bottom)
      if (hasFooter) {
        const agentIds = Array.from(this.agents.keys());
        const currentIdx = agentIds.indexOf(this.currentAgentId);
        const completedCount = this.completedAgentIds.size;
        const activeCount = totalAgents - completedCount;
        let footer: string;
        if (completedCount > 0) {
          footer = `  ← → switch agent (${currentIdx + 1}/${totalAgents}) • ${activeCount} active, ${completedCount} done`;
        } else {
          footer = `  ← → switch agent (${currentIdx + 1}/${totalAgents})`;
        }
        lines.push(padToWidth(dim(footer), width));
      }
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.dirty = false;
    return lines;
  }

  handleInput(data: string): void {
    const agentIds = this.getAgentIds();
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
