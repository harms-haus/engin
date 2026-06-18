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
import type { EventRecord, EventType } from '@engin/shared/event-types';

import type { Dashboard } from '../../packages/tui/src/components/dashboard.js';
import type { EventLog } from '../../packages/tui/src/components/event-log.js';
import { createWsBackedTui } from '../../packages/tui/src/ws-backed-tui.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const ISO_NOW = '2026-06-15T00:00:00.000Z';

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
      setSelectedAgentUid: () => {},
      toggleExpand: () => {},
      isExpanded: () => false,
      getExpandedLineCount: () => 20,
      getSelectedAgentUid: () => null,
      invalidate: () => {},
      handleInput: () => {},
      render: () => [] as string[],
    },
    getSelection: () => ({
      selectedPhaseId: null,
      selectedTaskId: null,
      selectedStepIndex: null,
      userPinnedPhase: false,
      userPinnedStep: false,
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
      ctx.clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'build feature', resumed: false }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['🚀 Workflow started: "build feature" (resumed: false)']);
    });

    it('processes events already in the store on creation (replay)', () => {
      const clientStore = new ClientStore();
      const eventLog = createMockEventLog();
      const dashboard = createMockDashboard();
      // Seed events BEFORE wiring up the adapter.
      clientStore.applyEvents([
        ev('workflow_started', { taskPrompt: 'preexisting', resumed: true }, {}, 1),
        ev('phase_started', { phase: 'scouting', round: 1 }, {}, 2),
      ]);

      createWsBackedTui({ clientStore, eventLog, dashboard, requestRender: () => {} });

      expect(eventLog.lines).toEqual([
        '🚀 Workflow started: "preexisting" (resumed: true)',
        '📦 Phase: scouting (round 1)',
      ]);
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
      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'first', resumed: false }, {}, 1)]);
      createWsBackedTui({ clientStore, eventLog, dashboard, requestRender: () => {} });
      expect(eventLog.lines).toHaveLength(1);

      // Apply a second batch — the first line must not be duplicated.
      clientStore.applyEvents([ev('phase_started', { phase: 'build', round: 1 }, {}, 2)]);
      expect(eventLog.lines).toEqual(['🚀 Workflow started: "first" (resumed: false)', '📦 Phase: build (round 1)']);
    });
  });

  // ── Event log line forwarding (one per loud lifecycle event) ──────────────

  describe('event log lines (ported from status-callbacks via shared formatWorkflowEventLine)', () => {
    it('forwards workflow_started line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'ship it', resumed: false }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['🚀 Workflow started: "ship it" (resumed: false)']);
    });

    it('forwards workflow_completed line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('workflow_completed', { totalDurationMs: 3456, agentCount: 5 }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['🎉 Complete in 3.5s (5 agents)']);
    });

    it('forwards workflow_failed line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('workflow_failed', { phase: 'planning', error: 'something broke' }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['💥 Failed at planning: something broke']);
    });

    it('forwards phase_registered line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('phase_registered', { id: 'scouting', label: 'Scouting', icon: '🔍' }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['📝 Phase registered: Scouting']);
    });

    it('forwards phase_started line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'scouting', round: 2 }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['📦 Phase: scouting (round 2)']);
    });

    it('forwards phase_completed line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('phase_completed', { phase: 'scouting', durationMs: 2500 }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['✅ Phase scouting done (2.5s)']);
    });

    it('forwards agent_spawned line (agentId from metadata)', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('agent_spawned', { profile: 'scout' }, { agentId: 'a1' }, 1)]);
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (scout)']);
    });

    it('forwards agent_completed line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('agent_spawned', { profile: 'scout' }, { agentId: 'a1', taskId: 't1' }, 1),
        ev('agent_completed', {}, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      expect(ctx.eventLog.lines).toContain('✅ Agent a1 complete');
    });

    it('forwards task_registered line (uses stepCount from data)', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('task_registered', { taskId: 't1', title: 'Task', phaseId: 'p1', stepCount: 2, steps: [] }, {}, 1),
      ]);
      expect(ctx.eventLog.lines).toEqual(['📋 Task registered: "Task" (phase: p1, 2 steps)']);
    });

    it('forwards task_started line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('task_started', { taskId: 't1', title: 'Implement feature' }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['📋 Task t1: "Implement feature"']);
    });

    it('forwards task_completed line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('task_completed', { taskId: 't1' }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['✅ Task t1 complete']);
    });

    it('forwards task_rejected line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('task_rejected', { taskId: 't1', reason: 'bad code' }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['❌ Task t1 rejected: bad code']);
    });

    it('forwards error line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('error', { error: 'crash' }, { agentId: 'a1', phaseId: 'planning' }, 1)]);
      expect(ctx.eventLog.lines).toEqual(['⚠️ Error in a1: crash (planning)']);
    });

    it('forwards sidebar_updated line when a title is present', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('sidebar_updated', { title: 'My Workflow' }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual(['📌 My Workflow']);
    });

    it('does NOT forward sidebar_updated when there is no title', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([ev('sidebar_updated', { indicator: '🟢' }, {}, 1)]);
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('forwards step_started line', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('step_started', { taskId: 't1', stepIndex: 0, stepName: 'step1' }, { agentId: 'a1' }, 1),
      ]);
      expect(ctx.eventLog.lines).toEqual(['Step 0 started: step1 (task: t1, agent: a1)']);
    });
  });

  // ── Verbose events produce no line ────────────────────────────────────────

  describe('verbose events produce no event-log line', () => {
    it('decision is silent', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1),
        ev('decision', { decision: 'proceed', reasoning: 'ok' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (p)']);
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
      ctx.clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'a', resumed: false }, {}, 1)]);
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'p', round: 1 }, {}, 2)]);
      ctx.clientStore.applyEvents([ev('phase_completed', { phase: 'p', durationMs: 0 }, {}, 3)]);

      expect(ctx.eventLog.lines).toEqual([
        '🚀 Workflow started: "a" (resumed: false)',
        '📦 Phase: p (round 1)',
        '✅ Phase p done (0.0s)',
      ]);
    });

    it('does not duplicate lines when a batch mixes loud and silent events', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('workflow_started', { taskPrompt: 'x', resumed: false }, {}, 1),
        ev('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 2),
        ev('decision', { decision: 'go' }, { agentId: 'a1', taskId: 't1' }, 3),
        ev('tool_call_started', { toolName: 'read' }, { agentId: 'a1', taskId: 't1' }, 4),
      ]);
      expect(ctx.eventLog.lines).toEqual(['🚀 Workflow started: "x" (resumed: false)', '⏳ Agent a1 spawned (p)']);

      // A subsequent batch only adds its own lines.
      ctx.clientStore.applyEvents([ev('phase_started', { phase: 'build', round: 1 }, {}, 5)]);
      expect(ctx.eventLog.lines).toHaveLength(3);
      expect(ctx.eventLog.lines[2]).toBe('📦 Phase: build (round 1)');
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
      expect(proj).toHaveProperty('agents');
      expect(proj).toHaveProperty('sidebar');
      expect(proj['currentPhaseId']).toBe('scouting');
    });

    it('reflects registered phases and tasks in the synced projection', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('phase_registered', { id: 'p1', label: 'Plan', icon: '📋' }, {}, 1),
        ev('phase_started', { phase: 'p1', round: 1 }, {}, 2),
        ev('task_registered', { taskId: 't1', title: 'Task A', phaseId: 'p1', steps: [], dependencies: [] }, {}, 3),
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

    it('reflects spawned agents in the synced projection', () => {
      const ctx = createTestDeps();
      ctx.clientStore.applyEvents([
        ev('phase_started', { phase: 'impl' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      const proj = ctx.dashboard.lastSyncedProjection as {
        agents: Record<string, { agentId: string; profile: string; active: boolean }>;
      };
      expect(Object.keys(proj.agents)).toHaveLength(1);
      const agent = Object.values(proj.agents)[0];
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
          agents: {},
          sidebar: { title: '', indicator: '' },
          status: 'running',
          stats: { totalTokens: 0, agentCount: 0 },
          runLog: [],
        },
        5,
      );
      expect(ctx.dashboard.syncCount).toBe(before + 1);
      const proj = ctx.dashboard.lastSyncedProjection as { currentPhaseId: string };
      expect(proj.currentPhaseId).toBe('exec');
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
      expect(ctx.eventLog.lines).toContain('🚀 Workflow started: "x" (resumed: false)');
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
      ctx.clientStore.applyEvents([
        ev('workflow_started', { taskPrompt: 'build', resumed: false }, {}, 1),
        ev('phase_registered', { id: 'p1', label: 'Plan', icon: '📋' }, {}, 2),
        ev('phase_started', { phase: 'p1', round: 1 }, {}, 3),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 4),
        ev('decision', { decision: 'go' }, { agentId: 'a1', taskId: 't1' }, 5),
      ]);
      expect(ctx.eventLog.lines).toEqual([
        '🚀 Workflow started: "build" (resumed: false)',
        '📝 Phase registered: Plan',
        '📦 Phase: p1 (round 1)',
        '⏳ Agent a1 spawned (coder)',
      ]);
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
