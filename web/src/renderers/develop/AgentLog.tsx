/**
 * Virtualized AgentLog component.
 *
 * Renders a scrollable, virtualized list of log entries using
 * @tanstack/react-virtual for efficient rendering of large logs.
 *
 * Props:
 *   entries: LogEntry[] — ordered list of log entries to display.
 *
 * Implementation:
 *   1. parentRef = useRef<HTMLDivElement>(null)
 *   2. isNearBottom ref, updated on scroll: true if
 *      scrollTop + clientHeight >= scrollHeight - 100
 *   3. virtualizer = useVirtualizer({
 *        count: entries.length,
 *        getScrollElement: () => parentRef.current,
 *        estimateSize: (idx) => estimateEntryHeight(entries[idx]),
 *        overscan: 5,
 *      })
 *   4. estimateEntryHeight maps entry types to pixel heights:
 *        text=60, thinking=40, tool_call_start/end=24, decision=32, error=32,
 *        default=24
 *   5. Auto-scroll: when entries.length increases and user is near bottom,
 *      scroll to the last entry.
 *   6. Render: outer div (ref=parentRef, class=agent-log, overflow-y:auto),
 *      inner div (height=virtualizer.getTotalSize()px, position:relative),
 *      each virtual item absolutely positioned with transform translateY
 *      and data-index for measurement.
 *
 * Known edge cases:
 *   - Variable-height content may cause scroll jumps if estimates are far off.
 *   - Rapid updates are batched by React.
 *   - Auto-scroll only triggers when user is near bottom to avoid interrupting
 *     manual scroll.
 */

import './AgentLog.css';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef } from 'react';

import type { LogEntry } from '../../types';

interface AgentLogProps {
  entries: LogEntry[];
}

/**
 * Map entry types to estimated pixel heights for the virtualizer.
 *
 * These estimates are used to calculate total scroll height before items
 * are rendered. Actual heights may differ but should average out.
 */
function estimateEntryHeight(entry: LogEntry): number {
  switch (entry.type) {
    case 'text':
      return 60;
    case 'thinking':
      return 40;
    case 'tool_call_start':
    case 'tool_call_end':
      return 24;
    case 'decision':
    case 'error':
      return 32;
    default:
      return 24;
  }
}

/**
 * Render a single log entry with type-specific prefix and styling.
 */
function renderEntryContent(entry: LogEntry): React.ReactNode {
  switch (entry.type) {
    case 'text':
      return entry.content;
    case 'thinking':
      return (
        <>
          <span className="log-entry-prefix">🧠</span>
          {entry.content}
        </>
      );
    case 'tool_call_start':
      return (
        <>
          <span className="log-entry-prefix">🔧</span>
          {entry.content}
        </>
      );
    case 'tool_call_end': {
      const isError = Boolean(entry.metadata && (entry.metadata as Record<string, unknown>).isError);
      return (
        <>
          <span className="log-entry-prefix">{isError ? '❌' : '✅'}</span>
          {entry.content}
        </>
      );
    }
    case 'tool_call':
      return (
        <>
          <span className="log-entry-prefix">🔧</span>
          {entry.content}
        </>
      );
    case 'decision':
      return (
        <>
          <span className="log-entry-prefix">🤝</span>
          {entry.content}
        </>
      );
    case 'error':
      return (
        <>
          <span className="log-entry-prefix">⚠️</span>
          {entry.content}
        </>
      );
    default:
      return entry.content;
  }
}

export function AgentLog({ entries }: AgentLogProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Track whether the user is near the bottom of the scroll container.
  // Initialised to true so that the first auto-scroll (if any) works.
  const isNearBottom = useRef(true);

  // Track previous entries length to detect additions vs. initial mount.
  const prevLength = useRef(entries.length);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (idx) => estimateEntryHeight(entries[idx]),
    overscan: 5,
  });

  // ── Scroll handler: update isNearBottom ──────────────────────────────────
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    isNearBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 100;
  }, []);

  // ── Auto-scroll when new entries are added ───────────────────────────────
  useEffect(() => {
    // Only auto-scroll when the list grows (new entries added).
    if (entries.length > prevLength.current && isNearBottom.current) {
      virtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
    }
    prevLength.current = entries.length;
  }, [entries.length, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} className="agent-log" onScroll={handleScroll}>
      <div
        style={{
          height: totalSize,
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualItem) => {
          const entry = entries[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              className="log-entry"
              data-index={virtualItem.index}
              style={{
                position: 'absolute',
                top: 0,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {renderEntryContent(entry)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
