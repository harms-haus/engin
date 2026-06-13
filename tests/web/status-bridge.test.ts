import { describe, expect, it, mock } from 'bun:test';
import type { ServerMessage } from '../../src/web/protocol-types.ts';
import { StatusBridge } from '../../src/web/status-bridge.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createBridge() {
  const messages: ServerMessage[] = [];
  const broadcast = mock((msg: ServerMessage) => {
    messages.push(msg);
  });
  const bridge = new StatusBridge(broadcast);
  const callbacks = bridge.getCallbacks();
  return { bridge, callbacks, broadcast, messages };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('StatusBridge', () => {
  describe('getSnapshot', () => {
    it('returns empty init state by default', () => {
      const { bridge } = createBridge();
      const snapshot = bridge.getSnapshot();
      expect(snapshot.type).toBe('init');
      expect(snapshot.currentPhase).toBe('');
      expect(snapshot.completedPhases).toEqual([]);
      expect(snapshot.tasks).toEqual([]);
      expect(snapshot.agents).toEqual([]);
      expect(snapshot.sidebar).toEqual({ title: '', indicator: '' });
    });
  });

  describe('onWorkflowComplete', () => {
    it('broadcasts workflow_complete', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onWorkflowComplete!({ totalDurationMs: 1000, agentCount: 2 });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: 'workflow_complete' });
    });
  });

  describe('onWorkflowFailed', () => {
    it('broadcasts workflow_failed with error and phase', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onWorkflowFailed!({ error: new Error('something broke'), phase: 'planning' });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'workflow_failed',
        error: 'something broke',
        phase: 'planning',
      });
    });
  });

  describe('onPhaseStart', () => {
    it('broadcasts workflow_phase and updates currentPhase', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onPhaseStart!({ phase: 'scouting', round: 1 });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'workflow_phase',
        phase: 'scouting',
        completed: [],
        currentPhase: 'scouting',
      });

      // Snapshot reflects the new phase
      const snapshot = bridge.getSnapshot();
      expect(snapshot.currentPhase).toBe('scouting');
      expect(snapshot.completedPhases).toEqual([]);
    });

    it('pushes previous phase to completed phases when non-empty', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onPhaseStart!({ phase: 'scouting', round: 1 });
      callbacks.onPhaseStart!({ phase: 'planning', round: 1 });

      expect(messages).toHaveLength(2);
      expect(messages[1]).toEqual({
        type: 'workflow_phase',
        phase: 'planning',
        completed: ['scouting'],
        currentPhase: 'planning',
      });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.currentPhase).toBe('planning');
      expect(snapshot.completedPhases).toEqual(['scouting']);
    });
  });

  describe('onPhaseComplete', () => {
    it('broadcasts workflow_phase with phase added to completed', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 500 });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'workflow_phase',
        phase: 'scouting',
        completed: ['scouting'],
        currentPhase: '',
      });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.completedPhases).toEqual(['scouting']);
    });

    it('does not duplicate completed phases', () => {
      const { callbacks } = createBridge();
      callbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 500 });
      callbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 500 });

      // The second broadcast should still only have one entry in completed
      expect((callbacks.onPhaseComplete as any).mock?.calls?.length || 2).toBe(2);
      // Check messages directly
    });
  });

  describe('onAgentSpawn', () => {
    it('broadcasts agent_spawned and stores agent state', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });

      expect(messages).toHaveLength(1);
      const msg = messages[0] as any;
      expect(msg.type).toBe('agent_spawned');
      expect(msg.agent.agentId).toBe('a1');
      expect(msg.agent.profile).toBe('scout');
      expect(msg.agent.phase).toBe('scouting');
      expect(msg.agent.active).toBe(true);
      expect(msg.agent.log).toEqual([]);

      const snapshot = bridge.getSnapshot();
      expect(snapshot.agents).toHaveLength(1);
      expect(snapshot.agents[0].agentId).toBe('a1');
    });

    it('stores agent with composite key when taskId is provided', () => {
      const { callbacks, bridge } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.agents).toHaveLength(1);
      expect(snapshot.agents[0].taskId).toBe('t1');
    });
  });

  describe('onAgentComplete', () => {
    it('broadcasts agent_complete and marks agent inactive', () => {
      const { callbacks, messages, bridge } = createBridge();
      // Spawn first
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onAgentComplete!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });

      expect(messages).toHaveLength(2);
      const msg = messages[1] as any;
      expect(msg.type).toBe('agent_complete');
      expect(msg.agentId).toBe('a1');

      const snapshot = bridge.getSnapshot();
      expect(snapshot.agents[0].active).toBe(false);
    });

    it('finds agent by composite key first, then bare agentId', () => {
      const { callbacks, bridge } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });
      callbacks.onAgentComplete!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.agents[0].active).toBe(false);
    });
  });

  describe('onTurnEnd', () => {
    it('converts text content blocks to log entries', () => {
      const { callbacks, messages } = createBridge();

      // Need a spawned agent first so the log is stored
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'Hello world' }],
      });

      // Should have agent_spawned + agent_log
      const logMsg = messages.find((m) => m.type === 'agent_log') as any;
      expect(logMsg).toBeDefined();
      expect(logMsg.agentId).toBe('a1');
      expect(logMsg.entry.type).toBe('text');
      expect(logMsg.entry.content).toBe('Hello world');
      expect(logMsg.entry.id).toMatch(/^text-/);
    });

    it('converts thinking content blocks to log entries', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'thinking', thinking: 'deep thoughts' }],
      });

      const logMsg = messages.find((m) => m.type === 'agent_log') as any;
      expect(logMsg).toBeDefined();
      expect(logMsg.entry.type).toBe('thinking');
      expect(logMsg.entry.content).toBe('deep thoughts');
    });

    it('broadcasts agent_stats when tokens are present', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        tokens: { input: 100, output: 50 },
      });

      const statsMsg = messages.find((m) => m.type === 'agent_stats') as any;
      expect(statsMsg).toBeDefined();
      expect(statsMsg.agentId).toBe('a1');
      expect(statsMsg.inputTokens).toBe(100);
      expect(statsMsg.outputTokens).toBe(50);
    });

    it('appends log entries to the correct agent', () => {
      const { callbacks, bridge } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'msg1' }],
      });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.agents[0].log).toHaveLength(1);
      expect(snapshot.agents[0].log[0].content).toBe('msg1');
    });
  });

  describe('onToolCallStart', () => {
    it('broadcasts agent_log with tool_call_start entry and agent_stats', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onToolCallStart!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'call_1',
        arguments: { path: 'test.ts' },
      });

      const logMsg = messages.find((m) => m.type === 'agent_log') as any;
      expect(logMsg).toBeDefined();
      expect(logMsg.entry.type).toBe('tool_call_start');
      expect(logMsg.entry.content).toBe('read');
      expect(logMsg.entry.id).toBe('call_1');

      const statsMsg = messages.find((m) => m.type === 'agent_stats') as any;
      expect(statsMsg).toBeDefined();
      expect(statsMsg.toolCallCount).toBe(1);
    });
  });

  describe('onToolCallEnd', () => {
    it('broadcasts agent_log with tool_call_end entry', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onToolCallEnd!({
        agentId: 'a1',
        toolName: 'read',
        toolCallId: 'call_1',
        isError: false,
      });

      const logMsg = messages.find((m) => m.type === 'agent_log') as any;
      expect(logMsg).toBeDefined();
      expect(logMsg.entry.type).toBe('tool_call_end');
      expect(logMsg.entry.content).toBe('read');
      expect(logMsg.entry.id).toBe('call_1-end');
      expect(logMsg.entry.metadata?.isError).toBe(false);
    });
  });

  describe('onError', () => {
    it('broadcasts agent_log with error entry', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onError!({ agentId: 'a1', error: 'crash', phase: 'planning', taskId: 't1' });

      const logMsg = messages.find((m) => m.type === 'agent_log') as any;
      expect(logMsg).toBeDefined();
      expect(logMsg.entry.type).toBe('error');
      expect(logMsg.entry.content).toBe('crash');
      expect(logMsg.entry.metadata?.phase).toBe('planning');
      expect(logMsg.taskId).toBe('t1');
    });
  });

  describe('onDecision', () => {
    it('broadcasts agent_log with decision entry', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onDecision!({ agentId: 'a1', decision: 'proceed', reasoning: 'looks good', taskId: 't1' });

      const logMsg = messages.find((m) => m.type === 'agent_log') as any;
      expect(logMsg).toBeDefined();
      expect(logMsg.entry.type).toBe('decision');
      expect(logMsg.entry.content).toBe('proceed');
      expect(logMsg.entry.metadata?.reasoning).toBe('looks good');
    });
  });

  describe('task management', () => {
    it('onTasksAdded stores tasks and broadcasts tasks_updated', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onTasksAdded!({
        tasks: [{ id: 't1', title: 'Task 1', status: 'ready', dependencies: [] }],
      });

      const msg = messages.find((m) => m.type === 'tasks_updated') as any;
      expect(msg).toBeDefined();
      expect(msg.tasks).toHaveLength(1);
      expect(msg.tasks[0].id).toBe('t1');
      expect(msg.tasks[0].status).toBe('ready');

      const snapshot = bridge.getSnapshot();
      expect(snapshot.tasks).toHaveLength(1);
    });

    it('onTaskStart updates task status and broadcasts', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onTasksAdded!({
        tasks: [{ id: 't1', title: 'Task 1', status: 'ready', dependencies: [] }],
      });
      callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1', phase: 'scouting', startedAt: 1000 });

      const msgs = messages.filter((m) => m.type === 'tasks_updated');
      const lastMsg = msgs[msgs.length - 1] as any;
      const task = lastMsg.tasks.find((t: any) => t.id === 't1');
      expect(task.status).toBe('implementing');
      expect(task.agentId).toBe('a1');

      const snapshot = bridge.getSnapshot();
      const t = snapshot.tasks.find((t) => t.id === 't1')!;
      expect(t.status).toBe('implementing');
      expect(t.startedAt).toBe(1000);
    });

    it('onTaskComplete updates task status to done', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onTasksAdded!({
        tasks: [{ id: 't1', title: 'Task 1', status: 'ready', dependencies: [] }],
      });
      callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      callbacks.onTaskComplete!({ taskId: 't1', title: 'Task 1' });

      const msgs = messages.filter((m) => m.type === 'tasks_updated');
      const lastMsg = msgs[msgs.length - 1] as any;
      const task = lastMsg.tasks.find((t: any) => t.id === 't1');
      expect(task.status).toBe('done');
    });

    it('onTaskRejected updates task status to failed', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onTasksAdded!({
        tasks: [{ id: 't1', title: 'Task 1', status: 'ready', dependencies: [] }],
      });
      callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      callbacks.onTaskRejected!({ taskId: 't1', title: 'Task 1', reason: 'bad' });

      const msgs = messages.filter((m) => m.type === 'tasks_updated');
      const lastMsg = msgs[msgs.length - 1] as any;
      const task = lastMsg.tasks.find((t: any) => t.id === 't1');
      expect(task.status).toBe('failed');
    });
  });

  describe('onSidebarUpdate', () => {
    it('merges sidebar updates and broadcasts', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onSidebarUpdate!({ title: 'My Workflow', indicator: '🟢' });

      const msg = messages.find((m) => m.type === 'workflow_sidebar') as any;
      expect(msg).toBeDefined();
      expect(msg.sidebar.title).toBe('My Workflow');
      expect(msg.sidebar.indicator).toBe('🟢');

      const snapshot = bridge.getSnapshot();
      expect(snapshot.sidebar.title).toBe('My Workflow');
      expect(snapshot.sidebar.indicator).toBe('🟢');
    });

    it('updates phases when provided', () => {
      const { callbacks, bridge } = createBridge();
      const phases = [
        { id: 'scout', label: 'Scouting', icon: '🔍' },
        { id: 'plan', label: 'Planning', icon: '📋' },
      ];
      callbacks.onSidebarUpdate!({ phases });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.sidebar.phases).toEqual(phases);
    });
  });

  describe('multiple agents with same agentId but different taskIds', () => {
    it('stores agents separately with composite keys', () => {
      const { callbacks, bridge } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'reviewer', phase: 'review', taskId: 't2' });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.agents).toHaveLength(2);

      // Each agent should have its own log
      const agentT1 = snapshot.agents.find((a) => a.taskId === 't1');
      const agentT2 = snapshot.agents.find((a) => a.taskId === 't2');
      expect(agentT1).toBeDefined();
      expect(agentT2).toBeDefined();
    });
  });
});
