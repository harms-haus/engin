/**
 * Tests for develop renderer types, the buildDevelopState helper,
 * and the getAgentsForPhase helper.
 */

import { describe, expect, it } from 'vitest';

import type { AgentWindowState, LogEntry, PhaseDescriptor, WorkflowRunState, WorkflowSummary } from '../../../types';
import type { DevelopAgentInfo, DevelopRendererState } from '../types';
import { buildDevelopState, getAgentsForPhase } from '../types';

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
        index: 0,
        label: 'Research',
        icon: '🔍',
        status: 'completed',
      });
      expect(result.phases[1]).toEqual({
        id: 'implement',
        index: 1,
        label: 'Implement',
        icon: '⚙️',
        status: 'active',
      });
    });

    it('should assign sequential index values to phases', () => {
      const phases: PhaseDescriptor[] = [
        createPhase('first', 'First', '1️⃣'),
        createPhase('second', 'Second', '2️⃣'),
        createPhase('third', 'Third', '3️⃣'),
      ];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({ summary, currentPhase: 'second' });
      const result = buildDevelopState(state);
      expect(result.phases[0].index).toBe(0);
      expect(result.phases[1].index).toBe(1);
      expect(result.phases[2].index).toBe(2);
    });

    it('should assign index 0 when there is only one phase', () => {
      const phases: PhaseDescriptor[] = [createPhase('solo', 'Solo', ' lonely')];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({ summary, currentPhase: 'solo' });
      const result = buildDevelopState(state);
      expect(result.phases[0].index).toBe(0);
      expect(result.phases).toHaveLength(1);
    });
  });

  describe('agents', () => {
    it('should return empty agentsByPhase record when runState has no agents', () => {
      const state = createRunState({ agents: new Map() });
      const result = buildDevelopState(state);
      expect(result.agentsByPhase).toEqual({});
    });

    it('should group agents by their phase field in agentsByPhase', () => {
      const agents = new Map<string, AgentWindowState>([
        ['agent-1', createAgentWindow('agent-1', { profile: 'alpha' })],
        ['agent-2', createAgentWindow('agent-2', { profile: 'beta' })],
        ['agent-3', createAgentWindow('agent-3', { profile: 'gamma' })],
      ]);
      const state = createRunState({
        agents,
        currentPhase: 'code',
        completedPhases: ['plan'],
      });
      const result = buildDevelopState(state);
      // Agents should be grouped under their respective phase keys
      expect(result.agentsByPhase).toBeDefined();
      expect(typeof result.agentsByPhase).toBe('object');
    });

    it('should include all agent properties including the phase field', () => {
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
      // Gather all agents across all phase buckets
      const allAgents = Object.values(result.agentsByPhase).flat();
      expect(allAgents[0]).toEqual(
        expect.objectContaining({
          agentId: 'agent-1',
          profile: 'worker',
          taskId: 'task-42',
          active: true,
          log: [logEntry],
          phase: expect.any(String),
        }),
      );
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
      const allAgents = Object.values(result.agentsByPhase).flat();
      expect(allAgents[0].taskId).toBeUndefined();
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
      const allAgents = Object.values(result.agentsByPhase).flat();
      expect(allAgents[0].log).toEqual([entry1, entry2, entry3]);
    });

    it('should set a phase string on each agent', () => {
      const agents = new Map<string, AgentWindowState>([
        ['agent-1', createAgentWindow('agent-1', { profile: 'alpha' })],
      ]);
      const state = createRunState({ agents });
      const result = buildDevelopState(state);
      const allAgents = Object.values(result.agentsByPhase).flat();
      for (const agent of allAgents) {
        expect(typeof agent.phase).toBe('string');
      }
    });

    it('should default agent phase to "unknown" when agent.phase is undefined', () => {
      const agents = new Map<string, AgentWindowState>([
        ['agent-1', createAgentWindow('agent-1', { profile: 'alpha' })],
        ['agent-2', createAgentWindow('agent-2', { profile: 'beta', phase: undefined })],
      ]);
      const state = createRunState({ agents });
      const result = buildDevelopState(state);
      const allAgents = Object.values(result.agentsByPhase).flat();
      for (const agent of allAgents) {
        expect(agent.phase).toBe('unknown');
      }
    });

    it('should use agent.phase as the grouping key when it is defined', () => {
      const agents = new Map<string, AgentWindowState>([
        ['agent-1', createAgentWindow('agent-1', { profile: 'alpha', phase: 'plan' })],
        ['agent-2', createAgentWindow('agent-2', { profile: 'beta', phase: 'code' })],
        ['agent-3', createAgentWindow('agent-3', { profile: 'gamma', phase: 'plan' })],
      ]);
      const state = createRunState({ agents });
      const result = buildDevelopState(state);
      expect(result.agentsByPhase['plan']).toHaveLength(2);
      expect(result.agentsByPhase['code']).toHaveLength(1);
      expect(result.agentsByPhase['plan'][0].agentId).toBe('agent-1');
      expect(result.agentsByPhase['plan'][1].agentId).toBe('agent-3');
      expect(result.agentsByPhase['code'][0].agentId).toBe('agent-2');
    });

    it('should sort agents by agentId lexicographically within each phase bucket', () => {
      const agents = new Map<string, AgentWindowState>([
        ['z-agent', createAgentWindow('z-agent', { profile: 'Z', phase: 'code' })],
        ['a-agent', createAgentWindow('a-agent', { profile: 'A', phase: 'code' })],
        ['m-agent', createAgentWindow('m-agent', { profile: 'M', phase: 'code' })],
        ['b-agent', createAgentWindow('b-agent', { profile: 'B', phase: 'plan' })],
      ]);
      const state = createRunState({ agents });
      const result = buildDevelopState(state);
      // code phase agents should be sorted: a-agent, m-agent, z-agent
      expect(result.agentsByPhase['code'].map((a) => a.agentId)).toEqual(['a-agent', 'm-agent', 'z-agent']);
      // plan phase agents should be sorted: b-agent
      expect(result.agentsByPhase['plan'].map((a) => a.agentId)).toEqual(['b-agent']);
    });

    it('should pre-populate agentsByPhase with empty arrays for every sidebar phase ID', () => {
      const phases: PhaseDescriptor[] = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
        createPhase('deploy', 'Deploy', '🚀'),
      ];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const state = createRunState({ summary, agents: new Map() });
      const result = buildDevelopState(state);
      expect(result.agentsByPhase).toEqual({
        plan: [],
        code: [],
        deploy: [],
      });
    });

    it('should not return the old flat agents array', () => {
      const agents = new Map<string, AgentWindowState>([['agent-1', createAgentWindow('agent-1', { phase: 'code' })]]);
      const state = createRunState({ agents });
      const result = buildDevelopState(state);
      expect((result as any).agents).toBeUndefined();
    });

    it('should place agents with a phase not matching any sidebar phase into its own bucket', () => {
      const phases: PhaseDescriptor[] = [createPhase('plan', 'Plan', '📋'), createPhase('code', 'Code', '💻')];
      const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });
      const agents = new Map<string, AgentWindowState>([
        ['agent-1', createAgentWindow('agent-1', { profile: 'alpha', phase: 'deploy' })],
      ]);
      const state = createRunState({ summary, agents });
      const result = buildDevelopState(state);
      // Sidebar phases pre-populated
      expect(result.agentsByPhase['plan']).toEqual([]);
      expect(result.agentsByPhase['code']).toEqual([]);
      // Agent with non-sidebar phase gets its own bucket
      expect(result.agentsByPhase['deploy']).toHaveLength(1);
      expect(result.agentsByPhase['deploy'][0].agentId).toBe('agent-1');
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
      expect(result.phases[0]).toEqual({ id: 'plan', label: 'Plan', icon: '📋', status: 'completed', index: 0 });
      expect(result.phases[1]).toEqual({ id: 'code', label: 'Code', icon: '💻', status: 'active', index: 1 });
      expect(result.phases[2]).toEqual({ id: 'test', label: 'Test', icon: '🧪', status: 'pending', index: 2 });
      expect(result.phases[3]).toEqual({ id: 'deploy', label: 'Deploy', icon: '🚀', status: 'pending', index: 3 });

      // Verify agentsByPhase is a plain object (Record), not a Map
      expect(result.agentsByPhase).toBeDefined();
      expect(typeof result.agentsByPhase).toBe('object');
      expect(result.agentsByPhase).not.toBeInstanceOf(Map);

      // Verify all agents are present across phase buckets
      const allAgents = Object.values(result.agentsByPhase).flat();
      expect(allAgents).toHaveLength(2);

      // Verify currentPhase
      expect(result.currentPhase).toBe('code');
    });
  });
});

