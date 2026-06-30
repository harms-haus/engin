/**
 * Tests for TuiStore — the React-bridgeable store wrapping ClientStore.
 *
 * Coverage:
 *   - eventLogLines drains workflowEventLog entries (seq-gated).
 *   - runLog entries: warn→"⚠️ "+message, error→"❌ "+message, info silent.
 *   - selectNextSession filters by BOTH taskId AND phaseId, sets userPinnedSession.
 *   - toggleExpand: implicit pin on expand, unpin on collapse (when not
 *     user-pinned via Tab).
 *   - CRITICAL C1: session-follow suppressed when isLogExpanded=true.
 *   - subscribe/getVersion triggers listener on notify.
 *   - dispose unsubscribes from ClientStore.
 *   - eventLogLines capped at 10 000 (FIFO).
 */

import type { EventRecord } from '@engin/shared';
import { ClientStore } from '@engin/shared/client-store';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TuiStore } from './tui-store.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(
  type: EventRecord['type'],
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
  seq = 1,
): EventRecord {
  return {
    seq,
    type,
    data,
    metadata: {
      timestamp: new Date().toISOString(),
      ...meta,
    },
  };
}

/**
 * Build a snapshot-compatible partial WorkflowProjection for applySnapshot.
 * We only need to set the fields that session-follow logic reads.
 */
function makeProjectionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    seq: 0,
    taskPrompt: 'test',
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    tasks: {},
    sessions: {},
    sidebar: { title: '', indicator: '' },
    status: 'running' as const,
    stats: { totalTokens: 0, sessionCount: 0 },
    runLog: [],
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('TuiStore', () => {
  let clientStore: ClientStore;
  let store: TuiStore;

  beforeEach(() => {
    clientStore = new ClientStore();
    store = new TuiStore(clientStore);
  });

  afterEach(() => {
    store.dispose();
  });

  // ── Event log draining ─────────────────────────────────────────────────

  describe('eventLogLines', () => {
    it('drains workflowEventLog entries on construction (replay)', () => {
      // Events already present in the store at construction time.
      const { ClientStore: CS } = { ClientStore };
      const cs = new CS();
      cs.applyEvents([
        makeEvent('workflow_started', { taskPrompt: 'hello' }, {}, 1),
        makeEvent('phase_registered', { id: 'p1', label: 'P1' }, {}, 2),
      ]);

      const s = new TuiStore(cs);
      try {
        expect(s.eventLogLines.length).toBeGreaterThanOrEqual(2);
        expect(s.eventLogLines[0]).toContain('workflow started');
        expect(s.eventLogLines[1]).toContain('phase registered');
      } finally {
        s.dispose();
      }
    });

    it('drains new workflowEventLog entries from subsequent applyEvents', () => {
      clientStore.applyEvents([makeEvent('workflow_started', { taskPrompt: 'test' }, {}, 1)]);
      const countAfterFirst = store.eventLogLines.length;

      clientStore.applyEvents([makeEvent('phase_registered', { id: 'p1', label: 'P1' }, {}, 2)]);

      expect(store.eventLogLines.length).toBe(countAfterFirst + 1);
      expect(store.eventLogLines[store.eventLogLines.length - 1]).toContain('phase registered');
    });

    it('does NOT duplicate event lines on double-notification (seq gate)', () => {
      clientStore.applyEvents([makeEvent('workflow_started', { taskPrompt: 'test' }, {}, 10)]);
      const count = store.eventLogLines.length;

      // Apply the same seq again — seq 10 is NOT > 10, so no new lines.
      clientStore.applyEvents([makeEvent('workflow_started', { taskPrompt: 'test' }, {}, 10)]);

      // seq 10 is NOT > 10, so no new lines.
      expect(store.eventLogLines.length).toBe(count);
    });

    it('forwards runLog warn entries with warning prefix', () => {
      clientStore.appendRunLog('warn', 'low disk space', new Date().toISOString());

      expect(store.eventLogLines).toContain('⚠️ low disk space');
    });

    it('forwards runLog error entries with error prefix', () => {
      clientStore.appendRunLog('error', 'connection lost', new Date().toISOString());

      expect(store.eventLogLines).toContain('❌ connection lost');
    });

    it('skips runLog info entries (silent)', () => {
      clientStore.appendRunLog('info', 'heartbeat', new Date().toISOString());

      expect(store.eventLogLines).not.toContain('heartbeat');
      expect(store.eventLogLines).not.toContain('⚠️ heartbeat');
      expect(store.eventLogLines).not.toContain('❌ heartbeat');
    });

    it('caps eventLogLines at 10000 FIFO', () => {
      const overflow = 10005;
      for (let i = 0; i < overflow; i++) {
        store.addEventLogLine(`line ${i}`);
      }

      expect(store.eventLogLines.length).toBe(10000);
      // Oldest 5 lines should have been dropped
      expect(store.eventLogLines[0]).toBe('line 5');
      expect(store.eventLogLines[store.eventLogLines.length - 1]).toBe(`line ${overflow - 1}`);
    });

    it('does not lose runLog warn/error entries after ClientStore trim (M1 bug fix)', () => {
      // Push 200 info entries to fill the buffer exactly.
      for (let i = 0; i < 200; i++) {
        clientStore.appendRunLog('info', `info ${i}`, new Date().toISOString());
      }

      // At this point _lastRunLogCount = 200, runLog.length = 200.
      // Push a warn entry — this triggers a trim (201 > 200 → slice to last 200).
      // After trim the warn entry is at index 199.
      // Without the fix, _lastRunLogCount (200) >= runLog.length (200) causes the
      // drain loop to skip, losing the warn entry.
      clientStore.appendRunLog('warn', 'warning after trim', new Date().toISOString());

      expect(store.eventLogLines).toContain('⚠️ warning after trim');

      // Push an error entry — same scenario.
      clientStore.appendRunLog('error', 'error after trim', new Date().toISOString());

      expect(store.eventLogLines).toContain('❌ error after trim');

      // Push many more entries causing repeated trims; verify subsequent
      // warn/error entries are still captured.
      for (let i = 0; i < 50; i++) {
        clientStore.appendRunLog('info', `padding ${i}`, new Date().toISOString());
      }
      clientStore.appendRunLog('warn', 'warning deep after many trims', new Date().toISOString());
      expect(store.eventLogLines).toContain('⚠️ warning deep after many trims');
    });

    it('does NOT notify when a ClientStore tick changes nothing observable (C2)', () => {
      // Set up initial state with one event.
      clientStore.applyEvents([makeEvent('workflow_started', { taskPrompt: 'test' }, {}, 1)]);

      let callCount = 0;
      const unsub = store.subscribe(() => {
        callCount++;
      });
      const versionBefore = store.getVersion();

      // Apply an empty event batch — ClientStore.applyEvents returns early
      // (no notify). Use setStatus to trigger a notify WITHOUT adding event
      // lines or changing session selection. We set the same status so
      // reconcileSelection produces the same selectedSessionId.
      //
      // Actually, setStatus always notifies the ClientStore which triggers
      // _processStoreUpdate. If nothing observable changed (no new event
      // lines, no session change), _notify should NOT fire.
      clientStore.setStatus('running'); // same status → no observable change

      expect(callCount).toBe(0);
      expect(store.getVersion()).toBe(versionBefore);
      unsub();
    });

    it('efficiently drains only the new tail after workflowEventLog entries (L7)', () => {
      // Push 3 batches with increasing seqs, then verify only new entries
      // are drained on each subsequent notification (no full-array scan).
      clientStore.applyEvents([makeEvent('workflow_started', { taskPrompt: 'test' }, {}, 1)]);
      const countAfterFirst = store.eventLogLines.length;

      clientStore.applyEvents([
        makeEvent('phase_registered', { id: 'p1', label: 'P1' }, {}, 2),
        makeEvent('phase_started', { id: 'p1', round: 1 }, { phaseId: 'p1' }, 3),
      ]);

      // Only 2 new entries should have been drained.
      expect(store.eventLogLines.length).toBe(countAfterFirst + 2);
      expect(store.eventLogLines[store.eventLogLines.length - 1]).toContain('phase started');
      expect(store.eventLogLines[store.eventLogLines.length - 2]).toContain('phase registered');
    });
  });

  // ── Session follow ─────────────────────────────────────────────────────

  describe('session-follow (C1 override)', () => {
    it('auto-selects the most-recently-started session for the selected task', () => {
      // Set up projection state with tasks and sessions.
      const ts = new Date().toISOString();
      const earlier = new Date(Date.now() - 5000).toISOString();
      const later = new Date(Date.now() - 1000).toISOString();

      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-early': {
              uid: 's-early',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: earlier,
            },
            's-late': {
              uid: 's-late',
              agentId: 'agent-2',
              profile: 'reviewer',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'reviewer',
              attempt: 1,
              startedAt: later,
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      // After snapshot, reconcileSelection runs which sets selectedPhaseId,
      // selectedTaskId, and selectedSessionId.
      const state = clientStore.getState();
      expect(state.selectedSessionId).toBe('s-late'); // later = most recent
    });

    it('sets selectedSessionId to null when no sessions match', () => {
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-other': {
              uid: 's-other',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't-different', // different task — should not match
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Other',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      const state = clientStore.getState();
      // s-other's taskId is t-different, not t1 → no match → null
      expect(state.selectedSessionId).toBeNull();
    });

    it('does NOT auto-follow when isLogExpanded is true', () => {
      // When expanded with a pinned session, reconcileSelection should not
      // override selectedSessionId even when new events arrive.
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-first': {
              uid: 's-first',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      // Add a second session via direct mutation, then pin to s-first.
      const st = clientStore.getState();
      (st.sessions as Record<string, unknown>)['s-second'] = {
        uid: 's-second',
        agentId: 'agent-2',
        profile: 'reviewer',
        phaseId: 'p1',
        taskId: 't1',
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: 'Task 1',
        runnerRole: 'reviewer',
        attempt: 1,
        startedAt: new Date(Date.now() + 100).toISOString(),
      };
      st.selectedSessionId = 's-first';
      st.userPinnedSession = true;

      // Expand: isLogExpanded=true, userPinnedSession is already true.
      store.toggleExpand();
      expect(store.isLogExpanded).toBe(true);

      // Trigger an event. reconcileSelection checks userPinnedSession=true → skips.
      // _processStoreUpdate sets userPinnedSession=true again (no change).
      clientStore.applyEvents([makeEvent('workflow_data_set', { foo: 'bar' }, { phaseId: 'p1' }, 2)]);

      expect(clientStore.getState().selectedSessionId).toBe('s-first');
    });

    it('suppresses session-follow when isLogExpanded=true (C1 critical)', () => {
      // C1 constraint: when the log is expanded, changing selectedTaskId must
      // NOT auto-change selectedSessionId. TuiStore's selectTask saves the
      // previous session ID before calling clientStore, then restores it when
      // isLogExpanded is true.
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
            t2: { id: 't2', title: 'Task 2', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-t1': {
              uid: 's-t1',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
            's-t2': {
              uid: 's-t2',
              agentId: 'agent-2',
              profile: 'reviewer',
              phaseId: 'p1',
              taskId: 't2',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 2',
              runnerRole: 'reviewer',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      // Initial: selectedSessionId is s-t1 (for the first active task t1).
      expect(clientStore.getState().selectedSessionId).toBe('s-t1');

      // Expand the log (implicitly pins s-t1).
      store.toggleExpand();
      expect(store.isLogExpanded).toBe(true);

      // Select a different task. TuiStore's selectTask saves the current
      // session (s-t1), calls clientStore.selectTask('t2') which runs
      // reconcileSelection (would set selectedSessionId to s-t2), then
      // restores s-t1 because isLogExpanded=true.
      store.selectTask('t2');
      expect(clientStore.getState().selectedSessionId).toBe('s-t1');
    });
  });

  // ── selectNextSession ──────────────────────────────────────────────────

  describe('selectNextSession', () => {
    it('cycles forward through filtered sessions', () => {
      // Set up two sessions for the same task+phase
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-a': {
              uid: 's-a',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
            's-b': {
              uid: 's-b',
              agentId: 'agent-2',
              profile: 'reviewer',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'reviewer',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      const state = clientStore.getState();
      // Both sessions have the same startedAt in the snapshot, so the
      // session-follow picks the first one iterated (insertion order: s-a, then s-b).
      // Since startedAt values are equal, reduce keeps the first (s-a).
      expect(state.selectedSessionId).toBe('s-a');

      // Cycle forward: s-a → s-b
      store.selectNextSession(1);
      const state2 = clientStore.getState();
      expect(state2.selectedSessionId).toBe('s-b');
      expect(state2.userPinnedSession).toBe(true);

      // Cycle forward again wraps to s-a
      store.selectNextSession(1);
      expect(clientStore.getState().selectedSessionId).toBe('s-a');
    });

    it('cycles backward through filtered sessions', () => {
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-a': {
              uid: 's-a',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
            's-b': {
              uid: 's-b',
              agentId: 'agent-2',
              profile: 'reviewer',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'reviewer',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      // After snapshot, selectedSessionId is 's-a' (first iterated, equal startedAt).
      // Cycle backward: s-a → s-b (wraps)
      store.selectNextSession(-1);
      expect(clientStore.getState().selectedSessionId).toBe('s-b');

      // Backward again: s-b → s-a
      store.selectNextSession(-1);
      expect(clientStore.getState().selectedSessionId).toBe('s-a');
    });

    it('filters by BOTH taskId AND phaseId', () => {
      // Sessions for a different task or different phase should not be included.
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [
            { id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] },
            { id: 'p2', label: 'Phase 2', icon: '', taskIds: ['t2'] },
          ],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
            t2: { id: 't2', title: 'Task 2', phaseId: 'p2', status: 'active', dependencies: [] },
          },
          sessions: {
            's-t1': {
              uid: 's-t1',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
            's-t2-p2': {
              uid: 's-t2-p2',
              agentId: 'agent-2',
              profile: 'reviewer',
              phaseId: 'p2',
              taskId: 't2',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 2',
              runnerRole: 'reviewer',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
            's-t1-p2': {
              uid: 's-t1-p2',
              agentId: 'agent-3',
              profile: 'debugger',
              phaseId: 'p2',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1 (p2)',
              runnerRole: 'debugger',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      // Current phase is p1, selectedTaskId is t1 (both set by reconcileSelection).
      // Only sessions matching both taskId=t1 AND phaseId=p1 should be in
      // the filter. s-t2-p2 fails taskId check; s-t1-p2 fails phaseId check.
      // So only s-t1 should be cyclable.
      const state = clientStore.getState();
      expect(state.selectedSessionId).toBe('s-t1');

      // Even though there are 3 sessions, cycling should only cycle within s-t1.
      // Since there's only 1 matching session, cycles stay on s-t1.
      store.selectNextSession(1);
      expect(clientStore.getState().selectedSessionId).toBe('s-t1');

      store.selectNextSession(-1);
      expect(clientStore.getState().selectedSessionId).toBe('s-t1');
    });

    it('sets userPinnedSession to true', () => {
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-a': {
              uid: 's-a',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      store.selectNextSession(1);
      expect(clientStore.getState().userPinnedSession).toBe(true);
    });
  });

  // ── toggleExpand ───────────────────────────────────────────────────────

  describe('toggleExpand', () => {
    it('flips isLogExpanded', () => {
      expect(store.isLogExpanded).toBe(false);
      store.toggleExpand();
      expect(store.isLogExpanded).toBe(true);
      store.toggleExpand();
      expect(store.isLogExpanded).toBe(false);
    });

    it('implicitly pins the session when expanding (sessionPinnedByUser is false)', () => {
      // Set up state with a selected session
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-a': {
              uid: 's-a',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      // Initially userPinnedSession should be false
      expect(clientStore.getState().userPinnedSession).toBe(false);

      // Expand → implicit pin
      store.toggleExpand();
      expect(clientStore.getState().userPinnedSession).toBe(true);

      // Collapse → unpin (since sessionPinnedByUser is false, i.e. not Tab-pinned)
      store.toggleExpand();
      expect(clientStore.getState().userPinnedSession).toBe(false);
    });

    it('does NOT implicitly pin when selectedSessionId is null on expand', () => {
      // Ensure selectedSessionId is null
      const state = clientStore.getState();
      state.selectedSessionId = null;

      store.toggleExpand();
      // userPinnedSession should not have been set to true
      expect(clientStore.getState().userPinnedSession).toBe(false);
    });

    it('does NOT unpin when collapsing if session was pinned via Tab (sessionPinnedByUser=true)', () => {
      // Set up state
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-a': {
              uid: 's-a',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      // Pin via selectNextSession (simulates Tab)
      store.selectNextSession(1);
      expect(clientStore.getState().userPinnedSession).toBe(true);

      // Expand → sessionPinnedByUser is true, so no implicit pin change needed
      store.toggleExpand();
      expect(clientStore.getState().userPinnedSession).toBe(true);

      // Collapse → sessionPinnedByUser is true, so userPinnedSession should NOT be cleared
      store.toggleExpand();
      expect(clientStore.getState().userPinnedSession).toBe(true);
    });

    it('H3 desync: Tab-pin → selectTask → expand does NOT use stale _sessionPinnedByUser', () => {
      // Regression: _sessionPinnedByUser was never reset after selectTask
      // cleared userPinnedSession, causing toggleExpand to skip the implicit
      // pin on expand (leaving userPinnedSession=false → session-follow runs).
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1', 't2'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
            t2: { id: 't2', title: 'Task 2', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-t1': {
              uid: 's-t1',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
            's-t2': {
              uid: 's-t2',
              agentId: 'agent-2',
              profile: 'reviewer',
              phaseId: 'p1',
              taskId: 't2',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 2',
              runnerRole: 'reviewer',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      // 1. Tab-pin the session.
      store.selectNextSession(1);
      expect(clientStore.getState().userPinnedSession).toBe(true);

      // 2. selectTask clears userPinnedSession on the ClientStore side.
      store.selectTask('t2');
      expect(clientStore.getState().userPinnedSession).toBe(false);

      // 3. Expand — _sessionPinnedByUser should now be false (reset by
      //    selectTask), so the implicit pin should fire and set
      //    userPinnedSession=true.
      store.toggleExpand();
      expect(store.isLogExpanded).toBe(true);
      expect(clientStore.getState().userPinnedSession).toBe(true);

      // 4. Collapse — _sessionPinnedByUser is false, so userPinnedSession
      //    should be cleared (re-enabling follow).
      store.toggleExpand();
      expect(store.isLogExpanded).toBe(false);
      expect(clientStore.getState().userPinnedSession).toBe(false);
    });
  });

  // ── subscribe / getVersion ─────────────────────────────────────────────

  describe('subscribe / getVersion', () => {
    it('calls listener when state changes (via notify)', () => {
      const versions: number[] = [];
      const unsub = store.subscribe(() => {
        versions.push(store.getVersion());
      });

      store.addEventLogLine('hello');

      expect(versions.length).toBeGreaterThanOrEqual(1);
      unsub();
    });

    it('does NOT call listener after unsubscribe', () => {
      let callCount = 0;
      const unsub = store.subscribe(() => {
        callCount++;
      });
      unsub();

      store.addEventLogLine('hello');
      expect(callCount).toBe(0);
    });

    it('getVersion increments on each notify', () => {
      const v0 = store.getVersion();
      store.addEventLogLine('a');
      const v1 = store.getVersion();
      store.addEventLogLine('b');
      const v2 = store.getVersion();

      expect(v1).toBeGreaterThan(v0);
      expect(v2).toBeGreaterThan(v1);
    });
  });

  // ── dispose ────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('unsubscribes from ClientStore', () => {
      // Create a fresh store and client
      const cs = new ClientStore();
      const s = new TuiStore(cs);
      const eventCountBefore = s.eventLogLines.length;

      // After dispose, ClientStore updates should NOT be processed
      s.dispose();
      cs.applyEvents([makeEvent('workflow_started', { taskPrompt: 'should be ignored' }, {}, 1)]);

      expect(s.eventLogLines.length).toBe(eventCountBefore);
    });
  });

  // ── User action methods (QR, prompt, runId) ────────────────────────────

  describe('QR overlay', () => {
    it('toggleQr flips qrVisible', () => {
      expect(store.qrVisible).toBe(false);
      store.toggleQr();
      expect(store.qrVisible).toBe(true);
      store.toggleQr();
      expect(store.qrVisible).toBe(false);
    });

    it('setQrString updates qrString', () => {
      store.setQrString('hello');
      expect(store.qrString).toBe('hello');
      store.setQrString(null);
      expect(store.qrString).toBeNull();
    });

    it('setQrVisible updates qrVisible', () => {
      store.setQrVisible(true);
      expect(store.qrVisible).toBe(true);
      store.setQrVisible(false);
      expect(store.qrVisible).toBe(false);
    });
  });

  describe('prompt', () => {
    it('showPrompt / dismissPrompt toggle promptVisible', () => {
      expect(store.promptVisible).toBe(false);
      store.showPrompt();
      expect(store.promptVisible).toBe(true);
      store.dismissPrompt();
      expect(store.promptVisible).toBe(false);
    });
  });

  describe('runId', () => {
    it('setRunId updates runId', () => {
      store.setRunId('run-123');
      expect(store.runId).toBe('run-123');
      store.setRunId(undefined);
      expect(store.runId).toBeUndefined();
    });
  });

  // ── inspecting / resolvePause ──────────────────────────────────────────

  describe('inspecting / resolvePause', () => {
    it('set inspecting triggers notify and is readable', () => {
      const versions: number[] = [];
      const unsub = store.subscribe(() => versions.push(store.getVersion()));

      expect(store.inspecting).toBe(false);
      const v0 = store.getVersion();

      store.inspecting = true;

      expect(store.inspecting).toBe(true);
      expect(store.getVersion()).toBeGreaterThan(v0);
      expect(versions.length).toBeGreaterThanOrEqual(1);
      unsub();
    });

    it('set resolvePause triggers notify and is readable', () => {
      const fn = () => {};

      expect(store.resolvePause).toBeNull();
      const v0 = store.getVersion();

      store.resolvePause = fn;

      expect(store.resolvePause).toBe(fn);
      expect(store.getVersion()).toBeGreaterThan(v0);
    });

    it('set resolvePause to null works', () => {
      store.resolvePause = () => {};
      store.resolvePause = null;
      expect(store.resolvePause).toBeNull();
    });
  });

  describe('addEventLogLine', () => {
    it('appends a line to eventLogLines', () => {
      store.addEventLogLine('custom line');
      expect(store.eventLogLines).toContain('custom line');
    });
  });

  describe('getClientStoreState', () => {
    it('returns the current ClientStore state', () => {
      const state = store.getClientStoreState();
      expect(state).toBe(clientStore.getState());
      expect(state.status).toBe('running');
    });
  });

  // ── selectPhase / selectTask ──────────────────────────────────────────

  describe('selectPhase / selectTask', () => {
    it('selectPhase delegates to clientStore and re-runs session-follow', () => {
      // Set up two phases
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [
            { id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] },
            { id: 'p2', label: 'Phase 2', icon: '', taskIds: [] },
          ],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {},
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      store.selectPhase('p2');
      const state = clientStore.getState();
      expect(state.selectedPhaseId).toBe('p2');
    });

    it('selectTask delegates to clientStore and re-runs session-follow', () => {
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {},
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );

      store.selectTask('t1');
      const state = clientStore.getState();
      expect(state.selectedTaskId).toBe('t1');
    });
  });

  // ── Agent-output live updates ────────────────────────────────────────
  //
  // Verbose events (text, thinking, tool_call*, turn_*, log, decision) append
  // to `session.log` and mutate token/tool counts but are filtered OUT of the
  // workflow event log (formatWorkflowEventLine returns null for them). The
  // store's dirty-gate must still notify React for these, otherwise the
  // AgentLog renders stale until an unrelated action (e.g. re-selecting a
  // task) forces a re-render.
  describe('agent-output live updates', () => {
    function setupSession() {
      clientStore.applySnapshot(
        makeProjectionSnapshot({
          seq: 1,
          currentPhaseId: 'p1',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '', taskIds: ['t1'] }],
          tasks: {
            t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'active', dependencies: [] },
          },
          sessions: {
            's-a': {
              uid: 's-a',
              agentId: 'agent-1',
              profile: 'coder',
              phaseId: 'p1',
              taskId: 't1',
              active: true,
              log: [],
              toolCallCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              taskTitle: 'Task 1',
              runnerRole: 'executor',
              attempt: 1,
              startedAt: new Date().toISOString(),
            },
          },
          stats: { totalTokens: 0, sessionCount: 0 },
        }),
        1,
      );
      // session-follow selects the only session for the active task.
      store.selectTask('t1');
      expect(clientStore.getState().selectedSessionId).toBe('s-a');
    }

    it('notifies React when a verbose turn_ended event appends to session.log', () => {
      setupSession();
      const versionBefore = store.getVersion();
      const logBefore = clientStore.getState().sessions['s-a'].log.length;

      // turn_ended with a text contentBlock appends to session.log AND bumps
      // tokens, but produces NO workflowEventLog line (it is a silent type).
      clientStore.applyEvents([
        makeEvent(
          'turn_ended',
          {
            contentBlocks: [{ type: 'text', text: 'working on it' }],
            tokens: { input: 10, output: 20 },
          },
          { agentId: 'agent-1', taskId: 't1' },
          2,
        ),
      ]);

      // The session log grew...
      expect(clientStore.getState().sessions['s-a'].log.length).toBe(logBefore + 1);
      // ...AND React subscribers were notified (version bumped). Without the
      // session-signature dirty-gate this stays equal to versionBefore.
      expect(store.getVersion()).toBeGreaterThan(versionBefore);
    });

    it('notifies React when only token counts change (no new log line)', () => {
      setupSession();
      const versionBefore = store.getVersion();

      // turn_ended with tokens but no contentBlocks: no log append, but
      // inputTokens/outputTokens change (shown in the AgentLog header).
      clientStore.applyEvents([
        makeEvent(
          'turn_ended',
          { contentBlocks: [], tokens: { input: 5, output: 7 } },
          { agentId: 'agent-1', taskId: 't1' },
          3,
        ),
      ]);

      expect(clientStore.getState().sessions['s-a'].outputTokens).toBe(7);
      expect(store.getVersion()).toBeGreaterThan(versionBefore);
    });

    it('does NOT notify when nothing observable changed', () => {
      // Guard against the fix over-notifying: a no-op event that leaves the
      // session signature identical must NOT bump the version. handleTurnStarted
      // is a pure seq-bump no-op.
      setupSession();
      // Drain any pending notifications from setup.
      const versionBefore = store.getVersion();

      clientStore.applyEvents([makeEvent('turn_started', {}, { agentId: 'agent-1', taskId: 't1' }, 4)]);

      expect(store.getVersion()).toBe(versionBefore);
    });
  });
});
