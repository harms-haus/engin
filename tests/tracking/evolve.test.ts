import type { EventRecord, EventType } from '@engin/shared/event-types';
import { createInitialProjection, MAX_RUN_LOG } from '@engin/shared/event-types';
import { evolve } from '@engin/shared/evolve';
import { describe, expect, it } from 'bun:test';

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

  describe('phase_registered', () => {
    it('appends a PhaseEntity to phases array', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'scouting', label: 'Scouting', icon: '🔍' }));
      expect(state.phases).toHaveLength(1);
      expect(state.phases[0].id).toBe('scouting');
      expect(state.phases[0].label).toBe('Scouting');
      expect(state.phases[0].icon).toBe('🔍');
      expect(state.phases[0].taskIds).toEqual([]);
    });

    it('preserves insertion order', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'a', label: 'A', icon: '' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'b', label: 'B', icon: '' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'c', label: 'C', icon: '' }));
      expect(state.phases.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    });

    it('no-op when phase already registered', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'First', icon: '1' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Second', icon: '2' }));
      expect(state.phases).toHaveLength(1);
      expect(state.phases[0].label).toBe('First');
    });
  });

  describe('phase_started', () => {
    it('sets currentPhaseId', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'scouting', round: 1 },
          { timestamp: new Date().toISOString(), phaseId: 'scouting' },
        ),
      );
      expect(state.currentPhaseId).toBe('scouting');
    });

    it('changes currentPhaseId without pushing completedPhaseIds', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'scouting', round: 1 },
          { timestamp: new Date().toISOString(), phaseId: 'scouting' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'planning', round: 1 },
          { timestamp: new Date().toISOString(), phaseId: 'planning' },
        ),
      );
      expect(state.currentPhaseId).toBe('planning');
      expect(state.completedPhaseIds).toEqual([]);
    });
  });

  describe('phase_completed', () => {
    it('pushes current phase to completedPhaseIds', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'scouting', round: 1 },
          { timestamp: new Date().toISOString(), phaseId: 'scouting' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'phase_completed',
          { phase: 'scouting', durationMs: 100 },
          { timestamp: new Date().toISOString(), phaseId: 'scouting' },
        ),
      );
      expect(state.completedPhaseIds).toEqual(['scouting']);
    });

    it('chains multiple phase completions', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_started', { phase: 'scouting', round: 1 }));
      state = evolve(state, makeEvent('phase_completed', { phase: 'scouting', durationMs: 100 }));
      state = evolve(state, makeEvent('phase_started', { phase: 'planning', round: 1 }));
      state = evolve(state, makeEvent('phase_completed', { phase: 'planning', durationMs: 200 }));
      expect(state.completedPhaseIds).toEqual(['scouting', 'planning']);
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
          { timestamp: new Date().toISOString(), agentId: 'agent-1', taskId: 'task-1', phaseId: 'impl' },
        ),
      );
      const key = 'agent-1::task-1';
      expect(state.agents[key]).toBeDefined();
      expect(state.agents[key].agentId).toBe('agent-1');
      expect(state.agents[key].profile).toBe('coder');
      expect(state.agents[key].phaseId).toBe('impl');
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

    it('stamps stepIndex from metadata and links to task step', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // Register a phase and a task with steps
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Phase 1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [
            { name: 'analyze', profileId: 'scout', isReadOnly: true },
            { name: 'implement', profileId: 'coder', isReadOnly: false },
          ],
          dependencies: [],
        }),
      );

      // Spawn agent with stepIndex
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1', stepIndex: 1 },
        ),
      );

      const key = 'a1::t1::1';
      expect(state.agents[key].stepIndex).toBe(1);
      // Task step should be linked
      expect(state.tasks['t1'].steps[1].agentKey).toBe(key);
    });

    it('creates independent agent entities for different steps within the same task', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // Register a phase and a task with 2 steps
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Phase 1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [
            { name: 'analyze', profileId: 'scout', isReadOnly: true },
            { name: 'implement', profileId: 'coder', isReadOnly: false },
          ],
          dependencies: [],
        }),
      );

      // Spawn agent for step 0
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'lane-0', profile: 'scout' },
          { timestamp: new Date().toISOString(), agentId: 'lane-0', taskId: 't1', stepIndex: 0 },
        ),
      );

      // Spawn agent for step 1 (same agentId, same taskId, different stepIndex)
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'lane-0', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'lane-0', taskId: 't1', stepIndex: 1 },
        ),
      );

      const key0 = 'lane-0::t1::0';
      const key1 = 'lane-0::t1::1';

      // Both entities must exist and be independent
      expect(state.agents[key0]).toBeDefined();
      expect(state.agents[key1]).toBeDefined();
      expect(state.agents[key0].agentId).toBe('lane-0');
      expect(state.agents[key1].agentId).toBe('lane-0');
      expect(state.agents[key0].stepIndex).toBe(0);
      expect(state.agents[key1].stepIndex).toBe(1);
      expect(state.agents[key0].profile).toBe('scout');
      expect(state.agents[key1].profile).toBe('coder');
      expect(state.agents[key0].uid).toBe(key0);
      expect(state.agents[key1].uid).toBe(key1);
      expect(state.agents[key0].active).toBe(true);
      expect(state.agents[key1].active).toBe(true);
      // Each has its own log
      expect(state.agents[key0].log).toEqual([]);
      expect(state.agents[key1].log).toEqual([]);
      // Task steps should be linked
      expect(state.tasks['t1'].steps[0].agentKey).toBe(key0);
      expect(state.tasks['t1'].steps[1].agentKey).toBe(key1);

      // agentCount should be 2 (two distinct spawns)
      expect(state.stats.agentCount).toBe(2);
    });

    it('events without stepIndex coalesce onto the last-active step agent when multiple are active', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // Register a phase and a task with 2 steps
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Phase 1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [
            { name: 'analyze', profileId: 'scout', isReadOnly: true },
            { name: 'implement', profileId: 'coder', isReadOnly: false },
          ],
          dependencies: [],
        }),
      );

      // Spawn agent for step 0
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'scout' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1', stepIndex: 0 },
        ),
      );

      // Spawn agent for step 1
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1', stepIndex: 1 },
        ),
      );

      const key0 = 'a1::t1::0';
      const key1 = 'a1::t1::1';

      // Fire turn_ended (no stepIndex metadata)
      state = evolve(
        state,
        makeEvent(
          'turn_ended',
          {
            turn: 1,
            tokens: { input: 100, output: 50 },
            contentBlocks: [{ type: 'text', text: 'step 0 work' }],
          },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      // Fire tool_call_started (taskId only, no stepIndex)
      state = evolve(
        state,
        makeEvent(
          'tool_call_started',
          { toolName: 'write', toolCallId: 'tc-1', arguments: {} },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );

      // turn_ended and tool_call_started carry only agentId (no stepIndex). With both step agents
      // active, resolveAgent's fallback prefers the last-inserted active agent (key1), so both
      // events land there and key0 is untouched. In production this coalescing does not occur
      // because steps run sequentially (only one agent active at a time).
      expect(state.agents[key0].log).toHaveLength(0);
      expect(state.agents[key0].inputTokens).toBe(0);
      expect(state.agents[key0].outputTokens).toBe(0);
      expect(state.agents[key0].toolCallCount).toBe(0);

      // Step 1 agent got both events (last active)
      expect(state.agents[key1].log).toHaveLength(2); // text + tool_call_start
      expect(state.agents[key1].inputTokens).toBe(100);
      expect(state.agents[key1].outputTokens).toBe(50);
      expect(state.agents[key1].toolCallCount).toBe(1);
    });

    it('re-spawn with stepIndex preserves accumulated log/tokens (per-step upsert)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // Register a phase and a task with 1 step
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Phase 1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [{ name: 'analyze', profileId: 'scout', isReadOnly: true }],
          dependencies: [],
        }),
      );

      // First spawn with stepIndex
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'scout' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1', stepIndex: 0 },
        ),
      );

      // Accumulate state
      state = evolve(
        state,
        makeEvent(
          'turn_ended',
          {
            turn: 1,
            tokens: { input: 200, output: 100 },
            contentBlocks: [{ type: 'text', text: 'hello' }],
          },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      state = evolve(
        state,
        makeEvent(
          'tool_call_started',
          { toolName: 'write', toolCallId: 'tc-1', arguments: {} },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );

      const key = 'a1::t1::0';
      expect(state.agents[key].log).toHaveLength(2);
      expect(state.agents[key].inputTokens).toBe(200);
      expect(state.agents[key].outputTokens).toBe(100);
      expect(state.agents[key].toolCallCount).toBe(1);
      expect(state.stats.agentCount).toBe(1);

      // Re-spawn same agent (same key — same stepIndex)
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'scout-v2' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1', stepIndex: 0 },
        ),
      );

      // Accumulated state must be preserved (UPSERT)
      expect(state.agents[key].log).toHaveLength(2);
      expect(state.agents[key].inputTokens).toBe(200);
      expect(state.agents[key].outputTokens).toBe(100);
      expect(state.agents[key].toolCallCount).toBe(1);
      expect(state.agents[key].active).toBe(true);
      expect(state.agents[key].profile).toBe('scout-v2');
      // agentCount must NOT double-count
      expect(state.stats.agentCount).toBe(1);
    });

    it('resolveAgent finds active step agent when only agentId is available', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // Register a phase and a task with 2 steps
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Phase 1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [
            { name: 'analyze', profileId: 'scout', isReadOnly: true },
            { name: 'implement', profileId: 'coder', isReadOnly: false },
          ],
          dependencies: [],
        }),
      );

      // Spawn step 0 agent, then complete it
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'scout' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1', stepIndex: 0 },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'agent_completed',
          {},
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1', stepIndex: 0 },
        ),
      );

      // Spawn step 1 agent (active)
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1', stepIndex: 1 },
        ),
      );

      // Now resolveAgent with only agentId (no taskId) should find the active one (step 1)
      // We'll verify by firing a decision event which uses resolveAgent internally
      state = evolve(
        state,
        makeEvent(
          'decision',
          { decision: 'use step 1', reasoning: '' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      // The decision should go to the active step 1 agent
      const key1 = 'a1::t1::1';
      expect(state.agents[key1].log).toHaveLength(1);
      expect(state.agents[key1].log[0].content).toBe('use step 1');

      // Step 0 agent should NOT have the decision
      const key0 = 'a1::t1::0';
      expect(state.agents[key0].log).toHaveLength(0);
    });

    // ── contextWindow & startedAt population ───────────────────────────────
    //
    // agent_spawned must read `data.contextWindow` (a number) and
    // `metadata.timestamp` (an ISO string) defensively. `startedAt` is stamped
    // ONCE at first spawn and preserved across re-spawns; `contextWindow`
    // always prefers the incoming value, falling back to the existing one.

    it('sets contextWindow and startedAt on first spawn from event.data and metadata.timestamp', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder', contextWindow: 200000 },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.agents[key].contextWindow).toBe(200000);
      expect(state.agents[key].startedAt).toBe('2026-06-18T10:00:00Z');
    });

    it('re-spawn preserves startedAt from the first spawn while updating contextWindow', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // First spawn
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder', contextWindow: 100000 },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.agents[key].startedAt).toBe('2026-06-18T10:00:00Z');
      expect(state.agents[key].contextWindow).toBe(100000);

      // Re-spawn the same key: newer contextWindow, newer timestamp
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder-v2', contextWindow: 200000 },
          { timestamp: '2026-06-18T11:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );

      // startedAt must NOT be overwritten by the later timestamp
      expect(state.agents[key].startedAt).toBe('2026-06-18T10:00:00Z');
      // contextWindow must reflect the incoming value
      expect(state.agents[key].contextWindow).toBe(200000);
      // profile still updates (UPSERT metadata)
      expect(state.agents[key].profile).toBe('coder-v2');
      // agentCount must NOT double-count
      expect(state.stats.agentCount).toBe(1);
    });

    it('fresh spawn without data.contextWindow leaves contextWindow undefined but still stamps startedAt', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' }, // no contextWindow
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.agents[key].contextWindow).toBeUndefined();
      expect(state.agents[key].startedAt).toBe('2026-06-18T10:00:00Z');
    });

    it('re-spawn without data.contextWindow preserves the existing contextWindow', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // First spawn sets contextWindow
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder', contextWindow: 200000 },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.agents[key].contextWindow).toBe(200000);

      // Re-spawn omits contextWindow → must fall back to the existing value
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder-v2' },
          { timestamp: '2026-06-18T11:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      expect(state.agents[key].contextWindow).toBe(200000);
      // startedAt still preserved from first spawn
      expect(state.agents[key].startedAt).toBe('2026-06-18T10:00:00Z');
    });

    it('sets contextWindow and startedAt for a per-step agent key (agentId::taskId::stepIndex)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Phase 1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
          dependencies: [],
        }),
      );

      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'lane-0', profile: 'coder', contextWindow: 150000 },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'lane-0', taskId: 't1', stepIndex: 0 },
        ),
      );
      const key = 'lane-0::t1::0';
      expect(state.agents[key].contextWindow).toBe(150000);
      expect(state.agents[key].startedAt).toBe('2026-06-18T10:00:00Z');

      // Re-spawn same per-step key: startedAt preserved, contextWindow updated
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'lane-0', profile: 'coder-v2', contextWindow: 250000 },
          { timestamp: '2026-06-18T12:00:00Z', agentId: 'lane-0', taskId: 't1', stepIndex: 0 },
        ),
      );
      expect(state.agents[key].startedAt).toBe('2026-06-18T10:00:00Z');
      expect(state.agents[key].contextWindow).toBe(250000);
      expect(state.stats.agentCount).toBe(1);
    });

    it('coerces non-number contextWindow defensively on fresh spawn (falls back to undefined)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      // A non-number contextWindow should be ignored → undefined on fresh entity
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder', contextWindow: 'big' },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.agents[key].contextWindow).toBeUndefined();
      expect(state.agents[key].startedAt).toBe('2026-06-18T10:00:00Z');
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

  describe('task_registered', () => {
    it('creates a TaskEntity with steps and appends taskId to phase', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Phase 1', icon: '' }));

      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [{ name: 'analyze', profileId: 'scout', isReadOnly: true }],
          dependencies: ['t0'],
        }),
      );

      expect(state.tasks['t1']).toBeDefined();
      expect(state.tasks['t1'].title).toBe('Do thing');
      expect(state.tasks['t1'].phaseId).toBe('p1');
      expect(state.tasks['t1'].status).toBe('ready');
      expect(state.tasks['t1'].steps).toHaveLength(1);
      expect(state.tasks['t1'].steps[0].name).toBe('analyze');
      expect(state.tasks['t1'].steps[0].index).toBe(0);
      expect(state.tasks['t1'].steps[0].profile).toBe('scout');
      expect(state.tasks['t1'].steps[0].isReadOnly).toBe(true);
      expect(state.tasks['t1'].steps[0].agentKey).toBeUndefined();
      expect(state.tasks['t1'].activeStepIndex).toBeUndefined();
      expect(state.tasks['t1'].dependencies).toEqual(['t0']);

      // Phase should have the taskId appended
      expect(state.phases[0].taskIds).toEqual(['t1']);
    });

    it('no-op if task already exists', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', { taskId: 't1', title: 'First', phaseId: 'p1', steps: [], dependencies: [] }),
      );
      state = evolve(
        state,
        makeEvent('task_registered', { taskId: 't1', title: 'Second', phaseId: 'p1', steps: [], dependencies: [] }),
      );
      expect(state.tasks['t1'].title).toBe('First');
    });
  });

  describe('task_started', () => {
    it('sets status to active, startedAt, and agentId', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [],
          dependencies: [],
        }),
      );
      state = evolve(
        state,
        makeEvent(
          'task_started',
          { taskId: 't1', title: 'Do thing', agentId: 'a1', startedAt: 1000 },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1']).toBeDefined();
      expect(state.tasks['t1'].title).toBe('Do thing');
      expect(state.tasks['t1'].status).toBe('active');
      expect(state.tasks['t1'].startedAt).toBe(1000);
    });

    it('no-op when task does not exist', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('task_started', { taskId: 'nonexistent', title: 'Nope', agentId: 'a1' }));
      expect(state.tasks).toEqual({});
    });
  });

  describe('step_started', () => {
    it('sets activeStepIndex on the task', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [
            { name: 'analyze', profileId: 'scout', isReadOnly: true },
            { name: 'implement', profileId: 'coder', isReadOnly: false },
          ],
          dependencies: [],
        }),
      );
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
          'step_started',
          { taskId: 't1', stepIndex: 1, stepName: 'implement' },
          { timestamp: new Date().toISOString(), taskId: 't1', agentId: 'a1' },
        ),
      );
      expect(state.tasks['t1'].activeStepIndex).toBe(1);
    });

    it('links agentKey to step when agent exists', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [{ name: 'analyze', profileId: 'scout', isReadOnly: true }],
          dependencies: [],
        }),
      );
      // Spawn agent first
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
          'step_started',
          { taskId: 't1', stepIndex: 0, stepName: 'analyze' },
          { timestamp: new Date().toISOString(), taskId: 't1', agentId: 'a1' },
        ),
      );
      expect(state.tasks['t1'].activeStepIndex).toBe(0);
      expect(state.tasks['t1'].steps[0].agentKey).toBe('a1::t1');
    });

    it('allows backward movement (retry)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Task',
          phaseId: 'p1',
          steps: [
            { name: 'step0', profileId: 'p0', isReadOnly: false },
            { name: 'step1', profileId: 'p1', isReadOnly: false },
          ],
          dependencies: [],
        }),
      );
      state = evolve(state, makeEvent('step_started', { taskId: 't1', stepIndex: 0 }));
      expect(state.tasks['t1'].activeStepIndex).toBe(0);
      state = evolve(state, makeEvent('step_started', { taskId: 't1', stepIndex: 1 }));
      expect(state.tasks['t1'].activeStepIndex).toBe(1);
      // Retry — move backward
      state = evolve(state, makeEvent('step_started', { taskId: 't1', stepIndex: 0 }));
      expect(state.tasks['t1'].activeStepIndex).toBe(0);
    });
  });

  describe('task_completed', () => {
    it('sets status to complete', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [],
          dependencies: [],
        }),
      );
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
      expect(state.tasks['t1'].status).toBe('complete');
      expect(state.tasks['t1'].completedAt).toBeDefined();
    });
  });

  describe('task_rejected', () => {
    it('sets status to failed', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          steps: [],
          dependencies: [],
        }),
      );
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

  describe('agent_rendered', () => {
    it('appends a render LogEntry to the agent log', () => {
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
          'agent_rendered',
          { rendered: '# Heading\n\nrendered markdown' },
          { timestamp: '2026-06-16T12:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.agents[key].log).toHaveLength(1);
      expect(state.agents[key].log[0].type).toBe('render');
      expect(state.agents[key].log[0].content).toBe('# Heading\n\nrendered markdown');
      expect(state.agents[key].log[0].timestamp).toBe('2026-06-16T12:00:00Z');
      // id derived from event seq: workflow_started=1, agent_spawned=2, agent_rendered=3
      expect(state.agents[key].log[0].id).toBe('log-3');
    });

    it('is a no-op when the agent is not found', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const before = state;
      state = evolve(
        state,
        makeEvent(
          'agent_rendered',
          { rendered: 'orphan render' },
          { timestamp: new Date().toISOString(), agentId: 'ghost' },
        ),
      );
      // No agents were created
      expect(Object.keys(state.agents)).toHaveLength(0);
      // seq is bumped
      expect(state.seq).toBe(before.seq + 1);
      // A new top-level object is returned, but the agents map is unchanged
      expect(state).not.toBe(before);
      expect(state.agents).toBe(before.agents);
    });

    it('falls back to empty string when data.rendered is undefined', () => {
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
      state = evolve(state, makeEvent('agent_rendered', {}, { timestamp: new Date().toISOString(), agentId: 'a1' }));
      const agent = state.agents['a1'];
      expect(agent.log).toHaveLength(1);
      expect(agent.log[0].type).toBe('render');
      expect(agent.log[0].content).toBe('');
    });

    it('resolves the agent by agentId alone when taskId is omitted', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      // Spawn with a taskId so the key is 'a1::t1'
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );
      // Fire agent_rendered with ONLY agentId (no taskId) — resolveAgent must still find it
      state = evolve(
        state,
        makeEvent('agent_rendered', { rendered: 'resolved' }, { timestamp: new Date().toISOString(), agentId: 'a1' }),
      );
      const key = 'a1::t1';
      expect(state.agents[key].log).toHaveLength(1);
      expect(state.agents[key].log[0].type).toBe('render');
      expect(state.agents[key].log[0].content).toBe('resolved');
    });

    it('does not mutate the previous state (immutability)', () => {
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
      const prevLog = state.agents['a1'].log;
      const next = evolve(
        state,
        makeEvent('agent_rendered', { rendered: 'r1' }, { timestamp: new Date().toISOString(), agentId: 'a1' }),
      );
      // Previous state's log is untouched
      expect(state.agents['a1'].log).toBe(prevLog);
      expect(state.agents['a1'].log).toHaveLength(0);
      // New state has a distinct log array with the appended entry
      expect(next.agents['a1'].log).not.toBe(prevLog);
      expect(next.agents['a1'].log).toHaveLength(1);
      // The agent object itself is replaced (not mutated in place)
      expect(next.agents['a1']).not.toBe(state.agents['a1']);
    });

    it('accumulates multiple render entries in insertion order', () => {
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
        makeEvent('agent_rendered', { rendered: 'first' }, { timestamp: new Date().toISOString(), agentId: 'a1' }),
      );
      state = evolve(
        state,
        makeEvent('agent_rendered', { rendered: 'second' }, { timestamp: new Date().toISOString(), agentId: 'a1' }),
      );
      state = evolve(
        state,
        makeEvent('agent_rendered', { rendered: 'third' }, { timestamp: new Date().toISOString(), agentId: 'a1' }),
      );
      const log = state.agents['a1'].log;
      expect(log).toHaveLength(3);
      expect(log.map((e) => e.content)).toEqual(['first', 'second', 'third']);
      expect(log.every((e) => e.type === 'render')).toBe(true);
    });
  });

  describe('sidebar_updated', () => {
    it('merges sidebar fields (title, indicator only)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent('sidebar_updated', {
          title: 'My Workflow',
          indicator: 'Building…',
        }),
      );
      expect(state.sidebar.title).toBe('My Workflow');
      expect(state.sidebar.indicator).toBe('Building…');
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
        completedPhaseIds: [...state.completedPhaseIds],
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
          { timestamp: new Date().toISOString(), phaseId: 'implementing' },
        ),
      );
      state = evolve(state, makeEvent('workflow_failed', { error: 'Kaboom', phaseId: 'implementing' }));
      expect(state.status).toBe('failed');
      expect(state.error).toBe('Kaboom');
      expect(state.failedPhase).toBe('implementing');
    });

    it('falls back to phase for backward compat', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_started', { phase: 'scouting', round: 1 }));
      state = evolve(state, makeEvent('workflow_failed', { error: 'Boom', phase: 'scouting' }));
      expect(state.failedPhase).toBe('scouting');
    });
  });

  describe('log', () => {
    it('appends a LogEntry to the projection runLog', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent('log', { level: 'info', message: 'server booted' }, { timestamp: '2026-06-15T00:00:00Z' }),
      );
      expect(state.runLog).toHaveLength(1);
      expect(state.runLog[0].content).toBe('server booted');
      expect(state.runLog[0].timestamp).toBe('2026-06-15T00:00:00Z');
      // id is derived from the event seq (workflow_started=1, log=2)
      expect(state.runLog[0].id).toBe('log-2');
    });

    it('maps level "error" to LogEntry type "error"', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('log', { level: 'error', message: 'kaboom' }));
      expect(state.runLog[0].type).toBe('error');
      expect(state.runLog[0].content).toBe('kaboom');
    });

    it('maps level "warn" to LogEntry type "text"', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('log', { level: 'warn', message: 'careful' }));
      expect(state.runLog[0].type).toBe('text');
    });

    it('maps level "info" to LogEntry type "text"', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('log', { level: 'info', message: 'hello' }));
      expect(state.runLog[0].type).toBe('text');
    });

    it('preserves insertion order across multiple log events', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('log', { level: 'info', message: 'first' }));
      state = evolve(state, makeEvent('log', { level: 'error', message: 'second' }));
      state = evolve(state, makeEvent('log', { level: 'info', message: 'third' }));
      expect(state.runLog.map((e) => e.content)).toEqual(['first', 'second', 'third']);
      expect(state.runLog.map((e) => e.type)).toEqual(['text', 'error', 'text']);
    });

    it('is immutable: does not mutate the previous state runLog', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const prevRunLog = state.runLog;
      const next = evolve(state, makeEvent('log', { level: 'info', message: 'hi' }));
      expect(state.runLog).toBe(prevRunLog);
      expect(state.runLog).toHaveLength(0);
      expect(next.runLog).not.toBe(state.runLog);
      expect(next.runLog).toHaveLength(1);
    });

    it('caps runLog at MAX_RUN_LOG, dropping the oldest entries', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const overflow = 5;
      for (let i = 0; i < MAX_RUN_LOG + overflow; i++) {
        state = evolve(state, makeEvent('log', { level: 'info', message: `m-${i}` }));
      }
      expect(state.runLog).toHaveLength(MAX_RUN_LOG);
      // The first `overflow` messages should have been dropped.
      expect(state.runLog[0].content).toBe(`m-${overflow}`);
      expect(state.runLog[state.runLog.length - 1].content).toBe(`m-${MAX_RUN_LOG + overflow - 1}`);
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

  describe('auto_retry_started', () => {
    it('appends a text log entry with retry details to the resolved agent', () => {
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
          'auto_retry_started',
          { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );

      const key = 'a1::t1';
      expect(state.agents[key].log).toHaveLength(1);
      expect(state.agents[key].log[0].type).toBe('text');
      // formatDuration(2000) → '2s' (≥1000ms renders as seconds)
      expect(state.agents[key].log[0].content).toBe('Retrying (attempt 1/3) in 2s: overloaded');
      expect(state.agents[key].log[0].id).toBe(`log-${eventSeq}`);
      expect(state.agents[key].log[0].metadata).toEqual({
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: 'overloaded',
      });
    });

    it('omits errorMessage when not provided', () => {
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
          'auto_retry_started',
          { attempt: 2, maxAttempts: 5, delayMs: 1000 },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      const agent = state.agents['a1'];
      expect(agent.log).toHaveLength(1);
      // formatDuration(1000) → '1s' (≥1000ms renders as seconds)
      expect(agent.log[0].content).toBe('Retrying (attempt 2/5) in 1s');
      expect(agent.log[0].metadata).toEqual({ attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: '' });
    });

    it('bumps seq', () => {
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
      const seqBefore = state.seq;
      state = evolve(
        state,
        makeEvent(
          'auto_retry_started',
          { attempt: 1, maxAttempts: 3, delayMs: 500 },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      expect(state.seq).toBe(seqBefore + 1);
    });

    it('is a no-op when agentId is missing (no throw)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const before = state;
      state = evolve(
        state,
        makeEvent(
          'auto_retry_started',
          { attempt: 1, maxAttempts: 3, delayMs: 500 },
          { timestamp: new Date().toISOString() }, // no agentId
        ),
      );
      expect(state.agents).toEqual(before.agents);
      expect(state.seq).toBe(before.seq + 1);
    });

    it('is a no-op when agent does not exist (no throw)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'auto_retry_started',
          { attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: 'err' },
          { timestamp: new Date().toISOString(), agentId: 'ghost' },
        ),
      );
      expect(Object.keys(state.agents)).toHaveLength(0);
    });

    it('resolves the agent by agentId when taskId is omitted from metadata', () => {
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

      // Fire with only agentId (no taskId) — resolveAgent fallback must find it
      state = evolve(
        state,
        makeEvent(
          'auto_retry_started',
          { attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: 'err' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      const key = 'a1::t1';
      expect(state.agents[key].log).toHaveLength(1);
      expect(state.agents[key].log[0].content).toContain('Retrying');
    });
  });

  describe('auto_retry_completed', () => {
    it('appends a text log entry on success', () => {
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
          'auto_retry_completed',
          { success: true, attempt: 1 },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );

      const key = 'a1::t1';
      expect(state.agents[key].log).toHaveLength(1);
      expect(state.agents[key].log[0].type).toBe('text');
      expect(state.agents[key].log[0].content).toBe('Retry succeeded');
      expect(state.agents[key].log[0].id).toBe(`log-${eventSeq}`);
      expect(state.agents[key].log[0].metadata).toEqual({ success: true, attempt: 1, finalError: '' });
    });

    it('appends a single error log entry on failure', () => {
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
          'auto_retry_completed',
          { success: false, attempt: 3, finalError: 'giving up' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );

      const key = 'a1::t1';
      expect(state.agents[key].log).toHaveLength(1);
      // Single error entry — the error type IS the signal clients flag on
      expect(state.agents[key].log[0].type).toBe('error');
      expect(state.agents[key].log[0].content).toBe('Retry failed: giving up');
      expect(state.agents[key].log[0].metadata).toEqual({ success: false, attempt: 3, finalError: 'giving up' });
    });

    it('failure with no finalError still appends a single error entry with empty message', () => {
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
          'auto_retry_completed',
          { success: false, attempt: 1 },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      const agent = state.agents['a1'];
      expect(agent.log).toHaveLength(1);
      expect(agent.log[0].type).toBe('error');
      expect(agent.log[0].content).toBe('Retry failed: ');
    });

    it('bumps seq', () => {
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
      const seqBefore = state.seq;
      state = evolve(
        state,
        makeEvent(
          'auto_retry_completed',
          { success: true, attempt: 1 },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      expect(state.seq).toBe(seqBefore + 1);
    });

    it('is a no-op when agentId is missing (no throw)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const before = state;
      state = evolve(
        state,
        makeEvent(
          'auto_retry_completed',
          { success: true, attempt: 1 },
          { timestamp: new Date().toISOString() }, // no agentId
        ),
      );
      expect(state.agents).toEqual(before.agents);
      expect(state.seq).toBe(before.seq + 1);
    });

    it('is a no-op when agent does not exist (no throw)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'auto_retry_completed',
          { success: false, attempt: 3, finalError: 'err' },
          { timestamp: new Date().toISOString(), agentId: 'ghost' },
        ),
      );
      expect(Object.keys(state.agents)).toHaveLength(0);
    });
  });

  describe('auto_retry end-to-end', () => {
    it('workflow_started -> agent_spawned -> auto_retry_started -> auto_retry_completed: seq increments, two log entries on agent', () => {
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
      expect(state.stats.agentCount).toBe(1);

      state = evolve(
        state,
        makeEvent(
          'auto_retry_started',
          { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      state = evolve(
        state,
        makeEvent(
          'auto_retry_completed',
          { success: true, attempt: 1 },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      const agent = state.agents['a1'];
      expect(state.seq).toBe(4); // workflow_started=1, agent_spawned=2, retry_started=3, retry_completed=4
      expect(agent.log).toHaveLength(2);
      expect(agent.log[0].type).toBe('text');
      // formatDuration(2000) → '2s' (≥1000ms renders as seconds)
      expect(agent.log[0].content).toBe('Retrying (attempt 1/3) in 2s: overloaded');
      expect(agent.log[0].metadata).toEqual({ attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' });
      expect(agent.log[1].type).toBe('text');
      expect(agent.log[1].content).toBe('Retry succeeded');
      expect(agent.log[1].metadata).toEqual({ success: true, attempt: 1, finalError: '' });
    });

    it('auto_retry_completed with success=false pushes a single error entry', () => {
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
          'auto_retry_completed',
          { success: false, attempt: 3, finalError: 'giving up' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      const agent = state.agents['a1'];
      expect(agent.log).toHaveLength(1);
      expect(agent.log[0].type).toBe('error');
      expect(agent.log[0].content).toBe('Retry failed: giving up');
    });

    it('log entries are capped at MAX_AGENT_LOG', () => {
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

      // Fill agent log to near capacity with decision events
      for (let i = 0; i < 499; i++) {
        state = evolve(
          state,
          makeEvent(
            'decision',
            { decision: `d-${i}`, reasoning: '' },
            { timestamp: new Date().toISOString(), agentId: 'a1' },
          ),
        );
      }
      expect(state.agents['a1'].log).toHaveLength(499);

      // auto_retry_started pushes to 500 (at cap)
      state = evolve(
        state,
        makeEvent(
          'auto_retry_started',
          { attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'err' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      expect(state.agents['a1'].log).toHaveLength(500);

      // auto_retry_completed (success=false) pushes 1 entry → cap drops 1 oldest
      state = evolve(
        state,
        makeEvent(
          'auto_retry_completed',
          { success: false, attempt: 1, finalError: 'fatal' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      expect(state.agents['a1'].log).toHaveLength(500);
      // The oldest entry from the decision series (d-0) was dropped;
      // the remaining should start at d-1
      expect(state.agents['a1'].log[0].content).toBe('d-1');
    });
  });

  describe('decision regression', () => {
    it('decision event still appends as before after auto_retry events exist', () => {
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

      // Fire auto_retry_started
      state = evolve(
        state,
        makeEvent(
          'auto_retry_started',
          { attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: 'timeout' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      // Fire auto_retry_completed
      state = evolve(
        state,
        makeEvent(
          'auto_retry_completed',
          { success: true, attempt: 1 },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      // Now fire a decision — must still work as before
      state = evolve(
        state,
        makeEvent(
          'decision',
          { decision: 'use module pattern', reasoning: 'cleaner architecture' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      const agent = state.agents['a1'];
      expect(agent.log).toHaveLength(3); // retry_started text + retry_completed text + decision
      expect(agent.log[0].type).toBe('text');
      expect(agent.log[0].content).toContain('Retrying');
      expect(agent.log[1].type).toBe('text');
      expect(agent.log[1].content).toBe('Retry succeeded');
      expect(agent.log[2].type).toBe('decision');
      expect(agent.log[2].content).toBe('use module pattern');
    });
  });

  describe('multi-event sequence', () => {
    it('phase_registered → task_registered → task_started → step_started → agent_spawned → decision → tool_call → turn_end → task_completed → agent_completed → verify final state', () => {
      resetSeq();
      let state = createInitialProjection();

      // 1. workflow_started
      state = evolve(
        state,
        makeEvent('workflow_started', { taskPrompt: 'Build auth module', resumed: false, workDir: '/tmp/proj' }),
      );
      expect(state.taskPrompt).toBe('Build auth module');
      expect(state.status).toBe('running');

      // 2. phase_registered
      state = evolve(state, makeEvent('phase_registered', { id: 'implementing', label: 'Implementing', icon: '🔧' }));
      expect(state.phases).toHaveLength(1);
      expect(state.phases[0].id).toBe('implementing');

      // 3. phase_started
      state = evolve(
        state,
        makeEvent(
          'phase_started',
          { phase: 'implementing', round: 1 },
          { timestamp: new Date().toISOString(), phaseId: 'implementing' },
        ),
      );
      expect(state.currentPhaseId).toBe('implementing');

      // 4. task_registered
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Auth handler',
          phaseId: 'implementing',
          steps: [
            { name: 'analyze', profileId: 'scout', isReadOnly: true },
            { name: 'implement', profileId: 'coder', isReadOnly: false },
          ],
          dependencies: [],
        }),
      );
      expect(state.tasks['t1'].title).toBe('Auth handler');
      expect(state.tasks['t1'].status).toBe('ready');
      expect(state.tasks['t1'].steps).toHaveLength(2);

      // 5. task_started
      state = evolve(
        state,
        makeEvent(
          'task_started',
          { taskId: 't1', title: 'Auth handler', agentId: 'coder-1', startedAt: Date.now() },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].status).toBe('active');

      // 6. step_started (step 0)
      state = evolve(
        state,
        makeEvent(
          'step_started',
          { taskId: 't1', stepIndex: 0, stepName: 'analyze' },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].activeStepIndex).toBe(0);

      // 7. agent_spawned (for step 1)
      state = evolve(
        state,
        makeEvent(
          'agent_spawned',
          { agentId: 'coder-1', profile: 'coder', sessionId: 'sess-abc', sessionPath: '/sessions/abc' },
          {
            timestamp: new Date().toISOString(),
            agentId: 'coder-1',
            taskId: 't1',
            stepIndex: 1,
            phaseId: 'implementing',
          },
        ),
      );
      expect(state.agents['coder-1::t1::1']).toBeDefined();
      expect(state.agents['coder-1::t1::1'].active).toBe(true);
      expect(state.agents['coder-1::t1::1'].stepIndex).toBe(1);
      // Task step should be linked
      expect(state.tasks['t1'].steps[1].agentKey).toBe('coder-1::t1::1');

      // 8. step_started (step 1) — also links agentKey
      state = evolve(
        state,
        makeEvent(
          'step_started',
          { taskId: 't1', stepIndex: 1, stepName: 'implement' },
          { timestamp: new Date().toISOString(), taskId: 't1', agentId: 'coder-1' },
        ),
      );
      expect(state.tasks['t1'].activeStepIndex).toBe(1);

      // 9. decision
      state = evolve(
        state,
        makeEvent(
          'decision',
          { decision: 'Use JWT tokens', reasoning: 'Stateless and scalable' },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1' },
        ),
      );

      // 10. tool_call_started
      state = evolve(
        state,
        makeEvent(
          'tool_call_started',
          { toolName: 'write', toolCallId: 'tc-w1', arguments: { path: 'auth.ts' } },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1' },
        ),
      );
      expect(state.agents['coder-1::t1::1'].toolCallCount).toBe(1);

      // 11. tool_call_ended
      state = evolve(
        state,
        makeEvent(
          'tool_call_ended',
          { toolName: 'write', toolCallId: 'tc-w1', isError: false },
          { timestamp: new Date().toISOString(), agentId: 'coder-1' },
        ),
      );

      // 12. turn_ended with tokens
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
      // turn_ended has no taskId/stepIndex metadata, resolveAgent falls back to active search
      expect(state.agents['coder-1::t1::1'].inputTokens).toBe(200);
      expect(state.agents['coder-1::t1::1'].outputTokens).toBe(100);
      expect(state.stats.totalTokens).toBe(300);

      // 13. task_completed
      state = evolve(
        state,
        makeEvent(
          'task_completed',
          { taskId: 't1', title: 'Auth handler' },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].status).toBe('complete');

      // 14. agent_completed
      state = evolve(
        state,
        makeEvent(
          'agent_completed',
          { agentId: 'coder-1', profile: 'coder', sessionId: 'sess-abc' },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1' },
        ),
      );
      // agent_completed has no stepIndex in metadata; resolveAgent falls back to active search
      expect(state.agents['coder-1::t1::1'].active).toBe(false);
      expect(state.agents['coder-1::t1::1'].completedAt).toBeDefined();

      // 15. phase_completed
      state = evolve(
        state,
        makeEvent(
          'phase_completed',
          { phase: 'implementing', durationMs: 3000 },
          { timestamp: new Date().toISOString(), phaseId: 'implementing' },
        ),
      );
      expect(state.completedPhaseIds).toEqual(['implementing']);

      // 16. workflow_completed
      state = evolve(state, makeEvent('workflow_completed', { totalDurationMs: 5000, agentCount: 1 }));
      expect(state.status).toBe('complete');

      // Final verification
      expect(state.taskPrompt).toBe('Build auth module');
      expect(state.currentPhaseId).toBe('implementing');
      expect(state.completedPhaseIds).toEqual(['implementing']);
      expect(Object.keys(state.tasks)).toEqual(['t1']);
      expect(Object.keys(state.agents)).toEqual(['coder-1::t1::1']);
      expect(state.stats.totalTokens).toBe(300);
      expect(state.stats.agentCount).toBe(1);
      expect(state.agents['coder-1::t1::1'].log.length).toBeGreaterThanOrEqual(3); // decision + tool_call_start + tool_call_end + text
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
