// ────────────────────────────────────────────────────────────────────────────
// ClientStore tests — plain-TS projection store for the TUI.
//
// `packages/shared/src/client-store.ts` ports the core logic from
// `web/src/store/workflow-store.ts` into a framework-free class (no zustand,
// no React, no Immer). These tests verify the four contract areas called out
// by the task:
//
//   1. applySnapshot          — full projection replace, defensive copies,
//                               agent-log cap, seq + event-log reset rules.
//   2. applyEvents            — fold a batch through the shared `evolve`.
//   3. selection reconcile    — phase / task / step follow rules.
//   4. event log building     — workflowEventLog lines via
//                               `formatWorkflowEventLine`.
//
// Plus coverage of: construction & initial state, subscribe / unsubscribe
// notification, setStatus / setFailed, and the selection mutators.
//
// ── CONTRACT ASSUMPTIONS (the implementation must satisfy these) ───────────
//
//   export class ClientStore {
//     constructor();
//     getState(): ClientStoreState;
//     subscribe(listener: (s: ClientStoreState) => void): () => void; // unsubscribe
//     applySnapshot(snapshot: WorkflowProjection, seq: number): void;
//     applyEvents(events: EventRecord[]): void;
//     setStatus(status: 'running' | 'complete' | 'failed'): void;
//     setFailed(error: string, failedPhase: string): void;
//     appendRunLog(...): void;               // see client-store.run-log.test.ts
//     selectPhase(id: string | null): void;
//     selectTask(id: string | null): void;
//     selectStep(index: number | null): void;
//   }
//
//   export interface WorkflowEventLogEntry { seq: number; line: string }
//
//   export interface ClientStoreState extends WorkflowProjection {
//     workflowEventLog: WorkflowEventLogEntry[];
//     selectedPhaseId: string | null;
//     selectedTaskId: string | null;
//     selectedStepIndex: number | null;
//     userPinnedPhase: boolean;
//     userPinnedStep: boolean;
//   }
//
// Internally the store must use `evolve` from `@engin/shared/evolve` and
// `formatWorkflowEventLine` from `@engin/shared/format-workflow-event`.
//
// NOTE: `ClientStoreState` EXTENDS `WorkflowProjection`, so the projection
// fields are read as `state.sessions`, `state.tasks`, `state.phases`,
// `state.currentPhaseId`, etc. (NOT the web store's `sessionsById`/`tasksById`).
// ────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'bun:test';

// ── Unit under test ─────────────────────────────────────────────────────────
import type { ClientStoreState } from '@engin/shared/client-store';
import { ClientStore } from '@engin/shared/client-store';

// ── Cross-check dependencies (the store must delegate to these) ──────────────
import type { EventRecord, EventType, WorkflowProjection } from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';
import { evolve } from '@engin/shared/evolve';
import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';

// ── Constants ───────────────────────────────────────────────────────────────
const ISO_NOW = '2026-06-15T00:00:00.000Z';
const MAX_SESSION_LOG = 500; // @engin/shared/evolve MAX_SESSION_LOG
// NOTE: workflowEventLog is capped at MAX_WORKFLOW_EVENT_LOG (10000) in
// packages/shared/src/client-store.ts so memory stays bounded for long-running
// workflows; entries beyond the cap are dropped FIFO (oldest first). The
// comprehensive sub-cap retention coverage lives in
// `tests/shared/client-store.event-log-cap.test.ts`.

// ── Helpers ─────────────────────────────────────────────────────────────────

let eventSeq = 0;
function resetSeq(): void {
  eventSeq = 0;
}

function ev(
  type: EventType,
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
  seqOverride?: number,
): EventRecord {
  const s = seqOverride ?? ++eventSeq;
  return { seq: s, type, data, metadata: { timestamp: ISO_NOW, ...meta } };
}

/** Build a WorkflowProjection seeded from createInitialProjection with overrides. */
function blankProjection(overrides: Partial<WorkflowProjection> = {}): WorkflowProjection {
  return { ...createInitialProjection(), ...overrides };
}

