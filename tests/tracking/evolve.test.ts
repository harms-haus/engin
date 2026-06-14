import { describe, expect, it } from 'bun:test';
import type { EventRecord, EventType } from '../../src/tracking/event-types.js';
import { createInitialProjection } from '../../src/tracking/event-types.js';
import { evolve } from '../../src/tracking/evolve.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let eventSeq = 0;

function makeEvent(
  type: EventType,
  data: Record<string, unknown> = {},
  metadata: EventRecord['metadata'] = { timestamp: new Date().toISOString() },
): EventRecord {
  return { seq: ++eventSeq, type, data, metadata };
}

function resetSeq() {
  eventSeq = 0;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('evolve', () => {
  // Each describe block resets the seq counter
  it('returns a new object (immutability)', () => {
    resetSeq();
    const state = createInitialProjection();
    const event = makeEvent('workflow_started', { taskPrompt: 'hello', resumed: false, workDir: '/tmp' });
    const next = evolve(state, event);
    expect(next).not.toBe(state);
    expect(next.taskPrompt).toBe('hello');
  });

  describe('workflow_started', () => {
    it('sets taskPrompt and status to running', () => {
      resetSeq();
      const state = createInitialProjection();
      const next = evolve(
        state,
        makeEvent('workflow_started', { taskPrompt: 'Build it', resumed: false, workDir: '/tmp' }),
      );
      expect(next.taskPrompt).toBe('Build it');
      expect(next.status).toBe('running');
    });
  });

  describe('phase_started', () => {
    it('sets currentPhase', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'scouting', round: 1 },
          { timestamp: new Date().toISOString(), phase: 'scouting' },
        ),
      );
      expect(state.currentPhase).toBe('scouting');
    });

    it('changes currentPhase without pushing completedPhases', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'scouting', round: 1 },
          { timestamp: new Date().toISOString(), phase: 'scouting' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'planning', round: 1 },
          { timestamp: new Date().toISOString(), phase: 'planning' },
        ),
      );
      expect(state.currentPhase).toBe('planning');
      expect(state.completedPhases).toEqual([]);
    });
  });

  describe('phase_completed', () => {
    it('pushes current phase to completedPhases', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'scouting', round: 1 },
          { timestamp: new Date().toISOString(), phase: 'scouting' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'phase_completed',
          { phase: 'scouting', durationMs: 100 },
          { timestamp: new Date().toISOString(), phase: 'scouting' },
        ),
      );
      expect(state.completedPhases).toEqual(['scouting']);
    });

    it('chains multiple phase completions', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_started', { phase: 'scouting', round: 1 }));
      state = evolve(state, makeEvent('phase_completed', { phase: 'scouting', durationMs: 100 }));
      state = evolve(state, makeEvent('phase_started', { phase: 'planning', round: 1 }));
      state = evolve(state, makeEvent('phase_completed', { phase: 'planning', durationMs: 200 }));
      expect(state.completedPhases).toEqual(['scouting', 'planning']);
    });
  });

  describe('agent_spawned', () => {
    it('inserts an AgentEntity keyed by agentId::taskId', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'agent-1', profile: 'coder', sessionId: 'sess-1', sessionPath: '/tmp/sess' },
          { timestamp: new Date().toISOString(), agentId: 'agent-1', taskId: 'task-1', phase: 'impl' },
        ),
      );
      const key = 'agent-1::task-1';
      expect(state.agents[key]).toBeDefined();
      expect(state.agents[key].agentId).toBe('agent-1');
      expect(state.agents[key].profile).toBe('coder');
      expect(state.agents[key].phase).toBe('impl');
      expect(state.agents[key].taskId).toBe('task-1');
      expect(state.agents[key].sessionId).toBe('sess-1');
      expect(state.agents[key].active).toBe(true);
      expect(state.agents[key].log).toEqual([]);
      expect(state.agents[key].toolCallCount).toBe(0);
      expect(state.stats.agentCount).toBe(1);
    });

    it('uses agentId as key when no taskId', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'agent-2', profile: 'scout' },
          { timestamp: new Date().toISOString(), agentId: 'agent-2' },
        ),
      );
      expect(state.agents['agent-2']).toBeDefined();
      expect(state.agents['agent-2'].uid).toBe('agent-2');
    });

    it('re-spawn preserves accumulated log/tokens/toolCallCount (upsert)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // First spawn
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );

      // Accumulate state via turn_ended (tokens + text log)
      state = evolve(
        state,
        makeEvent(
          'turn_ended',
          { turn: 1, tokens: { input: 200, output: 100 }, contentBlocks: [{ type: 'text', text: 'hello' }] },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      // Accumulate tool call count
      state = evolve(
        state,
        makeEvent(
          'tool_call_started',
          { toolName: 'write', toolCallId: 'tc-1', arguments: {} },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      const key = 'a1::t1';
      expect(state.agents[key].log).toHaveLength(2); // text + tool_call_start
      expect(state.agents[key].inputTokens).toBe(200);
      expect(state.agents[key].outputTokens).toBe(100);
      expect(state.agents[key].toolCallCount).toBe(1);
      expect(state.stats.agentCount).toBe(1);

      // Re-spawn same agent (same key)
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder-v2' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );

      // Accumulated state must be preserved
      expect(state.agents[key].log).toHaveLength(2);
      expect(state.agents[key].inputTokens).toBe(200);
      expect(state.agents[key].outputTokens).toBe(100);
      expect(state.agents[key].toolCallCount).toBe(1);
      expect(state.agents[key].active).toBe(true);
      // Metadata updated
      expect(state.agents[key].profile).toBe('coder-v2');
      // agentCount must NOT double-count
      expect(state.stats.agentCount).toBe(1);
    });
  });

  describe('agent_completed', () => {
    it('sets active=false and completedAt', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'agent_completed',
          { agentId: 'a1', profile: 'coder', sessionId: 's1' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.agents[key].active).toBe(false);
      expect(state.agents[key].completedAt).toBeDefined();
    });
  });

  describe('task_started', () => {
    it('upserts a TaskEntity with status implementing', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'task_started',
          { taskId: 't1', title: 'Do thing', agentId: 'a1', startedAt: 1000 },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );
      expect(state.tasks['t1']).toBeDefined();
      expect(state.tasks['t1'].title).toBe('Do thing');
      expect(state.tasks['t1'].status).toBe('implementing');
      expect(state.tasks['t1'].agentId).toBe('a1');
      expect(state.tasks['t1'].startedAt).toBe(1000);
    });
  });

  describe('task_step_started', () => {
    it('sets stepInfo on the task', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'task_started',
          { taskId: 't1', title: 'Do thing', agentId: 'a1', startedAt: 1000 },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'task_step_started',
          { taskId: 't1', stepName: 'analyze', stepIndex: 1, totalSteps: 3 },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].stepInfo).toBe('analyze');
    });
  });

  describe('task_completed', () => {
    it('sets status to done', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'task_started',
          { taskId: 't1', title: 'Do thing', agentId: 'a1', startedAt: 1000 },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'task_completed',
          { taskId: 't1', title: 'Do thing' },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].status).toBe('done');
      expect(state.tasks['t1'].completedAt).toBeDefined();
    });
  });

  describe('task_rejected', () => {
    it('sets status to failed', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'task_started',
          { taskId: 't1', title: 'Do thing', agentId: 'a1', startedAt: 1000 },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'task_rejected',
          { taskId: 't1', title: 'Do thing', reason: 'Bad code' },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].status).toBe('failed');
    });
  });

  describe('decision', () => {
    it('appends a LogEntry to the agent log', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'decision',
          { decision: 'use React', reasoning: 'best fit' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.agents[key].log).toHaveLength(1);
      expect(state.agents[key].log[0].type).toBe('decision');
      expect(state.agents[key].log[0].content).toBe('use React');
    });
  });

  describe('error', () => {
    it('appends an error LogEntry to the agent log', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      state = evolve(
        state,
        makeEvent('error', { error: 'something broke' }, { timestamp: new Date().toISOString(), agentId: 'a1' }),
      );
      const key = 'a1';
      expect(state.agents[key].log).toHaveLength(1);
      expect(state.agents[key].log[0].type).toBe('error');
      expect(state.agents[key].log[0].content).toBe('something broke');
    });
  });

  describe('tasks_added', () => {
    it('upserts tasks (delta, not full replace)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'task_started',
          { taskId: 't1', title: 'Existing', agentId: 'a1', startedAt: 1000 },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      // Add t2 and t3
      state = evolve(
        state,
        makeEvent(
          'tasks_added',
          {
            tasks: [
              { id: 't2', title: 'New task', status: 'ready', dependencies: [] },
              { id: 't3', title: 'Another', status: 'blocked', dependencies: ['t2'] },
            ],
          },
          { timestamp: new Date().toISOString() },
        ),
      );
      // t1 should still exist with its implementing status
      expect(state.tasks['t1']).toBeDefined();
      expect(state.tasks['t1'].status).toBe('implementing');
      expect(state.tasks['t2']).toBeDefined();
      expect(state.tasks['t2'].title).toBe('New task');
      expect(state.tasks['t3']).toBeDefined();
      expect(state.tasks['t3'].status).toBe('blocked');
    });
  });

  describe('sidebar_updated', () => {
    it('merges sidebar fields', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent('sidebar_updated', {
          title: 'My Workflow',
          indicator: 'Building…',
          phases: [{ id: 'p1', label: 'Phase 1', icon: '🚀' }],
        }),
      );
      expect(state.sidebar.title).toBe('My Workflow');
      expect(state.sidebar.indicator).toBe('Building…');
      expect(state.sidebar.phases).toHaveLength(1);
      expect(state.sidebar.phases![0].id).toBe('p1');
    });
  });

  describe('turn_started', () => {
    it('is a no-op (returns new object with same content)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const before = {
        ...state,
        tasks: { ...state.tasks },
        agents: { ...state.agents },
        completedPhases: [...state.completedPhases],
      };
      state = evolve(
        state,
        makeEvent('turn_started', { turn: 1 }, { timestamp: new Date().toISOString(), agentId: 'a1' }),
      );
      expect(state.taskPrompt).toBe(before.taskPrompt);
      expect(state.status).toBe(before.status);
    });
  });

  describe('turn_ended', () => {
    it('appends text/thinking blocks to agent log and accumulates tokens', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'turn_ended',
          {
            turn: 1,
            tokens: { input: 100, output: 50 },
            contentBlocks: [
              { type: 'text', text: 'Hello world' },
              { type: 'thinking', thinking: 'Let me think...' },
            ],
          },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      const agent = state.agents['a1'];
      expect(agent.log).toHaveLength(2);
      expect(agent.log[0].type).toBe('text');
      expect(agent.log[0].content).toBe('Hello world');
      expect(agent.log[1].type).toBe('thinking');
      expect(agent.inputTokens).toBe(100);
      expect(agent.outputTokens).toBe(50);
      expect(state.stats.totalTokens).toBe(150);
    });
  });

  describe('tool_call_started', () => {
    it('appends tool_call_start LogEntry and increments toolCallCount', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'tool_call_started',
          { toolName: 'bash', toolCallId: 'tc-1', arguments: { command: 'ls' } },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      const agent = state.agents['a1'];
      expect(agent.toolCallCount).toBe(1);
      expect(agent.log).toHaveLength(1);
      expect(agent.log[0].type).toBe('tool_call_start');
      expect(agent.log[0].metadata).toEqual({ toolName: 'bash', toolCallId: 'tc-1', arguments: { command: 'ls' } });
    });
  });

  describe('tool_call_ended', () => {
    it('appends tool_call_end LogEntry', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'tool_call_ended',
          { toolName: 'bash', toolCallId: 'tc-1', isError: false },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      const agent = state.agents['a1'];
      expect(agent.log).toHaveLength(1);
      expect(agent.log[0].type).toBe('tool_call_end');
      expect(agent.log[0].metadata).toEqual({ toolName: 'bash', toolCallId: 'tc-1', isError: false });
    });
  });

  describe('workflow_completed', () => {
    it('sets status to complete', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('workflow_completed', { totalDurationMs: 5000, agentCount: 3 }));
      expect(state.status).toBe('complete');
    });
  });

  describe('workflow_failed', () => {
    it('sets status to failed with error and failedPhase', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'implementing', round: 1 },
          { timestamp: new Date().toISOString(), phase: 'implementing' },
        ),
      );
      state = evolve(state, makeEvent('workflow_failed', { error: 'Kaboom', phase: 'implementing' }));
      expect(state.status).toBe('failed');
      expect(state.error).toBe('Kaboom');
      expect(state.failedPhase).toBe('implementing');
    });
  });

  describe('log cap at 500', () => {
    it('drops oldest entries when log exceeds 500', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      // Add 502 decision events
      for (let i = 0; i < 502; i++) {
        state = evolve(
          state,
          makeEvent(
            'decision',
            { decision: `d-${i}`, reasoning: '' },
            { timestamp: new Date().toISOString(), agentId: 'a1' },
          ),
        );
      }

      const agent = state.agents['a1'];
      expect(agent.log).toHaveLength(500);
      // Oldest entries (0, 1) should be dropped; first remaining is d-2
      expect(agent.log[0].content).toBe('d-2');
      expect(agent.log[499].content).toBe('d-501');
    });
  });

  describe('multi-event sequence', () => {
    it('spawn → tasks_added → task_started → decision → tool_call → turn_end → task_completed → agent_completed → verify final state', () => {
      resetSeq();
      let state = createInitialProjection();

      // 1. workflow_started
      state = evolve(
        state,
        makeEvent('workflow_started', { taskPrompt: 'Build auth module', resumed: false, workDir: '/tmp/proj' }),
      );
      expect(state.taskPrompt).toBe('Build auth module');
      expect(state.status).toBe('running');

      // 2. phase_started
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'implementing', round: 1 },
          { timestamp: new Date().toISOString(), phase: 'implementing' },
        ),
      );
      expect(state.currentPhase).toBe('implementing');

      // 3. tasks_added
      state = evolve(
        state,
        makeEvent('tasks_added', { tasks: [{ id: 't1', title: 'Auth handler', status: 'ready', dependencies: [] }] }),
      );
      expect(state.tasks['t1'].title).toBe('Auth handler');
      expect(state.tasks['t1'].status).toBe('ready');

      // 4. agent_spawned
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'coder-1', profile: 'coder', sessionId: 'sess-abc', sessionPath: '/sessions/abc' },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1', phase: 'implementing' },
        ),
      );
      expect(state.agents['coder-1::t1']).toBeDefined();
      expect(state.agents['coder-1::t1'].active).toBe(true);

      // 5. task_started
      state = evolve(
        state,
        makeEvent(
          'task_started',
          { taskId: 't1', title: 'Auth handler', agentId: 'coder-1', startedAt: Date.now() },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].status).toBe('implementing');
      expect(state.tasks['t1'].agentId).toBe('coder-1');

      // 6. decision
      state = evolve(
        state,
        makeEvent(
          'decision',
          { decision: 'Use JWT tokens', reasoning: 'Stateless and scalable' },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1' },
        ),
      );

      // 7. tool_call_started
      state = evolve(
        state,
        makeEvent(
          'tool_call_started',
          { toolName: 'write', toolCallId: 'tc-w1', arguments: { path: 'auth.ts' } },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1' },
        ),
      );
      expect(state.agents['coder-1::t1'].toolCallCount).toBe(1);

      // 8. tool_call_ended
      state = evolve(
        state,
        makeEvent(
          'tool_call_ended',
          { toolName: 'write', toolCallId: 'tc-w1', isError: false },
          { timestamp: new Date().toISOString(), agentId: 'coder-1' },
        ),
      );

      // 9. turn_ended with tokens
      state = evolve(
        state,
        makeEvent(
          'turn_ended',
          {
            turn: 1,
            tokens: { input: 200, output: 100 },
            contentBlocks: [{ type: 'text', text: 'Done implementing auth handler.' }],
          },
          { timestamp: new Date().toISOString(), agentId: 'coder-1' },
        ),
      );
      expect(state.agents['coder-1::t1'].inputTokens).toBe(200);
      expect(state.agents['coder-1::t1'].outputTokens).toBe(100);
      expect(state.stats.totalTokens).toBe(300);

      // 10. task_completed
      state = evolve(
        state,
        makeEvent(
          'task_completed',
          { taskId: 't1', title: 'Auth handler' },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].status).toBe('done');

      // 11. agent_completed
      state = evolve(
        state,
        makeEvent(
          'agent_completed',
          { agentId: 'coder-1', profile: 'coder', sessionId: 'sess-abc' },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1' },
        ),
      );
      expect(state.agents['coder-1::t1'].active).toBe(false);
      expect(state.agents['coder-1::t1'].completedAt).toBeDefined();

      // 12. phase_completed
      state = evolve(
        state,
        makeEvent(
          'phase_completed',
          { phase: 'implementing', durationMs: 3000 },
          { timestamp: new Date().toISOString(), phase: 'implementing' },
        ),
      );
      expect(state.completedPhases).toEqual(['implementing']);

      // 13. workflow_completed
      state = evolve(state, makeEvent('workflow_completed', { totalDurationMs: 5000, agentCount: 1 }));
      expect(state.status).toBe('complete');

      // Final verification
      expect(state.taskPrompt).toBe('Build auth module');
      expect(state.currentPhase).toBe('implementing');
      expect(state.completedPhases).toEqual(['implementing']);
      expect(Object.keys(state.tasks)).toEqual(['t1']);
      expect(Object.keys(state.agents)).toEqual(['coder-1::t1']);
      expect(state.stats.totalTokens).toBe(300);
      expect(state.stats.agentCount).toBe(1);
      expect(state.agents['coder-1::t1'].log.length).toBeGreaterThanOrEqual(3); // decision + tool_call_start + tool_call_end + text
    });
  });
});

