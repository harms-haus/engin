import { useEffect, useRef, useState } from 'react';
import type { AgentState } from '../types';
import './AgentLog.css';

export interface AgentLogProps {
  agents: Map<string, AgentState>;
  onTerminate: () => void;
  status: 'running' | 'complete' | 'failed';
  connected: boolean;
}

export function AgentLog({ agents, onTerminate, status, connected }: AgentLogProps) {
  const keys = Array.from(agents.keys());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset selection when agents change
  useEffect(() => {
    if (selectedIndex >= keys.length) {
      setSelectedIndex(Math.max(0, keys.length - 1));
    }
  }, [keys.length, selectedIndex]);

  const selectedKey = keys[selectedIndex] ?? null;
  const agent = selectedKey ? agents.get(selectedKey) : undefined;

  // Auto-scroll on new log entries – only when the user is already at/near
  // the bottom so we don't yank them away from content they're reading.
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
  });

  const handlePrev = () => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : keys.length - 1));
  };

  const handleNext = () => {
    setSelectedIndex((prev) => (prev < keys.length - 1 ? prev + 1 : 0));
  };

  return (
    <div className="agent-log">
      {/* Header stats */}
      {agent && (
        <div className="agent-log__header">
          {agent.taskId || agent.agentId} (profile: {agent.profile}) - {agent.toolCallCount} tool calls - \u2191
          {agent.inputTokens} - \u2193
          {agent.outputTokens}
        </div>
      )}

      {/* Log entries */}
      <div className="agent-log__entries" ref={scrollRef} onScroll={handleScroll}>
        {agent ? (
          agent.log.map((entry) => (
            <div key={entry.id} className={`agent-log__entry agent-log__entry--${entry.type}`}>
              {entry.content}
            </div>
          ))
        ) : (
          <div className="agent-log__entry agent-log__entry--empty">No agent selected</div>
        )}
      </div>

      {/* Navigation */}
      {keys.length > 0 && (
        <div className="agent-log__nav">
          <button className="agent-log__nav-btn" onClick={handlePrev}>
            ←
          </button>
          <span className="agent-log__nav-info">
            {selectedIndex + 1} / {keys.length}
          </span>
          <button className="agent-log__nav-btn" onClick={handleNext}>
            →
          </button>
        </div>
      )}

      {/* Terminate button */}
      {status === 'running' && (
        <button className="agent-log__terminate" onClick={onTerminate} disabled={!connected}>
          {connected ? 'Terminate Workflow' : 'Disconnected - Reconnecting...'}
        </button>
      )}
    </div>
  );
}
