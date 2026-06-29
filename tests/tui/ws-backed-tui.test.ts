// ────────────────────────────────────────────────────────────────────────────
// createWsBackedTui — WS-backed TUI adapter tests.
//
// `src/tui/ws-backed-tui.ts` replaces the old `createStoreBackedTui`
// (status-callbacks.ts) pattern. Instead of subscribing to a local
// `EventStore` driven by in-process `StatusCallbacks`, it subscribes to a
// `ClientStore` (from `@engin/shared/client-store`) — the plain-TS projection
// store that mirrors what the web client consumes over the WebSocket.
//
// Contract under test (the implementation must satisfy these):
//
//   export function createWsBackedTui(deps: {
//     clientStore: ClientStore;
//     eventLog: EventLog;
//     dashboard: Dashboard;
//     requestRender: () => void;
//   }): { dispose: () => void };
//
// On creation AND on every `clientStore` notification the adapter:
//   1. Drains new entries from `state.workflowEventLog` whose `seq` is greater
//      than the last seen seq, appending each entry's `line` to `eventLog`.
//   2. Drains new `state.runLog` entries, appending prefixed lines for `warn`
//      ("⚠️ " + message) and `error` ("❌ " + message) levels (info is silent).
//   3. Syncs the dashboard from the current projection
//      (`dashboard.syncFromProjection(...)`).
//   4. Calls `requestRender()`.
//
// `dispose()` unsubscribes from the store so no further updates are processed.
//
// The event-log line text is produced by `formatWorkflowEventLine` (now in
// `@engin/shared`); the ClientStore already builds the formatted
// `workflowEventLog` entries, so the adapter only forwards their `line` text.
// ────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'bun:test';

import { ClientStore } from '@engin/shared/client-store';
import { createInitialProjection, type EventRecord, type EventType } from '@engin/shared/event-types';
import { evolve } from '@engin/shared/evolve';
import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';

import type { Dashboard } from '../../packages/tui/src/components/dashboard.js';
import type { EventLog } from '../../packages/tui/src/components/event-log.js';
import { createWsBackedTui } from '../../packages/tui/src/ws-backed-tui.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const ISO_NOW = '2026-06-15T00:00:00.000Z';

/** Format `events` exactly as ClientStore.applyEvents would (fold to a
 *  projection, then format each loud event with that projection as ctx).
 *  Mirrors the store so assertions stay robust to label / session-name
 *  resolution and the embedded time prefix. */
function fmt(events: EventRecord[]): string[] {
  let p = createInitialProjection();
  for (const e of events) p = evolve(p, e);
  const ctx = { phases: p.phases, sessions: p.sessions };
  return events.map((e) => formatWorkflowEventLine(e, ctx)).filter((l): l is string => l !== null);
}

// ─── Event builder ───────────────────────────────────────────────────────────

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

// ─── Mocks ───────────────────────────────────────────────────────────────────

function createMockEventLog() {
  const lines: string[] = [];
  return {
    lines,
    addLine: (text: string) => {
      lines.push(text);
    },
  } as unknown as EventLog & { lines: string[] };
}

function createMockDashboard() {
  let lastProjection: unknown = null;
  let syncCount = 0;
  return {
    syncFromProjection(proj: unknown) {
      lastProjection = proj;
      syncCount++;
    },
    phaseBar: {
      setPhases: () => {},
      setCurrentPhaseId: () => {},
      setCompletedPhaseIds: () => {},
      setIndicator: () => {},
      setSelectedPhase: () => {},
      invalidate: () => {},
      handleInput: () => {},
      render: () => [''] as string[],
    },
    taskList: {
      updateTasks: () => {},
      setSelectedTaskId: () => {},
      getSelectedTaskId: () => null,
      getVisibleTaskCount: () => 0,
      getRenderedLineCount: () => 0,
      invalidate: () => {},
      handleInput: () => {},
      render: () => [] as string[],
    },
    agentLog: {
      setAgents: () => {},
      setSteps: () => {},
      setSelectedStepIndex: () => {},
      setActiveStepIndex: () => {},
      setSelectedSessionId: () => {},
      toggleExpand: () => {},
      isExpanded: () => false,
      getExpandedLineCount: () => 20,
      getSelectedSessionId: () => null,
      invalidate: () => {},
      handleInput: () => {},
      render: () => [] as string[],
    },
    getSelection: () => ({
      selectedPhaseId: null,
      selectedTaskId: null,
      userPinnedPhase: false,
    }),
    forceReselect: () => {},
    getComputedHeight: () => 25,
    invalidate: () => {},
    handleInput: () => {},
    render: () => [] as string[],
    get lastSyncedProjection() {
      return lastProjection;
    },
    get syncCount() {
      return syncCount;
    },
  } as unknown as Dashboard & { lastSyncedProjection: unknown; syncCount: number };
}

