import { formatToolCall } from '@engin/shared/format-tool-call';
import type { LogEntry } from '../protocol-types';

/**
 * Entry types hidden from the visible log. They remain in the underlying
 * projection/event store (useful for later analysis) but are not painted.
 *
 *  - tool_call_end: redundant — the tool_call_start entry already shows the
 *    call; the end marker only clutters the log.
 */
const HIDDEN_LOG_TYPES: ReadonlySet<LogEntry['type']> = new Set<LogEntry['type']>(['tool_call_end']);

export function shouldRenderEntry(entry: LogEntry): boolean {
  return !HIDDEN_LOG_TYPES.has(entry.type);
}

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
