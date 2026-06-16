/**
 * Workflow store tests — multi-run protocol.
 *
 * The store is transitional: it holds a single active projection (the
 * "selected run") but is multi-run-ready. Every projection action
 * (`applySnapshot`, `applyEvents`, `setStatus`, `setFailed`) now takes a
 * `runId` first argument and only mutates state when `runId === selectedRunId`.
 *
 * Covers:
 * - runs management: setRuns / addRun
 * - selectedRunId + selectRun
 * - runId gating on projection actions
 * - appendRunLog (per-run, NOT gated)
 * - applySnapshot (full replace, defensive log cap, event-log reset)
 * - applyEvents (fold through evolveClient, seq advance, tokens, re-spawn parity)
 * - setStatus / setFailed (gated)
 * - selection actions + follow rules (phase / task / step)
 * - workflowEventLog accumulation + cap
 * - selector hooks
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { EventRecord, RunSummary, WorkflowProjection } from '../protocol-types';
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
    runLog: [],
    ...overrides,
  };
}

function runSummary(overrides?: Partial<RunSummary>): RunSummary {
  return {
    runId: 'run-1',
    cwd: '/tmp/work',
    workflowName: 'default',
    taskPrompt: 'do something',
    status: 'running',
    startedAt: '2025-01-01T00:00:00.000Z',
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

// The run that projection/selection tests operate on.
const SELECTED_RUN = 'run-1';

// ─── Reset store between tests ─────────────────────────────────────────────

function resetStore(): void {
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
    // Multi-run fields
    runs: [],
    selectedRunId: null,
    runLogs: {},
  });
}

/** Select `run-1` so the (gated) projection actions take effect. */
function selectRunOne(): void {
  useWorkflowStore.setState({ selectedRunId: SELECTED_RUN });
}

beforeEach(() => {
  resetStore();
});

// ─── runs management ──────────────────────────────────────────────────────

describe('store – runs management', () => {
  it('starts with an empty runs array', () => {
    expect(useWorkflowStore.getState().runs).toEqual([]);
  });

  it('setRuns replaces the entire runs array', () => {
    const store = useWorkflowStore.getState();
    store.setRuns([runSummary({ runId: 'a' }), runSummary({ runId: 'b' })]);
    expect(useWorkflowStore.getState().runs.map((r) => r.runId)).toEqual(['a', 'b']);
  });

  it('setRuns can clear the runs array', () => {
    const store = useWorkflowStore.getState();
    store.setRuns([runSummary({ runId: 'a' })]);
    store.setRuns([]);
    expect(useWorkflowStore.getState().runs).toEqual([]);
  });

  it('addRun appends a new run summary', () => {
    const store = useWorkflowStore.getState();
    store.setRuns([runSummary({ runId: 'a' })]);
    store.addRun(runSummary({ runId: 'b', taskPrompt: 'second' }));
    const runs = useWorkflowStore.getState().runs;
    expect(runs).toHaveLength(2);
    expect(runs[1].runId).toBe('b');
    expect(runs[1].taskPrompt).toBe('second');
  });

  it('addRun is idempotent for an existing runId (updates in place, no duplicate)', () => {
    const store = useWorkflowStore.getState();
    store.addRun(runSummary({ runId: 'a', status: 'running' }));
    store.addRun(runSummary({ runId: 'a', status: 'complete' }));
    const runs = useWorkflowStore.getState().runs;
    expect(runs.filter((r) => r.runId === 'a')).toHaveLength(1);
    expect(runs[0].status).toBe('complete');
  });
});

// ─── selectedRunId & selectRun ────────────────────────────────────────────

describe('store – selectedRunId & selectRun', () => {
  it('starts with selectedRunId null', () => {
    expect(useWorkflowStore.getState().selectedRunId).toBeNull();
  });

  it('selectRun sets selectedRunId', () => {
    useWorkflowStore.getState().selectRun('run-42');
    expect(useWorkflowStore.getState().selectedRunId).toBe('run-42');
  });

  it('selectRun resets phase / task / step selection for the new run', () => {
    // Seed selection state belonging to a previous run.
    useWorkflowStore.setState({
      selectedRunId: 'run-old',
      selectedPhaseId: 'exec',
      selectedTaskId: 't1',
      selectedStepIndex: 2,
      userPinnedPhase: true,
      userPinnedStep: true,
    });

    useWorkflowStore.getState().selectRun('run-new');

    const s = useWorkflowStore.getState();
    expect(s.selectedRunId).toBe('run-new');
    expect(s.selectedPhaseId).toBeNull();
    expect(s.selectedTaskId).toBeNull();
    expect(s.selectedStepIndex).toBeNull();
    expect(s.userPinnedPhase).toBe(false);
    expect(s.userPinnedStep).toBe(false);
  });
});

