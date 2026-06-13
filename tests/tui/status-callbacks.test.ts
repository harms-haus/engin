import { describe, expect, it } from 'bun:test';
import { AgentRegistry } from '../../src/tracking/agent-registry.js';
import type { AgentLogWidget } from '../../src/tui/components/agent-log-widget.js';
import type { Dashboard } from '../../src/tui/components/dashboard.js';
import type { EventLog } from '../../src/tui/components/event-log.js';
import type { LanePoolWidget, TaskLane } from '../../src/tui/components/lane-pool-widget.js';
import type { PhaseBar } from '../../src/tui/components/phase-bar.js';
import { createTuiStatusCallbacks } from '../../src/tui/status-callbacks.js';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockEventLog() {
  const lines: string[] = [];
  return {
    lines,
    addLine: (text: string) => {
      lines.push(text);
    },
  } as unknown as EventLog & { lines: string[] };
}

function createMockPhaseBar() {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    setPhases(phases: unknown[]) {
      calls.push({ method: 'setPhases', args: [phases] });
    },
    setCurrentPhase(id: string) {
      calls.push({ method: 'setCurrentPhase', args: [id] });
    },
    setCompletedPhases(ids: string[]) {
      calls.push({ method: 'setCompletedPhases', args: [ids] });
    },
    setIndicator(icon: string) {
      calls.push({ method: 'setIndicator', args: [icon] });
    },
    invalidate() {
      calls.push({ method: 'invalidate', args: [] });
    },
  } as unknown as PhaseBar & { calls: { method: string; args: unknown[] }[] };
}

function createMockLanePool() {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    updateLanes(lanes: TaskLane[]) {
      calls.push({ method: 'updateLanes', args: [lanes] });
    },
    invalidate() {
      calls.push({ method: 'invalidate', args: [] });
    },
  } as unknown as LanePoolWidget & { calls: { method: string; args: unknown[] }[] };
}

/**
 * Minimal mock for AgentLogWidget that only exposes methods actually called by
 * status-callbacks.ts after the registry rewrite.
 */
function createMockAgentLog() {
  const calls: { method: string; args: unknown[] }[] = [];
  let expanded = false;
  return {
    calls,
    setCurrentPhase(phase: string) {
      calls.push({ method: 'setCurrentPhase', args: [phase] });
    },
    setPhases(phases: string[]) {
      calls.push({ method: 'setPhases', args: [phases] });
    },
    isExpanded(): boolean {
      return expanded;
    },
    toggleExpand() {
      expanded = !expanded;
      calls.push({ method: 'toggleExpand', args: [] });
    },
    getExpandedLineCount(): number {
      return 40;
    },
    invalidate() {
      calls.push({ method: 'invalidate', args: [] });
    },
  } as unknown as AgentLogWidget & { calls: { method: string; args: unknown[] }[] };
}

function createMockDashboard(
  phaseBar: ReturnType<typeof createMockPhaseBar>,
  lanePool: ReturnType<typeof createMockLanePool>,
  agentLog: ReturnType<typeof createMockAgentLog>,
) {
  return {
    phaseBar,
    lanePool,
    agentLog,
    registry: new AgentRegistry(),
  } as unknown as Dashboard;
}

function createTestDeps() {
  const eventLog = createMockEventLog();
  const phaseBar = createMockPhaseBar();
  const lanePool = createMockLanePool();
  const agentLog = createMockAgentLog();
  const dashboard = createMockDashboard(phaseBar, lanePool, agentLog);
  let renderCount = 0;
  const requestRender = () => {
    renderCount++;
  };

  const callbacks = createTuiStatusCallbacks({ eventLog, dashboard, requestRender });

  return {
    eventLog,
    phaseBar,
    lanePool,
    agentLog,
    dashboard,
    get renderCount() {
      return renderCount;
    },
    resetRenderCount() {
      renderCount = 0;
    },
    callbacks,
  };
}