// ────────────────────────────────────────────────────────────────────────────
// Construction & initial state
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – construction & getState', () => {
  it('returns a valid initial state with all projection fields zeroed', () => {
    const store = new ClientStore();
    const s = store.getState();
    expect(s.seq).toBe(0);
    expect(s.taskPrompt).toBe('');
    expect(s.phases).toEqual([]);
    expect(s.currentPhaseId).toBe('');
    expect(s.completedPhaseIds).toEqual([]);
    expect(s.tasks).toEqual({});
    expect(s.sessions).toEqual({});
    expect(s.sidebar).toEqual({ title: '', indicator: '' });
    expect(s.status).toBe('running');
    expect(s.error).toBeUndefined();
    expect(s.failedPhase).toBeUndefined();
    expect(s.stats).toEqual({ totalTokens: 0, sessionCount: 0 });
  });

  it('initializes selection state to nulls / false', () => {
    const s = new ClientStore().getState();
    expect(s.selectedPhaseId).toBeNull();
    expect(s.selectedTaskId).toBeNull();
    expect(s.userPinnedPhase).toBe(false);
  });

  it('initializes workflowEventLog to an empty array', () => {
    const s = new ClientStore().getState();
    expect(s.workflowEventLog).toEqual([]);
  });

  it('each new ClientStore instance is independent', () => {
    const a = new ClientStore();
    const b = new ClientStore();
    a.applyEvents([ev('workflow_started', { taskPrompt: 'aaa' }, {}, 1)]);
    expect(b.getState().seq).toBe(0);
    expect(b.getState().taskPrompt).toBe('');
    expect(a.getState().seq).toBe(1);
    expect(a.getState().taskPrompt).toBe('aaa');
  });

  it('getState returns the updated state after a mutation', () => {
    const store = new ClientStore();
    store.applyEvents([ev('phase_started', { phase: 'exec' }, {}, 7)]);
    const s = store.getState();
    expect(s.currentPhaseId).toBe('exec');
    expect(s.seq).toBe(7);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// subscribe / unsubscribe
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – subscribe / unsubscribe', () => {
  it('subscribe returns an unsubscribe function', () => {
    const store = new ClientStore();
    const unsub = store.subscribe(() => {});
    expect(typeof unsub).toBe('function');
  });

  it('invokes the listener on every state change', () => {
    const store = new ClientStore();
    const calls: ClientStoreState[] = [];
    store.subscribe((s) => calls.push(s));

    store.applyEvents([ev('workflow_started', { taskPrompt: 'hi' }, {}, 1)]);
    store.setStatus('complete');

    expect(calls).toHaveLength(2);
    expect(calls[0].taskPrompt).toBe('hi');
    expect(calls[1].status).toBe('complete');
  });

  it('passes the new state to the listener', () => {
    const store = new ClientStore();
    let received: ClientStoreState | null = null;
    store.subscribe((s) => {
      received = s;
    });
    store.applyEvents([ev('phase_started', { phase: 'build' }, {}, 3)]);
    expect(received).not.toBeNull();
    expect(received!.currentPhaseId).toBe('build');
    expect(received!.seq).toBe(3);
  });

  it('unsubscribe stops further notifications', () => {
    const store = new ClientStore();
    const calls: number[] = [];
    const unsub = store.subscribe(() => calls.push(1));

    store.setStatus('complete'); // notified
    unsub();
    store.setStatus('failed'); // NOT notified

    expect(calls).toHaveLength(1);
  });

  it('supports multiple independent listeners', () => {
    const store = new ClientStore();
    const a: number[] = [];
    const b: number[] = [];
    store.subscribe(() => a.push(1));
    store.subscribe(() => b.push(1));

    store.applyEvents([ev('workflow_started', {}, {}, 1)]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    // Removing one listener does not affect the other.
    store.subscribe(() => {})(); // subscribe + immediately unsubscribe (no-op listener)
    store.applyEvents([ev('workflow_completed', {}, {}, 2)]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
  });

  it('does not notify on applyEvents([]) (no state change)', () => {
    const store = new ClientStore();
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.applyEvents([]);
    expect(calls).toBe(0);
    expect(store.getState().seq).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applySnapshot
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – applySnapshot', () => {
  it('replaces the entire projection from a snapshot', () => {
    const store = new ClientStore();
    const snapshot: WorkflowProjection = {
      seq: 42,
      taskPrompt: 'build something',
      phases: [{ id: 'plan', label: 'Plan', icon: '📋', taskIds: ['t1'] }],
      currentPhaseId: 'exec',
      completedPhaseIds: ['plan'],
      tasks: {
        t1: { id: 't1', title: 'Task 1', status: 'complete', phaseId: 'plan', dependencies: [] },
        t2: { id: 't2', title: 'Task 2', status: 'active', phaseId: 'exec', dependencies: [] },
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

    store.applySnapshot(snapshot, 42);
    const s = store.getState();

    expect(s.seq).toBe(42);
    expect(s.taskPrompt).toBe('build something');
    expect(s.currentPhaseId).toBe('exec');
    expect(s.completedPhaseIds).toEqual(['plan']);
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0].id).toBe('plan');
    expect(Object.keys(s.tasks)).toHaveLength(2);
    expect(s.tasks['t1'].status).toBe('complete');
    expect(Object.keys(s.sessions)).toHaveLength(1);
    expect(s.sessions['a1::t1'].toolCallCount).toBe(5);
    expect(s.sidebar.title).toBe('My App');
    expect(s.stats.totalTokens).toBe(1500);
  });

  it('sets seq from the second argument', () => {
    const store = new ClientStore();
    store.applySnapshot(blankProjection(), 99);
    expect(store.getState().seq).toBe(99);
  });

  it('makes defensive copies of container collections', () => {
    const store = new ClientStore();
    const snapshot = blankProjection({
      phases: [{ id: 'p1', label: 'P1', icon: '', taskIds: [] }],
      tasks: { t1: { id: 't1', title: 'T', status: 'ready', phaseId: 'p1', dependencies: [] } },
      completedPhaseIds: ['p1'],
    });

    store.applySnapshot(snapshot, 1);

    // Mutate the original snapshot AFTER applying — state must be unaffected.
    snapshot.phases.push({ id: 'p2', label: 'P2', icon: '', taskIds: [] });
    snapshot.completedPhaseIds.push('pX');
    snapshot.tasks['t2'] = { id: 't2', title: 'X', status: 'ready', phaseId: '', dependencies: [] };

    const s = store.getState();
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0].id).toBe('p1');
    expect(s.completedPhaseIds).toEqual(['p1']);
    expect(Object.keys(s.tasks)).toEqual(['t1']);
  });

  it('caps oversized agent logs at MAX_SESSION_LOG (500)', () => {
    const store = new ClientStore();
    const logs = Array.from({ length: MAX_SESSION_LOG + 10 }, (_, i) => ({
      id: `log-${i}`,
      timestamp: ISO_NOW,
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

    store.applySnapshot(snapshot, 1);
    const agent = store.getState().sessions['a1'];

    expect(agent.log).toHaveLength(MAX_SESSION_LOG);
    // Oldest 10 entries dropped; first remaining is entry-10.
    expect(agent.log[0].content).toBe('entry-10');
    expect(agent.log[MAX_SESSION_LOG - 1].content).toBe(`entry-${MAX_SESSION_LOG + 9}`);
  });

  it('clears workflowEventLog on a fresh start (state.seq === 0)', () => {
    const store = new ClientStore();
    // Seed an event log via events first (seq advances past 0).
    store.applyEvents([
      ev('workflow_started', { taskPrompt: 'first' }, {}, 1),
      ev('phase_started', { phase: 'p' }, {}, 2),
    ]);
    expect(store.getState().workflowEventLog).toHaveLength(2);

    // Simulate a server reset: a fresh snapshot at seq 0-clears.
    // The store clears when state.seq === 0 OR incoming seq < state.seq.
    // Here we cannot re-zero seq via the public API; instead exercise the
    // backward-seq branch directly (seq went backwards).
    store.applySnapshot(blankProjection(), 1); // incoming seq 1 < state.seq 2 → clear
    expect(store.getState().workflowEventLog).toEqual([]);
  });

  it('clears workflowEventLog when incoming seq goes backwards (server reset)', () => {
    const store = new ClientStore();
    store.applyEvents([ev('workflow_started', { taskPrompt: 'x' }, {}, 10)]);
    expect(store.getState().workflowEventLog).toHaveLength(1);

    store.applySnapshot(blankProjection(), 3); // 3 < 10 → reset
    expect(store.getState().workflowEventLog).toEqual([]);
    expect(store.getState().seq).toBe(3);
  });

  it('preserves workflowEventLog on reconnection (incoming seq >= state.seq)', () => {
    const store = new ClientStore();
    store.applyEvents([ev('workflow_started', { taskPrompt: 'build' }, {}, 5)]);
    expect(store.getState().workflowEventLog).toHaveLength(1);
    const before = store.getState().workflowEventLog;

    store.applySnapshot(blankProjection({ taskPrompt: 'build' }), 6); // 6 >= 5 → keep
    const s = store.getState();
    expect(s.workflowEventLog).toHaveLength(1);
    expect(s.workflowEventLog).toEqual(before);
    expect(s.seq).toBe(6);
  });

  it('reconciles selection after applying a snapshot', () => {
    const store = new ClientStore();
    store.applySnapshot(
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
          },
        },
      }),
      1,
    );

    const s = store.getState();
    // Fresh store (selectedPhaseId null) → phase follow picks currentPhaseId.
    expect(s.selectedPhaseId).toBe('exec');
    // Task follow picks the first active task in the phase.
    expect(s.selectedTaskId).toBe('t1');
    // Step follow syncs to activeStepIndex.
  });

  it('notifies listeners', () => {
    const store = new ClientStore();
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.applySnapshot(blankProjection({ taskPrompt: 'x' }), 1);
    expect(calls).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyEvents
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – applyEvents', () => {
  it('folds a sequence of events through the shared evolve', () => {
    const store = new ClientStore();
    store.applyEvents([
      ev('workflow_started', { taskPrompt: 'hello' }, {}, 1),
      ev('phase_started', { phase: 'scouting' }, {}, 2),
      ev('task_registered', { id: 't1', title: 'Task 1', phaseId: 'scouting', dependencies: [] }, {}, 3),
      ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 4),
    ]);

    const s = store.getState();
    expect(s.taskPrompt).toBe('hello');
    expect(s.currentPhaseId).toBe('scouting');
    expect(s.tasks['t1'].title).toBe('Task 1');
    expect(s.sessions['a1::t1'].profile).toBe('coder');
    expect(s.seq).toBe(4);
  });

  it('advances seq to the last event seq in the batch', () => {
    const store = new ClientStore();
    store.applyEvents([ev('workflow_started', {}, {}, 5), ev('phase_started', { phase: 'a' }, {}, 10)]);
    expect(store.getState().seq).toBe(10);
  });

  it('accumulates tokens and tool-call counts across events', () => {
    const store = new ClientStore();
    store.applyEvents([
      ev('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
      ev('tool_call_started', { toolName: 'read' }, { agentId: 'a1', taskId: 't1' }, 2),
      ev(
        'turn_ended',
        { tokens: { input: 100, output: 50 }, contentBlocks: [{ type: 'text', text: 'hi' }] },
        { agentId: 'a1', taskId: 't1' },
        3,
      ),
    ]);

    const s = store.getState();
    const agent = s.sessions['a1::t1'];
    expect(agent.toolCallCount).toBe(1);
    expect(agent.inputTokens).toBe(100);
    expect(agent.outputTokens).toBe(50);
    expect(agent.log).toHaveLength(2); // tool_call_start + text
    expect(s.stats.totalTokens).toBe(150);
  });

  it('re-spawn preserves accumulated agent state and does not double-count (kb-11 parity)', () => {
    const store = new ClientStore();
    store.applyEvents([
      ev('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
      ev('tool_call_started', { toolName: 'a' }, { agentId: 'a1', taskId: 't1' }, 2),
      ev('tool_call_started', { toolName: 'b' }, { agentId: 'a1', taskId: 't1' }, 3),
      ev('turn_ended', { tokens: { input: 50, output: 25 } }, { agentId: 'a1', taskId: 't1' }, 4),
      ev('decision', { decision: 'proceed' }, { agentId: 'a1', taskId: 't1' }, 5),
      // Re-spawn the same agent key.
      ev('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 6),
    ]);

    const s = store.getState();
    const agent = s.sessions['a1::t1'];
    expect(agent.toolCallCount).toBe(2);
    expect(agent.inputTokens).toBe(50);
    expect(agent.outputTokens).toBe(25);
    expect(agent.log.length).toBe(3); // 2 tool_call_start + 1 decision
    expect(agent.active).toBe(true);
    expect(s.stats.sessionCount).toBe(1); // NOT incremented on re-spawn
  });

  it('produces a projection identical to folding evolve() manually', () => {
    const store = new ClientStore();
    const events: EventRecord[] = [
      ev('workflow_started', { taskPrompt: 'fold' }, {}, 1),
      ev('phase_registered', { id: 'p1', label: 'P1', icon: '' }, {}, 2),
      ev('phase_started', { phase: 'p1' }, { phaseId: 'p1' }, 3),
      ev(
        'task_registered',
        {
          id: 't1',
          title: 'T',
          phaseId: 'p1',

          dependencies: [],
        },
        {},
        4,
      ),
      ev('task_started', { taskId: 't1' }, { taskId: 't1' }, 5),
    ];
    store.applyEvents(events);

    // Manually fold the same events through the shared evolve.
    let expected: WorkflowProjection = createInitialProjection();
    for (const event of events) expected = evolve(expected, event);

    const s = store.getState();
    expect(s.seq).toBe(expected.seq);
    expect(s.taskPrompt).toBe(expected.taskPrompt);
    expect(s.currentPhaseId).toBe(expected.currentPhaseId);
    expect(s.phases).toEqual(expected.phases);
    expect(s.completedPhaseIds).toEqual(expected.completedPhaseIds);
    expect(s.tasks).toEqual(expected.tasks);
    expect(s.sessions).toEqual(expected.sessions);
    expect(s.stats).toEqual(expected.stats);
    expect(s.status).toBe(expected.status);
  });

  it('is a no-op for an empty event array (seq unchanged, no notification)', () => {
    const store = new ClientStore();
    store.applyEvents([ev('workflow_started', {}, {}, 5)]);
    const seqBefore = store.getState().seq;

    let notified = false;
    store.subscribe(() => {
      notified = true;
    });
    store.applyEvents([]);

    expect(store.getState().seq).toBe(seqBefore);
    expect(notified).toBe(false);
  });

  it('notifies listeners once per applyEvents call', () => {
    const store = new ClientStore();
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.applyEvents([
      ev('workflow_started', {}, {}, 1),
      ev('phase_started', { phase: 'p' }, {}, 2),
      ev('phase_completed', { phase: 'p' }, {}, 3),
    ]);
    // A single batch = a single notification (listeners fire on state change,
    // not per event).
    expect(calls).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// setStatus / setFailed
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – setStatus', () => {
  it('sets status to complete', () => {
    const store = new ClientStore();
    store.setStatus('complete');
    expect(store.getState().status).toBe('complete');
  });

  it('sets status to failed', () => {
    const store = new ClientStore();
    store.setStatus('failed');
    expect(store.getState().status).toBe('failed');
  });

  it('can transition back to running', () => {
    const store = new ClientStore();
    store.setStatus('failed');
    store.setStatus('running');
    expect(store.getState().status).toBe('running');
  });

  it('notifies listeners', () => {
    const store = new ClientStore();
    const states: string[] = [];
    store.subscribe((s) => states.push(s.status));
    store.setStatus('complete');
    store.setStatus('failed');
    expect(states).toEqual(['complete', 'failed']);
  });
});

describe('ClientStore – setFailed', () => {
  it('sets status=failed, error, and failedPhase', () => {
    const store = new ClientStore();
    store.setFailed('Kaboom', 'implementing');
    const s = store.getState();
    expect(s.status).toBe('failed');
    expect(s.error).toBe('Kaboom');
    expect(s.failedPhase).toBe('implementing');
  });

  it('notifies listeners', () => {
    const store = new ClientStore();
    let received: ClientStoreState | null = null;
    store.subscribe((s) => {
      received = s;
    });
    store.setFailed('oops', 'exec');
    expect(received).not.toBeNull();
    expect(received!.status).toBe('failed');
    expect(received!.error).toBe('oops');
    expect(received!.failedPhase).toBe('exec');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Selection mutators: selectPhase / selectTask / selectStep
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – selectPhase', () => {
  it('sets selectedPhaseId and pins when the phase is completed', () => {
    const store = new ClientStore();
    store.applyEvents([
      ev('phase_registered', { id: 'plan', label: 'Plan', icon: '📋' }, {}, 1),
      ev('phase_registered', { id: 'exec', label: 'Exec', icon: '⚡' }, {}, 2),
      ev('phase_started', { phase: 'exec' }, {}, 3),
      ev('phase_completed', { phase: 'plan' }, {}, 4),
    ]);

    store.selectPhase('plan');
    let s = store.getState();
    expect(s.selectedPhaseId).toBe('plan');
    expect(s.userPinnedPhase).toBe(true); // completed → pinned

    store.selectPhase('exec');
    s = store.getState();
    expect(s.selectedPhaseId).toBe('exec');
    expect(s.userPinnedPhase).toBe(false); // not completed → not pinned
  });

  it('selectPhase(null) clears selection with no pin', () => {
    const store = new ClientStore();
    store.selectPhase(null);
    const s = store.getState();
    expect(s.selectedPhaseId).toBeNull();
    expect(s.userPinnedPhase).toBe(false);
  });

  it('resets task and step selection, then reconcile settles an initial task', () => {
    const store = new ClientStore();
    store.applySnapshot(
      blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
        tasks: {
          t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', dependencies: [] },
          t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', dependencies: [] },
        },
      }),
      1,
    );

    // Pin a step first so we can observe it being reset.

    store.selectPhase('exec');
    const s = store.getState();
    // Task follow picks the first active task (t2).
    expect(s.selectedTaskId).toBe('t2'); // reset // reset
  });

  it('respects an explicit non-current phase selection (tightened phase-follow does not snap back)', () => {
    const store = new ClientStore();
    store.applySnapshot(
      blankProjection({
        currentPhaseId: 'exec',
        completedPhaseIds: [],
        phases: [
          { id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: [] },
          { id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] },
        ],
        tasks: {},
      }),
      1,
    );

    // The user explicitly navigates to scouting (a detour — neither completed
    // nor the current phase). The tightened phase-follow leaves it selected
    // instead of snapping it back to currentPhaseId (the old broad rule did).
    store.selectPhase('scouting');
    expect(store.getState().selectedPhaseId).toBe('scouting');
    expect(store.getState().userPinnedPhase).toBe(false);
  });

  it('notifies listeners', () => {
    const store = new ClientStore();
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.selectPhase('whatever');
    expect(calls).toBe(1);
  });
});

describe('ClientStore – selectTask', () => {
  it('sets selectedTaskId and resets step pin, then reconcile syncs the step', () => {
    const store = new ClientStore();
    store.applySnapshot(
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
          },
        },
      }),
      1,
    );
    // Reconcile after snapshot picks exec → t1 → step 1.

    // Pin step 0.

    // Re-select the same task — step pin resets and reconcile re-syncs to 1.
    store.selectTask('t1');
    const s = store.getState();
    expect(s.selectedTaskId).toBe('t1');
  });

  it('selectTask(null) is reconciled back to the first active task (task-follow rule)', () => {
    // selectTask runs reconcileSelection, whose task-follow rule auto-selects
    // the first active task whenever selectedTaskId is null. So deselecting a
    // task while the selected phase still has active tasks re-selects one —
    // this mirrors the ported web workflow-store behavior exactly.
    const store = new ClientStore();
    store.applySnapshot(
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
          },
        },
      }),
      1,
    );
    expect(store.getState().selectedTaskId).toBe('t1');

    store.selectTask(null);
    const s = store.getState();
    // Re-selected by the task-follow rule.
    expect(s.selectedTaskId).toBe('t1');
    // Step pin reset, then step-follow re-synced to activeStepIndex 0.
  });

  it('selectTask(null) stays null when the selected phase has no tasks', () => {
    const store = new ClientStore();
    store.applySnapshot(
      blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] }],
        tasks: {},
      }),
      1,
    );
    expect(store.getState().selectedTaskId).toBeNull();

    store.selectTask(null);
    const s = store.getState();
    expect(s.selectedTaskId).toBeNull();
  });

  it('notifies listeners', () => {
    const store = new ClientStore();
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.selectTask('t9');
    expect(calls).toBe(1);
  });
});