describe('getAgentsForPhase', () => {
  it('should return an empty array when phaseId does not exist in agentsByPhase', () => {
    const state: DevelopRendererState = {
      phases: [],
      agentsByPhase: {},
      currentPhase: '',
    };
    expect(getAgentsForPhase(state, 'nonexistent')).toEqual([]);
  });

  it('should return an empty array for a phase that has no agents', () => {
    const state: DevelopRendererState = {
      phases: [],
      agentsByPhase: {
        plan: [],
        code: [],
      },
      currentPhase: 'code',
    };
    expect(getAgentsForPhase(state, 'plan')).toEqual([]);
  });

  it('should return agents belonging to the requested phase', () => {
    const agentA: DevelopAgentInfo = {
      agentId: 'agent-a',
      profile: 'Alpha',
      phase: 'plan',
      active: false,
      log: [],
    };
    const agentB: DevelopAgentInfo = {
      agentId: 'agent-b',
      profile: 'Beta',
      phase: 'code',
      active: true,
      log: [],
    };
    const state: DevelopRendererState = {
      phases: [],
      agentsByPhase: {
        plan: [agentA],
        code: [agentB],
      },
      currentPhase: 'code',
    };
    const result = getAgentsForPhase(state, 'plan');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(agentA);
  });

  it('should return all agents for a phase when multiple agents share the same phase', () => {
    const agentA: DevelopAgentInfo = {
      agentId: 'agent-a',
      profile: 'Alpha',
      phase: 'code',
      active: true,
      log: [],
    };
    const agentB: DevelopAgentInfo = {
      agentId: 'agent-b',
      profile: 'Beta',
      phase: 'code',
      active: false,
      log: [],
    };
    const agentC: DevelopAgentInfo = {
      agentId: 'agent-c',
      profile: 'Gamma',
      phase: 'plan',
      active: false,
      log: [],
    };
    const state: DevelopRendererState = {
      phases: [],
      agentsByPhase: {
        code: [agentA, agentB],
        plan: [agentC],
      },
      currentPhase: 'code',
    };
    const result = getAgentsForPhase(state, 'code');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(agentA);
    expect(result[1]).toEqual(agentB);
  });

  it('should return the same reference as stored in agentsByPhase (not a copy)', () => {
    const agents: DevelopAgentInfo[] = [{ agentId: 'x', profile: 'X', phase: 'a', active: false, log: [] }];
    const state: DevelopRendererState = {
      phases: [],
      agentsByPhase: { a: agents },
      currentPhase: 'a',
    };
    const result = getAgentsForPhase(state, 'a');
    expect(result).toBe(agents);
  });

  it('should handle empty phaseId string', () => {
    const state: DevelopRendererState = {
      phases: [],
      agentsByPhase: { '': [{ agentId: 'z', profile: 'Z', phase: '', active: false, log: [] }] },
      currentPhase: '',
    };
    const result = getAgentsForPhase(state, '');
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('z');
  });

  it('should handle undefined-like keys by falling back to empty array', () => {
    const state: DevelopRendererState = {
      phases: [],
      agentsByPhase: {},
      currentPhase: '',
    };
    // Any arbitrary string not in the record should yield []
    expect(getAgentsForPhase(state, 'any-phase')).toEqual([]);
  });
});

