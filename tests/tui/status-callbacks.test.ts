import { describe, expect, it } from 'bun:test';
import { EventStore } from '../../src/tracking/event-store.js';
import { createStoreCallbacks } from '../../src/tracking/store-callbacks.js';
import type { Dashboard } from '../../src/tui/components/dashboard.js';
import type { EventLog } from '../../src/tui/components/event-log.js';
import { createStoreBackedTui } from '../../src/tui/status-callbacks.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  return {
    lastProjection,
    syncFromProjection(proj: unknown) {
      lastProjection = proj;
    },
    phaseBar: {
      setCurrentPhase: () => {},
      setCompletedPhases: () => {},
      setPhases: () => {},
      setIndicator: () => {},
      setSelectedPhase: () => {},
    },
    lanePool: { updateLanes: () => {} },
    agentLog: {
      setAgents: () => {},
      setPhases: () => {},
      setCurrentPhase: () => {},
      invalidate: () => {},
      getCurrentPhase: () => null,
    },
    get lastSyncedProjection() {
      return lastProjection;
    },
  } as unknown as Dashboard & { lastSyncedProjection: unknown };
}

function createStoreAndCallbacks() {
  const store = new EventStore('/tmp/test-workdir-' + Math.random());
  const storeCallbacks = createStoreCallbacks(store);
  return { store, storeCallbacks };
}

