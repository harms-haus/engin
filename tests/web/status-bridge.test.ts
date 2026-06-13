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
      expect(snapshot.taskPrompt).toBe('');
    });

    it('includes taskPrompt when set via onWorkflowStart', () => {
      const { bridge, callbacks } = createBridge();
      callbacks.onWorkflowStart!({ taskPrompt: 'Implement login page', resumed: false, workDir: '/tmp/test' });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.taskPrompt).toBe('Implement login page');
    });

    it('includes empty taskPrompt when onWorkflowStart was never called', () => {
      const { bridge } = createBridge();
      const snapshot = bridge.getSnapshot();
      expect(snapshot.taskPrompt).toBe('');
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

    it('does not duplicate phase in completed when transitioning after onPhaseComplete', () => {
      const { callbacks, messages, bridge } = createBridge();

      // Phase A: start scouting
      callbacks.onPhaseStart!({ phase: 'scouting', round: 1 });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'workflow_phase',
        phase: 'scouting',
        completed: [],
        currentPhase: 'scouting',
      });

      // Complete scouting — adds 'scouting' to completedPhases
      callbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 500 });
      expect(messages).toHaveLength(2);
      expect(messages[1]).toEqual({
        type: 'workflow_phase',
        phase: 'scouting',
        completed: ['scouting'],
        currentPhase: 'scouting',
      });

      // Start planning — onPhaseStart should push currentPhase ('scouting')
      // into completedPhases but it must NOT duplicate the entry since
      // onPhaseComplete already added it.
      callbacks.onPhaseStart!({ phase: 'planning', round: 1 });
      expect(messages).toHaveLength(3);
      expect(messages[2]).toEqual({
        type: 'workflow_phase',
        phase: 'planning',
        completed: ['scouting'],
        currentPhase: 'planning',
      });

      // Snapshot must show no duplicate 'scouting' entry
      const snapshot = bridge.getSnapshot();
      expect(snapshot.completedPhases).toEqual(['scouting']);
      expect(snapshot.currentPhase).toBe('planning');
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
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 500 });
      callbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 500 });

      // Both calls should have produced messages
      expect(messages).toHaveLength(2);

      // The second broadcast should still only have one entry in completed
      expect(messages[1]).toEqual({
        type: 'workflow_phase',
        phase: 'scouting',
        completed: ['scouting'],
        currentPhase: '',
      });

      // Snapshot should confirm no duplicates
      const snapshot = bridge.getSnapshot();
      expect(snapshot.completedPhases).toEqual(['scouting']);
    });
  });

  describe('onAgentSpawn', () => {
    it('broadcasts agent_spawned and stores agent state', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });

      expect(messages).toHaveLength(1);
      const msg = messages[0];
      expect(msg).toBeDefined();
      expect(msg.type).toBe('agent_spawned');
      if (msg.type === 'agent_spawned') {
        expect(msg.agent.agentId).toBe('a1');
        expect(msg.agent.profile).toBe('scout');
        expect(msg.agent.phase).toBe('scouting');
        expect(msg.agent.active).toBe(true);
        expect(msg.agent.log).toEqual([]);
      }

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
      const msg = messages[1];
      expect(msg).toBeDefined();
      expect(msg.type).toBe('agent_complete');
      if (msg.type === 'agent_complete') {
        expect(msg.agentId).toBe('a1');
      }

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
      const logMsg = messages.find((m) => m.type === 'agent_log');
      expect(logMsg).toBeDefined();
      expect(logMsg?.type).toBe('agent_log');
      if (logMsg?.type === 'agent_log') {
        expect(logMsg.agentId).toBe('a1');
        expect(logMsg.entry.type).toBe('text');
        expect(logMsg.entry.content).toBe('Hello world');
        expect(logMsg.entry.id).toMatch(/^text-/);
      }
    });

    it('converts thinking content blocks to log entries', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'thinking', thinking: 'deep thoughts' }],
      });

      const logMsg = messages.find((m) => m.type === 'agent_log');
      expect(logMsg).toBeDefined();
      expect(logMsg?.type).toBe('agent_log');
      if (logMsg?.type === 'agent_log') {
        expect(logMsg.entry.type).toBe('thinking');
        expect(logMsg.entry.content).toBe('deep thoughts');
      }
    });

    it('broadcasts agent_stats when tokens are present', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        tokens: { input: 100, output: 50 },
      });

      const statsMsg = messages.find((m) => m.type === 'agent_stats');
      expect(statsMsg).toBeDefined();
      expect(statsMsg?.type).toBe('agent_stats');
      if (statsMsg?.type === 'agent_stats') {
        expect(statsMsg.agentId).toBe('a1');
        expect(statsMsg.inputTokens).toBe(100);
        expect(statsMsg.outputTokens).toBe(50);
      }
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

      const logMsg = messages.find((m) => m.type === 'agent_log');
      expect(logMsg).toBeDefined();
      expect(logMsg?.type).toBe('agent_log');
      if (logMsg?.type === 'agent_log') {
        expect(logMsg.entry.type).toBe('tool_call_start');
        expect(logMsg.entry.content).toBe('read');
        expect(logMsg.entry.id).toBe('call_1');
      }

      const statsMsg = messages.find((m) => m.type === 'agent_stats');
      expect(statsMsg).toBeDefined();
      expect(statsMsg?.type).toBe('agent_stats');
      if (statsMsg?.type === 'agent_stats') {
        expect(statsMsg.toolCallCount).toBe(1);
      }
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

      const logMsg = messages.find((m) => m.type === 'agent_log');
      expect(logMsg).toBeDefined();
      expect(logMsg?.type).toBe('agent_log');
      if (logMsg?.type === 'agent_log') {
        expect(logMsg.entry.type).toBe('tool_call_end');
        expect(logMsg.entry.content).toBe('read');
        expect(logMsg.entry.id).toBe('call_1-end');
        expect(logMsg.entry.metadata?.isError).toBe(false);
      }
    });
  });

  // ─── taskId propagation tests ──────────────────────────────────────────────

  describe('taskId propagation via findTaskIdForAgent', () => {
    describe('onTurnEnd', () => {
      it('broadcasts agent_log with taskId when agent was spawned with taskId', () => {
        const { callbacks, messages } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't-42' });
        callbacks.onTurnEnd!({
          agentId: 'a1',
          turn: 1,
          contentBlocks: [{ type: 'text', text: 'progress report' }],
        });

        const logMsg = messages.find((m) => m.type === 'agent_log');
        expect(logMsg).toBeDefined();
        expect(logMsg?.type).toBe('agent_log');
        if (logMsg?.type === 'agent_log') {
          expect(logMsg.agentId).toBe('a1');
          expect(logMsg.taskId).toBe('t-42');
          expect(logMsg.entry.content).toBe('progress report');
        }
      });

      it('broadcasts agent_stats with taskId when tokens are present', () => {
        const { callbacks, messages } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't-42' });
        callbacks.onTurnEnd!({
          agentId: 'a1',
          turn: 1,
          tokens: { input: 200, output: 75 },
        });

        const statsMsg = messages.find((m) => m.type === 'agent_stats');
        expect(statsMsg).toBeDefined();
        expect(statsMsg?.type).toBe('agent_stats');
        if (statsMsg?.type === 'agent_stats') {
          expect(statsMsg.agentId).toBe('a1');
          expect(statsMsg.taskId).toBe('t-42');
          expect(statsMsg.inputTokens).toBe(200);
          expect(statsMsg.outputTokens).toBe(75);
        }
      });

      it('appends log entries to the correct agent when agent has taskId', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't-42' });
        callbacks.onTurnEnd!({
          agentId: 'a1',
          turn: 1,
          contentBlocks: [{ type: 'text', text: 'msg with task' }],
        });

        const snapshot = bridge.getSnapshot();
        expect(snapshot.agents).toHaveLength(1);
        expect(snapshot.agents[0].log).toHaveLength(1);
        expect(snapshot.agents[0].log[0].content).toBe('msg with task');
        expect(snapshot.agents[0].taskId).toBe('t-42');
      });
    });

    describe('onToolCallStart', () => {
      it('broadcasts agent_log with taskId when agent was spawned with taskId', () => {
        const { callbacks, messages } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't-42' });
        callbacks.onToolCallStart!({
          agentId: 'a1',
          toolName: 'edit',
          toolCallId: 'call_2',
          arguments: { path: 'file.ts' },
        });

        const logMsg = messages.find((m) => m.type === 'agent_log');
        expect(logMsg).toBeDefined();
        expect(logMsg?.type).toBe('agent_log');
        if (logMsg?.type === 'agent_log') {
          expect(logMsg.agentId).toBe('a1');
          expect(logMsg.taskId).toBe('t-42');
          expect(logMsg.entry.type).toBe('tool_call_start');
          expect(logMsg.entry.content).toBe('edit');
        }
      });

      it('broadcasts agent_stats with taskId on tool call start', () => {
        const { callbacks, messages } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't-42' });
        callbacks.onToolCallStart!({
          agentId: 'a1',
          toolName: 'edit',
          toolCallId: 'call_2',
          arguments: { path: 'file.ts' },
        });

        const statsMsg = messages.find((m) => m.type === 'agent_stats');
        expect(statsMsg).toBeDefined();
        expect(statsMsg?.type).toBe('agent_stats');
        if (statsMsg?.type === 'agent_stats') {
          expect(statsMsg.agentId).toBe('a1');
          expect(statsMsg.taskId).toBe('t-42');
          expect(statsMsg.toolCallCount).toBe(1);
        }
      });

      it('appends log entry to agent with composite key', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't-42' });
        callbacks.onToolCallStart!({
          agentId: 'a1',
          toolName: 'edit',
          toolCallId: 'call_2',
          arguments: { path: 'file.ts' },
        });

        const snapshot = bridge.getSnapshot();
        expect(snapshot.agents).toHaveLength(1);
        expect(snapshot.agents[0].log).toHaveLength(1);
        expect(snapshot.agents[0].log[0].type).toBe('tool_call_start');
      });
    });

    describe('onToolCallEnd', () => {
      it('broadcasts agent_log with taskId when agent was spawned with taskId', () => {
        const { callbacks, messages } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't-42' });
        callbacks.onToolCallEnd!({
          agentId: 'a1',
          toolName: 'edit',
          toolCallId: 'call_2',
          isError: false,
        });

        const logMsg = messages.find((m) => m.type === 'agent_log');
        expect(logMsg).toBeDefined();
        expect(logMsg?.type).toBe('agent_log');
        if (logMsg?.type === 'agent_log') {
          expect(logMsg.agentId).toBe('a1');
          expect(logMsg.taskId).toBe('t-42');
          expect(logMsg.entry.type).toBe('tool_call_end');
          expect(logMsg.entry.content).toBe('edit');
        }
      });

      it('appends log entry to agent with composite key', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't-42' });
        callbacks.onToolCallEnd!({
          agentId: 'a1',
          toolName: 'edit',
          toolCallId: 'call_2',
          isError: false,
        });

        const snapshot = bridge.getSnapshot();
        expect(snapshot.agents).toHaveLength(1);
        expect(snapshot.agents[0].log).toHaveLength(1);
        expect(snapshot.agents[0].log[0].type).toBe('tool_call_end');
      });
    });

    it('does not include taskId when agent was spawned without taskId', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'no task' }],
      });

      const logMsg = messages.find((m) => m.type === 'agent_log');
      expect(logMsg).toBeDefined();
      expect(logMsg?.type).toBe('agent_log');
      if (logMsg?.type === 'agent_log') {
        expect(logMsg.taskId).toBeUndefined();
      }
    });

    it('routes log to the most recently spawned agent when multiple are active', () => {
      const { callbacks, bridge } = createBridge();
      // Spawn two agents with same agentId but different taskIds
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'reviewer', phase: 'review', taskId: 't2' });

      // Both are still active — findTaskIdForAgent should prefer the most recently spawned (t2)
      callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'msg for latest active' }],
      });

      const agentT1 = bridge.getSnapshot().agents.find((a) => a.taskId === 't1');
      expect(agentT1).toBeDefined();
      // t1 is the earlier agent, so log should NOT go to t1
      expect(agentT1!.log).toHaveLength(0);

      const agentT2 = bridge.getSnapshot().agents.find((a) => a.taskId === 't2');
      expect(agentT2).toBeDefined();
      // t2 is the most recently spawned active agent, so log should go to t2
      expect(agentT2!.log).toHaveLength(1);
      expect(agentT2!.log[0].content).toBe('msg for latest active');
    });

    it('prefers active agent over inactive one when both exist', () => {
      const { callbacks, bridge } = createBridge();
      // Spawn first agent with task t1
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });
      // Mark t1 as complete (becomes inactive)
      callbacks.onAgentComplete!({ agentId: 'a1', profile: 'coder', phase: 'implement', taskId: 't1' });
      // Spawn second agent with same agentId but task t2 (stays active)
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'reviewer', phase: 'review', taskId: 't2' });

      // onTurnEnd for agentId a1 — should resolve to t2 because t1 is inactive
      callbacks.onTurnEnd!({
        agentId: 'a1',
        turn: 1,
        contentBlocks: [{ type: 'text', text: 'msg for active agent' }],
      });

      const agentT1 = bridge.getSnapshot().agents.find((a) => a.taskId === 't1');
      expect(agentT1).toBeDefined();
      expect(agentT1!.active).toBe(false);
      expect(agentT1!.log).toHaveLength(0);

      const agentT2 = bridge.getSnapshot().agents.find((a) => a.taskId === 't2');
      expect(agentT2).toBeDefined();
      expect(agentT2!.active).toBe(true);
      expect(agentT2!.log).toHaveLength(1);
      expect(agentT2!.log[0].content).toBe('msg for active agent');
    });
  });

  describe('onError', () => {
    it('broadcasts agent_log with error entry', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onError!({ agentId: 'a1', error: 'crash', phase: 'planning', taskId: 't1' });

      const logMsg = messages.find((m) => m.type === 'agent_log');
      expect(logMsg).toBeDefined();
      expect(logMsg?.type).toBe('agent_log');
      if (logMsg?.type === 'agent_log') {
        expect(logMsg.entry.type).toBe('error');
        expect(logMsg.entry.content).toBe('crash');
        expect(logMsg.entry.metadata?.phase).toBe('planning');
        expect(logMsg.taskId).toBe('t1');
      }
    });
  });

  describe('onDecision', () => {
    it('broadcasts agent_log with decision entry', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
      callbacks.onDecision!({ agentId: 'a1', decision: 'proceed', reasoning: 'looks good', taskId: 't1' });

      const logMsg = messages.find((m) => m.type === 'agent_log');
      expect(logMsg).toBeDefined();
      expect(logMsg?.type).toBe('agent_log');
      if (logMsg?.type === 'agent_log') {
        expect(logMsg.entry.type).toBe('decision');
        expect(logMsg.entry.content).toBe('proceed');
        expect(logMsg.entry.metadata?.reasoning).toBe('looks good');
      }
    });
  });

  describe('task management', () => {
    it('onTasksAdded stores tasks and broadcasts tasks_updated', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onTasksAdded!({
        tasks: [{ id: 't1', title: 'Task 1', status: 'ready', dependencies: [] }],
      });

      const msg = messages.find((m) => m.type === 'tasks_updated');
      expect(msg).toBeDefined();
      expect(msg?.type).toBe('tasks_updated');
      if (msg?.type === 'tasks_updated') {
        expect(msg.tasks).toHaveLength(1);
        expect(msg.tasks[0].id).toBe('t1');
        expect(msg.tasks[0].status).toBe('ready');
      }

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
      const lastMsg = msgs[msgs.length - 1];
      expect(lastMsg).toBeDefined();
      expect(lastMsg.type).toBe('tasks_updated');
      if (lastMsg.type === 'tasks_updated') {
        const task = lastMsg.tasks.find((t) => t.id === 't1');
        expect(task).toBeDefined();
        expect(task!.status).toBe('implementing');
        expect(task!.agentId).toBe('a1');
      }

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
      const lastMsg = msgs[msgs.length - 1];
      expect(lastMsg).toBeDefined();
      expect(lastMsg.type).toBe('tasks_updated');
      if (lastMsg.type === 'tasks_updated') {
        const task = lastMsg.tasks.find((t) => t.id === 't1');
        expect(task).toBeDefined();
        expect(task!.status).toBe('done');
      }
    });

    it('onTaskRejected updates task status to failed', () => {
      const { callbacks, messages } = createBridge();
      callbacks.onTasksAdded!({
        tasks: [{ id: 't1', title: 'Task 1', status: 'ready', dependencies: [] }],
      });
      callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1' });
      callbacks.onTaskRejected!({ taskId: 't1', title: 'Task 1', reason: 'bad' });

      const msgs = messages.filter((m) => m.type === 'tasks_updated');
      const lastMsg = msgs[msgs.length - 1];
      expect(lastMsg).toBeDefined();
      expect(lastMsg.type).toBe('tasks_updated');
      if (lastMsg.type === 'tasks_updated') {
        const task = lastMsg.tasks.find((t) => t.id === 't1');
        expect(task).toBeDefined();
        expect(task!.status).toBe('failed');
      }
    });
  });

  describe('onSidebarUpdate', () => {
    it('merges sidebar updates and broadcasts', () => {
      const { callbacks, messages, bridge } = createBridge();
      callbacks.onSidebarUpdate!({ title: 'My Workflow', indicator: '🟢' });

      const msg = messages.find((m) => m.type === 'workflow_sidebar');
      expect(msg).toBeDefined();
      expect(msg?.type).toBe('workflow_sidebar');
      if (msg?.type === 'workflow_sidebar') {
        expect(msg.sidebar.title).toBe('My Workflow');
        expect(msg.sidebar.indicator).toBe('🟢');
      }

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

  // ─── Handler-group decomposition tests ────────────────────────────────────
  //
  // These tests access private methods (createWorkflowHandlers,
  // createPhaseHandlers, createAgentHandlers, createTaskHandlers) via
  // `(bridge as any).methodName()`. The `as any` cast is required here
  // because these methods are private to StatusBridge and not exposed
  // on the public type. These tests verify the internal decomposition
  // of handler registration into groups.

  describe('handler-group decomposition', () => {
    describe('createWorkflowHandlers', () => {
      it('returns onWorkflowStart, onWorkflowComplete, onWorkflowFailed', () => {
        const { bridge } = createBridge();
        const handlers = (bridge as any).createWorkflowHandlers();
        expect(handlers).toHaveProperty('onWorkflowStart');
        expect(handlers).toHaveProperty('onWorkflowComplete');
        expect(handlers).toHaveProperty('onWorkflowFailed');
        expect(Object.keys(handlers)).toHaveLength(3);
      });

      it('onWorkflowStart stores taskPrompt and does not broadcast', () => {
        const { bridge, messages } = createBridge();
        const handlers = (bridge as any).createWorkflowHandlers();
        handlers.onWorkflowStart!({ taskPrompt: 'Implement login', resumed: false, workDir: '/tmp' });
        // No broadcast on workflow start
        expect(messages).toHaveLength(0);
        // But snapshot now includes the prompt
        const snapshot = bridge.getSnapshot();
        expect(snapshot.taskPrompt).toBe('Implement login');
      });

      it('onWorkflowStart stores non-empty taskPrompt from resumed workflow', () => {
        const { bridge, messages } = createBridge();
        const handlers = (bridge as any).createWorkflowHandlers();
        handlers.onWorkflowStart!({ taskPrompt: 'Resumed task', resumed: true, workDir: '/tmp' });
        expect(messages).toHaveLength(0);
        const snapshot = bridge.getSnapshot();
        expect(snapshot.taskPrompt).toBe('Resumed task');
      });

      it('onWorkflowStart overwrites previous taskPrompt on subsequent calls', () => {
        const { bridge } = createBridge();
        const handlers = (bridge as any).createWorkflowHandlers();
        handlers.onWorkflowStart!({ taskPrompt: 'First prompt', resumed: false, workDir: '/tmp' });
        expect(bridge.getSnapshot().taskPrompt).toBe('First prompt');

        handlers.onWorkflowStart!({ taskPrompt: 'Second prompt', resumed: false, workDir: '/tmp' });
        expect(bridge.getSnapshot().taskPrompt).toBe('Second prompt');
      });

      it('onWorkflowComplete broadcasts workflow_complete', () => {
        const { bridge, messages } = createBridge();
        const handlers = (bridge as any).createWorkflowHandlers();
        handlers.onWorkflowComplete!({ totalDurationMs: 100, agentCount: 1 });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({ type: 'workflow_complete' });
      });

      it('onWorkflowFailed broadcasts workflow_failed with error and phase', () => {
        const { bridge, messages } = createBridge();
        const handlers = (bridge as any).createWorkflowHandlers();
        handlers.onWorkflowFailed!({ error: new Error('fail'), phase: 'test' });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
          type: 'workflow_failed',
          error: 'fail',
          phase: 'test',
        });
      });
    });

    describe('createPhaseHandlers', () => {
      it('returns onPhaseStart and onPhaseComplete', () => {
        const { bridge } = createBridge();
        const handlers = (bridge as any).createPhaseHandlers();
        expect(handlers).toHaveProperty('onPhaseStart');
        expect(handlers).toHaveProperty('onPhaseComplete');
        expect(Object.keys(handlers)).toHaveLength(2);
      });

      it('onPhaseStart broadcasts workflow_phase and updates state', () => {
        const { bridge, messages } = createBridge();
        const handlers = (bridge as any).createPhaseHandlers();
        handlers.onPhaseStart!({ phase: 'scouting', round: 1 });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
          type: 'workflow_phase',
          phase: 'scouting',
          completed: [],
          currentPhase: 'scouting',
        });
        expect(bridge['currentPhase']).toBe('scouting');
      });

      it('onPhaseComplete adds phase to completed and broadcasts', () => {
        const { bridge, messages } = createBridge();
        const handlers = (bridge as any).createPhaseHandlers();
        handlers.onPhaseComplete!({ phase: 'scouting', durationMs: 500 });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
          type: 'workflow_phase',
          phase: 'scouting',
          completed: ['scouting'],
          currentPhase: '',
        });
      });
    });

    describe('createAgentHandlers', () => {
      it('returns all agent-related handlers', () => {
        const { bridge } = createBridge();
        const handlers = (bridge as any).createAgentHandlers();
        expect(handlers).toHaveProperty('onAgentSpawn');
        expect(handlers).toHaveProperty('onAgentComplete');
        expect(handlers).toHaveProperty('onTurnEnd');
        expect(handlers).toHaveProperty('onToolCallStart');
        expect(handlers).toHaveProperty('onToolCallEnd');
        expect(handlers).toHaveProperty('onError');
        expect(handlers).toHaveProperty('onDecision');
        expect(Object.keys(handlers)).toHaveLength(7);
      });
    });

    describe('createTaskHandlers', () => {
      it('returns all task-related handlers', () => {
        const { bridge } = createBridge();
        const handlers = (bridge as any).createTaskHandlers();
        expect(handlers).toHaveProperty('onTasksAdded');
        expect(handlers).toHaveProperty('onTaskStart');
        expect(handlers).toHaveProperty('onTaskComplete');
        expect(handlers).toHaveProperty('onTaskRejected');
        expect(Object.keys(handlers)).toHaveLength(4);
      });
    });

    describe('getCallbacks composition', () => {
      it('returns all required callbacks from merged groups', () => {
        const { callbacks } = createBridge();
        // Workflow handlers
        expect(callbacks.onWorkflowStart).toBeDefined();
        expect(callbacks.onWorkflowComplete).toBeDefined();
        expect(callbacks.onWorkflowFailed).toBeDefined();
        // Phase handlers
        expect(callbacks.onPhaseStart).toBeDefined();
        expect(callbacks.onPhaseComplete).toBeDefined();
        // Agent handlers
        expect(callbacks.onAgentSpawn).toBeDefined();
        expect(callbacks.onAgentComplete).toBeDefined();
        expect(callbacks.onTurnEnd).toBeDefined();
        expect(callbacks.onToolCallStart).toBeDefined();
        expect(callbacks.onToolCallEnd).toBeDefined();
        expect(callbacks.onError).toBeDefined();
        expect(callbacks.onDecision).toBeDefined();
        // Task handlers
        expect(callbacks.onTasksAdded).toBeDefined();
        expect(callbacks.onTaskStart).toBeDefined();
        expect(callbacks.onTaskComplete).toBeDefined();
        expect(callbacks.onTaskRejected).toBeDefined();
        // Sidebar (inline in getCallbacks)
        expect(callbacks.onSidebarUpdate).toBeDefined();
      });

      it('onSidebarUpdate is a direct method on the returned object (not from a group)', () => {
        const { bridge } = createBridge();
        const callbacks = bridge.getCallbacks();
        // Verify onSidebarUpdate is not from any of the group methods
        const workflowKeys = Object.keys((bridge as any).createWorkflowHandlers());
        const phaseKeys = Object.keys((bridge as any).createPhaseHandlers());
        const agentKeys = Object.keys((bridge as any).createAgentHandlers());
        const taskKeys = Object.keys((bridge as any).createTaskHandlers());
        const allGroupKeys = [...workflowKeys, ...phaseKeys, ...agentKeys, ...taskKeys];
        expect(allGroupKeys).not.toContain('onSidebarUpdate');
        // But the callbacks object has it
        expect(callbacks.onSidebarUpdate).toBeDefined();
      });
    });
  });

  describe('seed', () => {
    it('populates snapshot with currentPhase when seeded', () => {
      const { bridge } = createBridge();
      bridge.seed({ currentPhase: 'planning' });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.currentPhase).toBe('planning');
      expect(snapshot.completedPhases).toEqual([]);
      expect(snapshot.tasks).toEqual([]);
      expect(snapshot.sidebar.title).toBe('');
    });

    it('populates snapshot with completedPhases when seeded', () => {
      const { bridge } = createBridge();
      bridge.seed({ completedPhases: ['scouting', 'planning'] });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.completedPhases).toEqual(['scouting', 'planning']);
      expect(snapshot.currentPhase).toBe('');
    });

    it('populates snapshot with tasks when seeded', () => {
      const { bridge } = createBridge();
      bridge.seed({
        tasks: [
          { id: 't1', title: 'Task 1', status: 'ready', agentId: 'a1', phase: 'scouting' },
          { id: 't2', title: 'Task 2', status: 'done' },
        ],
      });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.tasks).toHaveLength(2);
      expect(snapshot.tasks[0]).toMatchObject({
        id: 't1',
        title: 'Task 1',
        status: 'ready',
        agentId: 'a1',
        phase: 'scouting',
      });
      expect(snapshot.tasks[1]).toMatchObject({ id: 't2', title: 'Task 2', status: 'done' });
    });

    it('populates snapshot with sidebar when seeded', () => {
      const { bridge } = createBridge();
      bridge.seed({
        sidebar: { title: 'Resumed Run', indicator: '🔄', phases: [{ id: 'scout', label: 'Scouting', icon: '🔍' }] },
      });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.sidebar.title).toBe('Resumed Run');
      expect(snapshot.sidebar.indicator).toBe('🔄');
      expect(snapshot.sidebar.phases).toEqual([{ id: 'scout', label: 'Scouting', icon: '🔍' }]);
    });

    it('populates snapshot with taskPrompt when seeded', () => {
      const { bridge } = createBridge();
      bridge.seed({ taskPrompt: 'Implement login page' });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.taskPrompt).toBe('Implement login page');
    });

    it('populates snapshot with all fields when seeded with complete data', () => {
      const { bridge } = createBridge();
      bridge.seed({
        currentPhase: 'implementing',
        completedPhases: ['scouting', 'planning'],
        tasks: [
          { id: 't1', title: 'Task 1', status: 'implementing', agentId: 'a1' },
          { id: 't2', title: 'Task 2', status: 'done' },
        ],
        sidebar: { title: 'My Workflow', indicator: '🟢' },
        taskPrompt: 'Build the feature',
      });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.currentPhase).toBe('implementing');
      expect(snapshot.completedPhases).toEqual(['scouting', 'planning']);
      expect(snapshot.tasks).toHaveLength(2);
      expect(snapshot.sidebar.title).toBe('My Workflow');
      expect(snapshot.sidebar.indicator).toBe('🟢');
      expect(snapshot.taskPrompt).toBe('Build the feature');
    });

    it('does not clobber existing fields when seeding with partial data', () => {
      const { bridge } = createBridge();
      // Set some initial values via callbacks
      const callbacks = bridge.getCallbacks();
      // Start a phase, then complete it, to build up completedPhases
      callbacks.onPhaseStart!({ phase: 'scouting', round: 1 });
      callbacks.onPhaseComplete!({ phase: 'scouting', durationMs: 300 });
      callbacks.onPhaseStart!({ phase: 'planning', round: 1 });
      callbacks.onSidebarUpdate!({ title: 'My Workflow' });
      callbacks.onWorkflowStart!({ taskPrompt: 'Original prompt', resumed: false, workDir: '/tmp' });

      // Now bridge has: currentPhase='planning', completedPhases=['scouting'],
      // sidebar.title='My Workflow', taskPrompt='Original prompt'

      // Seed only currentPhase, leaving other fields intact
      bridge.seed({ currentPhase: 'implementing' });

      const snapshot = bridge.getSnapshot();
      // currentPhase was updated by seed
      expect(snapshot.currentPhase).toBe('implementing');
      // Other fields survive
      expect(snapshot.completedPhases).toEqual(['scouting']);
      expect(snapshot.sidebar.title).toBe('My Workflow');
      expect(snapshot.taskPrompt).toBe('Original prompt');
    });

    it('seeded tasks survive and can be updated by subsequent callbacks', () => {
      const { bridge, callbacks } = createBridge();

      // Seed with initial tasks
      bridge.seed({
        tasks: [{ id: 't1', title: 'Task 1', status: 'ready' }],
      });

      // Simulate task started via callback
      callbacks.onTaskStart!({ taskId: 't1', title: 'Task 1', agentId: 'a1', phase: 'implement', startedAt: 2000 });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.tasks).toHaveLength(1);
      expect(snapshot.tasks[0]).toMatchObject({
        id: 't1',
        title: 'Task 1',
        status: 'implementing',
        agentId: 'a1',
        startedAt: 2000,
      });
    });

    it('seeded currentPhase is properly tracked by onPhaseStart transitions', () => {
      const { bridge, callbacks, messages } = createBridge();

      // Seed that scouting is already complete and we're in planning
      bridge.seed({
        currentPhase: 'planning',
        completedPhases: ['scouting'],
      });

      // Now start a new phase - 'planning' should move to completed
      callbacks.onPhaseStart!({ phase: 'implementing', round: 1 });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'workflow_phase',
        phase: 'implementing',
        completed: ['scouting', 'planning'],
        currentPhase: 'implementing',
      });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.completedPhases).toEqual(['scouting', 'planning']);
      expect(snapshot.currentPhase).toBe('implementing');
    });

    it('seeded completedPhases are not duplicated by onPhaseStart', () => {
      const { bridge, callbacks } = createBridge();

      // Seed that scouting has already been completed
      bridge.seed({
        currentPhase: 'planning',
        completedPhases: ['scouting'],
      });

      // Complete planning via onPhaseComplete
      callbacks.onPhaseComplete!({ phase: 'planning', durationMs: 500 });

      // 'planning' should not be duplicated in completedPhases
      const snapshot = bridge.getSnapshot();
      expect(snapshot.completedPhases).toEqual(['scouting', 'planning']);
    });

    it('seeding with empty arrays overwrites previous values', () => {
      const { bridge } = createBridge();

      // First seed with some data
      bridge.seed({
        currentPhase: 'planning',
        completedPhases: ['scouting'],
        tasks: [{ id: 't1', title: 'Task 1', status: 'ready' }],
      });

      // Then seed with empty arrays
      bridge.seed({
        currentPhase: '',
        completedPhases: [],
        tasks: [],
      });

      const snapshot = bridge.getSnapshot();
      expect(snapshot.currentPhase).toBe('');
      expect(snapshot.completedPhases).toEqual([]);
      expect(snapshot.tasks).toEqual([]);
    });
  });

  describe('broadcasting agent_stats with taskId', () => {
    it('can broadcast agent_stats with taskId field set', () => {
      const { broadcast, messages } = createBridge();
      const msg: ServerMessage = {
        type: 'agent_stats',
        agentId: 'a1',
        toolCallCount: 3,
        inputTokens: 200,
        outputTokens: 75,
        taskId: 't-42',
      };
      broadcast(msg);
      expect(messages).toHaveLength(1);
      const sent = messages[0];
      expect(sent).toBeDefined();
      expect(sent.type).toBe('agent_stats');
      if (sent.type === 'agent_stats') {
        expect(sent.agentId).toBe('a1');
        expect(sent.toolCallCount).toBe(3);
        expect(sent.inputTokens).toBe(200);
        expect(sent.outputTokens).toBe(75);
        expect(sent.taskId).toBe('t-42');
      }
    });

    it('can broadcast agent_stats without taskId (backward compat)', () => {
      const { broadcast, messages } = createBridge();
      const msg: ServerMessage = {
        type: 'agent_stats',
        agentId: 'a1',
        toolCallCount: 1,
      };
      broadcast(msg);
      expect(messages).toHaveLength(1);
      const sent = messages[0];
      expect(sent).toBeDefined();
      expect(sent.type).toBe('agent_stats');
      if (sent.type === 'agent_stats') {
        expect(sent.taskId).toBeUndefined();
      }
    });

    it('broadcasting agent_stats with taskId does not break existing token stats', () => {
      const { broadcast, messages } = createBridge();
      const msg: ServerMessage = {
        type: 'agent_stats',
        agentId: 'a1',
        inputTokens: 150,
        outputTokens: 60,
        taskId: 't-99',
      };
      broadcast(msg);
      expect(messages).toHaveLength(1);
      const sent = messages[0];
      expect(sent).toBeDefined();
      expect(sent.type).toBe('agent_stats');
      if (sent.type === 'agent_stats') {
        expect(sent.inputTokens).toBe(150);
        expect(sent.outputTokens).toBe(60);
        expect(sent.taskId).toBe('t-99');
      }
    });
  });

  // ─── Agent log cap tests ────────────────────────────────────────────────────

  describe('agent log cap', () => {
    describe('MAX_AGENT_LOG_ENTRIES constant', () => {
      it('is exported with value 500', async () => {
        const mod = await import('../../src/web/status-bridge.ts');
        expect(mod.MAX_AGENT_LOG_ENTRIES).toBe(500);
      });
    });

    describe('eviction behavior via appendAgentLog', () => {
      it('preserves all entries when under the cap', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });

        // Add 100 entries (well under 500 cap) via onTurnEnd
        for (let i = 0; i < 100; i++) {
          callbacks.onTurnEnd!({
            agentId: 'a1',
            turn: i,
            contentBlocks: [{ type: 'text', text: `entry-${i}` }],
          });
        }

        const snapshot = bridge.getSnapshot();
        const agent = snapshot.agents.find((a) => a.agentId === 'a1');
        expect(agent).toBeDefined();
        expect(agent!.log).toHaveLength(100);
        expect(agent!.log[0].content).toBe('entry-0');
        expect(agent!.log[99].content).toBe('entry-99');
      });

      it('preserves all entries when exactly at the cap', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });

        // Add exactly 500 entries
        for (let i = 0; i < 500; i++) {
          callbacks.onTurnEnd!({
            agentId: 'a1',
            turn: i,
            contentBlocks: [{ type: 'text', text: `entry-${i}` }],
          });
        }

        const snapshot = bridge.getSnapshot();
        const agent = snapshot.agents.find((a) => a.agentId === 'a1');
        expect(agent).toBeDefined();
        expect(agent!.log).toHaveLength(500);
        expect(agent!.log[0].content).toBe('entry-0');
        expect(agent!.log[499].content).toBe('entry-499');
      });

      it('evicts oldest entry when exceeding the cap (FIFO)', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });

        // Add 501 entries — the first should be evicted
        for (let i = 0; i < 501; i++) {
          callbacks.onTurnEnd!({
            agentId: 'a1',
            turn: i,
            contentBlocks: [{ type: 'text', text: `entry-${i}` }],
          });
        }

        const snapshot = bridge.getSnapshot();
        const agent = snapshot.agents.find((a) => a.agentId === 'a1');
        expect(agent).toBeDefined();
        expect(agent!.log).toHaveLength(500);
        // entry-0 should have been shifted out
        expect(agent!.log[0].content).toBe('entry-1');
        expect(agent!.log[499].content).toBe('entry-500');
      });

      it('evicts oldest entries proportionally when many entries are added', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });

        // Add 1000 entries — the first 500 should be evicted, last 500 kept
        for (let i = 0; i < 1000; i++) {
          callbacks.onTurnEnd!({
            agentId: 'a1',
            turn: i,
            contentBlocks: [{ type: 'text', text: `entry-${i}` }],
          });
        }

        const snapshot = bridge.getSnapshot();
        const agent = snapshot.agents.find((a) => a.agentId === 'a1');
        expect(agent).toBeDefined();
        expect(agent!.log).toHaveLength(500);
        // entry-0 through entry-499 should be gone
        expect(agent!.log[0].content).toBe('entry-500');
        expect(agent!.log[499].content).toBe('entry-999');
      });

      it('evicts per-agent independently (isolated caps)', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });
        callbacks.onAgentSpawn!({ agentId: 'a2', profile: 'coder', phase: 'implement', taskId: 't1' });

        // Add 600 entries to a1 (100 over cap)
        for (let i = 0; i < 600; i++) {
          callbacks.onTurnEnd!({
            agentId: 'a1',
            turn: i,
            contentBlocks: [{ type: 'text', text: `a1-entry-${i}` }],
          });
        }

        // Add 50 entries to a2 (well under cap)
        for (let i = 0; i < 50; i++) {
          callbacks.onTurnEnd!({
            agentId: 'a2',
            turn: i,
            contentBlocks: [{ type: 'text', text: `a2-entry-${i}` }],
          });
        }

        const snapshot = bridge.getSnapshot();

        const agent1 = snapshot.agents.find((a) => a.agentId === 'a1');
        expect(agent1).toBeDefined();
        expect(agent1!.log).toHaveLength(500);
        expect(agent1!.log[0].content).toBe('a1-entry-100');
        expect(agent1!.log[499].content).toBe('a1-entry-599');

        const agent2 = snapshot.agents.find((a) => a.agentId === 'a2');
        expect(agent2).toBeDefined();
        expect(agent2!.log).toHaveLength(50);
        expect(agent2!.log[0].content).toBe('a2-entry-0');
        expect(agent2!.log[49].content).toBe('a2-entry-49');
      });

      it('applies cap for tool_call_start entries too', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });

        // Add 500 tool calls (at cap)
        for (let i = 0; i < 500; i++) {
          callbacks.onToolCallStart!({
            agentId: 'a1',
            toolName: `tool-${i}`,
            toolCallId: `call_${i}`,
            arguments: {},
          });
        }

        // Add one more to trigger eviction
        callbacks.onToolCallStart!({
          agentId: 'a1',
          toolName: 'tool-500',
          toolCallId: 'call_500',
          arguments: {},
        });

        const snapshot = bridge.getSnapshot();
        const agent = snapshot.agents.find((a) => a.agentId === 'a1');
        expect(agent).toBeDefined();
        expect(agent!.log).toHaveLength(500);
        // First entry (call_0) should have been evicted
        expect(agent!.log[0].id).toBe('call_1');
        expect(agent!.log[499].id).toBe('call_500');
      });

      it('applies cap for error and decision entries too', () => {
        const { callbacks, bridge } = createBridge();
        callbacks.onAgentSpawn!({ agentId: 'a1', profile: 'scout', phase: 'scouting' });

        // Add 500 errors (at cap)
        for (let i = 0; i < 500; i++) {
          callbacks.onError!({ agentId: 'a1', error: `error-${i}`, phase: 'test', taskId: undefined! });
        }

        // Snapshot should have exactly 500 error entries
        expect(bridge.getSnapshot().agents.find((a) => a.agentId === 'a1')!.log).toHaveLength(500);

        // Add one more decision to trigger eviction
        callbacks.onDecision!({ agentId: 'a1', decision: 'final', reasoning: 'done', taskId: undefined! });

        const snapshot = bridge.getSnapshot();
        const agent = snapshot.agents.find((a) => a.agentId === 'a1');
        expect(agent).toBeDefined();
        expect(agent!.log).toHaveLength(500);
        // First error should have been evicted
        expect(agent!.log[0].content).toBe('error-1');
        expect(agent!.log[499].type).toBe('decision');
      });
    });
  });
});
