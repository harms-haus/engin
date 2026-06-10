/**
 * DevelopRenderer — top-level renderer for "develop" workflows.
 *
 * Composes the horizontal ProgressIndicator (phase bar) with an AgentGrid
 * showing per-agent log panels.  A small label in .develop-content shows
 * the current (active) phase name.
 */

import type { WorkflowRendererProps } from '../types';
import { registerRenderer } from '../registry';
import { buildDevelopState } from './types';
import { ProgressIndicator } from './ProgressIndicator';
import { AgentGrid } from './AgentGrid';
import './DevelopRenderer.css';

export function DevelopRenderer({ runState }: WorkflowRendererProps) {
  const state = buildDevelopState(runState);

  return (
    <div className="develop-renderer">
      <ProgressIndicator phases={state.phases} />
      <div className="develop-content">
        {state.currentPhase && (
          <div className="develop-phase-label">{state.currentPhase}</div>
        )}
        <AgentGrid agents={state.agents} />
      </div>
    </div>
  );
}

registerRenderer('develop', DevelopRenderer);
