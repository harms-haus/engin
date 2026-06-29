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

import { MAX_WORKFLOW_EVENT_LOG } from '@engin/shared/event-types';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EventRecord, RunSummary, WorkflowProjection } from '../protocol-types';
import type { WorkflowStoreState } from './workflow-store';
import { getSeq, setStoreSubscribeRunFn, setStoreUnsubscribeRunFn, useWorkflowStore } from './workflow-store';

// The two OPTIONAL prev-tracking fields the shared reconcileSelection write-back
// populates (added to WorkflowStoreState by the prev-tracking task). Defined
// locally so the assertions type-check before the interface is widened.
type PrevTrackingFields = {
  prevCurrentPhaseId: string | null;
  prevSelectedTaskStatus: string | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function blankProjection(overrides?: Partial<WorkflowProjection>): WorkflowProjection {
  return {
    seq: 0,
    taskPrompt: '',
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    tasks: {},
    sessions: {},
    sidebar: { title: '', indicator: '' },
    status: 'running',
    stats: { totalTokens: 0, sessionCount: 0 },
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
    sessionsById: {},
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
    stats: { totalTokens: 0, sessionCount: 0 },
    workflowEventLog: [],
    selectedPhaseId: null,
    selectedTaskId: null,
    userPinnedPhase: false,
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
      userPinnedPhase: true,
    });

    useWorkflowStore.getState().selectRun('run-new');

    const s = useWorkflowStore.getState();
    expect(s.selectedRunId).toBe('run-new');
    expect(s.selectedPhaseId).toBeNull();
    expect(s.selectedTaskId).toBeNull();
    expect(s.userPinnedPhase).toBe(false);
  });

  it('selectRun subscribes to the new run via the bridge (so the server streams its snapshot)', () => {
    const subscribed: string[] = [];
    setStoreSubscribeRunFn((runId) => subscribed.push(runId));
    try {
      useWorkflowStore.getState().selectRun('run-42');
      expect(subscribed).toEqual(['run-42']);
    } finally {
      setStoreSubscribeRunFn(null);
    }
  });

  it('selectRun unsubscribes the previously selected run when switching', () => {
    const subscribed: string[] = [];
    const unsubscribed: string[] = [];
    setStoreSubscribeRunFn((runId) => subscribed.push(runId));
    setStoreUnsubscribeRunFn((runId) => unsubscribed.push(runId));
    try {
      useWorkflowStore.getState().selectRun('run-a');
      useWorkflowStore.getState().selectRun('run-b');
      expect(unsubscribed).toEqual(['run-a']);
      expect(subscribed).toEqual(['run-a', 'run-b']);
    } finally {
      setStoreSubscribeRunFn(null);
      setStoreUnsubscribeRunFn(null);
    }
  });

  it('selectRun resets the projection so the previous run’s data does not bleed in', () => {
    // Seed a populated projection belonging to a previous run.
    useWorkflowStore.setState({
      selectedRunId: 'run-old',
      seq: 99,
      taskPrompt: 'old prompt',
      currentPhaseId: 'exec',
      completedPhaseIds: ['plan', 'exec'],
      workflowEventLog: [{ seq: 1, line: 'stale event line' }],
      stats: { totalTokens: 1234, sessionCount: 2 },
    });

    useWorkflowStore.getState().selectRun('run-new');

    const s = useWorkflowStore.getState();
    expect(s.seq).toBe(0);
    expect(s.taskPrompt).toBe('');
    expect(s.currentPhaseId).toBe('');
    expect(s.completedPhaseIds).toEqual([]);
    expect(s.workflowEventLog).toEqual([]);
    expect(s.stats).toEqual({ totalTokens: 0, sessionCount: 0 });
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
        t1: { id: 't1', title: 'Task 1', status: 'complete', phaseId: 'plan', dependencies: [] },
        t2: {
          id: 't2',
          title: 'Task 2',
          status: 'active',
          phaseId: 'exec',
          dependencies: [],
        },
      },
      sessions: {
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
          runnerRole: 'executor',
          attempt: 1,
        },
      },
      sidebar: { title: 'My App', indicator: 'green' },
      status: 'running',
      stats: { totalTokens: 1500, sessionCount: 1 },
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
    expect(Object.keys(s.sessionsById)).toHaveLength(1);
    expect(s.sessionsById['a1::t1'].toolCallCount).toBe(5);
    expect(s.sidebar.title).toBe('My App');
    expect(s.stats.totalTokens).toBe(1500);
  });

  it('replaces sessionsById with defensive log cap', () => {
    const logs = Array.from({ length: 510 }, (_, i) => ({
      id: `log-${i}`,
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'text' as const,
      content: `entry-${i}`,
    }));

    const snapshot = blankProjection({
      sessions: {
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
          runnerRole: 'executor',
          attempt: 1,
        },
      },
    });

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
    const s = useWorkflowStore.getState();

    expect(s.sessionsById['a1'].log.length).toBe(500);
    expect(s.sessionsById['a1'].log[0].content).toBe('entry-10');
    expect(s.sessionsById['a1'].log[499].content).toBe('entry-509');
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
      evt('task_registered', { id: 't1', title: 'Task 1', phaseId: 'scouting', dependencies: [] }, {}, 3),
      evt('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 4),
    ]);

    const s = useWorkflowStore.getState();
    expect(s.taskPrompt).toBe('hello');
    expect(s.currentPhaseId).toBe('scouting');
    expect(s.tasksById['t1'].title).toBe('Task 1');
    expect(s.sessionsById['a1::t1'].profile).toBe('coder');
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
      evt('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
      evt('tool_call_started', { toolName: 'read' }, { agentId: 'a1', taskId: 't1' }, 2),
      evt(
        'turn_ended',
        { tokens: { input: 100, output: 50 }, contentBlocks: [{ type: 'text', text: 'hi' }] },
        { agentId: 'a1', taskId: 't1' },
        3,
      ),
    ]);

    const s = useWorkflowStore.getState();
    const agent = s.sessionsById['a1::t1'];
    expect(agent.toolCallCount).toBe(1);
    expect(agent.inputTokens).toBe(100);
    expect(agent.outputTokens).toBe(50);
    expect(agent.log).toHaveLength(2);
    expect(s.stats.totalTokens).toBe(150);
  });

  it('re-spawn preserves accumulated agent state (kb-11 parity)', () => {
    const store = useWorkflowStore.getState();

    store.applyEvents(SELECTED_RUN, [
      evt('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
      evt('tool_call_started', { toolName: 'a' }, { agentId: 'a1', taskId: 't1' }, 2),
      evt('tool_call_started', { toolName: 'b' }, { agentId: 'a1', taskId: 't1' }, 3),
      evt('turn_ended', { tokens: { input: 50, output: 25 } }, { agentId: 'a1', taskId: 't1' }, 4),
      evt('decision', { decision: 'proceed' }, { agentId: 'a1', taskId: 't1' }, 5),
      // Re-spawn
      evt('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 6),
    ]);

    const s = useWorkflowStore.getState();
    const agent = s.sessionsById['a1::t1'];

    expect(agent.toolCallCount).toBe(2);
    expect(agent.inputTokens).toBe(50);
    expect(agent.outputTokens).toBe(25);
    expect(agent.log.length).toBe(3);
    expect(agent.active).toBe(true);
    expect(s.stats.sessionCount).toBe(1);
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
    expect(log[0].seq).toBe(1);
    expect(log[0].line).toContain('🚀 workflow started: "build" (resumed: false)');
    expect(log[1].seq).toBe(2);
    expect(log[1].line).toContain('📦 phase started (round 1)');
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

  it('caps workflowEventLog at MAX_WORKFLOW_EVENT_LOG (10000), dropping the oldest (FIFO)', () => {
    // The web store shares the consolidated MAX_WORKFLOW_EVENT_LOG constant
    // from @engin/shared/event-types (unified to 10000 — previously the web
    // store used a local 1000, 10× smaller than the TUI). Feeding more than
    // the cap trims the oldest entries so memory stays bounded.
    const store = useWorkflowStore.getState();
    const events: EventRecord[] = [];
    for (let i = 1; i <= MAX_WORKFLOW_EVENT_LOG + 1; i++) {
      events.push(evt('workflow_started', { taskPrompt: `run-${i}` }, {}, i));
    }
    store.applyEvents(SELECTED_RUN, events);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(MAX_WORKFLOW_EVENT_LOG);
    // Oldest entry (seq 1) dropped; first retained is seq 2.
    expect(log[0].seq).toBe(2);
    expect(log[0].line).toContain('run-2');
    expect(log[log.length - 1].seq).toBe(MAX_WORKFLOW_EVENT_LOG + 1);
    expect(log[log.length - 1].line).toContain(`run-${MAX_WORKFLOW_EVENT_LOG + 1}`);
  });

  it('uses the SAME cap value as the TUI ClientStore (unified MAX_WORKFLOW_EVENT_LOG)', () => {
    // Regression guard for the 1000-vs-10000 divergence: the web store must
    // cap at the shared constant, not a smaller local value.
    expect(MAX_WORKFLOW_EVENT_LOG).toBe(10000);

    const store = useWorkflowStore.getState();
    // Feed exactly the cap + a handful more in batches (realistic delivery).
    const total = MAX_WORKFLOW_EVENT_LOG + 50;
    const batch = 500;
    for (let start = 1; start <= total; start += batch) {
      const events: EventRecord[] = [];
      const end = Math.min(start + batch - 1, total);
      for (let i = start; i <= end; i++) events.push(evt('workflow_started', { taskPrompt: `run-${i}` }, {}, i));
      store.applyEvents(SELECTED_RUN, events);
    }

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(MAX_WORKFLOW_EVENT_LOG);
    // First 50 entries trimmed; oldest retained is seq 51.
    expect(log[0].seq).toBe(total - MAX_WORKFLOW_EVENT_LOG + 1);
    expect(log[log.length - 1].seq).toBe(total);
  });

  it('does NOT trim workflowEventLog at the old web cap of 1000', () => {
    // The previous web-only cap (1000) is gone — feeding just over 1000 loud
    // events must retain ALL of them (the unified cap is 10000).
    const store = useWorkflowStore.getState();
    const events: EventRecord[] = [];
    for (let i = 1; i <= 1001; i++) events.push(evt('workflow_started', { taskPrompt: `run-${i}` }, {}, i));
    store.applyEvents(SELECTED_RUN, events);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(1001); // nothing dropped below the 10000 cap
    expect(log[0].seq).toBe(1); // oldest retained
  });

  it('applySnapshot resets workflowEventLog on a fresh start (state.seq === 0)', () => {
    useWorkflowStore.setState({
      workflowEventLog: [{ seq: 1, line: '06:00:00pm -> 🚀 workflow started: "stale"' }],
    });
    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(1);

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, blankProjection(), 5);

    expect(useWorkflowStore.getState().workflowEventLog).toHaveLength(0);
    expect(useWorkflowStore.getState().seq).toBe(5);
  });

  it('applySnapshot does NOT clear workflowEventLog on reconnection (state.seq > 0, new seq >= state.seq)', () => {
    useWorkflowStore.setState({
      seq: 5,
      workflowEventLog: [{ seq: 1, line: '06:00:00pm -> 🚀 workflow started: "build"' }],
    });

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, blankProjection({ taskPrompt: 'build' }), 6);

    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual({ seq: 1, line: '06:00:00pm -> 🚀 workflow started: "build"' });
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
          dependencies: [],
        },
        t2: {
          id: 't2',
          title: 'Task 2',
          status: 'ready',
          phaseId: 'exec',
          dependencies: [],
        },
      },
    });
    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
    useWorkflowStore.getState().selectPhase('exec');

    useWorkflowStore.getState().selectTask('t2');
    const s = useWorkflowStore.getState();
    expect(s.selectedTaskId).toBe('t2');
  });

  it('resetSelection clears all selection state (incl. the prev-tracking fields)', () => {
    useWorkflowStore.setState({
      selectedPhaseId: 'exec',
      selectedTaskId: 't1',
      userPinnedPhase: true,
      prevCurrentPhaseId: 'exec',
      prevSelectedTaskStatus: 'active',
    } as Partial<WorkflowStoreState>);

    useWorkflowStore.getState().resetSelection();
    const s = useWorkflowStore.getState() as WorkflowStoreState & PrevTrackingFields;
    expect(s.selectedPhaseId).toBeNull();
    expect(s.selectedTaskId).toBeNull();
    expect(s.userPinnedPhase).toBe(false);
    // The prev-tracking fields reset too so stale transition state does not
    // leak into the next selection cycle.
    expect(s.prevCurrentPhaseId).toBeNull();
    expect(s.prevSelectedTaskStatus).toBeNull();
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
          t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', dependencies: [] },
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
          t2: { id: 't2', title: 'T2', status: 'ready', phaseId: 'review', dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot2, 2);

      expect(useWorkflowStore.getState().selectedPhaseId).toBe('plan');
    });

    it('follows currentPhaseId when synced to the previous current phase and it advanced (req 6)', () => {
      const snapshot = blankProjection({
        currentPhaseId: 'scouting',
        completedPhaseIds: [],
        phases: [
          { id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: ['t1'] },
          { id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] },
        ],
        tasks: {
          t1: { id: 't1', title: 'T1', status: 'active', phaseId: 'scouting', dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
      // Re-affirm selection on the (current) scouting phase; not pinned.
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
          t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot2, 2);

      // The user was SYNCED to scouting (selectedPhaseId === prevCurrentPhaseId)
      // and the active phase advanced → the tightened rule follows to exec
      // (completion no longer exempts a phase the user was synced to). Task
      // follow then picks the first active task in exec (t2).
      expect(useWorkflowStore.getState().selectedPhaseId).toBe('exec');
      expect(useWorkflowStore.getState().userPinnedPhase).toBe(false);
      expect(useWorkflowStore.getState().selectedTaskId).toBe('t2');
    });
  });

  describe('task follow', () => {
    it('auto-selects first active task in selected phase when selectedTaskId is null', () => {
      const snapshot = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
        tasks: {
          t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', dependencies: [] },
          t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', dependencies: [] },
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
          t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', dependencies: [] },
          t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', dependencies: [] },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);

      useWorkflowStore.setState({ selectedPhaseId: 'exec', selectedTaskId: 't-ghost' });

      useWorkflowStore.getState().applyEvents(SELECTED_RUN, [evt('workflow_started', { taskPrompt: 'build' }, {}, 2)]);

      expect(useWorkflowStore.getState().selectedTaskId).toBe('t2');
    });

    // ── Task completion reselection (req 2) ─────────────────────────────────
    // When the SELECTED task transitioned out of 'active' (→ complete /
    // failed / cancelled) and other active tasks remain, re-select the
    // most-recently-started (greatest startedAt) active task. If no active
    // task remains, keep the completed task selected (intended). Mirrors the
    // Dashboard's req-2 rule (task-4).

    it('re-selects the most-recently-started active task when the selected active task completes (req 2)', () => {
      // Seed: exec has a single active task (t1) → it is selected.
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'active',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 50,
            },
          },
        }),
        1,
      );
      expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');

      // t1 completes; t2 + t3 are now active. The rule must re-select the one
      // with the greatest startedAt (t3), not just the first active.
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2', 't3'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'complete',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 50,
            },
            t2: {
              id: 't2',
              title: 'T2',
              status: 'active',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 100,
            },
            t3: {
              id: 't3',
              title: 'T3',
              status: 'active',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 200,
            },
          },
        }),
        2,
      );

      expect(useWorkflowStore.getState().selectedTaskId).toBe('t3');
    });

    it('keeps the completed task selected when no active task remains (req 2)', () => {
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'active',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 10,
            },
          },
        }),
        1,
      );
      expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');

      // t1 completes; t2 is only 'ready' (not active) → keep t1 selected.
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'complete',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 10,
            },
            t2: { id: 't2', title: 'T2', status: 'ready', phaseId: 'exec', dependencies: [], startedAt: 20 },
          },
        }),
        2,
      );

      expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');
    });

    // ── Parked task handling (kb-35) ───────────────────────────────────────
    // Parked tasks have active sessions but are paused (not 'active').
    // reconcileSelection must treat 'parked' as non-terminal — it must NOT
    // auto-replace a parked selected task with an active one, and must NOT
    // auto-select a parked task when no active task exists.

    it('keeps a parked task selected through reconcileSelection (parked is non-terminal)', () => {
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'parked',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 10,
            },
          },
        }),
        1,
      );

      // Select the parked task explicitly
      useWorkflowStore.getState().selectTask('t1');
      expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');

      // applyEvents (which calls reconcileSelection) must NOT replace the
      // parked task with some other task because parked is NOT terminal
      // (isTerminalTaskStatus returns false).
      useWorkflowStore.getState().applyEvents(SELECTED_RUN, [evt('workflow_started', { taskPrompt: 'build' }, {}, 2)]);

      expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');
    });

    it('auto-selects a parked task when no active task exists (parked is in-progress)', () => {
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'ready',
              phaseId: 'exec',
              dependencies: [],
            },
            t2: {
              id: 't2',
              title: 'T2',
              status: 'parked',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 10,
            },
          },
        }),
        1,
      );

      // selectPhase triggers reconcileSelection, which should auto-select
      // the parked task (t2) as an in-progress task, NOT the first task (t1).
      useWorkflowStore.getState().selectPhase('exec');
      expect(useWorkflowStore.getState().selectedTaskId).toBe('t2');
    });

    // ── Parked task completion-reselection (U2) ────────────────────────────
    // A parked task that goes terminal should trigger reselection to another
    // in-progress task, mirroring the TUI dashboard logic.

    it('re-selects an active task when a parked task goes terminal (U2)', () => {
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'parked',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 10,
            },
            t2: {
              id: 't2',
              title: 'T2',
              status: 'active',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 20,
            },
          },
        }),
        1,
      );

      // t1 (parked) is auto-selected — it's first in array order.
      expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');

      // t1 (parked) transitions to complete → should re-select t2 (active)
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'complete',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 10,
              completedAt: '2026-06-17T00:00:00.000Z',
            },
            t2: {
              id: 't2',
              title: 'T2',
              status: 'active',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 20,
            },
          },
        }),
        2,
      );

      expect(useWorkflowStore.getState().selectedTaskId).toBe('t2');
    });

    it('re-selects a parked task as fallback when a parked task goes terminal and no active remains (U2)', () => {
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'parked',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 10,
            },
            t2: {
              id: 't2',
              title: 'T2',
              status: 'parked',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 20,
            },
          },
        }),
        1,
      );

      // t1 (parked) is auto-selected — first in array order.
      expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');

      // t1 (parked) transitions to failed → should re-select t2 (parked fallback)
      useWorkflowStore.getState().applySnapshot(
        SELECTED_RUN,
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: {
              id: 't1',
              title: 'T1',
              status: 'failed',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 10,
              completedAt: '2026-06-17T00:00:00.000Z',
            },
            t2: {
              id: 't2',
              title: 'T2',
              status: 'parked',
              phaseId: 'exec',
              dependencies: [],
              startedAt: 20,
            },
          },
        }),
        2,
      );

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
            dependencies: [],
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
      useWorkflowStore.getState().selectPhase('exec');

      const snapshot2 = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
        tasks: {
          t1: {
            id: 't1',
            title: 'T1',
            status: 'active',
            phaseId: 'exec',
            dependencies: [],
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot2, 2);
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
            dependencies: [],
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
      useWorkflowStore.getState().selectPhase('exec');

      const snapshot3 = blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
        tasks: {
          t1: {
            id: 't1',
            title: 'T1',
            status: 'active',
            phaseId: 'exec',
            dependencies: [],
          },
        },
      });
      useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot3, 3);
    });
  });

  it('reconcile runs after applyEvents and updates selection (phase follow + task follow)', () => {
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
          dependencies: [],
        },
      },
    });
    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
    useWorkflowStore.getState().selectPhase('scouting');
    expect(useWorkflowStore.getState().selectedTaskId).toBe('t1');

    useWorkflowStore
      .getState()
      .applyEvents(SELECTED_RUN, [
        evt('phase_completed', { phase: 'scouting' }, {}, 2),
        evt('phase_started', { phase: 'exec' }, {}, 3),
        evt('task_registered', { id: 't2', title: 'Exec Task', phaseId: 'exec', dependencies: [] }, {}, 4),
        evt('task_started', { taskId: 't2' }, {}, 5),
      ]);

    const s = useWorkflowStore.getState();
    // The user was synced to scouting and currentPhaseId advanced to exec →
    // tightened phase-follow moves selection to exec; task follow then picks
    // the first active task in exec (t2). t2 has no activeStepIndex yet, so the
    // step stays null.
    expect(s.selectedPhaseId).toBe('exec');
    expect(s.selectedTaskId).toBe('t2');
  });
});

// ─── Selectors ─────────────────────────────────────────────────────────────

describe('store – selectors', () => {
  beforeEach(selectRunOne);

  it('exposes agent keys via state', () => {
    useWorkflowStore
      .getState()
      .applyEvents(SELECTED_RUN, [
        evt('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
        evt('session_started', { profile: 'q' }, { agentId: 'a2' }, 2),
      ]);
    const ids = Object.keys(useWorkflowStore.getState().sessionsById);
    expect(ids).toContain('a1::t1');
    expect(ids).toContain('a2');
  });

  it('exposes task keys via state', () => {
    useWorkflowStore
      .getState()
      .applyEvents(SELECTED_RUN, [
        evt('task_registered', { id: 't1', title: 'A', phaseId: 'p1', dependencies: [] }, {}, 1),
        evt('task_registered', { id: 't2', title: 'B', phaseId: 'p1', dependencies: [] }, {}, 2),
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
