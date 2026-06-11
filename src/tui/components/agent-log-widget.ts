import { type Component, truncateToWidth } from '@earendil-works/pi-tui';
import { cyan, dim, green, red } from '../theme.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentLogEntry {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'decision';
  content: string;
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
  private agentId: string | null = null;
  private agentProfile = '';
  private entries: AgentLogEntry[] = [];
  private maxLines: number;
  private maxEntries = 200;
  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  constructor(maxLines = 5) {
    this.maxLines = maxLines;
  }

  selectAgent(agentId: string, profile: string): void {
    this.agentId = agentId;
    this.agentProfile = profile;
    this.entries = [];
    this.dirty = true;
  }

  clearAgent(): void {
    this.agentId = null;
    this.dirty = true;
  }

  addEntry(entry: AgentLogEntry): void {
    if (this.agentId === null) return;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.dirty = true;
  }

  getAgentId(): string | null {
    return this.agentId;
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    if (!this.agentId) {
      // No agent selected: header + empty lines
      lines.push(padToWidth(dim('  No agent selected'), width));
      for (let i = 1; i < this.maxLines; i++) {
        lines.push(padToWidth('', width));
      }
    } else {
      // Header line
      lines.push(padToWidth(dim(`  Agent: ${this.agentProfile}`), width));

      // Render the last (maxLines - 1) entries, newest at bottom
      const visibleCount = this.maxLines - 1;
      const startIdx = Math.max(0, this.entries.length - visibleCount);
      const visibleEntries = this.entries.slice(startIdx);

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

      // Pad remaining lines if fewer entries than visible slots
      while (lines.length < this.maxLines) {
        lines.push(padToWidth('', width));
      }
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.dirty = false;
    return lines;
  }
}