function createTestDepsWithInitialAgents(
  initialAgents: NonNullable<Parameters<typeof createTuiStatusCallbacks>[0]['initialAgents']>,
) {
  const eventLog = createMockEventLog();
  const phaseBar = createMockPhaseBar();
  const lanePool = createMockLanePool();
  const agentLog = createMockAgentLog();
  const dashboard = createMockDashboard(phaseBar, lanePool, agentLog);
  let renderCount = 0;
  const requestRender = () => {
    renderCount++;
  };

  const callbacks = createTuiStatusCallbacks({ eventLog, dashboard, requestRender, initialAgents });

  return {
    eventLog,
    phaseBar,
    lanePool,
    agentLog,
    dashboard,
    get renderCount() {
      return renderCount;
    },
    resetRenderCount() {
      renderCount = 0;
    },
    callbacks,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createTuiStatusCallbacks', () => {
  describe('onWorkflowStart', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onWorkflowStart!({ taskPrompt: 'build feature', resumed: false, workDir: '/tmp' });
      expect(ctx.eventLog.lines).toEqual(['🚀 Workflow started: "build feature" (resumed: false)']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onWorkflowStart!({ taskPrompt: 'test', resumed: true, workDir: '/tmp' });
      expect(ctx.renderCount).toBe(1);
    });
  });

  describe('onWorkflowComplete', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onWorkflowComplete!({ totalDurationMs: 3456, agentCount: 5 });
      expect(ctx.eventLog.lines).toEqual(['🎉 Complete in 3.5s (5 agents)']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onWorkflowComplete!({ totalDurationMs: 1000, agentCount: 1 });
      expect(ctx.renderCount).toBe(1);
    });
  });

  describe('onWorkflowFailed', () => {
    it('adds expected line to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onWorkflowFailed!({ error: new Error('something broke'), phase: 'planning' });
      expect(ctx.eventLog.lines).toEqual(['💥 Failed at planning: something broke']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onWorkflowFailed!({ error: new Error('x'), phase: 'p' });
      expect(ctx.renderCount).toBe(1);
    });
  });

  describe('onPhaseStart', () => {
    it('adds expected line to eventLog and updates phaseBar', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onPhaseStart!({ phase: 'scouting', round: 2 });
      expect(ctx.eventLog.lines).toEqual(['📦 Phase: scouting (round 2)']);
      expect(ctx.phaseBar.calls).toEqual([{ method: 'setCurrentPhase', args: ['scouting'] }]);
    });

    it('calls setCurrentPhase on agentLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onPhaseStart!({ phase: 'scouting', round: 2 });
      expect(ctx.agentLog.calls).toContainEqual({ method: 'setCurrentPhase', args: ['scouting'] });
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onPhaseStart!({ phase: 'x', round: 1 });
      expect(ctx.renderCount).toBe(1);
    });
  });

  describe('onPhaseComplete', () => {
    it('adds expected line to eventLog and updates phaseBar completedPhases', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 2500 });
      expect(ctx.eventLog.lines).toEqual(['✅ Phase scouting done (2.5s)']);
      expect(ctx.phaseBar.calls).toEqual([{ method: 'setCompletedPhases', args: [['scouting']] }]);
    });

    it('accumulates completed phases across calls', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 1000 });
      ctx.callbacks.onPhaseComplete!({ phase: 'planning', durationMs: 2000 });
      expect(ctx.phaseBar.calls.length).toBe(2);
      // Both calls share the same completedPhases array reference, so check the final state
      expect(ctx.phaseBar.calls[1].args[0]).toEqual(['scouting', 'planning']);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onPhaseComplete!({ phase: 'x', durationMs: 100 });
      expect(ctx.renderCount).toBe(1);
    });
  });

  describe('onAgentSpawn', () => {
    it('adds expected line to eventLog and registers agent in registry', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (scout)']);

      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe('a1');
      expect(agents[0].profile).toBe('scout');
      expect(agents[0].phase).toBe('scouting');
      expect(agents[0].status).toBe('active');
      expect(agents[0].uid).toMatch(/^agent-\d+$/);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'p', phase: 'x' });
      expect(ctx.renderCount).toBe(1);
    });

    it('builds reverse maps when taskId is provided', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });
      // Spawn a second agent without taskId to have a clean baseline
      // Verify the reverse map works by triggering onTaskStart with the same taskId
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'My task', agentId: 'a1' });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].taskTitle).toBe('My task');
    });

    it('passes sessionId and sessionPath to registry', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({
        agentId: 'a1',
        profile: 'coder',
        phase: 'implement',
        sessionId: 'sess-1',
        sessionPath: '/sessions/sess-1',
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].sessionId).toBe('sess-1');
      expect(agents[0].sessionPath).toBe('/sessions/sess-1');
    });
  });

  describe('onAgentComplete', () => {
    it('adds expected line to eventLog and completes agent in registry', () => {
      const ctx = createTestDeps();
      // Must spawn first so the agent exists in the registry
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      ctx.callbacks.onAgentComplete!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (scout)', '✅ Agent a1 complete']);

      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].status).toBe('completed');
      expect(agents[0].completedAt).toBeDefined();
      expect(agents[0].entries).toEqual([{ type: 'text', content: 'Agent session ended' }]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentComplete!({ agentId: 'a1', profile: 'p', phase: 'x' });
      expect(ctx.renderCount).toBe(1);
    });

    it('handles unknown agentId gracefully (no crash, no registry entry)', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentComplete!({ agentId: 'unknown', profile: 'p', phase: 'x' });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(0);
    });
  });

  describe('onTaskStart', () => {
    it('adds expected line to eventLog and creates lane', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Implement feature', agentId: 'a1' });
      expect(ctx.eventLog.lines).toEqual(['📋 Task t1: "Implement feature"']);
      expect(ctx.lanePool.calls).toEqual([
        {
          method: 'updateLanes',
          args: [[{ id: 't1', title: 'Implement feature', status: 'implementing', agentId: 'a1' }]],
        },
      ]);
    });

    it('accumulates lanes across multiple task starts', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.callbacks.onTaskStart!({ taskId: 't2', title: 'Task 2', agentId: 'a2' });
      expect(ctx.lanePool.calls.length).toBe(2);
      const secondCall = ctx.lanePool.calls[1].args[0] as TaskLane[];
      expect(secondCall.length).toBe(2);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'T', agentId: 'a1' });
      expect(ctx.renderCount).toBe(1);
    });

    it('updates taskTitle on the associated agent when agent was spawned with taskId', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Implement feature', agentId: 'a1' });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].taskTitle).toBe('Implement feature');
    });

    it('uses info.agentId as fallback for taskTitle when no reverse map entry', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Standalone task', agentId: 'a1' });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].taskTitle).toBe('Standalone task');
    });

    it('passes phase and startedAt to lane when provided', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({
        taskId: 't1',
        title: 'Task with phase',
        agentId: 'a1',
        phase: 'scouting',
        startedAt: 123456789,
      });
      const lastCall = ctx.lanePool.calls[ctx.lanePool.calls.length - 1];
      const lane = (lastCall.args[0] as TaskLane[])[0];
      expect(lane.phase).toBe('scouting');
      expect(lane.startedAt).toBe(123456789);
    });

    it('omits phase and startedAt when not provided', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Task without phase', agentId: 'a1' });
      const lastCall = ctx.lanePool.calls[ctx.lanePool.calls.length - 1];
      const lane = (lastCall.args[0] as TaskLane[])[0];
      expect(lane.phase).toBeUndefined();
      expect(lane.startedAt).toBeUndefined();
    });
  });

  describe('onTaskComplete', () => {
    it('updates lane status to done and sets completedAt', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.callbacks.onTaskComplete!({ taskId: 't1', title: 'Task 1' });
      expect(ctx.eventLog.lines).toContain('✅ Task t1 complete');
      const lastLaneUpdate = ctx.lanePool.calls[ctx.lanePool.calls.length - 1].args[0] as TaskLane[];
      expect(lastLaneUpdate[0].status).toBe('done');
      expect(lastLaneUpdate[0].completedAt).toEqual(expect.any(Number));
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'T', agentId: 'a1' });
      ctx.resetRenderCount();
      ctx.callbacks.onTaskComplete!({ taskId: 't1', title: 'T' });
      expect(ctx.renderCount).toBe(1);
    });

    it('handles unknown taskId gracefully', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskComplete!({ taskId: 'unknown', title: 'T' });
      expect(ctx.eventLog.lines).toContain('✅ Task unknown complete');
      // Should not have called updateLanes since lane doesn't exist
      expect(ctx.lanePool.calls.length).toBe(0);
    });
  });

  describe('onTaskRejected', () => {
    it('updates lane status to failed and sets completedAt', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.callbacks.onTaskRejected!({ taskId: 't1', title: 'Task 1', reason: 'bad code' });
      expect(ctx.eventLog.lines).toContain('❌ Task t1 rejected: bad code');
      const lastLaneUpdate = ctx.lanePool.calls[ctx.lanePool.calls.length - 1].args[0] as TaskLane[];
      expect(lastLaneUpdate[0].status).toBe('failed');
      expect(lastLaneUpdate[0].completedAt).toEqual(expect.any(Number));
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'T', agentId: 'a1' });
      ctx.resetRenderCount();
      ctx.callbacks.onTaskRejected!({ taskId: 't1', title: 'T', reason: 'x' });
      expect(ctx.renderCount).toBe(1);
    });

    it('handles unknown taskId gracefully', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskRejected!({ taskId: 'unknown', title: 'T', reason: 'x' });
      expect(ctx.lanePool.calls.length).toBe(0);
    });
  });

  describe('onDecision', () => {
    it('does not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onDecision!({ agentId: 'a1', decision: 'proceed', reasoning: 'looks good' });
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onDecision!({ agentId: 'a1', decision: 'd', reasoning: 'r' });
      expect(ctx.renderCount).toBe(1);
    });
  });

  describe('onError', () => {
    it('adds expected line to eventLog and error entry to registry', () => {
      const ctx = createTestDeps();
      // Must spawn first so the agent exists in the registry
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      ctx.callbacks.onError!({ agentId: 'a1', error: 'crash', phase: 'planning' });
      expect(ctx.eventLog.lines).toContain('⚠️ Error in a1: crash (planning)');

      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].entries).toEqual([{ type: 'error', content: 'crash' }]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onError!({ agentId: 'a1', error: 'e', phase: 'p' });
      expect(ctx.renderCount).toBe(1);
    });

    it('still logs to eventLog even when agent is not registered', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onError!({ agentId: 'unknown', error: 'crash', phase: 'planning' });
      expect(ctx.eventLog.lines).toEqual(['⚠️ Error in unknown: crash (planning)']);
      // No agent was spawned, so registry should be empty
      expect(ctx.dashboard.registry.getAgents()).toHaveLength(0);
    });
  });

  describe('onTurnEnd', () => {
    it('processes text content blocks', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'Hello world' }],
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].entries).toEqual([{ type: 'text', content: 'Hello world' }]);
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (coder)']);
    });

    it('ignores empty text blocks', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: '' }],
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].entries).toHaveLength(0);
    });

    it('processes thinking content blocks', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'thinking', thinking: 'deep thoughts' }],
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].entries).toEqual([{ type: 'thinking', content: 'deep thoughts' }]);
    });

    it('processes multiple content blocks in order', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'doing stuff' },
        ],
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].entries).toEqual([
        { type: 'thinking', content: 'hmm' },
        { type: 'text', content: 'doing stuff' },
      ]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({ agentId: 'a1', turn: 1 });
      expect(ctx.renderCount).toBe(2); // spawn + turnEnd
    });

    it('handles missing contentBlocks', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({ agentId: 'a1', turn: 1 });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].entries).toHaveLength(0);
    });

    it('updates token stats when tokens are present', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        tokens: { input: 100, output: 50 },
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].inputTokens).toBe(100);
      expect(agents[0].outputTokens).toBe(50);
    });

    it('accumulates tokens across multiple turns', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        tokens: { input: 100, output: 50 },
      });
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 2,
        tokens: { input: 200, output: 75 },
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].inputTokens).toBe(300);
      expect(agents[0].outputTokens).toBe(125);
    });

    it('processes content blocks and tokens together', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        tokens: { input: 500, output: 200 },
        contentBlocks: [{ type: 'text', text: 'output text' }],
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].entries).toEqual([{ type: 'text', content: 'output text' }]);
      expect(agents[0].inputTokens).toBe(500);
      expect(agents[0].outputTokens).toBe(200);
    });

    it('skips all processing when agent is not registered', () => {
      const ctx = createTestDeps();
      // No onAgentSpawn call — uid lookup fails
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        tokens: { input: 100, output: 50 },
        contentBlocks: [{ type: 'text', text: 'should not appear' }],
      });
      expect(ctx.dashboard.registry.getAgents()).toHaveLength(0);
      expect(ctx.eventLog.lines).toEqual([]);
    });
  });

  describe('onToolCallStart', () => {
    it('adds tool_call_start entry and increments toolCallCount in registry', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      ctx.callbacks.onToolCallStart!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'tc1',
        arguments: { path: 'test.ts' },
      });
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (scout)']);

      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].entries).toEqual([{ type: 'tool_call_start', content: '📖 read → test.ts' }]);
      expect(agents[0].toolCallCount).toBe(1);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onToolCallStart!({ agentId: 'a1', toolName: 't', toolCallId: 'tc1', arguments: {} });
      expect(ctx.renderCount).toBe(1);
    });

    it('accumulates toolCallCount across multiple calls', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      ctx.callbacks.onToolCallStart!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'tc1',
        arguments: { path: 'a.ts' },
      });
      ctx.callbacks.onToolCallStart!({
        agentId: 'a1',
        toolName: 'write',
        toolCallId: 'tc2',
        arguments: { path: 'b.ts', content: 'hi' },
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].toolCallCount).toBe(2);
    });
  });

  describe('onToolCallEnd', () => {
    it('does NOT add an entry when isError is false', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      ctx.callbacks.onToolCallEnd!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'tc1',
        isError: false,
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents[0].entries).toHaveLength(0);
    });

    it('adds an error entry when isError is true', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      ctx.callbacks.onToolCallEnd!({
        agentId: 'a1',
        toolName: 'bash',
        toolCallId: 'tc2',
        isError: true,
      });
      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].entries).toEqual([{ type: 'error', content: '❌ bash failed' }]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onToolCallEnd!({ agentId: 'a1', toolName: 't', toolCallId: 'tc1', isError: false });
      expect(ctx.renderCount).toBe(1);
    });
  });

  describe('onSidebarUpdate', () => {
    it('updates phases in phaseBar', () => {
      const ctx = createTestDeps();
      const phases = [
        { id: 'scout', label: 'Scouting', icon: '🔍' },
        { id: 'plan', label: 'Planning', icon: '📋' },
      ];
      ctx.callbacks.onSidebarUpdate!({ phases });
      expect(ctx.phaseBar.calls).toEqual([{ method: 'setPhases', args: [phases] }]);
    });

    it('sets phases on agentLog (replacing old setAvailablePhases)', () => {
      const ctx = createTestDeps();
      const phases = [
        { id: 'scout', label: 'Scouting', icon: '🔍' },
        { id: 'plan', label: 'Planning', icon: '📋' },
      ];
      ctx.callbacks.onSidebarUpdate!({ phases });
      expect(ctx.agentLog.calls).toContainEqual({
        method: 'setPhases',
        args: [['scout', 'plan']],
      });
    });

    it('updates indicator in phaseBar', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onSidebarUpdate!({ indicator: '🟢' });
      expect(ctx.phaseBar.calls).toEqual([{ method: 'setIndicator', args: ['🟢'] }]);
    });

    it('adds title to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onSidebarUpdate!({ title: 'My Workflow' });
      expect(ctx.eventLog.lines).toEqual(['📌 My Workflow']);
    });

    it('handles all fields at once', () => {
      const ctx = createTestDeps();
      const phases = [{ id: 'a', label: 'A', icon: '⭐' }];
      ctx.callbacks.onSidebarUpdate!({ phases, indicator: '🔵', title: 'Test' });
      expect(ctx.phaseBar.calls.length).toBe(2); // setPhases + setIndicator
      expect(ctx.eventLog.lines).toContain('📌 Test');
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onSidebarUpdate!({});
      expect(ctx.renderCount).toBe(1);
    });

    it('does nothing extra when optional fields are missing', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onSidebarUpdate!({});
      expect(ctx.phaseBar.calls.length).toBe(0);
      expect(ctx.eventLog.lines.length).toBe(0);
    });
  });

  describe('requestRender called after every callback', () => {
    it('requestRender is invoked for all callback types', () => {
      const ctx = createTestDeps();

      // Call every callback once
      ctx.callbacks.onWorkflowStart!({ taskPrompt: 't', resumed: false, workDir: '/tmp' });
      ctx.callbacks.onWorkflowComplete!({ totalDurationMs: 1000, agentCount: 1 });
      ctx.callbacks.onWorkflowFailed!({ error: new Error('e'), phase: 'p' });
      ctx.callbacks.onPhaseStart!({ phase: 'p', round: 1 });
      ctx.callbacks.onPhaseComplete!({ phase: 'p', durationMs: 100 });
      ctx.callbacks.onAgentSpawn!({ agentId: 'a', profile: 'p', phase: 'x' });
      ctx.callbacks.onAgentComplete!({ agentId: 'a', profile: 'p', phase: 'x' });
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'T', agentId: 'a1' });
      ctx.callbacks.onTaskComplete!({ taskId: 't1', title: 'T' });
      ctx.callbacks.onTaskRejected!({ taskId: 't1', title: 'T', reason: 'r' });
      ctx.callbacks.onDecision!({ agentId: 'a', decision: 'd', reasoning: 'r' });
      ctx.callbacks.onError!({ agentId: 'a', error: 'e', phase: 'p' });
      ctx.callbacks.onTurnEnd!({ agentId: 'a', turn: 1 });
      ctx.callbacks.onToolCallStart!({ agentId: 'a', toolName: 't', toolCallId: 'tc1', arguments: {} });
      ctx.callbacks.onToolCallEnd!({ agentId: 'a', toolName: 't', toolCallId: 'tc1', isError: false });
      ctx.callbacks.onSidebarUpdate!({});

      ctx.callbacks.onTasksAdded!({ tasks: [] });

      // 16 callbacks total (onTurnStart removed – it was a no-op;
      // onTurnEnd also returns early here because agent 'a' was completed
      // by onAgentComplete, so getActiveUid returns undefined)
      expect(ctx.renderCount).toBe(16);
    });
  });

  describe('onTasksAdded', () => {
    it('creates lanes for blocked/ready tasks', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTasksAdded!({
        tasks: [
          { id: 't1', title: 'Task A', status: 'blocked', dependencies: ['t2'] },
          { id: 't2', title: 'Task B', status: 'ready', dependencies: [] },
        ],
      });
      expect(ctx.lanePool.calls).toEqual([
        {
          method: 'updateLanes',
          args: [
            [
              { id: 't1', title: 'Task A', status: 'blocked' },
              { id: 't2', title: 'Task B', status: 'ready' },
            ],
          ],
        },
      ]);
    });

    it('preserves existing lanes', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Implement feature', agentId: 'a1' });
      ctx.callbacks.onTasksAdded!({
        tasks: [{ id: 't2', title: 'Blocked task', status: 'blocked', dependencies: ['t1'] }],
      });
      const lastLaneUpdate = ctx.lanePool.calls[ctx.lanePool.calls.length - 1].args[0] as TaskLane[];
      expect(lastLaneUpdate).toHaveLength(2);
      expect(lastLaneUpdate).toContainEqual({
        id: 't1',
        title: 'Implement feature',
        status: 'implementing',
        agentId: 'a1',
      });
      expect(lastLaneUpdate).toContainEqual({ id: 't2', title: 'Blocked task', status: 'blocked' });
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTasksAdded!({ tasks: [] });
      expect(ctx.renderCount).toBe(1);
    });

    it('does not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTasksAdded!({
        tasks: [{ id: 't1', title: 'Task', status: 'ready', dependencies: [] }],
      });
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('passes phase to lanes when provided', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTasksAdded!({
        tasks: [{ id: 't1', title: 'Phase task', status: 'ready', dependencies: [], phase: 'scouting' }],
      });
      const lastCall = ctx.lanePool.calls[ctx.lanePool.calls.length - 1];
      const lane = (lastCall.args[0] as TaskLane[])[0];
      expect(lane.phase).toBe('scouting');
    });
  });

  describe('verbose callbacks do not pollute eventLog', () => {
    it('onDecision does not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onDecision!({ agentId: 'a1', decision: 'proceed', reasoning: 'ok' });
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('onTurnEnd text blocks do not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement' });
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'some output' }],
      });
      // The onAgentSpawn call added one line; onTurnEnd should not add any
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (coder)']);
    });

    it('onToolCallStart does not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onToolCallStart!({
        agentId: 'a1',
        toolName: 'readFile',
        toolCallId: 'tc1',
        arguments: {},
      });
      expect(ctx.eventLog.lines).toEqual([]);
    });
  });

  // ─── initialAgents seeding ─────────────────────────────────────────

  describe('initialAgents', () => {
    it('registers each initial agent in the registry', () => {
      const ctx = createTestDepsWithInitialAgents([
        { agentId: 'a1', profile: 'coder', phase: 'implementing' },
        { agentId: 'a2', profile: 'scout', phase: 'scouting' },
      ]);

      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(2);
      expect(agents[0].agentId).toBe('a1');
      expect(agents[0].profile).toBe('coder');
      expect(agents[0].phase).toBe('implementing');
      expect(agents[0].status).toBe('active');
      expect(agents[1].agentId).toBe('a2');
      expect(agents[1].profile).toBe('scout');
      expect(agents[1].phase).toBe('scouting');
      expect(agents[1].status).toBe('active');
    });

    it('marks agents as completed when completedAt is present', () => {
      const ctx = createTestDepsWithInitialAgents([
        { agentId: 'a1', profile: 'coder', phase: 'implementing', completedAt: '2026-06-13T12:00:00.000Z' },
        { agentId: 'a2', profile: 'scout', phase: 'scouting' },
      ]);

      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(2);
      const a1 = agents.find((a) => a.agentId === 'a1')!;
      expect(a1.status).toBe('completed');
      expect(a1.completedAt).toBeDefined();
      const a2 = agents.find((a) => a.agentId === 'a2')!;
      expect(a2.status).toBe('active');
    });

    it('does not add lines to eventLog', () => {
      const ctx = createTestDepsWithInitialAgents([{ agentId: 'a1', profile: 'coder', phase: 'implementing' }]);

      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('does not affect lanes in lanePool', () => {
      const ctx = createTestDepsWithInitialAgents([{ agentId: 'a1', profile: 'coder', phase: 'implementing' }]);

      expect(ctx.lanePool.calls.length).toBe(0);
    });

    it('handles empty initialAgents array', () => {
      const ctx = createTestDepsWithInitialAgents([]);

      expect(ctx.dashboard.registry.getAgents()).toHaveLength(0);
    });

    it('handles initialAgents with taskId', () => {
      const ctx = createTestDepsWithInitialAgents([
        { agentId: 'a1', profile: 'coder', phase: 'implementing', taskId: 'task-1' },
      ]);

      const agents = ctx.dashboard.registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].taskId).toBe('task-1');
    });
  });
});
