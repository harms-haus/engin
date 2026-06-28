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

  describe('session_started', () => {
    it('inserts an SessionEntity keyed by agentId::taskId', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'agent-1', profile: 'coder', sessionId: 'sess-1', sessionPath: '/tmp/sess' },
          { timestamp: new Date().toISOString(), agentId: 'agent-1', taskId: 'task-1', phaseId: 'impl' },
        ),
      );
      const key = 'agent-1::task-1';
      expect(state.sessions[key]).toBeDefined();
      expect(state.sessions[key].agentId).toBe('agent-1');
      expect(state.sessions[key].profile).toBe('coder');
      expect(state.sessions[key].phaseId).toBe('impl');
      expect(state.sessions[key].taskId).toBe('task-1');
      expect(state.sessions[key].sessionId).toBe('sess-1');
      expect(state.sessions[key].active).toBe(true);
      expect(state.sessions[key].log).toEqual([]);
      expect(state.sessions[key].toolCallCount).toBe(0);
      expect(state.stats.sessionCount).toBe(1);
    });

    it('uses agentId as key when no taskId', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'agent-2', profile: 'scout' },
          { timestamp: new Date().toISOString(), agentId: 'agent-2' },
        ),
      );
      expect(state.sessions['agent-2']).toBeDefined();
      expect(state.sessions['agent-2'].uid).toBe('agent-2');
    });

    it('re-spawn preserves accumulated log/tokens/toolCallCount (upsert)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // First spawn
      state = evolve(
        state,
        makeEvent(
          'session_started',
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
      expect(state.sessions[key].log).toHaveLength(2); // text + tool_call_start
      expect(state.sessions[key].inputTokens).toBe(200);
      expect(state.sessions[key].outputTokens).toBe(100);
      expect(state.sessions[key].toolCallCount).toBe(1);
      expect(state.stats.sessionCount).toBe(1);

      // Re-spawn same agent (same key)
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder-v2' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );

      // Accumulated state must be preserved
      expect(state.sessions[key].log).toHaveLength(2);
      expect(state.sessions[key].inputTokens).toBe(200);
      expect(state.sessions[key].outputTokens).toBe(100);
      expect(state.sessions[key].toolCallCount).toBe(1);
      expect(state.sessions[key].active).toBe(true);
      // Metadata updated
      expect(state.sessions[key].profile).toBe('coder-v2');
      // sessionCount must NOT double-count
      expect(state.stats.sessionCount).toBe(1);
    });

    // step-index-based functionality removed in C1
    // (session keys no longer include stepIndex)

    // step-index-based independent agent entities removed in C1 —
    // session keys no longer include stepIndex; same agentId+taskId
    // produces the same key (upsert behavior).

    // step-index-based coalescing removed in C1 —
    // session keys no longer include stepIndex; all events for the same
    // agentId+taskId route to a single session entity.

    // step-index-based re-spawn removed in C1 — the shared parity fixture
    // 'agent_spawned re-spawn preserves accumulated log/tokens/toolCallCount'
    // covers the upsert behavior without stepIndex.

    it('resolveSession finds active session when only agentId is available', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // Register a phase and a task
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Phase 1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          dependencies: [],
        }),
      );

      // Spawn agent, then complete it
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'scout' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );
      state = evolve(
        state,
        makeEvent('session_completed', {}, { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' }),
      );

      // Re-spawn agent (active)
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );

      // Now resolveSession with only agentId (no taskId) should find the active one
      // We'll verify by firing a decision event which uses resolveSession internally
      state = evolve(
        state,
        makeEvent(
          'decision',
          { decision: 'use latest', reasoning: '' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );

      // The decision should go to the active session
      const key = 'a1::t1';
      expect(state.sessions[key].log).toHaveLength(1);
      expect(state.sessions[key].log[0].content).toBe('use latest');
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
          'session_started',
          { agentId: 'a1', profile: 'coder', contextWindow: 200000 },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.sessions[key].contextWindow).toBe(200000);
      expect(state.sessions[key].startedAt).toBe('2026-06-18T10:00:00Z');
    });

    it('re-spawn preserves startedAt from the first spawn while updating contextWindow', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // First spawn
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder', contextWindow: 100000 },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.sessions[key].startedAt).toBe('2026-06-18T10:00:00Z');
      expect(state.sessions[key].contextWindow).toBe(100000);

      // Re-spawn the same key: newer contextWindow, newer timestamp
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder-v2', contextWindow: 200000 },
          { timestamp: '2026-06-18T11:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );

      // startedAt must NOT be overwritten by the later timestamp
      expect(state.sessions[key].startedAt).toBe('2026-06-18T10:00:00Z');
      // contextWindow must reflect the incoming value
      expect(state.sessions[key].contextWindow).toBe(200000);
      // profile still updates (UPSERT metadata)
      expect(state.sessions[key].profile).toBe('coder-v2');
      // sessionCount must NOT double-count
      expect(state.stats.sessionCount).toBe(1);
    });

    it('fresh spawn without data.contextWindow leaves contextWindow undefined but still stamps startedAt', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder' }, // no contextWindow
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.sessions[key].contextWindow).toBeUndefined();
      expect(state.sessions[key].startedAt).toBe('2026-06-18T10:00:00Z');
    });

    it('re-spawn without data.contextWindow preserves the existing contextWindow', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      // First spawn sets contextWindow
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder', contextWindow: 200000 },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.sessions[key].contextWindow).toBe(200000);

      // Re-spawn omits contextWindow → must fall back to the existing value
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder-v2' },
          { timestamp: '2026-06-18T11:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      expect(state.sessions[key].contextWindow).toBe(200000);
      // startedAt still preserved from first spawn
      expect(state.sessions[key].startedAt).toBe('2026-06-18T10:00:00Z');
    });

    it('sets contextWindow and startedAt for a session key (agentId::taskId)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'Phase 1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          dependencies: [],
        }),
      );

      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'lane-0', profile: 'coder', contextWindow: 150000 },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'lane-0', taskId: 't1' },
        ),
      );
      const key = 'lane-0::t1';
      expect(state.sessions[key].contextWindow).toBe(150000);
      expect(state.sessions[key].startedAt).toBe('2026-06-18T10:00:00Z');

      // Re-spawn same key: startedAt preserved, contextWindow updated
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'lane-0', profile: 'coder-v2', contextWindow: 250000 },
          { timestamp: '2026-06-18T12:00:00Z', agentId: 'lane-0', taskId: 't1' },
        ),
      );
      expect(state.sessions[key].startedAt).toBe('2026-06-18T10:00:00Z');
      expect(state.sessions[key].contextWindow).toBe(250000);
      expect(state.stats.sessionCount).toBe(1);
    });

    it('coerces non-number contextWindow defensively on fresh spawn (falls back to undefined)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      // A non-number contextWindow should be ignored → undefined on fresh entity
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder', contextWindow: 'big' },
          { timestamp: '2026-06-18T10:00:00Z', agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.sessions[key].contextWindow).toBeUndefined();
      expect(state.sessions[key].startedAt).toBe('2026-06-18T10:00:00Z');
    });
  });

  describe('session_completed', () => {
    it('sets active=false and completedAt', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );
      state = evolve(
        state,
        makeEvent(
          'session_completed',
          { agentId: 'a1', profile: 'coder', sessionId: 's1' },
          { timestamp: new Date().toISOString(), agentId: 'a1', taskId: 't1' },
        ),
      );
      const key = 'a1::t1';
      expect(state.sessions[key].active).toBe(false);
      expect(state.sessions[key].completedAt).toBeDefined();
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
          dependencies: ['t0'],
        }),
      );

      expect(state.tasks['t1']).toBeDefined();
      expect(state.tasks['t1'].title).toBe('Do thing');
      expect(state.tasks['t1'].phaseId).toBe('p1');
      expect(state.tasks['t1'].status).toBe('ready');
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
        makeEvent('task_registered', { taskId: 't1', title: 'First', phaseId: 'p1', dependencies: [] }),
      );
      state = evolve(
        state,
        makeEvent('task_registered', { taskId: 't1', title: 'Second', phaseId: 'p1', dependencies: [] }),
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

  describe('task_parked', () => {
    it('sets status to parked when task exists', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          dependencies: [],
        }),
      );
      state = evolve(
        state,
        makeEvent(
          'task_parked',
          { taskId: 't1', reason: 'Waiting for upstream' },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].status).toBe('parked');
      expect(state.tasks['t1'].title).toBe('Do thing'); // other fields preserved
    });

    it('no-op when task does not exist (seq bumped)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const before = state;
      state = evolve(
        state,
        makeEvent(
          'task_parked',
          { taskId: 'nonexistent', reason: 'Nope' },
          { timestamp: new Date().toISOString(), taskId: 'nonexistent' },
        ),
      );
      expect(state.tasks).toEqual({});
      expect(state.seq).toBe(before.seq + 1);
    });
  });

  describe('task_unparked', () => {
    it('sets status to active when task exists', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
      state = evolve(
        state,
        makeEvent('task_registered', {
          taskId: 't1',
          title: 'Do thing',
          phaseId: 'p1',
          dependencies: [],
        }),
      );
      // First park it
      state = evolve(
        state,
        makeEvent(
          'task_parked',
          { taskId: 't1', reason: 'Blocked' },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].status).toBe('parked');
      // Now unpark
      state = evolve(
        state,
        makeEvent(
          'task_unparked',
          { taskId: 't1', reason: 'Dependency resolved' },
          { timestamp: new Date().toISOString(), taskId: 't1' },
        ),
      );
      expect(state.tasks['t1'].status).toBe('active');
      expect(state.tasks['t1'].title).toBe('Do thing'); // other fields preserved
    });

    it('no-op when task does not exist (seq bumped)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const before = state;
      state = evolve(
        state,
        makeEvent(
          'task_unparked',
          { taskId: 'nonexistent' },
          { timestamp: new Date().toISOString(), taskId: 'nonexistent' },
        ),
      );
      expect(state.tasks).toEqual({});
      expect(state.seq).toBe(before.seq + 1);
    });
  });

  describe('decision', () => {
    it('appends a LogEntry to the agent log', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
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
      expect(state.sessions[key].log).toHaveLength(1);
      expect(state.sessions[key].log[0].type).toBe('decision');
      expect(state.sessions[key].log[0].content).toBe('use React');
    });
  });

  describe('error', () => {
    it('appends an error LogEntry to the agent log', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      state = evolve(
        state,
        makeEvent('error', { error: 'something broke' }, { timestamp: new Date().toISOString(), agentId: 'a1' }),
      );
      const key = 'a1';
      expect(state.sessions[key].log).toHaveLength(1);
      expect(state.sessions[key].log[0].type).toBe('error');
      expect(state.sessions[key].log[0].content).toBe('something broke');
    });
  });

  describe('agent_rendered', () => {
    it('appends a render LogEntry to the agent log', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
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
      expect(state.sessions[key].log).toHaveLength(1);
      expect(state.sessions[key].log[0].type).toBe('render');
      expect(state.sessions[key].log[0].content).toBe('# Heading\n\nrendered markdown');
      expect(state.sessions[key].log[0].timestamp).toBe('2026-06-16T12:00:00Z');
      // id derived from event seq: workflow_started=1, agent_spawned=2, agent_rendered=3
      expect(state.sessions[key].log[0].id).toBe('log-3');
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
      // No sessions were created
      expect(Object.keys(state.sessions)).toHaveLength(0);
      // seq is bumped
      expect(state.seq).toBe(before.seq + 1);
      // A new top-level object is returned, but the sessions map is unchanged
      expect(state).not.toBe(before);
      expect(state.sessions).toBe(before.sessions);
    });

    it('falls back to empty string when data.rendered is undefined', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      state = evolve(state, makeEvent('agent_rendered', {}, { timestamp: new Date().toISOString(), agentId: 'a1' }));
      const agent = state.sessions['a1'];
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
          'session_started',
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
      expect(state.sessions[key].log).toHaveLength(1);
      expect(state.sessions[key].log[0].type).toBe('render');
      expect(state.sessions[key].log[0].content).toBe('resolved');
    });

    it('does not mutate the previous state (immutability)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      const prevLog = state.sessions['a1'].log;
      const next = evolve(
        state,
        makeEvent('agent_rendered', { rendered: 'r1' }, { timestamp: new Date().toISOString(), agentId: 'a1' }),
      );
      // Previous state's log is untouched
      expect(state.sessions['a1'].log).toBe(prevLog);
      expect(state.sessions['a1'].log).toHaveLength(0);
      // New state has a distinct log array with the appended entry
      expect(next.sessions['a1'].log).not.toBe(prevLog);
      expect(next.sessions['a1'].log).toHaveLength(1);
      // The agent object itself is replaced (not mutated in place)
      expect(next.sessions['a1']).not.toBe(state.sessions['a1']);
    });

    it('accumulates multiple render entries in insertion order', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
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
      const log = state.sessions['a1'].log;
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

  describe('workflow_data_set', () => {
    it('merges event.data into state.workflowData', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent('workflow_data_set', { key: 'value', number: 42 }, { timestamp: new Date().toISOString() }),
      );
      expect(state.workflowData).toEqual({ key: 'value', number: 42 });
    });

    it('accumulates data across multiple events', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent('workflow_data_set', { key: 'value', number: 42 }, { timestamp: new Date().toISOString() }),
      );
      state = evolve(
        state,
        makeEvent('workflow_data_set', { another: 'data', number: 99 }, { timestamp: new Date().toISOString() }),
      );
      expect(state.workflowData).toEqual({ key: 'value', another: 'data', number: 99 });
    });

    it('starts with undefined workflowData when no event fired', () => {
      resetSeq();
      const state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      expect(state.workflowData).toBeUndefined();
    });

    it('merges even when workflowData was undefined', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      expect(state.workflowData).toBeUndefined();
      state = evolve(
        state,
        makeEvent('workflow_data_set', { first: 'entry' }, { timestamp: new Date().toISOString() }),
      );
      expect(state.workflowData).toEqual({ first: 'entry' });
    });

    it('bumps seq', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const before = state;
      state = evolve(state, makeEvent('workflow_data_set', { key: 'val' }, { timestamp: new Date().toISOString() }));
      expect(state.seq).toBe(before.seq + 1);
    });
  });

  describe('turn_started', () => {
    it('is a no-op (returns new object with same content)', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      const before = {
        ...state,
        tasks: { ...state.tasks },
        sessions: { ...state.sessions },
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
          'session_started',
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
      const agent = state.sessions['a1'];
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
          'session_started',
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
      const agent = state.sessions['a1'];
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
          'session_started',
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
      const agent = state.sessions['a1'];
      expect(agent.log).toHaveLength(1);
      expect(agent.log[0].type).toBe('tool_call_end');
      expect(agent.log[0].metadata).toEqual({ toolName: 'bash', toolCallId: 'tc-1', isError: false });
    });
  });

  describe('workflow_completed', () => {
    it('sets status to complete', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(state, makeEvent('workflow_completed', { totalDurationMs: 5000, sessionCount: 3 }));
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
          'session_started',
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

      const agent = state.sessions['a1'];
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
          'session_started',
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
      expect(state.sessions[key].log).toHaveLength(1);
      expect(state.sessions[key].log[0].type).toBe('text');
      // formatDuration(2000) → '2s' (≥1000ms renders as seconds)
      expect(state.sessions[key].log[0].content).toBe('Retrying (attempt 1/3) in 2s: overloaded');
      expect(state.sessions[key].log[0].id).toBe(`log-${eventSeq}`);
      expect(state.sessions[key].log[0].metadata).toEqual({
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
          'session_started',
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

      const agent = state.sessions['a1'];
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
          'session_started',
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
      expect(state.sessions).toEqual(before.sessions);
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
      expect(Object.keys(state.sessions)).toHaveLength(0);
    });

    it('resolves the agent by agentId when taskId is omitted from metadata', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
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
      expect(state.sessions[key].log).toHaveLength(1);
      expect(state.sessions[key].log[0].content).toContain('Retrying');
    });
  });

  describe('auto_retry_completed', () => {
    it('appends a text log entry on success', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
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
      expect(state.sessions[key].log).toHaveLength(1);
      expect(state.sessions[key].log[0].type).toBe('text');
      expect(state.sessions[key].log[0].content).toBe('Retry succeeded');
      expect(state.sessions[key].log[0].id).toBe(`log-${eventSeq}`);
      expect(state.sessions[key].log[0].metadata).toEqual({ success: true, attempt: 1, finalError: '' });
    });

    it('appends a single error log entry on failure', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
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
      expect(state.sessions[key].log).toHaveLength(1);
      // Single error entry — the error type IS the signal clients flag on
      expect(state.sessions[key].log[0].type).toBe('error');
      expect(state.sessions[key].log[0].content).toBe('Retry failed: giving up');
      expect(state.sessions[key].log[0].metadata).toEqual({ success: false, attempt: 3, finalError: 'giving up' });
    });

    it('failure with no finalError still appends a single error entry with empty message', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
      state = evolve(
        state,
        makeEvent(
          'session_started',
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

      const agent = state.sessions['a1'];
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
          'session_started',
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
      expect(state.sessions).toEqual(before.sessions);
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
      expect(Object.keys(state.sessions)).toHaveLength(0);
    });
  });

  describe('auto_retry end-to-end', () => {
    it('workflow_started -> agent_spawned -> auto_retry_started -> auto_retry_completed: seq increments, two log entries on agent', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'a1', profile: 'coder' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      expect(state.stats.sessionCount).toBe(1);

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

      const agent = state.sessions['a1'];
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
          'session_started',
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

      const agent = state.sessions['a1'];
      expect(agent.log).toHaveLength(1);
      expect(agent.log[0].type).toBe('error');
      expect(agent.log[0].content).toBe('Retry failed: giving up');
    });

    it('log entries are capped at MAX_SESSION_LOG', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      state = evolve(
        state,
        makeEvent(
          'session_started',
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
      expect(state.sessions['a1'].log).toHaveLength(499);

      // auto_retry_started pushes to 500 (at cap)
      state = evolve(
        state,
        makeEvent(
          'auto_retry_started',
          { attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'err' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      expect(state.sessions['a1'].log).toHaveLength(500);

      // auto_retry_completed (success=false) pushes 1 entry → cap drops 1 oldest
      state = evolve(
        state,
        makeEvent(
          'auto_retry_completed',
          { success: false, attempt: 1, finalError: 'fatal' },
          { timestamp: new Date().toISOString(), agentId: 'a1' },
        ),
      );
      expect(state.sessions['a1'].log).toHaveLength(500);
      // The oldest entry from the decision series (d-0) was dropped;
      // the remaining should start at d-1
      expect(state.sessions['a1'].log[0].content).toBe('d-1');
    });
  });

  describe('decision regression', () => {
    it('decision event still appends as before after auto_retry events exist', () => {
      resetSeq();
      let state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));

      state = evolve(
        state,
        makeEvent(
          'session_started',
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

      const agent = state.sessions['a1'];
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
          dependencies: [],
        }),
      );
      expect(state.tasks['t1'].title).toBe('Auth handler');
      expect(state.tasks['t1'].status).toBe('ready');

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
      state = evolve(state, makeEvent('sidebar_updated', {}, { timestamp: new Date().toISOString() }));

      // 7. agent_spawned (for step 1)
      state = evolve(
        state,
        makeEvent(
          'session_started',
          { agentId: 'coder-1', profile: 'coder', sessionId: 'sess-abc', sessionPath: '/sessions/abc' },
          {
            timestamp: new Date().toISOString(),
            agentId: 'coder-1',
            taskId: 't1',
            phaseId: 'implementing',
          },
        ),
      );
      expect(state.sessions['coder-1::t1']).toBeDefined();
      expect(state.sessions['coder-1::t1'].active).toBe(true);
      // Task step should be linked

      // 8. step_started (step 1) — also links agentKey
      state = evolve(state, makeEvent('sidebar_updated', {}, { timestamp: new Date().toISOString() }));

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
      expect(state.sessions['coder-1::t1'].toolCallCount).toBe(1);

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
      // turn_ended has no taskId metadata; resolveSession falls back to active search
      expect(state.sessions['coder-1::t1'].inputTokens).toBe(200);
      expect(state.sessions['coder-1::t1'].outputTokens).toBe(100);
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
          'session_completed',
          { agentId: 'coder-1', profile: 'coder', sessionId: 'sess-abc' },
          { timestamp: new Date().toISOString(), agentId: 'coder-1', taskId: 't1' },
        ),
      );
      // session_completed has no taskId in metadata; resolveSession falls back to active search
      expect(state.sessions['coder-1::t1'].active).toBe(false);
      expect(state.sessions['coder-1::t1'].completedAt).toBeDefined();

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
      state = evolve(state, makeEvent('workflow_completed', { totalDurationMs: 5000, sessionCount: 1 }));
      expect(state.status).toBe('complete');

      // Final verification
      expect(state.taskPrompt).toBe('Build auth module');
      expect(state.currentPhaseId).toBe('implementing');
      expect(state.completedPhaseIds).toEqual(['implementing']);
      expect(Object.keys(state.tasks)).toEqual(['t1']);
      expect(Object.keys(state.sessions)).toEqual(['coder-1::t1']);
      expect(state.stats.totalTokens).toBe(300);
      expect(state.stats.sessionCount).toBe(1);
      expect(state.sessions['coder-1::t1'].log.length).toBeGreaterThanOrEqual(3); // decision + tool_call_start + tool_call_end + text
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
