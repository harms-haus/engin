import { useEffect, useRef, useState } from 'react';
import { useHasSnapshot, useRecentLogEntries } from '../store/workflow-store';
import { formatEntryContent } from '../utils/format-entry';
import './EventLog.css';

function entryClass(type: string): string {
  switch (type) {
    case 'thinking':
      return 'event-log__entry event-log__entry--thinking';
    case 'tool_call':
    case 'tool_call_start':
    case 'tool_call_end':
      return 'event-log__entry event-log__entry--tool';
    case 'decision':
      return 'event-log__entry event-log__entry--decision';
    case 'error':
      return 'event-log__entry event-log__entry--error';
    default:
      return 'event-log__entry';
  }
}

/** Non-color redundancy: text prefix for visually distinct entry types. */
function entryPrefix(type: string): string {
  switch (type) {
    case 'tool_call':
    case 'tool_call_start':
      return '[TOOL] ';
    case 'tool_call_end':
      return '[TOOL ✓] ';
    case 'decision':
      return '[DECISION] ';
    case 'error':
      return '[ERROR] ';
    case 'thinking':
      return '[THINKING] ';
    default:
      return '';
  }
}

export function EventLog() {
  const entries = useRecentLogEntries(100);
  const hasSnapshot = useHasSnapshot();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 30;
      setAutoScroll(isNearBottom);
    }
  };

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [autoScroll, entries]);

  return (
    <div className="event-log" ref={scrollRef} onScroll={handleScroll}>
      {entries.length === 0 ? (
        <div className="event-log__entry event-log__entry--empty">
          {hasSnapshot ? 'Waiting for activity…' : 'Connecting to workflow…'}
        </div>
      ) : (
        entries.map((entry) => (
          <div key={entry.id} className={entryClass(entry.type)}>
            {entryPrefix(entry.type)}
            {formatEntryContent(entry)}
          </div>
        ))
      )}
    </div>
  );
}
