import { describe, expect, it } from 'bun:test';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';
import { createStoreCallbacks } from '../../packages/engine/src/tracking/store-callbacks.js';
import type { Dashboard } from '../../packages/tui/src/components/dashboard.js';
import type { EventLog } from '../../packages/tui/src/components/event-log.js';
import { createStoreBackedTui } from '../../packages/tui/src/status-callbacks.js';

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
      ctx.storeCallbacks.onWorkflowFailed!({ error: new Error('something broke'), phaseId: 'planning' });
      expect(ctx.eventLog.lines).toEqual(['💥 Failed at planning: something broke']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onWorkflowFailed!({ error: new Error('x'), phaseId: 'p' });
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

    it('syncs projection into dashboard with structured fields', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseStart!({ phase: 'scouting', round: 1 });
      const proj = ctx.dashboard.lastSyncedProjection as any;
      expect(proj).toBeTruthy();
      expect(proj).toHaveProperty('phases');
      expect(proj).toHaveProperty('currentPhaseId');
      expect(proj).toHaveProperty('completedPhaseIds');
      expect(proj).toHaveProperty('tasks');
      expect(proj).toHaveProperty('agents');
      expect(proj).toHaveProperty('sidebar');
      expect(proj.sidebar).toHaveProperty('title');
      expect(proj.sidebar).toHaveProperty('indicator');
      expect(proj.currentPhaseId).toBe('scouting');
    });
  });

  describe('onPhaseRegister', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseRegister!({ id: 'scouting', label: 'Scouting', icon: '🔍' });
      expect(ctx.eventLog.lines).toEqual(['📝 Phase registered: Scouting']);
    });

    it('phase appears in projection with all fields', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseRegister!({ id: 'planning', label: 'Planning', icon: '📋' });
      const proj = ctx.store.getProjection();
      expect(proj.phases).toHaveLength(1);
      expect(proj.phases[0].id).toBe('planning');
      expect(proj.phases[0].label).toBe('Planning');
      expect(proj.phases[0].icon).toBe('📋');
      expect(proj.phases[0].taskIds).toEqual([]);
    });

    it('accumulates multiple phases in insertion order', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseRegister!({ id: 'scouting', label: 'Scouting', icon: '🔍' });
      ctx.storeCallbacks.onPhaseRegister!({ id: 'planning', label: 'Planning', icon: '📋' });
      ctx.storeCallbacks.onPhaseRegister!({ id: 'implement', label: 'Implementation', icon: '⚙️' });
      const proj = ctx.store.getProjection();
      expect(proj.phases).toHaveLength(3);
      expect(proj.phases[0].id).toBe('scouting');
      expect(proj.phases[1].id).toBe('planning');
      expect(proj.phases[2].id).toBe('implement');
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseRegister!({ id: 'x', label: 'X', icon: '' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
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
      expect(proj.completedPhaseIds).toEqual(['scouting', 'planning']);
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
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phaseId: 'scouting' });
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (scout)']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'p', phaseId: 'x' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
    });

    it('agent appears in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phaseId: 'implement' });
      const proj = ctx.store.getProjection();
      const agentKeys = Object.keys(proj.agents);
      expect(agentKeys.length).toBe(1);
      expect(proj.agents[agentKeys[0]].agentId).toBe('a1');
      expect(proj.agents[agentKeys[0]].profile).toBe('coder');
      expect(proj.agents[agentKeys[0]].active).toBe(true);
    });

    it('applies taskTitle from a prior onTaskRegister (production ordering)', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'implement',
        title: 'Implement feature',
        dependencies: [],
        steps: [],
      });
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phaseId: 'implement', taskId: 't1' });
      const proj = ctx.store.getProjection();
      const agent = Object.values(proj.agents).find((a) => a.agentId === 'a1')!;
      expect(agent.taskTitle).toBe('Implement feature');
    });
  });

  describe('onAgentComplete', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phaseId: 'scouting' });
      ctx.storeCallbacks.onAgentComplete!({ agentId: 'a1', profile: 'scout', phaseId: 'scouting' });
      expect(ctx.eventLog.lines).toContain('✅ Agent a1 complete');
    });

    it('marks agent as inactive in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phaseId: 'scouting' });
      ctx.storeCallbacks.onAgentComplete!({ agentId: 'a1', profile: 'scout', phaseId: 'scouting' });
      const proj = ctx.store.getProjection();
      const agent = Object.values(proj.agents).find((a) => a.agentId === 'a1')!;
      expect(agent.active).toBe(false);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onAgentComplete!({ agentId: 'a1', profile: 'p', phaseId: 'x' });
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
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Task 1',
        dependencies: [],
        steps: [],
      });
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      const proj = ctx.store.getProjection();
      expect(proj.tasks['t1']).toBeDefined();
      expect(proj.tasks['t1'].title).toBe('Task 1');
      expect(proj.tasks['t1'].status).toBe('active');
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
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Task 1',
        dependencies: [],
        steps: [],
      });
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.storeCallbacks.onTaskComplete!({ taskId: 't1', title: 'Task 1' });
      expect(ctx.eventLog.lines).toContain('✅ Task t1 complete');
    });

    it('marks task as complete in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Task 1',
        dependencies: [],
        steps: [],
      });
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.storeCallbacks.onTaskComplete!({ taskId: 't1', title: 'Task 1' });
      const proj = ctx.store.getProjection();
      expect(proj.tasks['t1'].status).toBe('complete');
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'T',
        dependencies: [],
        steps: [],
      });
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
      ctx.storeCallbacks.onError!({ agentId: 'a1', error: 'crash', phaseId: 'planning' });
      expect(ctx.eventLog.lines).toEqual(['⚠️ Error in a1: crash (planning)']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onError!({ agentId: 'a1', error: 'e', phaseId: 'p' });
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
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phaseId: 'implement' });
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
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phaseId: 'implement' });
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
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phaseId: 'scouting' });
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

  describe('onTaskRegister', () => {
    it('tasks appear in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Task A',
        dependencies: ['t2'],
        steps: [],
      });
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't2',
        phaseId: 'p1',
        title: 'Task B',
        dependencies: [],
        steps: [],
      });
      const proj = ctx.store.getProjection();
      expect(proj.tasks['t1']).toBeDefined();
      expect(proj.tasks['t2']).toBeDefined();
      expect(proj.tasks['t1'].status).toBe('ready');
      expect(proj.tasks['t2'].status).toBe('ready');
    });

    it('registers steps with correct structure', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Multi-step task',
        dependencies: [],
        steps: [
          { name: 'write-code', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      const proj = ctx.store.getProjection();
      expect(proj.tasks['t1'].steps).toHaveLength(2);
      expect(proj.tasks['t1'].steps[0].name).toBe('write-code');
      expect(proj.tasks['t1'].steps[0].index).toBe(0);
      expect(proj.tasks['t1'].steps[0].profile).toBe('coder');
      expect(proj.tasks['t1'].steps[0].isReadOnly).toBe(false);
      expect(proj.tasks['t1'].steps[0].agentKey).toBeUndefined();
      expect(proj.tasks['t1'].steps[1].name).toBe('review');
      expect(proj.tasks['t1'].steps[1].index).toBe(1);
      expect(proj.tasks['t1'].steps[1].profile).toBe('reviewer');
      expect(proj.tasks['t1'].steps[1].isReadOnly).toBe(true);
    });

    it('appends taskId to parent PhaseEntity.taskIds', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onPhaseRegister!({ id: 'p1', label: 'Phase 1', icon: '📦' });
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Task 1',
        dependencies: [],
        steps: [],
      });
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't2',
        phaseId: 'p1',
        title: 'Task 2',
        dependencies: [],
        steps: [],
      });
      const proj = ctx.store.getProjection();
      const phase = proj.phases.find((p) => p.id === 'p1')!;
      expect(phase.taskIds).toEqual(['t1', 't2']);
    });

    it('adds a line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Task',
        dependencies: [],
        steps: [],
      });
      expect(ctx.eventLog.lines).toHaveLength(1);
      expect(ctx.eventLog.lines[0]).toContain('📋 Task registered');
    });
  });

  describe('onStepStart', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Test',
        dependencies: [],
        steps: [{ name: 'step1', profileId: 'coder', isReadOnly: false }],
      });
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Test', agentId: 'a1' });
      ctx.storeCallbacks.onStepStart!({ taskId: 't1', stepIndex: 0, stepName: 'step1', agentId: 'a1' });
      expect(ctx.eventLog.lines).toContain('Step 0 started: step1 (task: t1, agent: a1)');
    });

    it('updates activeStepIndex in projection', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Test',
        dependencies: [],
        steps: [
          { name: 'step1', profileId: 'coder', isReadOnly: false },
          { name: 'step2', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Test', agentId: 'a1' });

      // First step
      ctx.storeCallbacks.onStepStart!({ taskId: 't1', stepIndex: 0, stepName: 'step1', agentId: 'a1' });
      let proj = ctx.store.getProjection();
      expect(proj.tasks['t1'].activeStepIndex).toBe(0);

      // Advance to second step
      ctx.storeCallbacks.onStepStart!({ taskId: 't1', stepIndex: 1, stepName: 'step2', agentId: 'a2' });
      proj = ctx.store.getProjection();
      expect(proj.tasks['t1'].activeStepIndex).toBe(1);
    });

    it('links spawned agent to step via agentKey', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onTaskRegister!({
        taskId: 't1',
        phaseId: 'p1',
        title: 'Test',
        dependencies: [],
        steps: [{ name: 'code', profileId: 'coder', isReadOnly: false }],
      });
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'Test', agentId: 'a1' });

      // Spawn agent for step 0
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phaseId: 'p1', taskId: 't1', stepIndex: 0 });
      ctx.storeCallbacks.onStepStart!({ taskId: 't1', stepIndex: 0, stepName: 'code', agentId: 'a1' });

      const proj = ctx.store.getProjection();
      const expectedKey = 'a1::t1';
      expect(proj.tasks['t1'].steps[0].agentKey).toBe(expectedKey);
      expect(proj.agents[expectedKey]).toBeDefined();
      expect(proj.agents[expectedKey].agentId).toBe('a1');
      expect(proj.agents[expectedKey].stepIndex).toBe(0);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.storeCallbacks.onStepStart!({ taskId: 't1', stepIndex: 0, stepName: 's', agentId: 'a1' });
      expect(ctx.renderCount).toBeGreaterThanOrEqual(1);
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
      ctx.storeCallbacks.onWorkflowFailed!({ error: new Error('e'), phaseId: 'p' });
      ctx.storeCallbacks.onPhaseStart!({ phase: 'p', round: 1 });
      ctx.storeCallbacks.onPhaseComplete!({ phase: 'p', durationMs: 100 });
      ctx.storeCallbacks.onAgentSpawn!({ agentId: 'a', profile: 'p', phaseId: 'x' });
      ctx.storeCallbacks.onAgentComplete!({ agentId: 'a', profile: 'p', phaseId: 'x' });
      ctx.storeCallbacks.onTaskStart!({ taskId: 't1', title: 'T', agentId: 'a1' });
      ctx.storeCallbacks.onTaskComplete!({ taskId: 't1', title: 'T' });
      ctx.storeCallbacks.onTaskRejected!({ taskId: 't1', title: 'T', reason: 'r' });
      ctx.storeCallbacks.onError!({ agentId: 'a', error: 'e', phaseId: 'p' });
      ctx.storeCallbacks.onSidebarUpdate!({ title: 'Test' });

      expect(ctx.renderCount).toBeGreaterThanOrEqual(12);
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