function createTestDeps() {
  const eventLog = createMockEventLog();
  const dashboard = createMockDashboard();
  let renderCount = 0;
  const requestRender = () => {
    renderCount++;
  };

  const { store, storeCallbacks } = createStoreAndCallbacks();
  const { dispose } = createStoreBackedTui({ store, eventLog, dashboard, requestRender });

  return {
    eventLog,
    dashboard,
    store,
    storeCallbacks,
    get renderCount() {
      return renderCount;
    },
    resetRenderCount() {
      renderCount = 0;
    },
    dispose,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createStoreBackedTui', () => {
  describe('onWorkflowStart', () => {
    it('adds expected line to eventLog via store events', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onWorkflowStart!({ taskPrompt: 'build feature', resumed: false, workDir: '/tmp' });
      expect(ctx.eventLog.lines).toEqual(['🚀 Workflow started: "build feature" (resumed: false)']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onWorkflowStart!({ taskPrompt: 'test', resumed: true, workDir: '/tmp' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onWorkflowComplete', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onWorkflowComplete!({ totalDurationMs: 3456, agentCount: 5 });
      expect(ctx.eventLog.lines).toEqual(['🎉 Complete in 3.5s (5 agents)']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onWorkflowComplete!({ totalDurationMs: 1000, agentCount: 1 });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onWorkflowFailed', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onWorkflowFailed!({ error: new Error('something broke'), phase: 'planning' });
      expect(ctx.eventLog.lines).toEqual(['💥 Failed at planning: something broke']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onWorkflowFailed!({ error: new Error('x'), phase: 'p' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onPhaseStart', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseStart!({ phase: 'scouting', round: 2 });
      expect(ctx.eventLog.lines).toEqual(['📦 Phase: scouting (round 2)']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseStart!({ phase: 'x', round: 1 });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });

    it('syncs projection into dashboard', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseStart!({ phase: 'scouting', round: 1 });
      expect(ctx.dashboard.lastSyncedProjection).toBeTruthy();
    });
  });

  describe('onPhaseComplete', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 2500 });
      expect(ctx.eventLog.lines).toEqual(['✅ Phase scouting done (2.5s)']);
    });

    it('accumulates completed phases across calls', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseStart!({ phase: 'scouting', round: 1 });
      ctx.storeCallbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 1000 });
      ctx.storeCallbacks.onPhaseStart!({ phase: 'planning', round: 1 });
      ctx.storeCallbacks.onPhaseComplete!({ phase: 'planning', durationMs: 2000 });

      const proj = ctx.store.getProjection();
      expect(proj.completedPhases).toEqual(['scouting', 'planning']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseComplete!({ phase: 'x', durationMs: 100 });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onAgentSpawn', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (scout)']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'p', phase: 'x' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });

    it('agent appears in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      const proj = ctx.store.getProjection();
      const agentKeys = Object.keys(proj.agents);
      expect(agentKeys.length).toBe(1);
      expect(proj.agents[agentKeys[0]].agentId).toBe('a1');
      expect(proj.agents[agentKeys[0]].profile).toBe('coder');
      expect(proj.agents[agentKeys[0]].active).toBe(true);
    });

    it('applies taskTitle from a prior onTaskStart (production ordering)', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Implement feature', agentId: 'a1' });
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });
      const proj = ctx.store.getProjection();
      const agent = Object.values(proj.agents).find((a) => a.agentId === 'a1')!;
      expect(agent.taskTitle).toBe('Implement feature');
    });
  });

  describe('onAgentComplete', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      ctx.storeCallbacks.onAgentComplete!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      expect(ctx.eventLog.lines).toContain('✅ Agent a1 complete');
    });

    it('marks agent as inactive in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      ctx.storeCallbacks.onAgentComplete!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      const proj = ctx.store.getProjection();
      const agent = Object.values(proj.agents).find((a) => a.agentId === 'a1')!;
      expect(agent.active).toBe(false);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentComplete!({ agentId: 'a1', profile: 'p', phase: 'x' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onTaskStart', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Implement feature', agentId: 'a1' });
      expect(ctx.eventLog.lines).toEqual(['📋 Task t1: "Implement feature"']);
    });

    it('task appears in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      const proj = ctx.store.getProjection();
      expect(proj.tasks['t1']).toBeDefined();
      expect(proj.tasks['t1'].title).toBe('Task 1');
      expect(proj.tasks['t1'].status).toBe('implementing');
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'T', agentId: 'a1' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onTaskComplete', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.storeCallbacks.onTaskComplete!({ taskId: 't1', title: 'Task 1' });
      expect(ctx.eventLog.lines).toContain('✅ Task t1 complete');
    });

    it('marks task as done in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.storeCallbacks.onTaskComplete!({ taskId: 't1', title: 'Task 1' });
      const proj = ctx.store.getProjection();
      expect(proj.tasks['t1'].status).toBe('done');
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'T', agentId: 'a1' });
      ctx.resetRenderCount();
      ctx.storeCallbacks.onTaskComplete!({ taskId: 't1', title: 'T' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onTaskRejected', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.storeCallbacks.onTaskRejected!({ taskId: 't1', title: 'Task 1', reason: 'bad code' });
      expect(ctx.eventLog.lines).toContain('❌ Task t1 rejected: bad code');
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'T', agentId: 'a1' });
      ctx.resetRenderCount();
      ctx.storeCallbacks.onTaskRejected!({ taskId: 't1', title: 'T', reason: 'x' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onError', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onError!({ agentId: 'a1', error: 'crash', phase: 'planning' });
      expect(ctx.eventLog.lines).toEqual(['⚠️ Error in a1: crash (planning)']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onError!({ agentId: 'a1', error: 'e', phase: 'p' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onDecision', () => {
    it('does not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onDecision!({ agentId: 'a1', decision: 'proceed', reasoning: 'looks good' });
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onDecision!({ agentId: 'a1', decision: 'd', reasoning: 'r' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onTurnEnd', () => {
    it('processes text content blocks', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.storeCallbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'Hello world' }],
      });
      const proj = ctx.store.getProjection();
      const agent = Object.values(proj.agents).find((a) => a.agentId === 'a1')!;
      expect(agent.log.length).toBe(1);
      expect(agent.log[0].type).toBe('text');
      expect(agent.log[0].content).toBe('Hello world');
    });

    it('updates token stats', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.storeCallbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        tokens: { input: 100, output: 50 },
      });
      const proj = ctx.store.getProjection();
      const agent = Object.values(proj.agents).find((a) => a.agentId === 'a1')!;
      expect(agent.inputTokens).toBe(100);
      expect(agent.outputTokens).toBe(50);
    });

    it('no event log line added', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTurnEnd!({ agentId: 'a1', turn: 1 });
      expect(ctx.eventLog.lines).toEqual([]);
    });
  });

  describe('onToolCallStart', () => {
    it('no event log line added', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onToolCallStart!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'tc1',
        arguments: {},
      });
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('increments toolCallCount in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      ctx.storeCallbacks.onToolCallStart!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'tc1',
        arguments: {},
      });
      ctx.storeCallbacks.onToolCallStart!({
        agentId: 'a1',
        toolName: 'write',
        toolCallId: 'tc2',
        arguments: {},
      });
      const proj = ctx.store.getProjection();
      const agent = Object.values(proj.agents).find((a) => a.agentId === 'a1')!;
      expect(agent.toolCallCount).toBe(2);
    });
  });

  describe('onToolCallEnd', () => {
    it('no event log line added', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onToolCallEnd!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'tc1',
        isError: false,
      });
      expect(ctx.eventLog.lines).toEqual([]);
    });
  });

  describe('onSidebarUpdate', () => {
    it('adds title to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onSidebarUpdate!({ title: 'My Workflow' });
      expect(ctx.eventLog.lines).toEqual(['📌 My Workflow']);
    });

    it('does nothing when no title', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onSidebarUpdate!({ indicator: '🟢' });
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onSidebarUpdate!({});
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onTasksAdded', () => {
    it('tasks appear in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTasksAdded!({
        tasks: [
          { id: 't1', title: 'Task A', status: 'blocked', dependencies: ['t2'] },
          { id: 't2', title: 'Task B', status: 'ready', dependencies: [] },
        ],
      });
      const proj = ctx.store.getProjection();
      expect(proj.tasks['t1']).toBeDefined();
      expect(proj.tasks['t2']).toBeDefined();
      expect(proj.tasks['t1'].status).toBe('blocked');
      expect(proj.tasks['t2'].status).toBe('ready');
    });

    it('no event log line added', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTasksAdded!({
        tasks: [{ id: 't1', title: 'Task', status: 'ready', dependencies: [] }],
      });
      expect(ctx.eventLog.lines).toEqual([]);
    });
  });

  describe('dispose', () => {
    it('stops receiving events after dispose', () => {
      const eventLog = createMockEventLog();
      const dashboard = createMockDashboard();
      const { store, storeCallbacks } = createStoreAndCallbacks();
      const { dispose } = createStoreBackedTui({ store, eventLog, dashboard, requestRender: () => {} });

      // First event — should be processed
      storeCallbacks.onWorkflowStart!({ taskPrompt: 'test', resumed: false, workDir: '/tmp' });
      expect(eventLog.lines.length).toBe(1);
      dispose();

      // After dispose — should NOT add more lines
      const prevCount = eventLog.lines.length;
      storeCallbacks.onWorkflowComplete!({ totalDurationMs: 100, agentCount: 1 });
      expect(eventLog.lines.length).toBe(prevCount);
    });
  });

  describe('requestRender called after every callback', () => {
    it('requestRender is invoked for callbacks that produce event log lines', () => {
      const ctx = createTestDeps();

      ctx.storeCallbacks.onWorkflowStart!({ taskPrompt: 't', resumed: false, workDir: '/tmp' });
      ctx.storeCallbacks.onWorkflowComplete!({ totalDurationMs: 1000, agentCount: 1 });
      ctx.storeCallbacks.onWorkflowFailed!({ error: new Error('e'), phase: 'p' });
      ctx.storeCallbacks.onPhaseStart!({ phase: 'p', round: 1 });
      ctx.storeCallbacks.onPhaseComplete!({ phase: 'p', durationMs: 100 });
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a', profile: 'p', phase: 'x' });
      ctx.storeCallbacks.onAgentComplete!({ agentId: 'a', profile: 'p', phase: 'x' });
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'T', agentId: 'a1' });
      ctx.storeCallbacks.onTaskComplete!({ taskId: 't1', title: 'T' });
      ctx.storeCallbacks.onTaskRejected!({ taskId: 't1', title: 'T', reason: 'r' });
      ctx.storeCallbacks.onError!({ agentId: 'a', error: 'e', phase: 'p' });
      ctx.storeCallbacks.onSidebarUpdate!({ title: 'Test' });
      ctx.storeCallbacks.onTasksAdded!({ tasks: [] });

      expect(ctx.renderCount).toBeGreaterThanOrEqual(13);
    });
  });

  describe('verbose callbacks do not pollute eventLog', () => {
    it('onDecision does not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onDecision!({ agentId: 'a1', decision: 'proceed', reasoning: 'ok' });
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('onTurnEnd does not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTurnEnd!({ agentId: 'a1', turn: 1, contentBlocks: [{ type: 'text', text: 'output' }] });
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('onToolCallStart does not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onToolCallStart!({ agentId: 'a1', toolName: 'readFile', toolCallId: 'tc1', arguments: {} });
      expect(ctx.eventLog.lines).toEqual([]);
    });
  });

  describe('initial projection sync', () => {
    it('syncs existing projection state on creation', () => {
      const eventLog = createMockEventLog();
      const dashboard = createMockDashboard();
      const { store, storeCallbacks } = createStoreAndCallbacks();

      // Seed some events before creating the TUI bridge
      storeCallbacks.onWorkflowStart!({ taskPrompt: 'test', resumed: false, workDir: '/tmp' });
      storeCallbacks.onPhaseStart!({ phase: 'scouting', round: 1 });

      // Now create the bridge — it should pick up the existing projection
      createStoreBackedTui({ store, eventLog, dashboard, requestRender: () => {} });

      // dashboard.syncFromProjection should have been called with the current projection
      expect(dashboard.lastSyncedProjection).toBeTruthy();
    });
  });
});
