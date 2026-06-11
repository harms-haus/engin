import './ProgressIndicator.css';
import type { DevelopPhaseInfo } from './types';

interface ProgressIndicatorProps {
  phases: DevelopPhaseInfo[];
  activePhaseTab: string;
  onTabClick: (phaseId: string) => void;
}

export function ProgressIndicator({ phases, activePhaseTab, onTabClick }: ProgressIndicatorProps) {
  return (
    <div className="progress-indicator" role="tablist">
      {phases.map((phase) => (
        <div
          key={phase.id}
          className={`phase-tab${phase.id === activePhaseTab ? ' phase-tab--selected' : ''}`}
          role="tab"
          data-status={phase.status}
          aria-disabled={phase.status === 'pending' || undefined}
          style={
            {
              '--phase-color':
                phase.status === 'pending' ? 'var(--engin-phase-disabled)' : 'var(--engin-phase-' + phase.index + ')',
            } as React.CSSProperties
          }
          onClick={() => {
            if (phase.status !== 'pending') {
              onTabClick(phase.id);
            }
          }}
        >
          <span className="phase-icon">{phase.status === 'completed' ? '✅' : phase.icon}</span>
          <span className="phase-label">{phase.label}</span>
        </div>
      ))}
    </div>
  );
}
