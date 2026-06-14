import { useCompletedPhases, useCurrentPhase, useSidebar } from '../store/workflow-store';
import './PhaseBar.css';

export function PhaseBar() {
  const sidebar = useSidebar();
  const currentPhase = useCurrentPhase();
  const completedPhases = useCompletedPhases();
  const phases = sidebar.phases ?? [];

  const isCompleted = (id: string) => completedPhases.includes(id);
  const isCurrent = (id: string) => id === currentPhase;

  return (
    <div className="phase-bar">
      {phases.map((phase) => {
        let className = 'phase-bar__tab';
        if (isCompleted(phase.id)) className += ' phase-bar__tab--completed';
        if (isCurrent(phase.id)) className += ' phase-bar__tab--current';
        return (
          <div key={phase.id} className={className}>
            <span className="phase-bar__icon">{phase.icon}</span>
            <span className="phase-bar__label">{phase.label}</span>
          </div>
        );
      })}
    </div>
  );
}
