import { describe, expect, it } from 'bun:test';
import type { AgentLogEntry, AgentLogWidget } from '../../src/tui/components/agent-log-widget.js';
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

function createMockAgentLog() {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    selectAgent(agentId: string, profile: string) {
      calls.push({ method: 'selectAgent', args: [agentId, profile] });
    },
    clearAgent() {
      calls.push({ method: 'clearAgent', args: [] });
    },
    addEntry(entry: AgentLogEntry, agentId?: string) {
      calls.push({ method: 'addEntry', args: [entry, agentId] });
    },
    updateStats(
      agentId: string,
      partial: {
        toolCallCount?: number;
        inputTokens?: number;
        outputTokens?: number;
        taskTitle?: string;
        profile?: string;
      },
    ) {
      calls.push({ method: 'updateStats', args: [agentId, partial] });
    },
    markAgentComplete(agentId: string) {
      calls.push({ method: 'markAgentComplete', args: [agentId] });
    },
    invalidate() {
      calls.push({ method: 'invalidate', args: [] });
    },
    hasAgent(_agentId: string): boolean {
      return false;
    },
    transferAgent(_fromId: string, _toId: string): void {
      calls.push({ method: 'transferAgent', args: [_fromId, _toId] });
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
    it('adds expected line to eventLog and selects agent in agentLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      expect(ctx.eventLog.lines).toEqual(['⏳ Agent a1 spawned (scout)']);
      expect(ctx.agentLog.calls).toEqual([
        { method: 'selectAgent', args: ['a1', 'scout'] },
        { method: 'updateStats', args: ['a1', { profile: 'scout' }] },
      ]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'p', phase: 'x' });
      expect(ctx.renderCount).toBe(1);
    });

    it('builds reverse maps when taskId is provided', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });
      // Verify the reverse map works by triggering onTaskStart with the same taskId
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'My task', agentId: 'a1' });
      // The taskTitle updateStats call should use agentId 'a1' from the reverse map
      expect(ctx.agentLog.calls).toContainEqual({
        method: 'updateStats',
        args: ['a1', { taskTitle: 'My task' }],
      });
    });
  });

  describe('onAgentComplete', () => {
    it('adds expected line to eventLog and entry to agentLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentComplete!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      expect(ctx.eventLog.lines).toEqual(['✅ Agent a1 complete']);
      expect(ctx.agentLog.calls).toEqual([
        { method: 'addEntry', args: [{ type: 'text', content: 'Agent session ended' }, 'a1'] },
        { method: 'markAgentComplete', args: ['a1'] },
      ]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onAgentComplete!({ agentId: 'a1', profile: 'p', phase: 'x' });
      expect(ctx.renderCount).toBe(1);
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
      expect(ctx.agentLog.calls).toContainEqual({
        method: 'updateStats',
        args: ['a1', { taskTitle: 'Implement feature' }],
      });
    });

    it('uses info.agentId as fallback for taskTitle when no reverse map entry', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Standalone task', agentId: 'a1' });
      expect(ctx.agentLog.calls).toEqual([{ method: 'updateStats', args: ['a1', { taskTitle: 'Standalone task' }] }]);
    });
  });

  describe('onTaskComplete', () => {
    it('updates lane status to done', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.callbacks.onTaskComplete!({ taskId: 't1', title: 'Task 1' });
      expect(ctx.eventLog.lines).toContain('✅ Task t1 complete');
      const lastLaneUpdate = ctx.lanePool.calls[ctx.lanePool.calls.length - 1].args[0] as TaskLane[];
      expect(lastLaneUpdate[0].status).toBe('done');
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
    it('updates lane status to failed', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      ctx.callbacks.onTaskRejected!({ taskId: 't1', title: 'Task 1', reason: 'bad code' });
      expect(ctx.eventLog.lines).toContain('❌ Task t1 rejected: bad code');
      const lastLaneUpdate = ctx.lanePool.calls[ctx.lanePool.calls.length - 1].args[0] as TaskLane[];
      expect(lastLaneUpdate[0].status).toBe('failed');
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
    it('adds expected line to eventLog and error entry to agentLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onError!({ agentId: 'a1', error: 'crash', phase: 'planning' });
      expect(ctx.eventLog.lines).toEqual(['⚠️ Error in a1: crash (planning)']);
      expect(ctx.agentLog.calls).toEqual([{ method: 'addEntry', args: [{ type: 'error', content: 'crash' }, 'a1'] }]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onError!({ agentId: 'a1', error: 'e', phase: 'p' });
      expect(ctx.renderCount).toBe(1);
    });
  });

  describe('onTurnEnd', () => {
    it('processes text content blocks', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'Hello world' }],
      });
      expect(ctx.agentLog.calls).toEqual([
        { method: 'addEntry', args: [{ type: 'text', content: 'Hello world' }, 'a1'] },
      ]);
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('ignores empty text blocks', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: '' }],
      });
      expect(ctx.agentLog.calls.length).toBe(0);
      expect(ctx.eventLog.lines.length).toBe(0);
    });

    it('processes thinking content blocks', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'thinking', thinking: 'deep thoughts' }],
      });
      expect(ctx.agentLog.calls).toEqual([
        { method: 'addEntry', args: [{ type: 'thinking', content: 'deep thoughts' }, 'a1'] },
      ]);
      // Thinking blocks should not be added to eventLog
      expect(ctx.eventLog.lines.length).toBe(0);
    });

    it('processes multiple content blocks in order', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'doing stuff' },
        ],
      });
      expect(ctx.agentLog.calls.length).toBe(2);
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTurnEnd!({ agentId: 'a1', turn: 1 });
      expect(ctx.renderCount).toBe(1);
    });

    it('handles missing contentBlocks', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTurnEnd!({ agentId: 'a1', turn: 1 });
      expect(ctx.agentLog.calls.length).toBe(0);
      expect(ctx.eventLog.lines.length).toBe(0);
    });

    it('updates token stats when tokens are present', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        tokens: { input: 100, output: 50 },
      });
      expect(ctx.agentLog.calls).toEqual([
        { method: 'updateStats', args: ['a1', { inputTokens: 100, outputTokens: 50 }] },
      ]);
    });

    it('accumulates tokens across multiple turns', () => {
      const ctx = createTestDeps();
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
      expect(ctx.agentLog.calls.length).toBe(2);
      expect(ctx.agentLog.calls[0]).toEqual({
        method: 'updateStats',
        args: ['a1', { inputTokens: 100, outputTokens: 50 }],
      });
      expect(ctx.agentLog.calls[1]).toEqual({
        method: 'updateStats',
        args: ['a1', { inputTokens: 200, outputTokens: 75 }],
      });
    });

    it('processes content blocks and tokens together', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        tokens: { input: 500, output: 200 },
        contentBlocks: [{ type: 'text', text: 'output text' }],
      });
      expect(ctx.agentLog.calls).toEqual([
        { method: 'addEntry', args: [{ type: 'text', content: 'output text' }, 'a1'] },
        { method: 'updateStats', args: ['a1', { inputTokens: 500, outputTokens: 200 }] },
      ]);
    });
  });

  describe('onToolCallStart', () => {
    it('does not add to eventLog but adds entry and increments toolCallCount in agentLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onToolCallStart!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'tc1',
        arguments: { path: 'test.ts' },
      });
      expect(ctx.eventLog.lines).toEqual([]);
      expect(ctx.agentLog.calls).toEqual([
        { method: 'addEntry', args: [{ type: 'tool_call_start', content: '📖 read → test.ts' }, 'a1'] },
        { method: 'updateStats', args: ['a1', { toolCallCount: 1 }] },
      ]);
    });

    it('calls requestRender', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onToolCallStart!({ agentId: 'a1', toolName: 't', toolCallId: 'tc1', arguments: {} });
      expect(ctx.renderCount).toBe(1);
    });
  });

  describe('onToolCallEnd', () => {
    it('does NOT add an entry to the agent log', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onToolCallEnd!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'tc1',
        isError: false,
      });
      // No addEntry calls should have been made — tool_call_end entries are suppressed
      const addEntryCalls = ctx.agentLog.calls.filter((c) => c.method === 'addEntry');
      expect(addEntryCalls).toHaveLength(0);
    });

    it('adds an error entry when isError is true', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onToolCallEnd!({
        agentId: 'a1',
        toolName: 'bash',
        toolCallId: 'tc2',
        isError: true,
      });
      expect(ctx.agentLog.calls).toEqual([
        { method: 'addEntry', args: [{ type: 'error', content: '❌ bash failed' }, 'a1'] },
      ]);
    });

    it('calls requestRender (regression)', () => {
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

      // 17 callbacks total (onTurnStart removed – it was a no-op)
      expect(ctx.renderCount).toBe(17);
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
  });

  describe('verbose callbacks do not pollute eventLog', () => {
    it('onDecision does not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onDecision!({ agentId: 'a1', decision: 'proceed', reasoning: 'ok' });
      expect(ctx.eventLog.lines).toEqual([]);
    });

    it('onTurnEnd text blocks do not add to eventLog', () => {
      const ctx = createTestDeps();
      ctx.callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'some output' }],
      });
      expect(ctx.eventLog.lines).toEqual([]);
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
});
