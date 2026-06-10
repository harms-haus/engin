import type { LogEntry, WorkflowRunState } from '../../types';

// ─── Develop renderer types ─────────────────────────────────────────────────

export interface DevelopPhaseInfo {
  id: string;
  label: string;
  icon: string;
  status: 'completed' | 'active' | 'pending';
}

export interface DevelopAgentInfo {
  agentId: string;
  profile: string;
  taskId?: string;
  active: boolean;
  log: LogEntry[];
}

export interface DevelopRendererState {
  phases: DevelopPhaseInfo[];
  agents: DevelopAgentInfo[];
  currentPhase: string;
}

// ─── Helper ─────────────────────────────────────────────────────────────────

export function buildDevelopState(runState: WorkflowRunState): DevelopRendererState {
  const phases: DevelopPhaseInfo[] = [];
  const sidebarPhases = runState.summary.sidebar.phases;
  if (sidebarPhases) {
    for (const phase of sidebarPhases) {
      let status: 'completed' | 'active' | 'pending';
      if (runState.completedPhases.includes(phase.id)) {
        status = 'completed';
      } else if (phase.id === runState.currentPhase) {
        status = 'active';
      } else {
        status = 'pending';
      }
      phases.push({
        id: phase.id,
        label: phase.label,
        icon: phase.icon,
        status,
      });
    }
  }

  const agents: DevelopAgentInfo[] = [];
  for (const [_agentId, agent] of runState.agents) {
    agents.push({
      agentId: agent.agentId,
      profile: agent.profile,
      taskId: agent.taskId,
      active: agent.active,
      log: agent.log,
    });
  }
  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));

  return {
    phases,
    agents,
    currentPhase: runState.currentPhase,
  };
}