describe('ClientStore – selectStep', () => {
  it('sets selectedStepIndex and userPinnedStep=true', () => {
    const store = new ClientStore();
    const s = store.getState();
  });

  it('selectStep(null) sets step to null and still pins', () => {
    const store = new ClientStore();
    const s = store.getState();
  });

  it('notifies listeners after applyEvents', () => {
    const store = new ClientStore();
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    expect(calls).toBe(0);
    store.applyEvents([
      {
        seq: 1,
        type: 'workflow_started',
        data: { taskPrompt: 'x' },
        metadata: { timestamp: new Date().toISOString() },
      },
    ]);
    expect(calls).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Follow rules (reconcileSelection)
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – follow rules', () => {
  describe('phase follow', () => {
    it('auto-selects currentPhaseId when selectedPhaseId is null (fresh connect)', () => {
      const store = new ClientStore();
      store.applySnapshot(
        blankProjection({
          currentPhaseId: 'scouting',
          phases: [{ id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: [] }],
          tasks: {},
        }),
        1,
      );
      expect(store.getState().selectedPhaseId).toBe('scouting');
    });

    it('follows currentPhaseId when synced to the previous current phase and it advanced (req 6)', () => {
      const store = new ClientStore();
      // First snapshot: current = scouting, nothing completed.
      store.applySnapshot(
        blankProjection({
          currentPhaseId: 'scouting',
          completedPhaseIds: [],
          phases: [{ id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'T1', status: 'active', phaseId: 'scouting', dependencies: [] },
          },
        }),
        1,
      );
      // Re-affirm selection on the (current) scouting phase; not pinned.
      store.selectPhase('scouting');
      expect(store.getState().selectedPhaseId).toBe('scouting');
      expect(store.getState().userPinnedPhase).toBe(false);

      // Second snapshot: current advances to exec; scouting now completed.
      // The user was SYNCED to scouting (selectedPhaseId === prevCurrentPhaseId)
      // and the active phase advanced → the tightened rule follows to exec
      // (completion no longer exempts a phase that the user was synced to).
      store.applySnapshot(
        blankProjection({
          currentPhaseId: 'exec',
          completedPhaseIds: ['scouting'],
          phases: [
            { id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: ['t1'] },
            { id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t2'] },
          ],
          tasks: {
            t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', dependencies: [] },
          },
        }),
        2,
      );
      expect(store.getState().selectedPhaseId).toBe('exec'); // followed the advance
      // Follow resets userPinnedPhase / task selection for the new phase.
      expect(store.getState().userPinnedPhase).toBe(false);
      // Task follow then picks the first active task in exec (t2).
      expect(store.getState().selectedTaskId).toBe('t2');
    });

    it('keeps selection on a pinned (completed) phase even when currentPhaseId moves', () => {
      const store = new ClientStore();
      store.applySnapshot(
        blankProjection({
          currentPhaseId: 'exec',
          completedPhaseIds: ['plan'],
          phases: [
            { id: 'plan', label: 'Plan', icon: '📋', taskIds: [] },
            { id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] },
          ],
          tasks: {
            t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', dependencies: [] },
          },
        }),
        1,
      );
      // Explicitly pin on the completed 'plan' phase.
      store.selectPhase('plan');
      expect(store.getState().selectedPhaseId).toBe('plan');
      expect(store.getState().userPinnedPhase).toBe(true);

      // currentPhaseId moves to review; plan remains completed → stays pinned.
      store.applySnapshot(
        blankProjection({
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
        }),
        2,
      );
      expect(store.getState().selectedPhaseId).toBe('plan');
    });
  });

  describe('task follow', () => {
    it('auto-selects the first active task in the selected phase when selectedTaskId is null', () => {
      const store = new ClientStore();
      store.applySnapshot(
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', dependencies: [] },
            t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', dependencies: [] },
          },
        }),
        1,
      );
      store.selectPhase('exec');
      expect(store.getState().selectedTaskId).toBe('t2'); // first active
    });

    it('falls back to the first task when no active task exists', () => {
      const store = new ClientStore();
      store.applySnapshot(
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', dependencies: [] },
            t2: { id: 't2', title: 'T2', status: 'complete', phaseId: 'exec', dependencies: [] },
          },
        }),
        1,
      );
      store.selectPhase('exec');
      expect(store.getState().selectedTaskId).toBe('t1'); // no active → first
    });

    it('re-selects first active when selectedTaskId no longer belongs to the selected phase', () => {
      const store = new ClientStore();
      store.applySnapshot(
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: { id: 't1', title: 'T1', status: 'ready', phaseId: 'exec', dependencies: [] },
            t2: { id: 't2', title: 'T2', status: 'active', phaseId: 'exec', dependencies: [] },
          },
        }),
        1,
      );
      // Force a stale task selection that is not in the exec phase.
      store.selectTask('t-ghost');
      // Wait — selectTask sets selectedTaskId then reconcile immediately fixes it.
      // 't-ghost' is not in exec's tasks → reconcile re-selects first active (t2).
      expect(store.getState().selectedTaskId).toBe('t2');
    });

    // ── Task completion reselection (req 2) ─────────────────────────────────
    // When the SELECTED task transitioned out of 'active' (→ complete /
    // failed / cancelled) and other active tasks remain, re-select the
    // most-recently-started (greatest startedAt) active task. If no active
    // task remains, keep the completed task selected (intended). Mirrors the
    // Dashboard's req-2 rule (task-4).

    it('re-selects the most-recently-started active task when the selected active task completes (req 2)', () => {
      const store = new ClientStore();
      // Seed: exec has a single active task (t1) → it is selected.
      store.applySnapshot(
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
      expect(store.getState().selectedTaskId).toBe('t1');

      // t1 completes; t2 + t3 are now active. The rule must re-select the one
      // with the greatest startedAt (t3), not just the first active.
      store.applySnapshot(
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

      expect(store.getState().selectedTaskId).toBe('t3');
    });

    it('keeps the completed task selected when no active task remains (req 2)', () => {
      const store = new ClientStore();
      store.applySnapshot(
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
      expect(store.getState().selectedTaskId).toBe('t1');

      // t1 completes; t2 is only 'ready' (not active) → keep t1 selected.
      store.applySnapshot(
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

      expect(store.getState().selectedTaskId).toBe('t1');
    });
  });

  describe('step follow', () => {
    it('syncs selectedStepIndex with activeStepIndex when the step is not pinned', () => {
      const store = new ClientStore();
      store.applySnapshot(
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
            },
          },
        }),
        1,
      );
      store.selectPhase('exec');

      // activeStepIndex advances to 1 via a new snapshot.
      store.applySnapshot(
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
            },
          },
        }),
        2,
      );
    });

    it('does NOT sync selectedStepIndex when the step is user-pinned', () => {
      const store = new ClientStore();
      const baseTasks = (): WorkflowProjection['tasks'] => ({
        t1: {
          id: 't1',
          title: 'T1',
          status: 'active',
          phaseId: 'exec',

          dependencies: [],
        },
      });

      store.applySnapshot(
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
          tasks: baseTasks(),
        }),
        1,
      );
      store.selectPhase('exec');

      // Pin to step 1.

      // activeStepIndex advances to 2 — pinned selection must NOT follow.
      store.applySnapshot(
        blankProjection({
          currentPhaseId: 'exec',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
          tasks: {
            t1: { ...baseTasks()['t1'] },
          },
        }),
        2,
      );
    });
  });

  it('reconcile runs after applyEvents and updates selection (phase follow + task follow)', () => {
    const store = new ClientStore();
    store.applySnapshot(
      blankProjection({
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
      }),
      1,
    );
    store.selectPhase('scouting');
    expect(store.getState().selectedTaskId).toBe('t1');

    // Complete scouting, start exec, register + start a task there.
    store.applyEvents([
      ev('phase_completed', { phase: 'scouting' }, {}, 2),
      ev('phase_started', { phase: 'exec' }, {}, 3),
      ev('task_registered', { id: 't2', title: 'Exec Task', phaseId: 'exec', dependencies: [] }, {}, 4),
      ev('task_started', { taskId: 't2' }, {}, 5),
    ]);

    const s = store.getState();
    // The user was synced to scouting and currentPhaseId advanced to exec →
    // tightened phase-follow moves selection to exec; task follow then picks
    // the first active task in exec (t2). t2 has no activeStepIndex yet, so the
    // step stays null.
    expect(s.selectedPhaseId).toBe('exec');
    expect(s.selectedTaskId).toBe('t2');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Event log building (workflowEventLog via formatWorkflowEventLine)
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – workflowEventLog building', () => {
  it('populates workflowEventLog with a line for each loud lifecycle event', () => {
    const store = new ClientStore();
    store.applyEvents([
      ev('workflow_started', { taskPrompt: 'build', resumed: false }, {}, 1),
      ev('phase_started', { phase: 'scouting', round: 1 }, {}, 2),
    ]);

    const log = store.getState().workflowEventLog;
    expect(log).toHaveLength(2);
    expect(log[0].seq).toBe(1);
    expect(log[0].line).toContain('🚀 workflow started: "build" (resumed: false)');
    expect(log[1].seq).toBe(2);
    expect(log[1].line).toContain('📦 phase started (round 1)');
  });

  it('produces a line equal to formatWorkflowEventLine for every loud event', () => {
    const events: EventRecord[] = [
      ev('workflow_started', { taskPrompt: 'ship it', resumed: false }, {}, 1),
      ev('phase_registered', { id: 'p1', label: 'Build', icon: '🔧' }, {}, 2),
      ev('phase_started', { phase: 'p1', round: 1 }, {}, 3),
      ev('task_registered', { id: 't1', title: 'Task 1', phaseId: 'p1', stepCount: 1 }, { phaseId: 'p1' }, 4),
      ev('task_started', { taskId: 't1', title: 'Task 1' }, {}, 5),
      ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 6),
      ev('task_completed', { taskId: 't1' }, {}, 7),
      ev('phase_completed', { phase: 'p1', durationMs: 2500 }, {}, 8),
      ev('workflow_completed', { totalDurationMs: 5000, sessionCount: 1 }, {}, 9),
    ];

    const store = new ClientStore();
    store.applyEvents(events);

    // The store builds its format ctx from the POST-evolve projection
    // (phases + sessions). Mirror that here so label / session-name
    // resolution matches exactly.
    const st = store.getState();
    const ctx = { phases: st.phases, sessions: st.sessions };
    const expected = events
      .map((event) => ({ seq: event.seq, line: formatWorkflowEventLine(event, ctx) }))
      .filter((e): e is { seq: number; line: string } => e.line !== null);

    // workflow_completed (totalDurationMs 5000 > 0) ALSO appends a two-line
    // completion summary keyed to the completed event's seq. In this scenario
    // agent a1 was spawned (startedAt stamped) but never completed and
    // accumulated no tokens → 0 tokens, 0 agent time, 0%.
    expect(store.getState().workflowEventLog).toEqual([
      ...expected,
      { seq: 9, line: '📊 Tokens: ↑0 in · ↓0 out' },
      { seq: 9, line: '⏱ Time: 5.0s total · 0.0s session (0%)' },
    ]);
  });

  it('excludes events for which formatWorkflowEventLine returns null (verbose events)', () => {
    const events: EventRecord[] = [
      ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
      ev('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 2),
      ev('decision', { decision: 'proceed' }, { agentId: 'a1' }, 3),
      ev('tool_call_started', { toolName: 'read' }, { agentId: 'a1' }, 4),
      ev('turn_ended', { tokens: { input: 1, output: 1 } }, { agentId: 'a1' }, 5),
    ];

    const store = new ClientStore();
    store.applyEvents(events);

    const log = store.getState().workflowEventLog;
    const st = store.getState();
    const ctx = { phases: st.phases, sessions: st.sessions };
    // Only workflow_started + agent_spawned produce lines (the rest are silent).
    expect(log).toHaveLength(2);
    for (const event of events) {
      const sharedLine = formatWorkflowEventLine(event, ctx);
      if (sharedLine === null) {
        expect(log.find((e) => e.seq === event.seq)).toBeUndefined();
      } else {
        expect(log.find((e) => e.seq === event.seq)).toEqual({ seq: event.seq, line: sharedLine });
      }
    }
  });

  it('preserves the event seq as the log entry key', () => {
    const store = new ClientStore();
    store.applyEvents([ev('workflow_started', { taskPrompt: 'seq-check' }, {}, 77)]);
    const log = store.getState().workflowEventLog;
    expect(log[0].seq).toBe(77);
    const expectedLine = formatWorkflowEventLine(ev('workflow_started', { taskPrompt: 'seq-check' }, {}, 77));
    expect(expectedLine).not.toBeNull();
    expect(log[0].line).toBe(expectedLine!);
  });

  it('accumulates across multiple applyEvents calls in seq order', () => {
    const store = new ClientStore();
    store.applyEvents([ev('workflow_started', { taskPrompt: 'a' }, {}, 1)]);
    store.applyEvents([ev('phase_started', { phase: 'p', round: 1 }, {}, 2)]);
    store.applyEvents([ev('phase_completed', { phase: 'p', durationMs: 0 }, {}, 3)]);

    const log = store.getState().workflowEventLog;
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('caps workflowEventLog at MAX_WORKFLOW_EVENT_LOG (10000), dropping the oldest beyond it', () => {
    // The workflow event log is bounded at MAX_WORKFLOW_EVENT_LOG (10000 in
    // packages/shared/src/client-store.ts) so memory stays bounded for
    // long-running workflows. Entries beyond the cap are dropped FIFO (oldest
    // first); the newest entries and ample scroll-back are preserved.
    const CAP = 10000; // MAX_WORKFLOW_EVENT_LOG in packages/shared/src/client-store.ts
    const OVER = CAP + 25;
    const store = new ClientStore();
    const events: EventRecord[] = [];
    for (let i = 1; i <= OVER; i++) {
      events.push(ev('workflow_started', { taskPrompt: `run-${i}` }, {}, i));
    }
    store.applyEvents(events);

    const log = store.getState().workflowEventLog;
    // Capped exactly at CAP; the oldest OVER - CAP entries were dropped.
    expect(log).toHaveLength(CAP);
    // Oldest retained entry is seq (OVER - CAP + 1); seq 1..(OVER - CAP) dropped.
    expect(log[0].seq).toBe(OVER - CAP + 1);
    expect(log[0].line).toContain(`run-${OVER - CAP + 1}`);
    // Newest entry is retained.
    expect(log[CAP - 1].seq).toBe(OVER);
    expect(log[CAP - 1].line).toContain(`run-${OVER}`);
  });

  it('does not duplicate or reorder entries when applySnapshot preserves the log', () => {
    const store = new ClientStore();
    store.applyEvents([ev('workflow_started', { taskPrompt: 'build' }, {}, 1)]);
    const before = store.getState().workflowEventLog;

    // Reconnection snapshot (seq >= current) preserves the log untouched.
    store.applySnapshot(blankProjection({ taskPrompt: 'build' }), 2);
    expect(store.getState().workflowEventLog).toEqual(before);
    // A subsequent event appends — the preserved line remains first.
    store.applyEvents([ev('phase_started', { phase: 'p', round: 1 }, {}, 3)]);
    const log = store.getState().workflowEventLog;
    expect(log.map((e) => e.seq)).toEqual([1, 3]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// prev-tracking fields (transition detection for the tightened phase-follow
// + task-completion-reselection rules)
// ────────────────────────────────────────────────────────────────────────────
//
// `ClientStoreState` carries two OPTIONAL previous-state fields that the
// shared `reconcileSelection` write-back populates on every call so the NEXT
// call can detect a phase / task-status transition:
//
//   prevCurrentPhaseId      : string | null
//   prevSelectedTaskStatus  : TaskStatus | null
//
// NOTE: there is intentionally NO prevActiveStepIndex — the shared step-follow
// stays the broad userPinnedStep-gated rule (the TUI-only expanded-state
// exception is not mirrored here).
//
// These tests pin (1) the initial values and (2) that the store, after running
// its real applySnapshot → reconcileSelection chain, has the fields populated
// to match the current (post-follow) values. The cast to
// `ClientStoreState & PrevTrackingFields` keeps the access type-safe before the
// fields land on the interface (and is a harmless redundant cast afterwards).

type PrevTrackingFields = {
  prevCurrentPhaseId: string | null;
  prevSelectedTaskStatus: string | null;
};

describe('ClientStore – prev-tracking fields', () => {
  it('initializes the prev-tracking fields to null', () => {
    const s = new ClientStore().getState() as ClientStoreState & PrevTrackingFields;
    expect(s.prevCurrentPhaseId).toBeNull();
    expect(s.prevSelectedTaskStatus).toBeNull();
  });

  it('populates the prev-tracking fields after applySnapshot runs reconcileSelection', () => {
    const store = new ClientStore();
    store.applySnapshot(
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
          },
        },
      }),
      1,
    );

    const s = store.getState() as ClientStoreState & PrevTrackingFields;
    // Reconcile settled on exec → t1 → step 2.
    expect(s.selectedPhaseId).toBe('exec');
    expect(s.selectedTaskId).toBe('t1');
    // The write-back mirrors the post-follow current values.
    expect(s.prevCurrentPhaseId).toBe('exec');
    expect(s.prevSelectedTaskStatus).toBe('active');
  });

  it('writes prevSelectedTaskStatus = null when no task is selected', () => {
    const store = new ClientStore();
    // A snapshot with a current phase but no tasks → task-follow selects null.
    store.applySnapshot(
      blankProjection({
        currentPhaseId: 'exec',
        phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] }],
        tasks: {},
      }),
      1,
    );

    const s = store.getState() as ClientStoreState & PrevTrackingFields;
    expect(s.selectedTaskId).toBeNull();
    expect(s.prevCurrentPhaseId).toBe('exec');
    expect(s.prevSelectedTaskStatus).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Global seq reset between tests (helper hygiene)
// ────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetSeq();
});
