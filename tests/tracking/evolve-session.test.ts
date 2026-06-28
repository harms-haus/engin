// ────────────────────────────────────────────────────────────────────────────
// Tests for session_started / session_completed dispatch in evolve.ts.
//
// Verifies:
//   1. session_started → handleSessionStarted (upserts agent with session key)
//   2. session_completed → handleSessionCompleted (marks active=false)
//   3. Old routes (session_started, session_completed, step_started) still work
// ────────────────────────────────────────────────────────────────────────────

import type { EventRecord, EventType, WorkflowProjection } from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';
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

function baseline(): WorkflowProjection {
  return evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
}

// ── session_started dispatch ─────────────────────────────────────────────────

describe('evolve – session_started', () => {
  it('dispatches to handleSessionStarted and upserts an agent into projection.sessions', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    const key = 'a1::t1::executor::1';
    expect(next.sessions[key]).toBeDefined();
    expect(next.sessions[key].agentId).toBe('a1');
    expect(next.sessions[key].profile).toBe('coder');
    expect(next.sessions[key].active).toBe(true);
    expect(next.sessions[key].runnerRole).toBe('executor');
    expect(next.sessions[key].attempt).toBe(1);
    expect(next.stats.sessionCount).toBe(1);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('sets status:"running" on first spawn', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    const key = 'a1::t1::executor::1';
    expect(next.sessions[key].status).toBe('running');
    expect(next.sessions[key].active).toBe(true);
  });

  it('sets status:"running" on upsert (re-spawn)', () => {
    resetSeq();
    let state = baseline();
    // First spawn
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );
    const key = 'a1::t1::executor::1';
    expect(state.sessions[key].status).toBe('running');

    // Complete it
    state = evolve(
      state,
      makeEvent(
        'session_completed',
        { agentId: 'a1' },
        { timestamp: '2026-06-26T10:05:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );
    expect(state.sessions[key].status).toBe('completed');
    expect(state.sessions[key].active).toBe(false);

    // Re-spawn
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder-v2', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:10:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );
    expect(state.sessions[key].status).toBe('running');
    expect(state.sessions[key].active).toBe(true);
    expect(state.sessions[key].completedAt).toBeUndefined();
  });

  it('uses runnerRole and attempt from metadata for the session key', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'reviewer', runnerRole: 'reviewer', attempt: 3 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'reviewer', attempt: 3 },
      ),
    );

    const key = 'a1::t1::reviewer::3';
    expect(next.sessions[key]).toBeDefined();
    expect(next.sessions[key].runnerRole).toBe('reviewer');
    expect(next.sessions[key].attempt).toBe(3);
  });

  it('upserts on re-spawn preserving accumulated state', () => {
    resetSeq();
    let state = baseline();

    // First spawn
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    // Accumulate state
    state = evolve(
      state,
      makeEvent(
        'turn_ended',
        { turn: 1, tokens: { input: 300, output: 150 }, contentBlocks: [{ type: 'text', text: 'work' }] },
        { timestamp: '2026-06-26T10:01:00Z', agentId: 'a1' },
      ),
    );

    const key = 'a1::t1::executor::1';
    expect(state.sessions[key].inputTokens).toBe(300);
    expect(state.sessions[key].outputTokens).toBe(150);
    expect(state.sessions[key].log).toHaveLength(1);

    // Re-spawn same key
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder-v2', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:02:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    // Accumulated state preserved
    expect(state.sessions[key].inputTokens).toBe(300);
    expect(state.sessions[key].outputTokens).toBe(150);
    expect(state.sessions[key].log).toHaveLength(1);
    expect(state.sessions[key].active).toBe(true);
    expect(state.sessions[key].profile).toBe('coder-v2');
    // sessionCount NOT double-counted
    expect(state.stats.sessionCount).toBe(1);
  });

  it('is a no-op when no runnerRole/attempt and entity already exists via agentKey', () => {
    resetSeq();
    let state = baseline();

    // Spawn via session_started (uses agentKey)
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );

    // session_started without runnerRole/attempt should use sessionKey = agentKey
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder-v2' },
        { timestamp: '2026-06-26T10:01:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );

    // Should be an upsert (same key a1::t1), not a second agent
    expect(state.stats.sessionCount).toBe(1);
    expect(state.sessions['a1::t1'].profile).toBe('coder-v2');
  });
});

// ── session_completed dispatch ───────────────────────────────────────────────

