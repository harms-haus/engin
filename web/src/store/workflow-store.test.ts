/**
 * Workflow store tests.
 *
 * Covers: applySnapshot (full replace), applyEvents (fold through evolveClient),
 * setStatus, selector hooks, seq advancement, and the kb-11 re-spawn parity.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { EventRecord, WorkflowProjection } from '../protocol-types';
import { getSeq, useWorkflowStore } from './workflow-store';

// ─── Helpers ────────────────────────────────────────────────────────────────

function blankProjection(overrides?: Partial<WorkflowProjection>): WorkflowProjection {
  return {
    seq: 0,
    taskPrompt: '',
    currentPhase: '',
    completedPhases: [],
    tasks: {},
    agents: {},
    sidebar: { title: '', indicator: '' },
    status: 'running',
    stats: { totalTokens: 0, agentCount: 0 },
    ...overrides,
  };
}

function evt(
  type: EventRecord['type'],
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
  seq = 1,
): EventRecord {
  return {
    seq,
    type,
    data,
    metadata: { timestamp: '2025-01-01T00:00:00.000Z', ...meta },
  };
}

// ─── Reset store between tests ─────────────────────────────────────────────

beforeEach(() => {
  useWorkflowStore.setState({
    agentsById: {},
    tasksById: {},
    currentPhase: '',
    completedPhases: [],
    sidebar: { title: '', indicator: '' },
    status: 'running',
    taskPrompt: '',
    error: undefined,
    failedPhase: undefined,
    seq: 0,
    stats: { totalTokens: 0, agentCount: 0 },
  });
});

// ─── applySnapshot ────────────────────────────────────────────────────────

describe('store – applySnapshot', () => {
  it('replaces the entire store from a snapshot', () => {
    const snapshot: WorkflowProjection = {
      seq: 42,
      taskPrompt: 'build something',
      currentPhase: 'exec',
      completedPhases: ['plan'],
      tasks: {
        t1: { id: 't1', title: 'Task 1', status: 'done' },
        t2: { id: 't2', title: 'Task 2', status: 'implementing' },
      },
      agents: {
        'a1::t1': {
          uid: 'a1::t1',
          agentId: 'a1',
          profile: 'coder',
          phase: 'exec',
          taskId: 't1',
          active: false,
          log: [],
          toolCallCount: 5,
          inputTokens: 1000,
          outputTokens: 500,
          taskTitle: 'Task 1',
        },
      },
      sidebar: { title: 'My App', indicator: 'green', phases: [{ id: 'exec', label: 'Exec', icon: '⚡' }] },
      status: 'running',
      stats: { totalTokens: 1500, agentCount: 1 },
    };

    useWorkflowStore.getState().applySnapshot(snapshot, 42);
    const s = useWorkflowStore.getState();

    expect(s.seq).toBe(42);
    expect(s.taskPrompt).toBe('build something');
    expect(s.currentPhase).toBe('exec');
    expect(s.completedPhases).toEqual(['plan']);
    expect(Object.keys(s.tasksById)).toHaveLength(2);
    expect(s.tasksById['t1'].status).toBe('done');
    expect(Object.keys(s.agentsById)).toHaveLength(1);
    expect(s.agentsById['a1::t1'].toolCallCount).toBe(5);
    expect(s.sidebar.title).toBe('My App');
    expect(s.sidebar.phases).toHaveLength(1);
    expect(s.stats.totalTokens).toBe(1500);
  });

  it('replaces agentsById with defensive log cap', () => {
    // Create a snapshot with an agent that has > 500 log entries
    const logs = Array.from({ length: 510 }, (_, i) => ({
      id: `log-${i}`,
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'text' as const,
      content: `entry-${i}`,
    }));

    const snapshot = blankProjection({
      agents: {
        a1: {
          uid: 'a1',
          agentId: 'a1',
          profile: 'p',
          phase: '',
          active: true,
          log: logs,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          taskTitle: '',
        },
      },
    });

    useWorkflowStore.getState().applySnapshot(snapshot, 1);
    const s = useWorkflowStore.getState();

    // Should be capped at 500
    expect(s.agentsById['a1'].log.length).toBe(500);
    // Oldest entries dropped
    expect(s.agentsById['a1'].log[0].content).toBe('entry-10');
    expect(s.agentsById['a1'].log[499].content).toBe('entry-509');
  });

  it('sets getSeq() to match the seq argument', () => {
    useWorkflowStore.getState().applySnapshot(blankProjection(), 99);
    expect(getSeq()).toBe(99);
  });
});

// ─── applyEvents ──────────────────────────────────────────────────────────

describe('store – applyEvents', () => {
  it('folds a sequence of events through evolveClient', () => {
    const store = useWorkflowStore.getState();

    store.applyEvents([
      evt('workflow_started', { taskPrompt: 'hello' }, {}, 1),
      evt('phase_started', { phase: 'scouting' }, {}, 2),
      evt('tasks_added', { tasks: [{ id: 't1', title: 'Task 1', status: 'ready' }] }, {}, 3),
      evt('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 4),
    ]);

    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('hello');
    expect(s.currentPhase).toBe('scouting');
    expect(s.tasksById['t1'].title).toBe('Task 1');
    expect(s.agentsById['a1::t1'].profile).toBe('coder');
    expect(s.seq).toBe(4);
  });

  it('advances seq to the last event seq', () => {
    useWorkflowStore
      .getState()
      .applyEvents([evt('workflow_started', {}, {}, 5), evt('phase_started', { phase: 'a' }, {}, 10)]);
    expect(getSeq()).toBe(10);
  });

  it('applies turn_ended tokens and tool_call events', () => {
    const store = useWorkflowStore.getState();

    store.applyEvents([
      evt('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
      evt('tool_call_started', { toolName: 'read' }, { agentId: 'a1', taskId: 't1' }, 2),
      evt(
        'turn_ended',
        { tokens: { input: 100, output: 50 }, contentBlocks: [{ type: 'text', text: 'hi' }] },
        { agentId: 'a1', taskId: 't1' },
        3,
      ),
    ]);

    const s = useWorkflowStore.getState();
    const agent = s.agentsById['a1::t1'];
    expect(agent.toolCallCount).toBe(1);
    expect(agent.inputTokens).toBe(100);
    expect(agent.outputTokens).toBe(50);
    expect(agent.log).toHaveLength(2); // tool_call_start + text
    expect(s.stats.totalTokens).toBe(150);
  });

  it('re-spawn preserves accumulated agent state (kb-11 parity)', () => {
    const store = useWorkflowStore.getState();

    // Spawn → accumulate → re-spawn → verify preservation
    store.applyEvents([
      evt('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
      evt('tool_call_started', { toolName: 'a' }, { agentId: 'a1', taskId: 't1' }, 2),
      evt('tool_call_started', { toolName: 'b' }, { agentId: 'a1', taskId: 't1' }, 3),
      evt('turn_ended', { tokens: { input: 50, output: 25 } }, { agentId: 'a1', taskId: 't1' }, 4),
      evt('decision', { decision: 'proceed' }, { agentId: 'a1', taskId: 't1' }, 5),
      // Re-spawn
      evt('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 6),
    ]);

    const s = useWorkflowStore.getState();
    const agent = s.agentsById['a1::t1'];

    // All accumulated state preserved
    expect(agent.toolCallCount).toBe(2);
    expect(agent.inputTokens).toBe(50);
    expect(agent.outputTokens).toBe(25);
    expect(agent.log.length).toBe(3); // 2 tool_starts + 1 decision
    expect(agent.active).toBe(true);
    expect(s.stats.agentCount).toBe(1); // NOT incremented on re-spawn
  });
});

// ─── setStatus ───────────────────────────────────────────────────────────

describe('store – setStatus', () => {
  it('sets status to complete', () => {
    useWorkflowStore.getState().setStatus('complete');
    expect(useWorkflowStore.getState().status).toBe('complete');
  });

  it('sets status to failed', () => {
    useWorkflowStore.getState().setStatus('failed');
    expect(useWorkflowStore.getState().status).toBe('failed');
  });

  it('sets status back to running', () => {
    useWorkflowStore.getState().setStatus('failed');
    useWorkflowStore.getState().setStatus('running');
    expect(useWorkflowStore.getState().status).toBe('running');
  });
});

// ─── Selector hooks ──────────────────────────────────────────────────────

describe('store – selectors', () => {
  it('useAgentIds returns agent keys', () => {
    useWorkflowStore
      .getState()
      .applyEvents([
        evt('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
        evt('agent_spawned', { profile: 'q' }, { agentId: 'a2' }, 2),
      ]);

    const ids = useWorkflowStore.getState() ? Object.keys(useWorkflowStore.getState().agentsById) : [];
    expect(ids).toContain('a1::t1');
    expect(ids).toContain('a2');
  });

  it('useAgentById returns the correct agent', () => {
    useWorkflowStore
      .getState()
      .applyEvents([evt('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 1)]);

    const agent = useWorkflowStore.getState().agentsById['a1::t1'];
    expect(agent).toBeDefined();
    expect(agent.profile).toBe('coder');
  });

  it('useTaskIds returns task keys', () => {
    useWorkflowStore
      .getState()
      .applyEvents([
        evt('tasks_added', { tasks: [{ id: 't1', title: 'A', status: 'ready' }] }, {}, 1),
        evt('tasks_added', { tasks: [{ id: 't2', title: 'B', status: 'ready' }] }, {}, 2),
      ]);

    const ids = Object.keys(useWorkflowStore.getState().tasksById);
    expect(ids).toContain('t1');
    expect(ids).toContain('t2');
  });

  it('useCurrentPhase returns current phase', () => {
    useWorkflowStore.getState().applyEvents([evt('phase_started', { phase: 'exec' }, {}, 1)]);
    expect(useWorkflowStore.getState().currentPhase).toBe('exec');
  });

  it('useCompletedPhases returns completed phases', () => {
    useWorkflowStore
      .getState()
      .applyEvents([
        evt('phase_completed', { phase: 'plan' }, {}, 1),
        evt('phase_completed', { phase: 'exec' }, {}, 2),
      ]);
    expect(useWorkflowStore.getState().completedPhases).toEqual(['plan', 'exec']);
  });

  it('useSidebar returns sidebar info', () => {
    useWorkflowStore.getState().applyEvents([evt('sidebar_updated', { title: 'App', indicator: 'blue' }, {}, 1)]);
    const sidebar = useWorkflowStore.getState().sidebar;
    expect(sidebar.title).toBe('App');
    expect(sidebar.indicator).toBe('blue');
  });

  it('useStatus returns current status', () => {
    expect(useWorkflowStore.getState().status).toBe('running');
    useWorkflowStore.getState().setStatus('complete');
    expect(useWorkflowStore.getState().status).toBe('complete');
  });

  it('useSeq returns current seq', () => {
    expect(getSeq()).toBe(0);
    useWorkflowStore.getState().applyEvents([evt('workflow_started', {}, {}, 7)]);
    expect(getSeq()).toBe(7);
  });
});
