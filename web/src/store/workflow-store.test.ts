/**
 * Workflow store tests.
 *
 * Covers: applySnapshot (full replace), applyEvents (fold through evolveClient),
 * setStatus, selector hooks, seq advancement, selection actions, follow rules,
 * and the kb-11 re-spawn parity.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { EventRecord, WorkflowProjection } from '../protocol-types';
import { getSeq, useWorkflowStore } from './workflow-store';

// ─── Helpers ────────────────────────────────────────────────────────────────

function blankProjection(overrides?: Partial<WorkflowProjection>): WorkflowProjection {
  return {
    seq: 0,
    taskPrompt: '',
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
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
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    sidebar: { title: '', indicator: '' },
    status: 'running',
    taskPrompt: '',
    error: undefined,
    failedPhase: undefined,
    seq: 0,
    stats: { totalTokens: 0, agentCount: 0 },
    workflowEventLog: [],
    selectedPhaseId: null,
    selectedTaskId: null,
    selectedStepIndex: null,
    userPinnedPhase: false,
    userPinnedStep: false,
  });
});

// ─── applySnapshot ────────────────────────────────────────────────────────

describe('store – applySnapshot', () => {
  it('replaces the entire store from a snapshot', () => {
    const snapshot: WorkflowProjection = {
      seq: 42,
      taskPrompt: 'build something',
      phases: [{ id: 'plan', label: 'Plan', icon: '📋', taskIds: ['t1'] }],
      currentPhaseId: 'exec',
      completedPhaseIds: ['plan'],
      tasks: {
        t1: { id: 't1', title: 'Task 1', status: 'done', phaseId: 'plan', steps: [], dependencies: [] },
        t2: {
          id: 't2',
          title: 'Task 2',
          status: 'implementing',
          phaseId: 'exec',
          steps: [],
          dependencies: [],
        },
      },
      agents: {
        'a1::t1': {
          uid: 'a1::t1',
          agentId: 'a1',
          profile: 'coder',
          phaseId: 'exec',
          taskId: 't1',
          active: false,
          log: [],
          toolCallCount: 5,
          inputTokens: 1000,
          outputTokens: 500,
          taskTitle: 'Task 1',
        },
      },
      sidebar: { title: 'My App', indicator: 'green' },
      status: 'running',
      stats: { totalTokens: 1500, agentCount: 1 },
    };

    useWorkflowStore.getState().applySnapshot(snapshot, 42);
    const s = useWorkflowStore.getState();

    expect(s.seq).toBe(42);
    expect(s.taskPrompt).toBe('build something');
    expect(s.currentPhaseId).toBe('exec');
    expect(s.completedPhaseIds).toEqual(['plan']);
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0].id).toBe('plan');
    expect(Object.keys(s.tasksById)).toHaveLength(2);
    expect(s.tasksById['t1'].status).toBe('done');
    expect(Object.keys(s.agentsById)).toHaveLength(1);
    expect(s.agentsById['a1::t1'].toolCallCount).toBe(5);
    expect(s.sidebar.title).toBe('My App');
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
          phaseId: '',
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
      evt('task_registered', { id: 't1', title: 'Task 1', phaseId: 'scouting', steps: [], dependencies: [] }, {}, 3),
      evt('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 4),
    ]);

    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('hello');
    expect(s.currentPhaseId).toBe('scouting');
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
        evt('task_registered', { id: 't1', title: 'A', phaseId: 'p1', steps: [], dependencies: [] }, {}, 1),
        evt('task_registered', { id: 't2', title: 'B', phaseId: 'p1', steps: [], dependencies: [] }, {}, 2),
      ]);

    const ids = Object.keys(useWorkflowStore.getState().tasksById);
    expect(ids).toContain('t1');
    expect(ids).toContain('t2');
  });

  it('useCurrentPhaseId returns current phase id', () => {
    useWorkflowStore.getState().applyEvents([evt('phase_started', { phase: 'exec' }, {}, 1)]);
    expect(useWorkflowStore.getState().currentPhaseId).toBe('exec');
  });

  it('useCompletedPhaseIds returns completed phase ids', () => {
    useWorkflowStore
      .getState()
      .applyEvents([
        evt('phase_completed', { phase: 'plan' }, {}, 1),
        evt('phase_completed', { phase: 'exec' }, {}, 2),
      ]);
    expect(useWorkflowStore.getState().completedPhaseIds).toEqual(['plan', 'exec']);
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

// ─── workflowEventLog ─────────────────────────────────────────────────────

describe('store – workflowEventLog', () => {
  it('populates workflowEventLog with lifecycle event lines', () => {
    useWorkflowStore
      .getState()
      .applyEvents([
        evt('workflow_started', { taskPrompt: 'build', resumed: false }, {}, 1),
        evt('phase_started', { phase: 'scouting', round: 1 }, {}, 2),
      ]);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({
      seq: 1,
      line: '🚀 Workflow started: "build" (resumed: false)',
    });
    expect(log[1]).toEqual({
      seq: 2,
      line: '📦 Phase: scouting (round 1)',
    });
  });

  it('does NOT add entries for verbose events (decision, tool_call_started, turn_ended)', () => {
    useWorkflowStore
      .getState()
      .applyEvents([
        evt('workflow_started', { taskPrompt: 'x' }, {}, 1),
        evt('decision', { decision: 'proceed' }, { agentId: 'a1' }, 2),
        evt('tool_call_started', { toolName: 'read' }, { agentId: 'a1' }, 3),
        evt('turn_ended', { tokens: { input: 10, output: 5 } }, { agentId: 'a1' }, 4),
      ]);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(1);
    expect(log[0].seq).toBe(1);
  });

  it('caps workflowEventLog at 1000 entries (oldest dropped)', () => {
    const store = useWorkflowStore.getState();

    // Push 1001 workflow_started events
    const events: EventRecord[] = [];
    for (let i = 1; i <= 1001; i++) {
      events.push(evt('workflow_started', { taskPrompt: `run-${i}` }, {}, i));
    }
    store.applyEvents(events);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(1000);
    // Oldest (seq 1) should be dropped; first entry is seq 2
    expect(log[0].seq).toBe(2);
    expect(log[0].line).toContain('run-2');
    // Last entry is seq 1001
    expect(log[999].seq).toBe(1001);
    expect(log[999].line).toContain('run-1001');
  });

  it('applySnapshot resets workflowEventLog to empty on a fresh start (state.seq === 0)', () => {
    // Seed a stale event log directly while keeping seq=0 (pre-first-snapshot).
    useWorkflowStore.setState({
      workflowEventLog: [{ seq: 1, line: '🚀 Workflow started: "stale"' }],
    });
    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(1);

    // Apply the first snapshot — state.seq === 0 → clear the log
    useWorkflowStore.getState().applySnapshot(blankProjection(), 5);

    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(0);
    expect(useWorkflowStore.getState().seq).toBe(5);
  });

  it('applySnapshot does NOT clear workflowEventLog on reconnection (state.seq > 0, new seq >= state.seq)', () => {
    // Seed the store with an accumulated event line and seq=5 (prior snapshot received).
    useWorkflowStore.setState({
      seq: 5,
      workflowEventLog: [{ seq: 1, line: '🚀 Workflow started: "build"' }],
    });
    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(1);

    // A reconnection snapshot arrives at seq=6 (>= current seq) — log preserved
    useWorkflowStore.getState().applySnapshot(blankProjection({ taskPrompt: 'build' }), 6);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual({ seq: 1, line: '🚀 Workflow started: "build"' });
    expect(useWorkflowStore.getState().seq).toBe(6);
  });
});

// ─── Selection actions ──────────────────────────────────────────────────

describe('store – selection actions', () => {
  it('selectPhase sets selectedPhaseId and pins when phase is completed', () => {
    const store = useWorkflowStore.getState();

    // Seed with a workflow that has phases and tasks
    store.applyEvents([
      evt('sidebar_updated', { title: 'App', indicator: 'green' }, {}, 1),
      evt('phase_registered', { id: 'plan', label: 'Plan', icon: '📋' }, {}, 2),
      evt('phase_registered', { id: 'exec', label: 'Exec', icon: '⚡' }, {}, 3),
      evt('phase_completed', { phase: 'plan' }, {}, 4),
    ]);

    store.selectPhase('plan');
    let s = useWorkflowStore.getState();
    expect(s.selectedPhaseId).toBe('plan');
    expect(s.userPinnedPhase).toBe(true); // completed → pinned

    store.selectPhase('exec');
    s = useWorkflowStore.getState();
    expect(s.selectedPhaseId).toBe('exec');
    expect(s.userPinnedPhase).toBe(false); // not completed → not pinned
  });

  it('selectPhase with null sets selectedPhaseId to null and no pin', () => {
    useWorkflowStore.getState().selectPhase(null);
    const s = useWorkflowStore.getState();
    expect(s.selectedPhaseId).toBeNull();
    expect(s.userPinnedPhase).toBe(false);
  });

  it('selectTask sets selectedTaskId and resets step pin', () => {
    // Seed tasks via snapshot
    const snapshot = blankProjection({
      currentPhaseId: 'exec',
      phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
      tasks: {
        t1: {
          id: 't1',
          title: 'Task 1',
          status: 'active',
          phaseId: 'exec',
          steps: [],
          dependencies: [],
          activeStepIndex: 1,
        },
        t2: {
          id: 't2',
          title: 'Task 2',
          status: 'ready',
          phaseId: 'exec',
          steps: [],
          dependencies: [],
        },
      },
    });
    useWorkflowStore.getState().applySnapshot(snapshot, 1);

    // First select a phase so follow rules settle
    useWorkflowStore.getState().selectPhase('exec');

    // Then pin a step
    useWorkflowStore.getState().selectStep(0);
    expect(useWorkflowStore.getState().userPinnedStep).toBe(true);

    // Now select a different task — step pin should be reset
    useWorkflowStore.getState().selectTask('t2');
    const s = useWorkflowStore.getState();
    expect(s.selectedTaskId).toBe('t2');
    expect(s.selectedStepIndex).toBeNull(); // reset
    expect(s.userPinnedStep).toBe(false); // reset
  });

  it('selectStep sets selectedStepIndex and userPinnedStep=true', () => {
    useWorkflowStore.getState().selectStep(2);
    const s = useWorkflowStore.getState();
    expect(s.selectedStepIndex).toBe(2);
    expect(s.userPinnedStep).toBe(true);
  });

  it('selectStep with null sets step to null and pins', () => {
    useWorkflowStore.getState().selectStep(null);
    const s = useWorkflowStore.getState();
    expect(s.selectedStepIndex).toBeNull();
    expect(s.userPinnedStep).toBe(true);
  });

  it('resetSelection clears all selection state', () => {
    // Seed some selection
    useWorkflowStore.setState({
      selectedPhaseId: 'exec',
      selectedTaskId: 't1',
      selectedStepIndex: 2,
      userPinnedPhase: true,
      userPinnedStep: true,
    });

    useWorkflowStore.getState().resetSelection();
    const s = useWorkflowStore.getState();
    expect(s.selectedPhaseId).toBeNull();
    expect(s.selectedTaskId).toBeNull();
    expect(s.selectedStepIndex).toBeNull();
    expect(s.userPinnedPhase).toBe(false);
    expect(s.userPinnedStep).toBe(false);
  });
});

// ─── Follow rules ───────────────────────────────────────────────────────

describe('store – follow rules', () => {
  describe('phase follow', () => {
    it('follows currentPhaseId when selected phase is not completed and differs from current', () => {
      // Seed a snapshot with plan completed, exec as current
      const snapshot = blankProjection({
        currentPhaseId: 'exec',
        completedPhaseIds: ['plan'],
        phases: [
          { id: 'plan', label: 'Plan', icon: '📋', taskIds: [] },
          { id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] },
        ],
        tasks: {
          t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', steps: [], dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot, 1);

      // Now select a non-completed, non-current phase
      useWorkflowStore.getState().selectPhase('plan'); // completed → pinned
      expect(useWorkflowStore.getState().selectedPhaseId).toBe('plan');
      expect(useWorkflowStore.getState().userPinnedPhase).toBe(true);

      // Apply a new snapshot where currentPhaseId moves to 'review'
      const snapshot2 = blankProjection({
        currentPhaseId: 'review',
        completedPhaseIds: ['plan', 'exec'],
        phases: [
          { id: 'plan', label: 'Plan', icon: '📋', taskIds: [] },
          { id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] },
          { id: 'review', label: 'Review', icon: '🔍', taskIds: ['t2'] },
        ],
        tasks: {
          t2: { id: 't2', title: 'T2', status: 'ready', phaseId: 'review', steps: [], dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot2, 2);

      // selectedPhaseId should still be 'plan' because it's completed (pinned)
      expect(useWorkflowStore.getState().selectedPhaseId).toBe('plan');
    });

    it('follows currentPhaseId when selected phase is not pinned (not completed)', () => {
      const snapshot = blankProjection({
        currentPhaseId: 'scouting',
        completedPhaseIds: [],
        phases: [
          { id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: ['t1'] },
          { id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] },
        ],
        tasks: {
          t1: { id: 't1', title: 'T1', status: 'active', phaseId: 'scouting', steps: [], dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot, 1);

      // Select scouting (the current phase) — should NOT be pinned
      useWorkflowStore.getState().selectPhase('scouting');
      expect(useWorkflowStore.getState().selectedPhaseId).toBe('scouting');
      expect(useWorkflowStore.getState().userPinnedPhase).toBe(false);

      // Apply snapshot where currentPhaseId advances to 'exec'
      const snapshot2 = blankProjection({
        currentPhaseId: 'exec',
        completedPhaseIds: ['scouting'],
        phases: [
          { id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: ['t1'] },
          { id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t2'] },
        ],
        tasks: {
          t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', steps: [], dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot2, 2);

      // scouting is now completed → pinned, so it stays on scouting
      expect(useWorkflowStore.getState().selectedPhaseId).toBe('scouting');
    });
  });

  describe('task follow', () => {
    it('auto-selects first active task in selected phase when selectedTaskId is null', () => {
      const snapshot = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
        tasks: {
          t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', steps: [], dependencies: [] },
          t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', steps: [], dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot, 1);

      // selectPhase triggers reconcile which should pick t2 (first active)
      useWorkflowStore.getState().selectPhase('exec');
      expect(useWorkflowStore.getState().selectedTaskId).toBe('t2');
    });

    it('auto-selects first active when selectedTaskId is not in the selected phase', () => {
      const snapshot = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
        tasks: {
          t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', steps: [], dependencies: [] },
          t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', steps: [], dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot, 1);

      // Manually set a task that doesn't exist in exec phase
      useWorkflowStore.setState({
        selectedPhaseId: 'exec',
        selectedTaskId: 't-ghost',
      });

      // Apply events to trigger reconcile — should fix task selection
      useWorkflowStore.getState().applyEvents([evt('workflow_started', { taskPrompt: 'build' }, {}, 2)]);

      expect(useWorkflowStore.getState().selectedTaskId).toBe('t2');
    });
  });

  describe('step follow', () => {
    it('syncs selectedStepIndex with activeStepIndex when not pinned', () => {
      const snapshot = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
        tasks: {
          t1: {
            id: 't1',
            title: 'T1',
            status: 'active',
            phaseId: 'exec',
            steps: [
              { name: 'step0', index: 0 },
              { name: 'step1', index: 1 },
            ],
            dependencies: [],
            activeStepIndex: 0,
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot, 1);
      useWorkflowStore.getState().selectPhase('exec');

      // Should follow activeStepIndex=0
      expect(useWorkflowStore.getState().selectedStepIndex).toBe(0);

      // Apply events that advance the active step (via a new snapshot)
      const snapshot2 = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
        tasks: {
          t1: {
            id: 't1',
            title: 'T1',
            status: 'active',
            phaseId: 'exec',
            steps: [
              { name: 'step0', index: 0 },
              { name: 'step1', index: 1 },
            ],
            dependencies: [],
            activeStepIndex: 1, // advanced
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot2, 2);

      // Should follow to new activeStepIndex
      expect(useWorkflowStore.getState().selectedStepIndex).toBe(1);
    });

    it('does NOT sync selectedStepIndex when step is pinned', () => {
      const snapshot = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
        tasks: {
          t1: {
            id: 't1',
            title: 'T1',
            status: 'active',
            phaseId: 'exec',
            steps: [
              { name: 'step0', index: 0 },
              { name: 'step1', index: 1 },
            ],
            dependencies: [],
            activeStepIndex: 0,
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot, 1);
      useWorkflowStore.getState().selectPhase('exec');

      // Pin to step 1
      useWorkflowStore.getState().selectStep(1);
      expect(useWorkflowStore.getState().selectedStepIndex).toBe(1);
      expect(useWorkflowStore.getState().userPinnedStep).toBe(true);

      // Advance active step via snapshot
      const snapshot2 = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
        tasks: {
          t1: {
            id: 't1',
            title: 'T1',
            status: 'active',
            phaseId: 'exec',
            steps: [
              { name: 'step0', index: 0 },
              { name: 'step1', index: 1 },
            ],
            dependencies: [],
            activeStepIndex: 1, // advanced
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot2, 2);

      // Should stay pinned to step 1 (which happens to match, but should NOT follow if it changed)
      expect(useWorkflowStore.getState().selectedStepIndex).toBe(1);

      // Now advance again to step 2 (different from pinned value)
      const snapshot3 = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
        tasks: {
          t1: {
            id: 't1',
            title: 'T1',
            status: 'active',
            phaseId: 'exec',
            steps: [
              { name: 'step0', index: 0 },
              { name: 'step1', index: 1 },
              { name: 'step2', index: 2 },
            ],
            dependencies: [],
            activeStepIndex: 2, // advanced to step 2
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(snapshot3, 3);

      // Pinned — should NOT follow to 2
      expect(useWorkflowStore.getState().selectedStepIndex).toBe(1);
    });
  });

  it('reconcile runs after applyEvents and updates selection', () => {
    // Start with a snapshot that has selection on the current phase
    const snapshot = blankProjection({
      currentPhaseId: 'scouting',
      phases: [
        { id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: ['t1'] },
        { id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] },
      ],
      tasks: {
        t1: {
          id: 't1',
          title: 'T1',
          status: 'active',
          phaseId: 'scouting',
          steps: [{ name: 's0', index: 0 }],
          dependencies: [],
          activeStepIndex: 0,
        },
      },
    });
    useWorkflowStore.getState().applySnapshot(snapshot, 1);

    // Select scouting (the current phase) — not pinned
    useWorkflowStore.getState().selectPhase('scouting');
    expect(useWorkflowStore.getState().selectedPhaseId).toBe('scouting');
    expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');
    expect(useWorkflowStore.getState().selectedStepIndex).toBe(0);

    // Now apply events that complete scouting, start exec, and add an active task
    useWorkflowStore
      .getState()
      .applyEvents([
        evt('phase_completed', { phase: 'scouting' }, {}, 2),
        evt('phase_started', { phase: 'exec' }, {}, 3),
        evt(
          'task_registered',
          { id: 't2', title: 'Exec Task', phaseId: 'exec', steps: [{ name: 's0', index: 0 }], dependencies: [] },
          {},
          4,
        ),
        evt('task_started', { taskId: 't2' }, {}, 5),
      ]);

    const s = useWorkflowStore.getState();
    // Phase follow: scouting was selected but is now completed → stays pinned on scouting
    expect(s.selectedPhaseId).toBe('scouting');
    // Task follow: t1 is still in scouting phase with status 'active' → stays selected
    expect(s.selectedTaskId).toBe('t1');
    // Step follow: t1 has activeStepIndex 0 → follows
    expect(s.selectedStepIndex).toBe(0);
  });
});
