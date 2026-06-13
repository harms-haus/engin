import './PhaseBar.css';

export interface Phase {
  id: string;
  label: string;
  icon: string;
}

export interface PhaseBarProps {
  phases: Phase[];
  currentPhase: string;
  completedPhases: string[];
}

export function PhaseBar({ phases, currentPhase, completedPhases }: PhaseBarProps) {
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
