import { useAutoScroll } from '../hooks/useAutoScroll';
import { useHasSnapshot, useWorkflowEventLog } from '../store/workflow-store';
import './EventLog.css';

export function EventLog() {
  const entries = useWorkflowEventLog();
  const hasSnapshot = useHasSnapshot();
  const { scrollRef, handleScroll } = useAutoScroll(entries);

  return (
    <div className="event-log" ref={scrollRef} onScroll={handleScroll}>
      {entries.length === 0 ? (
        <div className="event-log__entry event-log__entry--empty">
          {hasSnapshot ? 'Waiting for activity…' : 'Connecting to workflow…'}
        </div>
      ) : (
        entries.map((entry) => (
          <div key={entry.seq} className="event-log__entry">
            {entry.line}
          </div>
        ))
      )}
    </div>
  );
}
