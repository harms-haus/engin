import type { LogEntry, WorkflowRunState } from '../../types';

// ─── Develop renderer types ─────────────────────────────────────────────────

export interface DevelopPhaseInfo {
  id: string;
  index: number;
  label: string;
  icon: string;
  status: 'completed' | 'active' | 'pending';
}

export interface DevelopAgentInfo {
  agentId: string;
  profile: string;
  phase: string;
  taskId?: string;
  active: boolean;
  log: LogEntry[];
}

export interface DevelopRendererState {
  phases: DevelopPhaseInfo[];
  agentsByPhase: Record<string, DevelopAgentInfo[]>;
  currentPhase: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function getAgentsForPhase(state: DevelopRendererState, phaseId: string): DevelopAgentInfo[] {
  return state.agentsByPhase[phaseId] ?? [];
}

// ─── Build ──────────────────────────────────────────────────────────────────

export function buildDevelopState(runState: WorkflowRunState): DevelopRendererState {
  const phases: DevelopPhaseInfo[] = [];
  const agentsByPhase: Record<string, DevelopAgentInfo[]> = {};
  const sidebarPhases = runState.summary.sidebar.phases;
  const isBeforeFirstPhase = !runState.currentPhase && runState.completedPhases.length === 0;
  if (sidebarPhases) {
    for (let i = 0; i < sidebarPhases.length; i++) {
      const phase = sidebarPhases[i];
      let status: 'completed' | 'active' | 'pending';
      if (phase.id === 'initialization') {
        status = isBeforeFirstPhase ? 'active' : 'completed';
      } else if (runState.completedPhases.includes(phase.id)) {
        status = 'completed';
      } else if (phase.id === runState.currentPhase) {
        status = 'active';
      } else {
        status = 'pending';
      }
      phases.push({
        id: phase.id,
        index: i,
        label: phase.label,
        icon: phase.icon,
        status,
      });
      agentsByPhase[phase.id] = [];
    }
  }

  for (const [_agentId, agent] of runState.agents) {
    const phaseKey = agent.phase ?? 'unknown';
    agentsByPhase[phaseKey] = agentsByPhase[phaseKey] ?? [];
    agentsByPhase[phaseKey].push({
      agentId: agent.agentId,
      profile: agent.profile,
      phase: phaseKey,
      taskId: agent.taskId,
      active: agent.active,
      log: agent.log,
    });
  }

  for (const key of Object.keys(agentsByPhase)) {
    agentsByPhase[key].sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  return {
    phases,
    agentsByPhase,
    currentPhase: runState.currentPhase,
  };
}
