/**
 * Tests for develop renderer types and the buildDevelopState helper.
 */

import { describe, expect, it } from 'vitest';

import type { AgentWindowState, LogEntry, PhaseDescriptor, WorkflowRunState, WorkflowSummary } from '../../../types';
import { buildDevelopState } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createPhase(id: string, label?: string, icon?: string): PhaseDescriptor {
  return { id, label: label ?? id, icon: icon ?? '🔵' };
}

function createAgentWindow(agentId: string, overrides: Partial<AgentWindowState> = {}): AgentWindowState {
  return {
    agentId,
    profile: 'default',
    active: false,
    log: [],
    ...overrides,
  };
}

function createSummary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  const sidebar = overrides.sidebar ?? {
    title: 'Test',
    indicator: '…',
    phases: [],
  };
  return {
    id: 'test-run',
    workflowName: 'Test Workflow',
    status: 'running',
    startedAt: new Date().toISOString(),
    ...overrides,
    sidebar,
  };
}

function createRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    summary: createSummary(),
    agents: new Map(),
    currentPhase: '',
    completedPhases: [],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildDevelopState', () => {
  describe('phases', () => {
    it('should return empty phases array when sidebar has no phases', () => {
      const summary = createSummary({ sidebar: { title: 'No phases', indicator: '…' } });
      const state = createRunState({ summary });
      const result = buildDevelopState(state);
      expect(result.phases).toEqual([]);
    });

    it('should return empty phases array when sidebar.phases is undefined', () => {
      const summary = createSummary({ sidebar: { title: 'No phases', indicator: '…', phases: undefined } });
      const state = createRunState({ summary });
      const result = buildDevelopState(state);
      expect(result.phases).toEqual([]);
    });

    it('should mark a phase as completed when its id is in completedPhases', () => {
      const phases: PhaseDescriptor[] = [
        createPhase('phase-1', 'Phase 1', '📋'),
        createPhase('phase-2', 'Phase 2', '⚙️'),
      ];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({
        summary,
        currentPhase: 'phase-2',
        completedPhases: ['phase-1'],
      });
      const result = buildDevelopState(state);
      expect(result.phases).toHaveLength(2);
      expect(result.phases[0].status).toBe('completed');
      expect(result.phases[1].status).toBe('active');
    });

    it('should mark a phase as active when it equals currentPhase and is not in completedPhases', () => {
      const phases: PhaseDescriptor[] = [createPhase('phase-1'), createPhase('phase-2'), createPhase('phase-3')];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({
        summary,
        currentPhase: 'phase-2',
        completedPhases: ['phase-1'],
      });
      const result = buildDevelopState(state);
      expect(result.phases[0].status).toBe('completed');
      expect(result.phases[1].status).toBe('active');
      expect(result.phases[2].status).toBe('pending');
    });

    it('should mark a phase as pending when it is neither completed nor active', () => {
      const phases: PhaseDescriptor[] = [createPhase('phase-1'), createPhase('phase-2'), createPhase('phase-3')];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({
        summary,
        currentPhase: 'phase-1',
        completedPhases: [],
      });
      const result = buildDevelopState(state);
      expect(result.phases[0].status).toBe('active');
      expect(result.phases[1].status).toBe('pending');
      expect(result.phases[2].status).toBe('pending');
    });

    it('should prefer completed status over active when phase is in both completedPhases and currentPhase', () => {
      const phases: PhaseDescriptor[] = [createPhase('phase-1')];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({
        summary,
        currentPhase: 'phase-1',
        completedPhases: ['phase-1'],
      });
      const result = buildDevelopState(state);
      expect(result.phases[0].status).toBe('completed');
    });

    it('should mark initialization as active when currentPhase is empty and completedPhases is empty', () => {
      const phases: PhaseDescriptor[] = [
        createPhase('initialization', 'Initialization', '🚀'),
        createPhase('scouting', 'Scouting', '🔭'),
      ];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({
        summary,
        currentPhase: '',
        completedPhases: [],
      });
      const result = buildDevelopState(state);
      expect(result.phases[0].status).toBe('active');
      expect(result.phases[1].status).toBe('pending');
    });

    it('should mark initialization as completed when currentPhase is set to scouting', () => {
      const phases: PhaseDescriptor[] = [
        createPhase('initialization', 'Initialization', '🚀'),
        createPhase('scouting', 'Scouting', '🔭'),
      ];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({
        summary,
        currentPhase: 'scouting',
        completedPhases: [],
      });
      const result = buildDevelopState(state);
      expect(result.phases[0].status).toBe('completed');
      expect(result.phases[1].status).toBe('active');
    });

    it('should mark initialization as completed when completedPhases includes scouting', () => {
      const phases: PhaseDescriptor[] = [
        createPhase('initialization', 'Initialization', '🚀'),
        createPhase('scouting', 'Scouting', '🔭'),
      ];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({
        summary,
        currentPhase: '',
        completedPhases: ['scouting'],
      });
      const result = buildDevelopState(state);
      expect(result.phases[0].status).toBe('completed');
      expect(result.phases[1].status).toBe('completed');
    });

    it('should preserve id, label, and icon from PhaseDescriptor', () => {
      const phases: PhaseDescriptor[] = [
        { id: 'research', label: 'Research', icon: '🔍' },
        { id: 'implement', label: 'Implement', icon: '⚙️' },
      ];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({
        summary,
        currentPhase: 'implement',
        completedPhases: ['research'],
      });
      const result = buildDevelopState(state);
      expect(result.phases[0]).toEqual({
        id: 'research',
        label: 'Research',
        icon: '🔍',
        status: 'completed',
      });
      expect(result.phases[1]).toEqual({
        id: 'implement',
        label: 'Implement',
        icon: '⚙️',
        status: 'active',
      });
    });
  });

  describe('agents', () => {
    it('should return empty agents array when runState has no agents', () => {
      const state = createRunState({ agents: new Map() });
      const result = buildDevelopState(state);
      expect(result.agents).toEqual([]);
    });

    it('should convert agents Map to sorted array by agentId', () => {
      const agents = new Map<string, AgentWindowState>([
        ['agent-beta', createAgentWindow('agent-beta', { profile: 'beta', active: true })],
        ['agent-alpha', createAgentWindow('agent-alpha', { profile: 'alpha', active: false })],
        ['agent-gamma', createAgentWindow('agent-gamma', { profile: 'gamma', active: true })],
      ]);
      const state = createRunState({ agents });
      const result = buildDevelopState(state);
      expect(result.agents).toHaveLength(3);
      expect(result.agents[0].agentId).toBe('agent-alpha');
      expect(result.agents[1].agentId).toBe('agent-beta');
      expect(result.agents[2].agentId).toBe('agent-gamma');
    });

    it('should include all agent properties', () => {
      const logEntry: LogEntry = {
        id: 'log-1',
        timestamp: new Date().toISOString(),
        type: 'text',
        content: 'hello',
      };
      const agent = createAgentWindow('agent-1', {
        profile: 'worker',
        taskId: 'task-42',
        active: true,
        log: [logEntry],
      });
      const agents = new Map([['agent-1', agent]]);
      const state = createRunState({ agents });
      const result = buildDevelopState(state);
      expect(result.agents[0]).toEqual({
        agentId: 'agent-1',
        profile: 'worker',
        taskId: 'task-42',
        active: true,
        log: [logEntry],
      });
    });

    it('should handle agents without taskId', () => {
      const agent = createAgentWindow('agent-1', {
        profile: 'solo',
        active: false,
        taskId: undefined,
      });
      const agents = new Map([['agent-1', agent]]);
      const state = createRunState({ agents });
      const result = buildDevelopState(state);
      expect(result.agents[0].taskId).toBeUndefined();
    });

    it('should preserve log entries array order', () => {
      const entry1: LogEntry = { id: '1', timestamp: '2024-01-01T00:00:00Z', type: 'text', content: 'first' };
      const entry2: LogEntry = { id: '2', timestamp: '2024-01-01T00:00:01Z', type: 'text', content: 'second' };
      const entry3: LogEntry = { id: '3', timestamp: '2024-01-01T00:00:02Z', type: 'text', content: 'third' };
      const agent = createAgentWindow('agent-1', {
        log: [entry1, entry2, entry3],
      });
      const agents = new Map([['agent-1', agent]]);
      const state = createRunState({ agents });
      const result = buildDevelopState(state);
      expect(result.agents[0].log).toEqual([entry1, entry2, entry3]);
    });
  });

  describe('currentPhase', () => {
    it('should return the currentPhase from runState', () => {
      const state = createRunState({ currentPhase: 'phase-3' });
      const result = buildDevelopState(state);
      expect(result.currentPhase).toBe('phase-3');
    });

    it('should return empty string when currentPhase is empty', () => {
      const state = createRunState({ currentPhase: '' });
      const result = buildDevelopState(state);
      expect(result.currentPhase).toBe('');
    });
  });

  describe('integration', () => {
    it('should produce correct DevelopRendererState from a realistic WorkflowRunState', () => {
      const phases: PhaseDescriptor[] = [
        { id: 'plan', label: 'Plan', icon: '📋' },
        { id: 'code', label: 'Code', icon: '💻' },
        { id: 'test', label: 'Test', icon: '🧪' },
        { id: 'deploy', label: 'Deploy', icon: '🚀' },
      ];

      const logA: LogEntry[] = [{ id: 'a1', timestamp: '2024-01-01T00:00:00Z', type: 'text', content: 'Starting' }];
      const logB: LogEntry[] = [
        { id: 'b1', timestamp: '2024-01-01T00:00:05Z', type: 'thinking', content: 'Thinking...' },
        { id: 'b2', timestamp: '2024-01-01T00:00:06Z', type: 'decision', content: 'Decided' },
      ];

      const agents = new Map<string, AgentWindowState>([
        [
          'planner',
          {
            agentId: 'planner',
            profile: 'Planner Agent',
            taskId: 'task-plan',
            active: false,
            log: logA,
          },
        ],
        [
          'coder',
          {
            agentId: 'coder',
            profile: 'Coder Agent',
            taskId: 'task-code',
            active: true,
            log: logB,
          },
        ],
      ]);

      const summary = createSummary({
        id: 'run-integration',
        workflowName: 'Build Feature',
        status: 'running',
        sidebar: {
          title: 'Build Feature',
          indicator: '…',
          phases,
        },
        startedAt: '2024-01-01T00:00:00Z',
      });

      const runState: WorkflowRunState = {
        summary,
        agents,
        currentPhase: 'code',
        completedPhases: ['plan'],
      };

      const result = buildDevelopState(runState);

      // Verify phases
      expect(result.phases).toHaveLength(4);
      expect(result.phases[0]).toEqual({ id: 'plan', label: 'Plan', icon: '📋', status: 'completed' });
      expect(result.phases[1]).toEqual({ id: 'code', label: 'Code', icon: '💻', status: 'active' });
      expect(result.phases[2]).toEqual({ id: 'test', label: 'Test', icon: '🧪', status: 'pending' });
      expect(result.phases[3]).toEqual({ id: 'deploy', label: 'Deploy', icon: '🚀', status: 'pending' });

      // Verify agents (sorted by agentId: coder before planner)
      expect(result.agents).toHaveLength(2);
      expect(result.agents[0].agentId).toBe('coder');
      expect(result.agents[0].profile).toBe('Coder Agent');
      expect(result.agents[0].taskId).toBe('task-code');
      expect(result.agents[0].active).toBe(true);
      expect(result.agents[0].log).toEqual(logB);

      expect(result.agents[1].agentId).toBe('planner');
      expect(result.agents[1].profile).toBe('Planner Agent');
      expect(result.agents[1].taskId).toBe('task-plan');
      expect(result.agents[1].active).toBe(false);
      expect(result.agents[1].log).toEqual(logA);

      // Verify currentPhase
      expect(result.currentPhase).toBe('code');
    });
  });
});
