import { type Component, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
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
  private static readonly MAX_CACHED_AGENTS = 20;
  private agents = new Map<string, AgentData>();
  private currentAgentId: string | null = null;
  private maxLines: number;
  private maxEntries = 200;
  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  constructor(maxLines = 10) {
    this.maxLines = maxLines;
  }

  selectAgent(agentId: string, profile: string): void {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, {
        entries: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        profile,
      });
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

  private getOrCreateAgent(agentId: string): AgentData {
    let data = this.agents.get(agentId);
    if (!data) {
      data = {
        entries: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        profile: '',
      };
      this.agents.set(agentId, data);
      this.evictIfNeeded();
    }
    return data;
  }

  /** Evict the oldest non-current agent when the cache exceeds the limit. */
  private evictIfNeeded(): void {
    if (this.agents.size <= AgentLogWidget.MAX_CACHED_AGENTS) return;
    for (const [id] of this.agents) {
      if (id !== this.currentAgentId) {
        this.agents.delete(id);
        return;
      }
    }
  }

  getAgentId(): string | null {
    return this.currentAgentId;
  }

  getCurrentAgentId(): string | null {
    return this.currentAgentId;
  }

  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
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
      data = {
        entries: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
        profile: '',
      };
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

      // Render the last (maxLines - 1) entries, newest at bottom
      const visibleCount = this.maxLines - 1;
      // Reserve 1 line for footer if multiple agents
      const totalAgents = this.agents.size;
      const hasFooter = totalAgents > 1;
      const entrySlots = hasFooter ? visibleCount - 1 : visibleCount;
      const startIdx = Math.max(0, data.entries.length - entrySlots);
      const visibleEntries = data.entries.slice(startIdx);

      for (const entry of visibleEntries) {
        const icon = typeIconMap[entry.type];
        const colorFn = typeColorMap[entry.type];
        const prefix = `  ${icon} `;
        const prefixLen = 4; // 2 spaces + emoji (typically 2 columns) — but emoji width varies
        const remainingWidth = Math.max(0, width - prefixLen);
        const truncated = truncateToWidth(entry.content, remainingWidth);
        const raw = `${prefix}${truncated}`;
        const colored = colorFn ? colorFn(raw) : raw;
        lines.push(padToWidth(colored, width));
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
        const footer = `  ← → switch agent (${currentIdx + 1}/${totalAgents})`;
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
