import { useEffect, useRef, useState } from 'react';
import './EventLog.css';

export interface EventLogProps {
  entries: string[];
}

export function EventLog({ entries }: EventLogProps) {
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
      {entries.map((entry, i) => (
        <div key={i} className="event-log__entry">
          {entry}
        </div>
      ))}
    </div>
  );
}