// ─── Composite key – agent deduplication via taskId ───────────────────────

describe('buildDevelopState – composite key agents', () => {
  it('groups all agents by phase even with duplicate agentIds', () => {
    const phases: PhaseDescriptor[] = [
      createPhase('implementing', 'Implementing', '💻'),
      createPhase('review', 'Review', '🔍'),
    ];
    const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });

    // Two agents with same agentId but different taskIds.
    // The Map keys are composite (${agentId}::${taskId}) which is what the
    // fixed RunRegistry will produce.
    const agents = new Map<string, AgentWindowState>([
      [
        'lane-0::T1',
        createAgentWindow('lane-0', { profile: 'coder', phase: 'implementing', taskId: 'T1', active: true }),
      ],
      [
        'lane-0::T2',
        createAgentWindow('lane-0', { profile: 'coder', phase: 'implementing', taskId: 'T2', active: true }),
      ],
    ]);

    const state = createRunState({ summary, agents, currentPhase: 'implementing' });
    const result = buildDevelopState(state);

    // Both agents should appear in the implementing phase group
    expect(result.agentsByPhase['implementing']).toHaveLength(2);
    expect(result.agentsByPhase['implementing'][0].taskId).toBe('T1');
    expect(result.agentsByPhase['implementing'][1].taskId).toBe('T2');
  });

  it('correctly routes agents with same agentId across different phases', () => {
    const phases: PhaseDescriptor[] = [createPhase('plan', 'Plan', '📋'), createPhase('code', 'Code', '💻')];
    const summary = createSummary({ sidebar: { title: 'Test', indicator: '…', phases } });

    const agents = new Map<string, AgentWindowState>([
      ['lane-0::T1', createAgentWindow('lane-0', { profile: 'coder', phase: 'plan', taskId: 'T1', active: false })],
      ['lane-0::T2', createAgentWindow('lane-0', { profile: 'coder', phase: 'code', taskId: 'T2', active: true })],
    ]);

    const state = createRunState({ summary, agents, currentPhase: 'code', completedPhases: ['plan'] });
    const result = buildDevelopState(state);

    expect(result.agentsByPhase['plan']).toHaveLength(1);
    expect(result.agentsByPhase['plan'][0].taskId).toBe('T1');
    expect(result.agentsByPhase['code']).toHaveLength(1);
    expect(result.agentsByPhase['code'][0].taskId).toBe('T2');
  });
});
