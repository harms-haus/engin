import {
  useCompletedPhaseIds,
  useCurrentPhaseId,
  usePhases,
  useSelectedPhaseId,
  useWorkflowStore,
} from '../store/workflow-store';
import './PhaseBar.css';

export function PhaseBar() {
  const phases = usePhases();
  const currentPhaseId = useCurrentPhaseId();
  const completedPhaseIds = useCompletedPhaseIds();
  const selectedPhaseId = useSelectedPhaseId();
  const selectPhase = useWorkflowStore((s) => s.selectPhase);

  const isCompleted = (id: string) => completedPhaseIds.includes(id);
  const isCurrent = (id: string) => id === currentPhaseId;
  const isSelected = (id: string) => id === selectedPhaseId;

  return (
    <div className="phase-bar">
      {phases.map((phase) => {
        let className = 'phase-bar__tab';
        if (isCompleted(phase.id)) className += ' phase-bar__tab--completed';
        if (isCurrent(phase.id)) className += ' phase-bar__tab--current';
        if (isSelected(phase.id)) className += ' phase-bar__tab--selected';
        return (
          <div key={phase.id} className={className} onClick={() => selectPhase(phase.id)} role="button" tabIndex={0}>
            <span className="phase-bar__icon">{phase.icon}</span>
            <span className="phase-bar__label">{phase.label}</span>
          </div>
        );
      })}
    </div>
  );
}
