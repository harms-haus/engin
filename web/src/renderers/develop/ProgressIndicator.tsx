import './ProgressIndicator.css';
import type { DevelopPhaseInfo } from './types';

interface ProgressIndicatorProps {
  phases: DevelopPhaseInfo[];
}

export function ProgressIndicator({ phases }: ProgressIndicatorProps) {
  return (
    <div className="progress-indicator">
      {phases.map((phase, index) => (
        <div key={phase.id} className={`phase-item ${phase.status}`}>
          <span className="phase-icon">
            {phase.status === 'completed' ? '✅' : phase.icon}
          </span>
          <span className="phase-label">{phase.label}</span>
          {index < phases.length - 1 && (
            <div
              className={`phase-connector ${phase.status === 'completed' ? 'completed' : 'pending'}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