// ── Shared evolve-parity fixture ─────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ParityScenario {
  name: string;
  events: EventRecord[];
  expect: Record<string, unknown>;
}

const parityScenarios: ParityScenario[] = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../fixtures/evolve-parity.json'), 'utf-8'),
);

/**
 * Deep subset assertion. Recursively walks `expected` and asserts that
 * every leaf value matches `actual`.  Supports a special `{ length: N }
 * sentinel for asserting array lengths without enumerating every entry.
 */
function assertSubset(actual: unknown, expected: unknown, path = ''): void {
  if (
    expected !== null &&
    typeof expected === 'object' &&
    !Array.isArray(expected) &&
    'length' in (expected as Record<string, unknown>) &&
    Object.keys(expected).length === 1 &&
    typeof (expected as Record<string, unknown>).length === 'number' &&
    Array.isArray(actual)
  ) {
    // Sentinel: { length: N } on an array — assert length only
    expect(actual).toHaveLength((expected as { length: number }).length);
    return;
  }
  if (expected === null || typeof expected !== 'object') {
    expect(actual).toBe(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    expect(actual).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      assertSubset((actual as unknown[])[i], expected[i], `${path}[${i}]`);
    }
    return;
  }
  // Plain object
  expect(actual && typeof actual === 'object').toBe(true);
  for (const [key, val] of Object.entries(expected)) {
    if (val === undefined) {
      expect((actual as Record<string, unknown>)[key]).toBeUndefined();
    } else {
      assertSubset((actual as Record<string, unknown>)[key], val, `${path}.${key}`);
    }
  }
}

describe('evolve – shared parity fixture', () => {
  for (const scenario of parityScenarios) {
    it(scenario.name, () => {
      let state = createInitialProjection();
      for (const evt of scenario.events) {
        state = evolve(state, evt);
      }
      assertSubset(state, scenario.expect);
    });
  }
});
