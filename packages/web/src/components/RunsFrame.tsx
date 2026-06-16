import { useEffect, useState } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useRuns, useSelectedRunId, useWorkflowStore } from '../store/workflow-store';
import './RunsFrame.css';

const MAX_PROMPT_LENGTH = 50;

export function RunsFrame() {
  const runs = useRuns();
  const selectedRunId = useSelectedRunId();
  const selectRun = useWorkflowStore((s) => s.selectRun);
  const cancelRun = useWorkflowStore((s) => s.cancelRun);
  const { connected } = useWebSocket();
  const [confirmingRunId, setConfirmingRunId] = useState<string | null>(null);

  // Reset confirmation when a run is no longer running
  useEffect(() => {
    if (confirmingRunId) {
      const run = runs.find((r) => r.runId === confirmingRunId);
      if (!run || run.status !== 'running') {
        setConfirmingRunId(null);
      }
    }
  }, [runs, confirmingRunId]);

  const handleCancelClick = (runId: string) => {
    if (confirmingRunId === runId) {
      cancelRun(runId);
      setConfirmingRunId(null);
    } else {
      setConfirmingRunId(runId);
    }
  };

  return (
    <div className="runs-frame">
      {runs.length === 0 ? (
        <div className="runs-frame__empty">No active runs</div>
      ) : (
        runs.map((run) => {
          const isSelected = run.runId === selectedRunId;
          const isRunning = run.status === 'running';
          const isConfirming = confirmingRunId === run.runId;

          const truncatedPrompt =
            run.taskPrompt.length > MAX_PROMPT_LENGTH
              ? run.taskPrompt.slice(0, MAX_PROMPT_LENGTH) + '…'
              : run.taskPrompt;

          let className = 'runs-frame__entry';
          if (isSelected) className += ' runs-frame__entry--selected';

          return (
            <div
              key={run.runId}
              className={className}
              role="button"
              tabIndex={0}
              aria-label={`${run.workflowName} — ${run.status}`}
              onClick={() => selectRun(run.runId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  selectRun(run.runId);
                }
              }}
            >
              <span className={`runs-frame__indicator${isRunning ? ' runs-frame__indicator--active' : ''}`} />
              <div className="runs-frame__details">
                <span className="runs-frame__name">{run.workflowName}</span>
                <span className="runs-frame__prompt">{truncatedPrompt}</span>
                {run.currentPhaseId && <span className="runs-frame__phase">{run.currentPhaseId}</span>}
              </div>
              <span className="runs-frame__status">{run.status}</span>
              {isRunning && (
                <button
                  className={`runs-frame__cancel${isConfirming ? ' runs-frame__cancel--confirm' : ''}`}
                  disabled={!connected}
                  aria-label={isConfirming ? `Confirm cancel ${run.workflowName}` : `Cancel ${run.workflowName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCancelClick(run.runId);
                  }}
                >
                  {isConfirming ? 'Confirm?' : 'Cancel'}
                </button>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
