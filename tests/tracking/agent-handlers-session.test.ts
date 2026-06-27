// ────────────────────────────────────────────────────────────────────────────
// Tests for the new handleSessionStarted / handleSessionCompleted handlers
// in agent-handlers.ts. These are additive alongside the existing
// handleAgentSpawned / handleAgentCompleted handlers.
// ────────────────────────────────────────────────────────────────────────────

import type { EventRecord, WorkflowProjection } from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';
import { evolve } from '@engin/shared/evolve';
import { describe, expect, it } from 'bun:test';

import { handleSessionCompleted, handleSessionStarted } from '../../packages/shared/src/session-handlers.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let eventSeq = 0;

function makeEvent(
  type: EventRecord['type'],
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

// ── handleSessionStarted ─────────────────────────────────────────────────────

describe('handleSessionStarted', () => {
  it('creates an agent entity using session key (agentId::taskId::runnerRole::attempt)', () => {
    resetSeq();
    const state = baseline();
    const event = makeEvent(
      'session_started',
      { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
      { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
    );
    const next = handleSessionStarted(state, event);

    // The agent should be keyed by sessionKey, not agentKey
    const expectedKey = 'a1::t1::executor::1';
    expect(next.sessions[expectedKey]).toBeDefined();
    expect(next.sessions[expectedKey].agentId).toBe('a1');
    expect(next.sessions[expectedKey].profile).toBe('coder');
    expect(next.sessions[expectedKey].active).toBe(true);
    expect(next.sessions[expectedKey].runnerRole).toBe('executor');
    expect(next.sessions[expectedKey].attempt).toBe(1);
  });

  it('stores runnerRole and attempt from event data on the entity', () => {
    resetSeq();
    const state = baseline();
    const event = makeEvent(
      'session_started',
      { agentId: 'a1', profile: 'reviewer', runnerRole: 'reviewer', attempt: 3 },
      { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'reviewer', attempt: 3 },
    );
    const next = handleSessionStarted(state, event);
    const key = 'a1::t1::reviewer::3';
    expect(next.sessions[key].runnerRole).toBe('reviewer');
    expect(next.sessions[key].attempt).toBe(3);
  });

  it('increments sessionCount on first spawn', () => {
    resetSeq();
    const state = baseline();
    expect(state.stats.sessionCount).toBe(0);

    const event = makeEvent(
      'session_started',
      { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
      { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
    );
    const next = handleSessionStarted(state, event);
    expect(next.stats.sessionCount).toBe(1);
  });

  it('upserts on re-spawn (same key) preserving accumulated log/tokens', () => {
    resetSeq();
    let state = baseline();

    // First spawn
    state = handleSessionStarted(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    // Accumulate tokens via turn_ended
    state = evolve(
      state,
      makeEvent(
        'turn_ended',
        { turn: 1, tokens: { input: 200, output: 100 }, contentBlocks: [{ type: 'text', text: 'hello' }] },
        { timestamp: '2026-06-26T10:01:00Z', agentId: 'a1' },
      ),
    );

    const key = 'a1::t1::executor::1';
    expect(state.sessions[key].log).toHaveLength(1);
    expect(state.sessions[key].inputTokens).toBe(200);
    expect(state.sessions[key].outputTokens).toBe(100);
    expect(state.stats.sessionCount).toBe(1);

    // Re-spawn same key
    state = handleSessionStarted(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder-v2', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:02:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    // Accumulated state preserved
    expect(state.sessions[key].log).toHaveLength(1);
    expect(state.sessions[key].inputTokens).toBe(200);
    expect(state.sessions[key].outputTokens).toBe(100);
    expect(state.sessions[key].active).toBe(true);
    // sessionCount NOT double-counted
    expect(state.stats.sessionCount).toBe(1);
    // Metadata updated
    expect(state.sessions[key].profile).toBe('coder-v2');
  });

  it('creates independent entities for different runnerRole values', () => {
    resetSeq();
    let state = baseline();

    state = handleSessionStarted(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    state = handleSessionStarted(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'reviewer', runnerRole: 'reviewer', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'reviewer', attempt: 1 },
      ),
    );

    const key1 = 'a1::t1::executor::1';
    const key2 = 'a1::t1::reviewer::1';
    expect(state.sessions[key1]).toBeDefined();
    expect(state.sessions[key2]).toBeDefined();
    expect(state.sessions[key1].runnerRole).toBe('executor');
    expect(state.sessions[key2].runnerRole).toBe('reviewer');
    expect(state.sessions[key1]).not.toBe(state.sessions[key2]);
    expect(state.stats.sessionCount).toBe(2);
  });

  it('creates independent entities for different attempt values', () => {
    resetSeq();
    let state = baseline();

    state = handleSessionStarted(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    state = handleSessionStarted(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 2 },
        { timestamp: '2026-06-26T10:01:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 2 },
      ),
    );

    const key1 = 'a1::t1::executor::1';
    const key2 = 'a1::t1::executor::2';
    expect(state.sessions[key1]).toBeDefined();
    expect(state.sessions[key2]).toBeDefined();
    expect(state.sessions[key1].attempt).toBe(1);
    expect(state.sessions[key2].attempt).toBe(2);
    expect(state.stats.sessionCount).toBe(2);
  });
});

// ── handleSessionCompleted ───────────────────────────────────────────────────

describe('handleSessionCompleted', () => {
  it('marks the session agent as inactive with completedAt', () => {
    resetSeq();
    let state = baseline();

    // Spawn a session agent
    state = handleSessionStarted(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    const key = 'a1::t1::executor::1';
    expect(state.sessions[key].active).toBe(true);

    // Complete it
    state = handleSessionCompleted(
      state,
      makeEvent(
        'session_completed',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-26T10:05:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    expect(state.sessions[key].active).toBe(false);
    expect(state.sessions[key].completedAt).toBe('2026-06-26T10:05:00Z');
  });

  it('is a no-op when the session entity does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = handleSessionCompleted(
      state,
      makeEvent('session_completed', { agentId: 'ghost' }, { timestamp: '2026-06-26T10:00:00Z', agentId: 'ghost' }),
    );
    expect(Object.keys(next.sessions)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('completes the correct session entity when multiple exist for the same agentId', () => {
    resetSeq();
    let state = baseline();

    // Spawn two session sessions for the same agentId with different runnerRole
    state = handleSessionStarted(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );
    state = handleSessionStarted(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'reviewer', runnerRole: 'reviewer', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'reviewer', attempt: 1 },
      ),
    );

    const execKey = 'a1::t1::executor::1';
    const reviewKey = 'a1::t1::reviewer::1';
    expect(state.sessions[execKey].active).toBe(true);
    expect(state.sessions[reviewKey].active).toBe(true);

    // Complete only the executor session
    state = handleSessionCompleted(
      state,
      makeEvent(
        'session_completed',
        { agentId: 'a1' },
        { timestamp: '2026-06-26T10:05:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    expect(state.sessions[execKey].active).toBe(false);
    expect(state.sessions[execKey].completedAt).toBe('2026-06-26T10:05:00Z');
    // The reviewer session should still be active
    expect(state.sessions[reviewKey].active).toBe(true);
    expect(state.sessions[reviewKey].completedAt).toBeUndefined();
  });
});

// ── Regression: old agent handlers still work ───────────────────────────────

describe('handleSessionStarted/handleSessionCompleted regression', () => {
  it('old session_started handler still works independently', () => {
    resetSeq();
    const state = baseline();
    const event = makeEvent(
      'session_started',
      { agentId: 'a1', profile: 'coder' },
      { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1' },
    );
    const next = evolve(state, event);
    // After C1, session_started → handleSessionStarted is canonical. When
    // runnerRole/attempt are absent from the event, the key is agentId::taskId.
    const key = 'a1::t1';
    expect(next.sessions[key]).toBeDefined();
    expect(next.sessions[key].profile).toBe('coder');
    expect(next.sessions[key].active).toBe(true);
    // Defaults are applied when runnerRole/attempt are not present in the event.
    expect(next.sessions[key].runnerRole).toBe('executor');
    expect(next.sessions[key].attempt).toBe(1);
  });

  it('old session_completed handler still works independently', () => {
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

  it('session_started events produce different keys when runnerRole/attempt differ', () => {
    // After C1, ALL session_started events route through handleSessionStarted
    // with the unified session key. There is no separate agent_spawned path.
    resetSeq();
    let state = baseline();

    // First event: runnerRole in data but no attempt → key a1::t1::executor
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor' },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );

    // Second event: runnerRole + attempt → key a1::t1::executor::1
    state = evolve(
      state,
      makeEvent(
        'session_started',
        { agentId: 'a1', profile: 'coder', runnerRole: 'executor', attempt: 1 },
        { timestamp: '2026-06-26T10:00:00Z', agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 },
      ),
    );

    const keyWithoutAttempt = 'a1::t1::executor';
    const keyWithAttempt = 'a1::t1::executor::1';
    expect(state.sessions[keyWithoutAttempt]).toBeDefined();
    expect(state.sessions[keyWithAttempt]).toBeDefined();
    expect(state.sessions[keyWithoutAttempt]).not.toBe(state.sessions[keyWithAttempt]);
    expect(state.stats.sessionCount).toBe(2);
  });
});
