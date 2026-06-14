import { formatToolCall } from '@engin/tui/format-tool-call';
import type { LogEntry } from '../protocol-types';

/**
 * Render a log entry's display text.
 *
 * Tool-call start entries carry structured `arguments` in their metadata; we
 * render a human-readable summary (e.g. `read → ./path`) via the shared
 * `formatToolCall` (imported from the engine, single source of truth). All
 * other entry types fall back to their plain `content`.
 */
export function formatEntryContent(entry: LogEntry): string {
  if (entry.type === 'tool_call_start' || entry.type === 'tool_call') {
    return formatToolCall(
      String(entry.metadata?.toolName ?? entry.content),
      (entry.metadata?.arguments as Record<string, unknown> | undefined) ?? {},
    );
  }
  return entry.content;
}