describe('evolve – session_completed', () => {
  it('dispatches to handleSessionCompleted and marks agent inactive + status completed', () => {
    resetSeq();
    let state = baseline();

    // Spawn a session agent
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    const key = 'a1::t1::executor::1';
    expect(state.sessions[key].active).toBe(true);
    expect(state.sessions[key].status).toBe('running');

    // Complete the session
    state = evolve(
      state,
      makeEvent(
        'session_completed',
        { agentId: 'a1' },
        { timestamp: '2026-06-26T10:05:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    expect(state.sessions[key].active).toBe(false);
    expect(state.sessions[key].status).toBe('completed');
    expect(state.sessions[key].completedAt).toBe('2026-06-26T10:05:00Z');
  });

  it('is a no-op when the session entity does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('session_completed', { agentId: 'ghost' }, { timestamp: '2026-06-26T10:00:00Z', agentId: 'ghost' }),
    );
    expect(Object.keys(next.sessions)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('completes the correct session when multiple exist for the same agentId', () => {
    resetSeq();
    let state = baseline();

    // Spawn two sessions
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'reviewer', runnerRole: 'reviewer', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'reviewer', attempt: 1 },
      ),
    );

    // Complete only the executor
    state = evolve(
      state,
      makeEvent(
        'session_completed',
        { agentId: 'a1' },
        { timestamp: '2026-06-26T10:05:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    expect(state.sessions['a1::t1::executor::1'].active).toBe(false);
    expect(state.sessions['a1::t1::reviewer::1'].active).toBe(true);
  });
});

// ── session_failed dispatch ─────────────────────────────────────────────────

describe('evolve – session_failed', () => {
  it('dispatches to handleSessionFailed and marks agent inactive + status failed', () => {
    resetSeq();
    let state = baseline();

    // Spawn a session agent
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    const key = 'a1::t1::executor::1';
    expect(state.sessions[key].active).toBe(true);
    expect(state.sessions[key].status).toBe('running');

    // Fail the session
    state = evolve(
      state,
      makeEvent(
        'session_failed',
        { error: 'Something broke' },
        { timestamp: '2026-06-26T10:05:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    expect(state.sessions[key].active).toBe(false);
    expect(state.sessions[key].status).toBe('failed');
  });

  it('is a no-op when the session entity does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('session_failed', {}, { timestamp: '2026-06-26T10:00:00Z', agentId: 'ghost' }),
    );
    expect(Object.keys(next.sessions)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('preserves accumulated log/tokens when failing', () => {
    resetSeq();
    let state = baseline();

    // Spawn
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    // Accumulate
    state = evolve(
      state,
      makeEvent(
        'turn_ended',
        { turn: 1, tokens: { input: 200, output: 100 }, contentBlocks: [{ type: 'text', text: 'work' }] },
        { timestamp: '2026-06-26T10:01:00Z', agentId: 'a1' },
      ),
    );

    const key = 'a1::t1::executor::1';
    expect(state.sessions[key].inputTokens).toBe(200);
    expect(state.sessions[key].log).toHaveLength(1);

    // Fail
    state = evolve(
      state,
      makeEvent(
        'session_failed',
        { error: 'Kaboom' },
        { timestamp: '2026-06-26T10:05:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    // Accumulated state preserved
    expect(state.sessions[key].inputTokens).toBe(200);
    expect(state.sessions[key].log).toHaveLength(1);
    expect(state.sessions[key].status).toBe('failed');
    expect(state.sessions[key].active).toBe(false);
  });
});

// ── Old routes still work (regression) ──────────────────────────────────────

describe('evolve – old routes regression with session events present', () => {
  it('session_started routes to handleSessionStarted with default runnerRole/attempt', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );

    // Uses sessionKey (a1::t1) — new API defaults runnerRole/attempt
    expect(next.sessions['a1::t1']).toBeDefined();
    expect(next.sessions['a1::t1'].runnerRole).toBe('executor');
    expect(next.sessions['a1::t1'].attempt).toBe(1);
    expect(next.stats.sessionCount).toBe(1);
  });

  it('session_completed still routes to handleAgentCompleted', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'session_completed',
        { agentId: 'a1' },
        { timestamp: '2026-06-26T10:05:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );

    expect(state.sessions['a1::t1'].active).toBe(false);
    expect(state.sessions['a1::t1'].completedAt).toBe('2026-06-26T10:05:00Z');
  });

  it('session_started and session_started coexist without interference', () => {
    resetSeq();
    let state = baseline();

    // session_started creates agent at agentKey
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );

    // session_started creates agent at sessionKey
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    // Both exist independently
    expect(state.sessions['a1::t1']).toBeDefined();
    expect(state.sessions['a1::t1::executor::1']).toBeDefined();
    expect(state.stats.sessionCount).toBe(2);

    // Completing via session_completed only affects the agentKey entity
    state = evolve(
      state,
      makeEvent(
        'session_completed',
        { agentId: 'a1' },
        { timestamp: '2026-06-26T10:05:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    expect(state.sessions['a1::t1'].active).toBe(false);
    expect(state.sessions['a1::t1::executor::1'].active).toBe(true);

    // Completing via session_completed only affects the sessionKey entity
    state = evolve(
      state,
      makeEvent(
        'session_completed',
        { agentId: 'a1' },
        { timestamp: '2026-06-26T10:06:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );
    expect(state.sessions['a1::t1::executor::1'].active).toBe(false);
  });
});

// ── All event types still routed ─────────────────────────────────────────────

describe('evolve – all event types still routed (including new session types)', () => {
  const knownTypes: EventType[] = [
    'workflow_started',
    'workflow_completed',
    'workflow_failed',
    'phase_registered',
    'phase_started',
    'phase_completed',
    'session_started',
    'session_completed',
    'session_failed',
    'auto_retry_started',
    'auto_retry_completed',
    'task_registered',
    'task_started',
    'task_completed',
    'task_rejected',
    'task_parked',
    'task_unparked',
    'decision',
    'error',
    'sidebar_updated',
    'turn_started',
    'turn_ended',
    'tool_call_started',
    'tool_call_ended',
    'log',
    'agent_rendered',
    'workflow_data_set',
  ];

  for (const type of knownTypes) {
    it(`routes ${type} through a handler (seq matches event.seq, new object returned)`, () => {
      resetSeq();
      const state = baseline();
      const evt = makeEvent(type, {}, { timestamp: '2026-06-26T00:00:00Z' });
      const next = evolve(state, evt);
      expect(next).not.toBe(state);
      expect(next.seq).toBe(evt.seq);
    });
  }
});
