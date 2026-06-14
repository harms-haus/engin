import { useEffect, useState } from 'react';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAgentById, useAgentIds, useHasSnapshot, useStatus } from '../store/workflow-store';
import { formatEntryContent, shouldRenderEntry } from '../utils/format-entry';
import './AgentLog.css';

export function AgentLog() {
  const keys = useAgentIds();
  const status = useStatus();
  const hasSnapshot = useHasSnapshot();
  const { send, connected } = useWebSocket();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);

  // Reset selection when agents change
  useEffect(() => {
    if (selectedIndex >= keys.length) {
      setSelectedIndex(Math.max(0, keys.length - 1));
    }
  }, [keys.length, selectedIndex]);

  const selectedKey = keys[selectedIndex] ?? null;
  const agent = useAgentById(selectedKey ?? '__nonexistent__');

  // Auto-scroll on new log entries – only when the user is already at/near
  // the bottom so we don't yank them away from content they're reading.
  const { scrollRef, handleScroll } = useAutoScroll(agent?.log);

  const handlePrev = () => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : keys.length - 1));
  };

  const handleNext = () => {
    setSelectedIndex((prev) => (prev < keys.length - 1 ? prev + 1 : 0));
  };

  const handleTerminateClick = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    send({ type: 'terminate_server' });
  };

  const handleCancelTerminate = () => {
    setConfirming(false);
  };

  // Reset confirmation when the workflow is no longer running
  useEffect(() => {
    if (status !== 'running') {
      setConfirming(false);
    }
  }, [status]);

  const emptyMessage = hasSnapshot ? 'No agent selected' : 'Connecting to workflow…';

  return (
    <div className="agent-log">
      {/* Header stats */}
      {agent && (
        <div
          className="agent-log__header"
          aria-label={`Input: ${agent.inputTokens}, Output: ${agent.outputTokens}, ${agent.toolCallCount} tool calls`}
        >
          {agent.taskId || agent.agentId} (profile: {agent.profile}) - {agent.toolCallCount} tool calls -{' '}
          <span aria-label={`Input tokens: ${agent.inputTokens}`}>Input: {agent.inputTokens}</span> -{' '}
          <span aria-label={`Output tokens: ${agent.outputTokens}`}>Output: {agent.outputTokens}</span>
        </div>
      )}

      {/* Log entries */}
      <div className="agent-log__entries" ref={scrollRef} onScroll={handleScroll}>
        {agent ? (
          agent.log.filter(shouldRenderEntry).map((entry) => (
            <div key={entry.id} className={`agent-log__entry agent-log__entry--${entry.type}`}>
              {formatEntryContent(entry)}
            </div>
          ))
        ) : (
          <div className="agent-log__entry agent-log__entry--empty">{emptyMessage}</div>
        )}
      </div>

      {/* Navigation */}
      {keys.length > 0 && (
        <div className="agent-log__nav">
          <button className="agent-log__nav-btn" onClick={handlePrev} aria-label="Previous agent">
            ←
          </button>
          <span className="agent-log__nav-info">
            {selectedIndex + 1} / {keys.length}
          </span>
          <button className="agent-log__nav-btn" onClick={handleNext} aria-label="Next agent">
            →
          </button>
        </div>
      )}

      {/* Terminate button */}
      {status === 'running' && (
        <div className="agent-log__terminate-row">
          {confirming ? (
            <>
              <button
                className="agent-log__terminate agent-log__terminate--confirm"
                onClick={handleTerminateClick}
                disabled={!connected}
              >
                {connected ? 'Confirm termination' : 'Disconnected - Reconnecting...'}
              </button>
              <button className="agent-log__cancel" onClick={handleCancelTerminate}>
                Cancel
              </button>
            </>
          ) : (
            <button className="agent-log__terminate" onClick={handleTerminateClick} disabled={!connected}>
              {connected ? 'Terminate Workflow' : 'Disconnected - Reconnecting...'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