interface TestCtx {
  clientStore: ClientStore;
  eventLog: EventLog & { lines: string[] };
  dashboard: Dashboard & { lastSyncedProjection: unknown; syncCount: number };
  renderCount: number;
  resetRenderCount(): void;
  dispose(): void;
}

function createTestDeps(): TestCtx {
  const clientStore = new ClientStore();
  const eventLog = createMockEventLog();
  const dashboard = createMockDashboard();
  const ctx: TestCtx = {
    clientStore,
    eventLog,
    dashboard,
    renderCount: 0,
    resetRenderCount() {
      ctx.renderCount = 0;
    },
    dispose() {},
  };
  const requestRender = () => {
    ctx.renderCount++;
  };
  const handle = createWsBackedTui({ clientStore, eventLog, dashboard, requestRender });
  ctx.dispose = handle.dispose;
  return ctx;
}

beforeEach(() => {
  resetSeq();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createWsBackedTui', () => {
  // ── Subscription & initial sync ──────────────────────────────────────────

  describe('subscription & initial sync', () => {
    it('subscribes to clientStore and reflects events applied after creation', () => {
      const ctx = createTestDeps();
      const events = [ev('workflow_started', { taskPrompt: 'build feature', resumed: false }, {}, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('processes events already in the store on creation (replay)', () => {
      const clientStore = new ClientStore();
      const eventLog = createMockEventLog();
      const dashboard = createMockDashboard();
      // Seed events BEFORE wiring up the adapter.
      const events = [
        ev('workflow_started', { taskPrompt: 'preexisting', resumed: true }, {}, 1),
        ev('phase_started', { phase: 'scouting', round: 1 }, {}, 2),
      ];
      clientStore.applyEvents(events);

      createWsBackedTui({ clientStore, eventLog, dashboard, requestRender: () => {} });

      expect(eventLog.lines).toEqual(fmt(events));
    });

    it('syncs the dashboard with the current projection on creation', () => {
      const clientStore = new ClientStore();
      const eventLog = createMockEventLog();
      const dashboard = createMockDashboard();
      clientStore.applyEvents([ev('phase_started', { phase: 'scouting' }, {}, 1)]);

      createWsBackedTui({ clientStore, eventLog, dashboard, requestRender: () => {} });

      const proj = dashboard.lastSyncedProjection as { currentPhaseId: string };
      expect(proj).toBeTruthy();
      expect(proj.currentPhaseId).toBe('scouting');
    });

    it('does not re-add already-processed lines when more events arrive', () => {
      const clientStore = new ClientStore();
      const eventLog = createMockEventLog();
      const dashboard = createMockDashboard();
      // Seed one event before wiring.
      const first = [ev('workflow_started', { taskPrompt: 'first', resumed: false }, {}, 1)];
      clientStore.applyEvents(first);
      createWsBackedTui({ clientStore, eventLog, dashboard, requestRender: () => {} });
      expect(eventLog.lines).toHaveLength(1);

      // Apply a second batch — the first line must not be duplicated.
      const second = [ev('phase_started', { phase: 'build', round: 1 }, {}, 2)];
      clientStore.applyEvents(second);
      expect(eventLog.lines).toEqual(fmt([...first, ...second]));
    });
  });

  // ── Event log line forwarding (one per loud lifecycle event) ──────────────

  describe('event log lines (ported from status-callbacks via shared formatWorkflowEventLine)', () => {
    it('forwards workflow_started line', () => {
      const ctx = createTestDeps();
      const events = [ev('workflow_started', { taskPrompt: 'ship it', resumed: false }, {}, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards workflow_completed line plus the two summary lines', () => {
      const ctx = createTestDeps();
      const events = [ev('workflow_completed', { totalDurationMs: 3456, sessionCount: 5 }, {}, 1)];
      ctx.clientStore.applyEvents(events);
      // totalDurationMs > 0 → the shared ClientStore appends a two-line
      // completion summary (empty session set → 0 tokens / 0 session time). All
      // three entries share seq 1, so the adapter drains them together.
      expect(ctx.eventLog.lines).toEqual([
        ...fmt(events),
        '📊 Tokens: ↑0 in · ↓0 out',
        '⏱ Time: 3.5s total · 0.0s session (0%)',
      ]);
    });

    it('forwards workflow_failed line', () => {
      const ctx = createTestDeps();
      const events = [ev('workflow_failed', { phase: 'planning', error: 'something broke' }, {}, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards phase_registered line', () => {
      const ctx = createTestDeps();
      const events = [
        ev('phase_registered', { id: 'scouting', label: 'Scouting', icon: '🔍' }, { phaseId: 'scouting' }, 1),
      ];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards phase_started line', () => {
      const ctx = createTestDeps();
      const events = [ev('phase_started', { phase: 'scouting', round: 2 }, {}, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards phase_completed line', () => {
      const ctx = createTestDeps();
      const events = [ev('phase_completed', { phase: 'scouting', durationMs: 2500 }, {}, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards agent_spawned line (agentId from metadata)', () => {
      const ctx = createTestDeps();
      const events = [ev('session_started', { profile: 'scout' }, { agentId: 'a1' }, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards agent_completed line', () => {
      const ctx = createTestDeps();
      const events = [
        ev('session_started', { profile: 'scout' }, { agentId: 'a1', taskId: 't1' }, 1),
        ev('session_completed', {}, { agentId: 'a1', taskId: 't1' }, 2),
      ];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards task_registered line', () => {
      const ctx = createTestDeps();
      const events = [
        ev('task_registered', { taskId: 't1', title: 'Task', phaseId: 'p1' }, { taskId: 't1', phaseId: 'p1' }, 1),
      ];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards task_started line', () => {
      const ctx = createTestDeps();
      const events = [ev('task_started', { taskId: 't1', title: 'Implement feature' }, { taskId: 't1' }, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards task_completed line', () => {
      const ctx = createTestDeps();
      const events = [ev('task_completed', { taskId: 't1' }, { taskId: 't1' }, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards task_rejected line', () => {
      const ctx = createTestDeps();
      const events = [ev('task_rejected', { taskId: 't1', reason: 'bad code' }, { taskId: 't1' }, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards error line', () => {
      const ctx = createTestDeps();
      const events = [ev('error', { error: 'crash' }, { agentId: 'a1', phaseId: 'planning' }, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('forwards sidebar_updated line when a title is present', () => {
      const ctx = createTestDeps();
      const events = [ev('sidebar_updated', { title: 'My Workflow' }, {}, 1)];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('does NOT forward sidebar_updated when there is no title', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('sidebar_updated', { indicator: '🟢' }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual([]);
    });
    // step_started event line removed in C1/C2 — no longer emitted
  });

  // ── Verbose events produce no line ────────────────────────────────────────

  describe('verbose events produce no event-log line', () => {
    it('decision is silent', () => {
      const ctx = createTestDeps();
      const events = [
        ev('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
        ev('decision', { decision: 'proceed', reasoning: 'ok' }, { agentId: 'a1', taskId: 't1' }, 2),
      ];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('turn_started is silent', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('turn_started', {}, { agentId: 'a1' }, 1)]);
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('turn_ended is silent', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('turn_ended', { tokens: { input: 1, output: 1 } }, { agentId: 'a1' }, 1)]);
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('tool_call_started is silent', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('tool_call_started', { toolName: 'read', toolCallId: 'tc1', arguments: {} }, { agentId: 'a1' }, 1),
      ]);
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('tool_call_ended is silent', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('tool_call_ended', { toolName: 'read', toolCallId: 'tc1', isError: false }, { agentId: 'a1' }, 1),
      ]);
      expect(ctx.eventLog.lines).toEqual([]);
    });
  });

  // ── lastSeq tracking ──────────────────────────────────────────────────────

  describe('lastSeq tracking (no re-processing across batches)', () => {
    it('accumulates lines in order across multiple applyEvents calls', () => {
      const ctx = createTestDeps();
      const e1 = [ev('workflow_started', { taskPrompt: 'a', resumed: false }, {}, 1)];
      const e2 = [ev('phase_started', { phase: 'p', round: 1 }, {}, 2)];
      const e3 = [ev('phase_completed', { phase: 'p', durationMs: 0 }, {}, 3)];
      ctx.clientStore.applyEvents(e1);
      ctx.clientStore.applyEvents(e2);
      ctx.clientStore.applyEvents(e3);

      expect(ctx.eventLog.lines).toEqual(fmt([...e1, ...e2, ...e3]));
    });

    it('does not duplicate lines when a batch mixes loud and silent events', () => {
      const ctx = createTestDeps();
      const first = [
        ev('workflow_started', { taskPrompt: 'x', resumed: false }, {}, 1),
        ev('session_started', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 2),
        ev('decision', { decision: 'go' }, { agentId: 'a1', taskId: 't1' }, 3),
        ev('tool_call_started', { toolName: 'read' }, { agentId: 'a1', taskId: 't1' }, 4),
      ];
      ctx.clientStore.applyEvents(first);
      expect(ctx.eventLog.lines).toEqual(fmt(first));

      // A subsequent batch only adds its own lines.
      const second = [ev('phase_started', { phase: 'build', round: 1 }, {}, 5)];
      ctx.clientStore.applyEvents(second);
      expect(ctx.eventLog.lines).toHaveLength(fmt([...first, ...second]).length);
      expect(ctx.eventLog.lines[2]).toBe(fmt([...first, ...second])[2]);
    });

    it('does not re-add lines for events that were already in the store at creation', () => {
      const clientStore = new ClientStore();
      const eventLog = createMockEventLog();
      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'seed', resumed: false }, {}, 1)]);
      createWsBackedTui({ clientStore, eventLog, dashboard: createMockDashboard(), requestRender: () => {} });
      const seededCount = eventLog.lines.length;
      expect(seededCount).toBe(1);

      // An unrelated store mutation (status) must not re-emit the seeded line.
      clientStore.setStatus('complete');
      expect(eventLog.lines).toHaveLength(seededCount);
    });
  });

  // ── Dashboard sync from projection ─────────────────────────────────────────

  describe('dashboard sync from projection', () => {
    it('syncs the dashboard on every store notification', () => {
      const ctx = createTestDeps();
      const initialSyncs = ctx.dashboard.syncCount;
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'scouting' }, {}, 1)]);
      expect(ctx.dashboard.syncCount).toBe(initialSyncs + 1);
      ctx.clientStore.applyEvents([ev('phase_completed', { phase: 'scouting', durationMs: 0 }, {}, 2)]);
      expect(ctx.dashboard.syncCount).toBe(initialSyncs + 2);
    });

    it('passes a projection with structured fields into syncFromProjection', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'scouting' }, {}, 1)]);
      const proj = ctx.dashboard.lastSyncedProjection as Record<string, unknown>;
      expect(proj).toBeTruthy();
      expect(proj).toHaveProperty('phases');
      expect(proj).toHaveProperty('currentPhaseId');
      expect(proj).toHaveProperty('completedPhaseIds');
      expect(proj).toHaveProperty('tasks');
      expect(proj).toHaveProperty('sessions');
      expect(proj).toHaveProperty('sidebar');
      expect(proj['currentPhaseId']).toBe('scouting');
    });

    it('reflects registered phases and tasks in the synced projection', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('phase_registered', { id: 'p1', label: 'Plan', icon: '📋' }, {}, 1),
        ev('phase_started', { phase: 'p1', round: 1 }, {}, 2),
        ev('task_registered', { taskId: 't1', title: 'Task A', phaseId: 'p1', dependencies: [] }, {}, 3),
      ]);
      const proj = ctx.dashboard.lastSyncedProjection as {
        phases: { id: string; taskIds: string[] }[];
        tasks: Record<string, unknown>;
      };
      expect(proj.phases).toHaveLength(1);
      expect(proj.phases[0].id).toBe('p1');
      expect(proj.phases[0].taskIds).toEqual(['t1']);
      expect(proj.tasks['t1']).toBeDefined();
    });

    it('reflects spawned sessions in the synced projection', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('phase_started', { phase: 'impl' }, {}, 1),
        ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      const proj = ctx.dashboard.lastSyncedProjection as {
        sessions: Record<string, { agentId: string; profile: string; active: boolean }>;
      };
      expect(Object.keys(proj.sessions)).toHaveLength(1);
      const agent = Object.values(proj.sessions)[0];
      expect(agent.agentId).toBe('a1');
      expect(agent.profile).toBe('coder');
      expect(agent.active).toBe(true);
    });

    it('syncs the dashboard even when a notification adds no new event-log line (snapshot)', () => {
      const ctx = createTestDeps();
      const before = ctx.dashboard.syncCount;
      // applySnapshot replaces the projection without adding workflowEventLog
      // entries — the dashboard must still be synced.
      ctx.clientStore.applySnapshot(
        {
          seq: 5,
          taskPrompt: 'snap',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] }],
          currentPhaseId: 'exec',
          completedPhaseIds: [],
          tasks: {},
          sessions: {},
          sidebar: { title: '', indicator: '' },
          status: 'running',
          stats: { totalTokens: 0, sessionCount: 0 },
          runLog: [],
        },
        5,
      );
      expect(ctx.dashboard.syncCount).toBe(before + 1);
      const proj = ctx.dashboard.lastSyncedProjection as { currentPhaseId: string };
      expect(proj.currentPhaseId).toBe('exec');
    });
  });

  // ── Projection shape passed to syncFromProjection (toProjection contract) ──
  //
  // `createWsBackedTui` rebuilds a `WorkflowProjection` from the
  // `ClientStoreState` via a `toProjection` helper. These tests pin down the
  // EXACT shape handed to `dashboard.syncFromProjection` so that swapping the
  // local `toProjection` for the shared `@engin/shared/projection-helpers`
  // `toProjection` cannot silently change what the dashboard receives.
  describe('synced projection shape (toProjection contract)', () => {
    it('always resets runLog to an empty array (never leaks the store RunLogEntry[] runLog)', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'x', resumed: false }, {}, 1)]);
      // Append runLog entries — these must NOT bleed into the synced projection.
      ctx.clientStore.appendRunLog('warn', 'careful', ISO_NOW);
      ctx.clientStore.appendRunLog('error', 'boom', ISO_NOW);

      const proj = ctx.dashboard.lastSyncedProjection as { runLog: unknown[] };
      expect(Array.isArray(proj.runLog)).toBe(true);
      expect(proj.runLog).toEqual([]);
    });

    it('resets runLog to [] even when the store has no runLog entries', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'p', round: 1 }, {}, 1)]);
      const proj = ctx.dashboard.lastSyncedProjection as { runLog: unknown[] };
      expect(proj.runLog).toEqual([]);
    });

    it('copies every WorkflowProjection field from the store state', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('workflow_started', { taskPrompt: 'ship it', resumed: false }, {}, 1),
        ev('phase_registered', { id: 'p1', label: 'Plan', icon: '📋' }, {}, 2),
        ev('phase_started', { phase: 'p1', round: 1 }, {}, 3),
        ev('task_registered', { taskId: 't1', title: 'Task A', phaseId: 'p1', dependencies: [] }, {}, 4),
        ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 5),
        ev('sidebar_updated', { title: 'My WF', indicator: '🟢' }, {}, 6),
      ]);
      const state = ctx.clientStore.getState();
      const proj = ctx.dashboard.lastSyncedProjection as Record<string, unknown>;

      // Every projection field is mirrored from the corresponding state field.
      expect(proj['seq']).toBe(state.seq);
      expect(proj['taskPrompt']).toBe(state.taskPrompt);
      expect(proj['phases']).toBe(state.phases);
      expect(proj['currentPhaseId']).toBe(state.currentPhaseId);
      expect(proj['completedPhaseIds']).toBe(state.completedPhaseIds);
      expect(proj['tasks']).toBe(state.tasks);
      expect(proj['sessions']).toBe(state.sessions);
      expect(proj['sidebar']).toBe(state.sidebar);
      expect(proj['status']).toBe(state.status);
      expect(proj['stats']).toBe(state.stats);
      // error / failedPhase are optional; assert they're at least present keys.
      expect(proj).toHaveProperty('error');
      expect(proj).toHaveProperty('failedPhase');
    });

    it('mirrors error and failedPhase when the workflow fails', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('phase_started', { phase: 'planning', round: 1 }, {}, 1),
        ev('workflow_failed', { phase: 'planning', error: 'kaboom' }, {}, 2),
      ]);
      const state = ctx.clientStore.getState();
      const proj = ctx.dashboard.lastSyncedProjection as {
        error?: string;
        failedPhase?: string;
        status: string;
      };
      expect(proj.status).toBe('failed');
      expect(proj.error).toBe(state.error);
      expect(proj.failedPhase).toBe(state.failedPhase);
    });

    it('mirrors seq from the store state', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'x', resumed: false }, {}, 7)]);
      const state = ctx.clientStore.getState();
      const proj = ctx.dashboard.lastSyncedProjection as { seq: number };
      expect(proj.seq).toBe(state.seq);
    });

    it('does NOT leak ClientStore-only fields into the projection', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('phase_started', { phase: 'p', round: 1 }, {}, 1),
        ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      ctx.clientStore.appendRunLog('warn', 'hey', ISO_NOW);
      const proj = ctx.dashboard.lastSyncedProjection as Record<string, unknown>;

      // Selection / prev-tracking / event-log fields live on ClientStoreState
      // but are NOT part of WorkflowProjection — they must not appear on the
      // projection handed to the dashboard.
      expect(proj).not.toHaveProperty('workflowEventLog');
      expect(proj).not.toHaveProperty('selectedPhaseId');
      expect(proj).not.toHaveProperty('selectedTaskId');
      expect(proj).not.toHaveProperty('selectedStepIndex');
      expect(proj).not.toHaveProperty('userPinnedPhase');
      expect(proj).not.toHaveProperty('userPinnedStep');
      expect(proj).not.toHaveProperty('prevCurrentPhaseId');
      expect(proj).not.toHaveProperty('prevSelectedTaskStatus');
    });

    it('produces a projection whose enumerable keys are exactly the WorkflowProjection fields', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'p', round: 1 }, {}, 1)]);
      const proj = ctx.dashboard.lastSyncedProjection as Record<string, unknown>;
      expect(Object.keys(proj).sort()).toEqual(
        [
          'seq',
          'taskPrompt',
          'phases',
          'currentPhaseId',
          'completedPhaseIds',
          'tasks',
          'sessions',
          'sidebar',
          'status',
          'error',
          'failedPhase',
          'stats',
          'runLog',
        ].sort(),
      );
    });

    it('produces a fresh projection object on every sync (not a stale cached reference)', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'p1', round: 1 }, {}, 1)]);
      const first = ctx.dashboard.lastSyncedProjection;
      ctx.clientStore.applyEvents([ev('phase_completed', { phase: 'p1', durationMs: 0 }, {}, 2)]);
      const second = ctx.dashboard.lastSyncedProjection;
      expect(second).not.toBe(first);
    });

    it('snapshot syncs also produce a projection with runLog reset to []', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applySnapshot(
        {
          seq: 9,
          taskPrompt: 'snap',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] }],
          currentPhaseId: 'exec',
          completedPhaseIds: [],
          tasks: {},
          sessions: {},
          sidebar: { title: '', indicator: '' },
          status: 'running',
          stats: { totalTokens: 0, sessionCount: 0 },
          // Non-empty runLog on the snapshot itself — must still be reset.
          runLog: [
            { id: '1', timestamp: ISO_NOW, type: 'text', content: 'ignored' },
            { id: '2', timestamp: ISO_NOW, type: 'error', content: 'also ignored' },
          ],
        },
        9,
      );
      const proj = ctx.dashboard.lastSyncedProjection as { runLog: unknown[]; seq: number };
      expect(proj.runLog).toEqual([]);
      expect(proj.seq).toBe(9);
    });
  });

  // ── requestRender ─────────────────────────────────────────────────────────

  describe('requestRender', () => {
    it('is called when events are applied', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'p', round: 1 }, {}, 1)]);
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });

    it('is called on every store notification', () => {
      const ctx = createTestDeps();
      ctx.resetRenderCount();
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'p', round: 1 }, {}, 1)]);
      ctx.clientStore.applyEvents([ev('phase_completed', { phase: 'p', durationMs: 0 }, {}, 2)]);
      ctx.clientStore.setStatus('complete');
      expect(ctx.renderCount).toBeGreaterThanOrEqual(3);
    });

    it('is called when only a runLog entry is appended', () => {
      const ctx = createTestDeps();
      ctx.resetRenderCount();
      ctx.clientStore.appendRunLog('warn', 'low memory', ISO_NOW);
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });

    it('is called on creation for an already-populated store', () => {
      const clientStore = new ClientStore();
      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'x', resumed: false }, {}, 1)]);
      let renders = 0;
      createWsBackedTui({
        clientStore,
        eventLog: createMockEventLog(),
        dashboard: createMockDashboard(),
        requestRender: () => {
          renders++;
        },
      });
      expect(renders).toBeGreaterThanOrEqual(1);
    });
  });

  // ── runLog handling (warn / error prefixed lines) ─────────────────────────

  describe('runLog handling', () => {
    it('appends a "⚠️ "-prefixed line for a warn entry', () => {
      const ctx = createTestDeps();
      ctx.clientStore.appendRunLog('warn', 'low memory', ISO_NOW);
      expect(ctx.eventLog.lines).toEqual(['⚠️ low memory']);
    });

    it('appends a "❌ "-prefixed line for an error entry', () => {
      const ctx = createTestDeps();
      ctx.clientStore.appendRunLog('error', 'kaboom', ISO_NOW);
      expect(ctx.eventLog.lines).toEqual(['❌ kaboom']);
    });

    it('does NOT append a line for an info entry', () => {
      const ctx = createTestDeps();
      ctx.clientStore.appendRunLog('info', 'starting build', ISO_NOW);
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('preserves order across mixed-level entries', () => {
      const ctx = createTestDeps();
      ctx.clientStore.appendRunLog('warn', 'first', ISO_NOW);
      ctx.clientStore.appendRunLog('info', 'middle', ISO_NOW);
      ctx.clientStore.appendRunLog('error', 'last', ISO_NOW);
      // info is skipped; warn then error remain in order.
      expect(ctx.eventLog.lines).toEqual(['⚠️ first', '❌ last']);
    });

    it('does not re-emit runLog lines already processed on creation', () => {
      const clientStore = new ClientStore();
      const eventLog = createMockEventLog();
      clientStore.appendRunLog('warn', 'preexisting', ISO_NOW);
      createWsBackedTui({
        clientStore,
        eventLog,
        dashboard: createMockDashboard(),
        requestRender: () => {},
      });
      expect(eventLog.lines).toEqual(['⚠️ preexisting']);

      // A subsequent append must not re-emit the preexisting entry.
      clientStore.appendRunLog('error', 'new', ISO_NOW);
      expect(eventLog.lines).toEqual(['⚠️ preexisting', '❌ new']);
    });

    it('coexists with workflow event-log lines', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'x', resumed: false }, {}, 1)]);
      ctx.clientStore.appendRunLog('warn', 'careful', ISO_NOW);
      expect(ctx.eventLog.lines.some((l) => l.includes('🚀 workflow started: "x" (resumed: false)'))).toBe(true);
      expect(ctx.eventLog.lines).toContain('⚠️ careful');
    });
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('stops processing events after dispose', () => {
      const clientStore = new ClientStore();
      const eventLog = createMockEventLog();
      const handle = createWsBackedTui({
        clientStore,
        eventLog,
        dashboard: createMockDashboard(),
        requestRender: () => {},
      });

      // First event is processed.
      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'a', resumed: false }, {}, 1)]);
      expect(eventLog.lines).toHaveLength(1);

      handle.dispose();

      // After dispose, new events must not add lines.
      clientStore.applyEvents([ev('phase_started', { phase: 'p', round: 1 }, {}, 2)]);
      expect(eventLog.lines).toHaveLength(1);
    });

    it('stops processing runLog entries after dispose', () => {
      const clientStore = new ClientStore();
      const eventLog = createMockEventLog();
      const handle = createWsBackedTui({
        clientStore,
        eventLog,
        dashboard: createMockDashboard(),
        requestRender: () => {},
      });

      handle.dispose();
      clientStore.appendRunLog('error', 'ignored', ISO_NOW);
      expect(eventLog.lines).toEqual([]);
    });

    it('stops calling requestRender after dispose', () => {
      const ctx = createTestDeps();
      ctx.dispose();
      ctx.resetRenderCount();
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'p', round: 1 }, {}, 1)]);
      expect(ctx.renderCount).toBe(0);
    });

    it('dispose can be called multiple times without throwing', () => {
      const ctx = createTestDeps();
      expect(() => {
        ctx.dispose();
        ctx.dispose();
      }).not.toThrow();
    });
  });

  // ── Multiple events in a single batch ──────────────────────────────────────

  describe('batch processing', () => {
    it('forwards all loud lines from a single applyEvents batch', () => {
      const ctx = createTestDeps();
      const events = [
        ev('workflow_started', { taskPrompt: 'build', resumed: false }, {}, 1),
        ev('phase_registered', { id: 'p1', label: 'Plan', icon: '📋' }, { phaseId: 'p1' }, 2),
        ev('phase_started', { phase: 'p1', round: 1 }, {}, 3),
        ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 4),
        ev('decision', { decision: 'go' }, { agentId: 'a1', taskId: 't1' }, 5),
      ];
      ctx.clientStore.applyEvents(events);
      expect(ctx.eventLog.lines).toEqual(fmt(events));
    });

    it('triggers a single dashboard sync per batch (listeners fire once per applyEvents)', () => {
      const ctx = createTestDeps();
      const before = ctx.dashboard.syncCount;
      ctx.clientStore.applyEvents([
        ev('workflow_started', { taskPrompt: 'a', resumed: false }, {}, 1),
        ev('phase_started', { phase: 'p', round: 1 }, {}, 2),
        ev('phase_completed', { phase: 'p', durationMs: 0 }, {}, 3),
      ]);
      // ClientStore notifies once per applyEvents call → one sync.
      expect(ctx.dashboard.syncCount).toBe(before + 1);
    });
  });
});
