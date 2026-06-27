import { selectNextSession } from '@engin/shared/projection-helpers';
import { useEffect, useMemo, useState } from 'react';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useWebSocket } from '../hooks/useWebSocket';
import type { SessionEntity } from '../protocol-types';
import { useHasSnapshot, useSelectedSessionId, useStatus, useWorkflowStore } from '../store/workflow-store';
import { formatEntryContent, shouldRenderEntry } from '../utils/format-entry';
import './AgentLog.css';

export function AgentLog() {
  const status = useStatus();
  const hasSnapshot = useHasSnapshot();
  const { send, connected } = useWebSocket();
  const [confirming, setConfirming] = useState(false);

  // Selection state from the store
  const selectedTaskId = useWorkflowStore((s) => s.selectedTaskId);
  const selectedSessionId = useSelectedSessionId();
  const sessionsById = useWorkflowStore((s) => s.sessionsById);
  const selectSession = useWorkflowStore((s) => s.selectSession);
  const selectedRunId = useWorkflowStore((s) => s.selectedRunId);

  // Derive sessions and selected agent from selection state
  const sessions = useMemo<SessionEntity[]>(
    () => Object.values(sessionsById).filter((a) => a.taskId === selectedTaskId),
    [sessionsById, selectedTaskId],
  );
  const agent = selectedSessionId ? (sessionsById[selectedSessionId] ?? null) : null;

  // Auto-scroll on new log entries – only when the user is already at/near
  // the bottom so we don't yank them away from content they're reading.
  const { scrollRef, handleScroll } = useAutoScroll(agent?.log);

  const handleTerminateClick = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    if (selectedRunId) {
      send({ type: 'cancel_run', runId: selectedRunId });
    }
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

  // ArrowLeft/ArrowRight keyboard navigation: cycle through the per-task session
  // list (WAI-ARIA tab pattern). Only active when there are sessions for the
  // selected task. Tab moves focus naturally out of the component.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (sessions.length === 0) return;
    e.preventDefault();
    const direction = e.key === 'ArrowRight' ? 1 : -1;
    const next = selectNextSession(sessions, selectedSessionId, direction);
    if (next !== null) {
      selectSession(next);
    }
  };

  const emptyMessage = hasSnapshot ? 'No agent selected' : 'Connecting to workflow…';

  return (
    <div className="agent-log" onKeyDown={handleKeyDown}>
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

      {/* Session tab bar */}
      {sessions.length > 0 && (
        <div className="agent-log__session-bar" role="tablist" aria-label="Task sessions">
          {sessions.map((session) => {
            const isSelected = session.uid === selectedSessionId;
            const ariaLabel = session.runnerRole ? `${session.profile} (${session.runnerRole})` : session.profile;

            return (
              <button
                key={session.uid}
                role="tab"
                aria-selected={isSelected}
                aria-label={ariaLabel}
                className={`agent-log__session-tab${isSelected ? ' agent-log__session-tab--selected' : ''}`}
                onClick={() => selectSession(session.uid)}
              >
                <span className="agent-log__session-name">{session.profile}</span>
                {session.runnerRole && <span className="agent-log__session-role">{session.runnerRole}</span>}
              </button>
            );
          })}
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