// ─── runId gating ─────────────────────────────────────────────────────────

describe('store – runId gating', () => {
  beforeEach(selectRunOne);

  describe('applySnapshot', () => {
    it('applies when runId matches selectedRunId', () => {
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, blankProjection({ taskPrompt: 'hello', seq: 10 }), 10);

      const s = useWorkflowStore.getState();
      expect(s.taskPrompt).toBe('hello');
      expect(s.seq).toBe(10);
    });

    it('is a no-op when runId does not match selectedRunId', () => {
      useWorkflowStore.getState().applySnapshot('run-other', blankProjection({ taskPrompt: 'hello', seq: 10 }), 10);

      const s = useWorkflowStore.getState();
      expect(s.taskPrompt).toBe('');
      expect(s.seq).toBe(0);
    });

    it('is a no-op when no run is selected', () => {
      resetStore(); // selectedRunId = null
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, blankProjection({ taskPrompt: 'hello', seq: 10 }), 10);

      const s = useWorkflowStore.getState();
      expect(s.taskPrompt).toBe('');
      expect(s.seq).toBe(0);
    });
  });

  describe('applyEvents', () => {
    it('applies when runId matches selectedRunId', () => {
      useWorkflowStore.getState().applyEvents(SELECTED_RUN, [evt('workflow_started', { taskPrompt: 'hello' }, {}, 1)]);
      expect(useWorkflowStore.getState().taskPrompt).toBe('hello');
      expect(getSeq()).toBe(1);
    });

    it('is a no-op when runId does not match selectedRunId', () => {
      useWorkflowStore.getState().applyEvents('run-other', [evt('workflow_started', { taskPrompt: 'hello' }, {}, 1)]);
      expect(useWorkflowStore.getState().taskPrompt).toBe('');
      expect(getSeq()).toBe(0);
    });
  });

  describe('setStatus', () => {
    it('applies when runId matches selectedRunId', () => {
      useWorkflowStore.getState().setStatus(SELECTED_RUN, 'complete');
      expect(useWorkflowStore.getState().status).toBe('complete');
    });

    it('is a no-op when runId does not match selectedRunId', () => {
      useWorkflowStore.getState().setStatus('run-other', 'complete');
      expect(useWorkflowStore.getState().status).toBe('running');
    });
  });

  describe('setFailed', () => {
    it('applies when runId matches selectedRunId', () => {
      useWorkflowStore.getState().setFailed(SELECTED_RUN, 'boom', 'exec');
      const s = useWorkflowStore.getState();
      expect(s.status).toBe('failed');
      expect(s.error).toBe('boom');
      expect(s.failedPhase).toBe('exec');
    });

    it('is a no-op when runId does not match selectedRunId', () => {
      useWorkflowStore.getState().setFailed('run-other', 'boom', 'exec');
      const s = useWorkflowStore.getState();
      expect(s.status).toBe('running');
      expect(s.error).toBeUndefined();
      expect(s.failedPhase).toBeUndefined();
    });
  });
});

// ─── appendRunLog ─────────────────────────────────────────────────────────

