import { useEffect, useState } from 'react';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useWebSocket } from '../hooks/useWebSocket';
import type { StepEntity } from '../protocol-types';
import { useHasSnapshot, useSelectedStepIndex, useStatus, useWorkflowStore } from '../store/workflow-store';
import { formatEntryContent, shouldRenderEntry } from '../utils/format-entry';
import './AgentLog.css';

export function AgentLog() {
  const status = useStatus();
  const hasSnapshot = useHasSnapshot();
  const { send, connected } = useWebSocket();
  const [confirming, setConfirming] = useState(false);

  // Selection state from the store
  const selectedTaskId = useWorkflowStore((s) => s.selectedTaskId);
  const selectedStepIndex = useSelectedStepIndex();
  const tasksById = useWorkflowStore((s) => s.tasksById);
  const agentsById = useWorkflowStore((s) => s.agentsById);
  const selectStep = useWorkflowStore((s) => s.selectStep);
  const selectedRunId = useWorkflowStore((s) => s.selectedRunId);

  // Derive task, steps, and agent from selection state
  const task = selectedTaskId ? (tasksById[selectedTaskId] ?? null) : null;
  const steps: StepEntity[] = task?.steps ?? [];
  const activeStepIndex = task?.activeStepIndex;
  const selectedStep = steps[selectedStepIndex ?? -1] ?? null;
  const agent = selectedStep?.agentKey ? (agentsById[selectedStep.agentKey] ?? null) : null;

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

      {/* Step tab bar */}
      {steps.length > 0 && (
        <div className="agent-log__step-bar" role="tablist" aria-label="Task steps">
          {steps.map((step, index) => {
            const isSelected = index === selectedStepIndex;
            const hasAgent = step.agentKey !== undefined;
            const isActive = index === activeStepIndex;
            const isDone = activeStepIndex !== undefined && index < activeStepIndex;
            const isPending = activeStepIndex !== undefined && index > activeStepIndex;

            let marker: string;
            let markerLabel: string;
            if (isDone) {
              marker = '✓';
              markerLabel = 'done';
            } else if (isActive) {
              marker = '▶';
              markerLabel = 'active';
            } else {
              marker = '○';
              markerLabel = 'pending';
            }

            return (
              <button
                key={index}
                role="tab"
                aria-selected={isSelected}
                aria-label={`Step ${index + 1}: ${step.name} (${markerLabel})${!hasAgent ? ', no agent assigned' : ''}`}
                className={
                  `agent-log__step-tab` +
                  (isSelected ? ' agent-log__step-tab--selected' : '') +
                  (!hasAgent ? ' agent-log__step-tab--dimmed' : '') +
                  (isDone ? ' agent-log__step-tab--done' : '') +
                  (isActive ? ' agent-log__step-tab--active' : '') +
                  (isPending ? ' agent-log__step-tab--pending' : '')
                }
                onClick={() => {
                  if (hasAgent) {
                    selectStep(index);
                  }
                }}
                disabled={!hasAgent}
              >
                <span className="agent-log__step-marker">{marker}</span>
                <span className="agent-log__step-name">{step.name}</span>
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
