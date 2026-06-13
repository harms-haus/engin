import { useEffect, useRef } from 'react';
import './EventLog.css';

export interface EventLogProps {
  entries: string[];
}

export function EventLog({ entries }: EventLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="event-log" ref={scrollRef}>
      {entries.map((entry, i) => (
        <div key={i} className="event-log__entry">
          {entry}
        </div>
      ))}
    </div>
  );
}