describe('store – appendRunLog', () => {
  it('appends a log entry to the matching run', () => {
    const store = useWorkflowStore.getState();
    store.appendRunLog('run-1', {
      level: 'info',
      message: 'starting up',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    const logs = useWorkflowStore.getState().runLogs['run-1'];
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      level: 'info',
      message: 'starting up',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
  });

  it('keeps logs for different runs separate (NOT gated by selectedRunId)', () => {
    const store = useWorkflowStore.getState();
    // No run is selected at all.
    expect(useWorkflowStore.getState().selectedRunId).toBeNull();

    store.appendRunLog('run-1', { level: 'info', message: 'a', timestamp: 't1' });
    store.appendRunLog('run-2', { level: 'warn', message: 'b', timestamp: 't2' });
    store.appendRunLog('run-1', { level: 'error', message: 'c', timestamp: 't3' });

    const s = useWorkflowStore.getState();
    expect(s.runLogs['run-1']).toHaveLength(2);
    expect(s.runLogs['run-1'][1].message).toBe('c');
    expect(s.runLogs['run-2']).toHaveLength(1);
    expect(s.runLogs['run-2'][0].message).toBe('b');
  });

  it('accumulates entries in arrival order', () => {
    const store = useWorkflowStore.getState();
    for (let i = 0; i < 5; i++) {
      store.appendRunLog('run-1', { level: 'info', message: `m${i}`, timestamp: `t${i}` });
    }
    expect(useWorkflowStore.getState().runLogs['run-1'].map((e) => e.message)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });
});

// ─── applySnapshot (projection) ───────────────────────────────────────────

describe('store – applySnapshot (projection)', () => {
  beforeEach(selectRunOne);

  it('replaces the entire store from a snapshot', () => {
    const snapshot: WorkflowProjection = {
      seq: 42,
      taskPrompt: 'build something',
      phases: [{ id: 'plan', label: 'Plan', icon: '📋', taskIds: ['t1'] }],
      currentPhaseId: 'exec',
      completedPhaseIds: ['plan'],
      tasks: {
        t1: { id: 't1', title: 'Task 1', status: 'complete', phaseId: 'plan', steps: [], dependencies: [] },
        t2: {
          id: 't2',
          title: 'Task 2',
          status: 'active',
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
      runLog: [],
    };

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 42);
    const s = useWorkflowStore.getState();

    expect(s.seq).toBe(42);
    expect(s.taskPrompt).toBe('build something');
    expect(s.currentPhaseId).toBe('exec');
    expect(s.completedPhaseIds).toEqual(['plan']);
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0].id).toBe('plan');
    expect(Object.keys(s.tasksById)).toHaveLength(2);
    expect(s.tasksById['t1'].status).toBe('complete');
    expect(Object.keys(s.agentsById)).toHaveLength(1);
    expect(s.agentsById['a1::t1'].toolCallCount).toBe(5);
    expect(s.sidebar.title).toBe('My App');
    expect(s.stats.totalTokens).toBe(1500);
  });

  it('replaces agentsById with defensive log cap', () => {
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

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
    const s = useWorkflowStore.getState();

    expect(s.agentsById['a1'].log.length).toBe(500);
    expect(s.agentsById['a1'].log[0].content).toBe('entry-10');
    expect(s.agentsById['a1'].log[499].content).toBe('entry-509');
  });

  it('sets getSeq() to match the seq argument', () => {
    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, blankProjection(), 99);
    expect(getSeq()).toBe(99);
  });
});

// ─── applyEvents (projection) ─────────────────────────────────────────────

describe('store – applyEvents (projection)', () => {
  beforeEach(selectRunOne);

  it('folds a sequence of events through evolveClient', () => {
    const store = useWorkflowStore.getState();

    store.applyEvents(SELECTED_RUN, [
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
      .applyEvents(SELECTED_RUN, [evt('workflow_started', {}, {}, 5), evt('phase_started', { phase: 'a' }, {}, 10)]);
    expect(getSeq()).toBe(10);
  });

  it('ignores an empty events batch', () => {
    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, blankProjection({ seq: 7 }), 7);
    useWorkflowStore.getState().applyEvents(SELECTED_RUN, []);
    expect(getSeq()).toBe(7);
  });

  it('applies turn_ended tokens and tool_call events', () => {
    const store = useWorkflowStore.getState();

    store.applyEvents(SELECTED_RUN, [
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
    expect(agent.log).toHaveLength(2);
    expect(s.stats.totalTokens).toBe(150);
  });

  it('re-spawn preserves accumulated agent state (kb-11 parity)', () => {
    const store = useWorkflowStore.getState();

    store.applyEvents(SELECTED_RUN, [
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

    expect(agent.toolCallCount).toBe(2);
    expect(agent.inputTokens).toBe(50);
    expect(agent.outputTokens).toBe(25);
    expect(agent.log.length).toBe(3);
    expect(agent.active).toBe(true);
    expect(s.stats.agentCount).toBe(1);
  });
});

// ─── setStatus / setFailed (projection) ───────────────────────────────────

describe('store – setStatus / setFailed (projection)', () => {
  beforeEach(selectRunOne);

  it('sets status to complete', () => {
    useWorkflowStore.getState().setStatus(SELECTED_RUN, 'complete');
    expect(useWorkflowStore.getState().status).toBe('complete');
  });

  it('sets status back to running', () => {
    useWorkflowStore.getState().setStatus(SELECTED_RUN, 'failed');
    useWorkflowStore.getState().setStatus(SELECTED_RUN, 'running');
    expect(useWorkflowStore.getState().status).toBe('running');
  });

  it('setFailed marks the run failed with error + phase', () => {
    useWorkflowStore.getState().setFailed(SELECTED_RUN, 'kaboom', 'exec');
    const s = useWorkflowStore.getState();
    expect(s.status).toBe('failed');
    expect(s.error).toBe('kaboom');
    expect(s.failedPhase).toBe('exec');
  });
});

// ─── workflowEventLog ─────────────────────────────────────────────────────

describe('store – workflowEventLog', () => {
  beforeEach(selectRunOne);

  it('populates workflowEventLog with lifecycle event lines', () => {
    useWorkflowStore
      .getState()
      .applyEvents(SELECTED_RUN, [
        evt('workflow_started', { taskPrompt: 'build', resumed: false }, {}, 1),
        evt('phase_started', { phase: 'scouting', round: 1 }, {}, 2),
      ]);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({ seq: 1, line: '🚀 Workflow started: "build" (resumed: false)' });
    expect(log[1]).toEqual({ seq: 2, line: '📦 Phase: scouting (round 1)' });
  });

  it('does NOT add entries for verbose events (decision, tool_call_started, turn_ended)', () => {
    useWorkflowStore
      .getState()
      .applyEvents(SELECTED_RUN, [
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
    const events: EventRecord[] = [];
    for (let i = 1; i <= 1001; i++) {
      events.push(evt('workflow_started', { taskPrompt: `run-${i}` }, {}, i));
    }
    store.applyEvents(SELECTED_RUN, events);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(1000);
    expect(log[0].seq).toBe(2);
    expect(log[0].line).toContain('run-2');
    expect(log[999].seq).toBe(1001);
    expect(log[999].line).toContain('run-1001');
  });

  it('applySnapshot resets workflowEventLog on a fresh start (state.seq === 0)', () => {
    useWorkflowStore.setState({
      workflowEventLog: [{ seq: 1, line: '🚀 Workflow started: "stale"' }],
    });
    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(1);

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, blankProjection(), 5);

    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(0);
    expect(useWorkflowStore.getState().seq).toBe(5);
  });

  it('applySnapshot does NOT clear workflowEventLog on reconnection (state.seq > 0, new seq >= state.seq)', () => {
    useWorkflowStore.setState({
      seq: 5,
      workflowEventLog: [{ seq: 1, line: '🚀 Workflow started: "build"' }],
    });

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, blankProjection({ taskPrompt: 'build' }), 6);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual({ seq: 1, line: '🚀 Workflow started: "build"' });
    expect(useWorkflowStore.getState().seq).toBe(6);
  });

  it('does NOT accumulate workflowEventLog when events are for a different run', () => {
    useWorkflowStore.getState().applyEvents('run-other', [evt('workflow_started', { taskPrompt: 'x' }, {}, 1)]);
    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(0);
  });
});

// ─── Selection actions ──────────────────────────────────────────────────

describe('store – selection actions', () => {
  beforeEach(selectRunOne);

  it('selectPhase sets selectedPhaseId and pins when phase is completed', () => {
    const store = useWorkflowStore.getState();

    store.applyEvents(SELECTED_RUN, [
      evt('sidebar_updated', { title: 'App', indicator: 'green' }, {}, 1),
      evt('phase_registered', { id: 'plan', label: 'Plan', icon: '📋' }, {}, 2),
      evt('phase_registered', { id: 'exec', label: 'Exec', icon: '⚡' }, {}, 3),
      evt('phase_completed', { phase: 'plan' }, {}, 4),
    ]);

    store.selectPhase('plan');
    let s = useWorkflowStore.getState();
    expect(s.selectedPhaseId).toBe('plan');
    expect(s.userPinnedPhase).toBe(true);

    store.selectPhase('exec');
    s = useWorkflowStore.getState();
    expect(s.selectedPhaseId).toBe('exec');
    expect(s.userPinnedPhase).toBe(false);
  });

  it('selectPhase with null sets selectedPhaseId to null and no pin', () => {
    useWorkflowStore.getState().selectPhase(null);
    const s = useWorkflowStore.getState();
    expect(s.selectedPhaseId).toBeNull();
    expect(s.userPinnedPhase).toBe(false);
  });

  it('selectTask sets selectedTaskId and resets step pin', () => {
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
    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
    useWorkflowStore.getState().selectPhase('exec');

    useWorkflowStore.getState().selectStep(0);
    expect(useWorkflowStore.getState().userPinnedStep).toBe(true);

    useWorkflowStore.getState().selectTask('t2');
    const s = useWorkflowStore.getState();
    expect(s.selectedTaskId).toBe('t2');
    expect(s.selectedStepIndex).toBeNull();
    expect(s.userPinnedStep).toBe(false);
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
  beforeEach(selectRunOne);

  describe('phase follow', () => {
    it('keeps a pinned (completed) phase selected when currentPhaseId moves on', () => {
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
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);

      useWorkflowStore.getState().selectPhase('plan');
      expect(useWorkflowStore.getState().selectedPhaseId).toBe('plan');
      expect(useWorkflowStore.getState().userPinnedPhase).toBe(true);

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
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot2, 2);

      expect(useWorkflowStore.getState().selectedPhaseId).toBe('plan');
    });

    it('follows currentPhaseId when the selected phase is not pinned', () => {
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
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);

      useWorkflowStore.getState().selectPhase('scouting');
      expect(useWorkflowStore.getState().userPinnedPhase).toBe(false);

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
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot2, 2);

      // scouting is now completed → pinned, stays on scouting
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
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);

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
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);

      useWorkflowStore.setState({ selectedPhaseId: 'exec', selectedTaskId: 't-ghost' });

      useWorkflowStore.getState().applyEvents(SELECTED_RUN, [evt('workflow_started', { taskPrompt: 'build' }, {}, 2)]);

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
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
      useWorkflowStore.getState().selectPhase('exec');
      expect(useWorkflowStore.getState().selectedStepIndex).toBe(0);

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
            activeStepIndex: 1,
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot2, 2);
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
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
      useWorkflowStore.getState().selectPhase('exec');

      useWorkflowStore.getState().selectStep(1);
      expect(useWorkflowStore.getState().selectedStepIndex).toBe(1);
      expect(useWorkflowStore.getState().userPinnedStep).toBe(true);

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
            activeStepIndex: 2,
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot3, 3);
      expect(useWorkflowStore.getState().selectedStepIndex).toBe(1);
    });
  });

  it('reconcile runs after applyEvents and updates selection', () => {
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
    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
    useWorkflowStore.getState().selectPhase('scouting');
    expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');
    expect(useWorkflowStore.getState().selectedStepIndex).toBe(0);

    useWorkflowStore
      .getState()
      .applyEvents(SELECTED_RUN, [
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
    // scouting was selected and is now completed → pinned, stays
    expect(s.selectedPhaseId).toBe('scouting');
    expect(s.selectedTaskId).toBe('t1');
    expect(s.selectedStepIndex).toBe(0);
  });
});

// ─── Selectors ─────────────────────────────────────────────────────────────

describe('store – selectors', () => {
  beforeEach(selectRunOne);

  it('exposes agent keys via state', () => {
    useWorkflowStore
      .getState()
      .applyEvents(SELECTED_RUN, [
        evt('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
        evt('agent_spawned', { profile: 'q' }, { agentId: 'a2' }, 2),
      ]);
    const ids = Object.keys(useWorkflowStore.getState().agentsById);
    expect(ids).toContain('a1::t1');
    expect(ids).toContain('a2');
  });

  it('exposes task keys via state', () => {
    useWorkflowStore
      .getState()
      .applyEvents(SELECTED_RUN, [
        evt('task_registered', { id: 't1', title: 'A', phaseId: 'p1', steps: [], dependencies: [] }, {}, 1),
        evt('task_registered', { id: 't2', title: 'B', phaseId: 'p1', steps: [], dependencies: [] }, {}, 2),
      ]);
    const ids = Object.keys(useWorkflowStore.getState().tasksById);
    expect(ids).toContain('t1');
    expect(ids).toContain('t2');
  });

  it('useSeq / getSeq returns current seq', () => {
    expect(getSeq()).toBe(0);
    useWorkflowStore.getState().applyEvents(SELECTED_RUN, [evt('workflow_started', {}, {}, 7)]);
    expect(getSeq()).toBe(7);
  });
});
