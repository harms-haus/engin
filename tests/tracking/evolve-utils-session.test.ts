// ────────────────────────────────────────────────────────────────────────────
// Tests for the new sessionKey and resolveSession helpers in evolve-utils.ts.
//
// These are additive alongside the existing sessionKey / resolveSession helpers,
// which remain tested in the main evolve.test.ts suite.
// ────────────────────────────────────────────────────────────────────────────

import type { SessionEntity } from '@engin/shared/event-types';
import { describe, expect, it } from 'bun:test';
import { resolveSession, sessionKey } from '../../packages/shared/src/evolve-utils.js';

// ── sessionKey ───────────────────────────────────────────────────────────────

describe('sessionKey', () => {
  it('returns agentId when only agentId is provided', () => {
    expect(sessionKey('a1')).toBe('a1');
  });

  it('returns agentId::taskId when taskId is provided', () => {
    expect(sessionKey('a1', 't1')).toBe('a1::t1');
  });

  it('returns agentId::taskId::runnerRole when runnerRole is provided', () => {
    expect(sessionKey('a1', 't1', 'executor')).toBe('a1::t1::executor');
  });

  it('returns agentId::taskId::runnerRole::attempt when all params are provided', () => {
    expect(sessionKey('a1', 't1', 'executor', 2)).toBe('a1::t1::executor::2');
  });

  it('skips runnerRole and attempt when they are undefined', () => {
    expect(sessionKey('a1', 't1', undefined, undefined)).toBe('a1::t1');
  });

  it('includes attempt even when runnerRole is undefined', () => {
    // Attempt without runnerRole still produces a 4-segment key with an empty runnerRole segment skipped.
    // The function should skip undefined segments, so a1::t1::3.
    expect(sessionKey('a1', 't1', undefined, 3)).toBe('a1::t1::3');
  });

  it('produces deterministic output for the same inputs', () => {
    const k1 = sessionKey('agent-x', 'task-y', 'runner-z', 5);
    const k2 = sessionKey('agent-x', 'task-y', 'runner-z', 5);
    expect(k1).toBe(k2);
  });

  it('produces different keys for different runnerRole values', () => {
    const k1 = sessionKey('a1', 't1', 'executor', 1);
    const k2 = sessionKey('a1', 't1', 'reviewer', 1);
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different attempt values', () => {
    const k1 = sessionKey('a1', 't1', 'executor', 1);
    const k2 = sessionKey('a1', 't1', 'executor', 2);
    expect(k1).not.toBe(k2);
  });

  it('is distinct from sessionKey when runnerRole or attempt are present', () => {
    // sessionKey ignores runnerRole and attempt; sessionKey includes them.
    const ak = 'a1::t1'; // sessionKey('a1', 't1')
    const sk = sessionKey('a1', 't1', 'executor', 1);
    expect(sk).not.toBe(ak);
  });
});

// ── resolveSession ───────────────────────────────────────────────────────────

describe('resolveSession', () => {
  function makeAgent(overrides: Partial<SessionEntity> & { agentId: string; uid: string }): SessionEntity {
    return {
      profile: 'coder',
      phaseId: 'phase-1',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
      runnerRole: 'executor',
      attempt: 1,
      ...overrides,
    };
  }

  it('finds an entity by exact session key match', () => {
    const key = sessionKey('a1', 't1', 'executor', 1);
    const entity = makeAgent({ uid: key, agentId: 'a1', taskId: 't1', runnerRole: 'executor', attempt: 1 });
    const sessions: Record<string, SessionEntity> = { [key]: entity };

    const result = resolveSession(sessions, 'a1', 't1', 'executor', 1);
    expect(result).toBeDefined();
    expect(result!.key).toBe(key);
    expect(result!.entity).toBe(entity);
  });

  it('returns undefined when no matching entity exists', () => {
    const sessions: Record<string, SessionEntity> = {};
    const result = resolveSession(sessions, 'a1', 't1', 'executor', 1);
    expect(result).toBeUndefined();
  });

  it('falls back to search when exact key is missing but agent matches', () => {
    const entity = makeAgent({
      uid: 'a1::t1',
      agentId: 'a1',
      taskId: 't1',
      runnerRole: 'executor',
      attempt: 1,
    });
    const sessions: Record<string, SessionEntity> = { 'a1::t1': entity };

    // Lookup with different runnerRole (no exact match, but agentId+taskId match)
    const result = resolveSession(sessions, 'a1', 't1', 'reviewer', 2);
    expect(result).toBeDefined();
    expect(result!.entity.agentId).toBe('a1');
  });

  it('prefers the active entity in fallback search', () => {
    const inactive = makeAgent({
      uid: 'a1::t1',
      agentId: 'a1',
      taskId: 't1',
      active: false,
    });
    const active = makeAgent({
      uid: 'a1::t1::executor::1',
      agentId: 'a1',
      taskId: 't1',
      runnerRole: 'executor',
      attempt: 1,
      active: true,
    });
    const sessions: Record<string, SessionEntity> = {
      'a1::t1': inactive,
      'a1::t1::executor::1': active,
    };

    // Search with runnerRole/attempt that doesn't match either exactly
    const result = resolveSession(sessions, 'a1', 't1', 'reviewer', 2);
    expect(result).toBeDefined();
    // Should prefer the active entity
    expect(result!.entity.active).toBe(true);
    expect(result!.key).toBe('a1::t1::executor::1');
  });

  it('returns undefined when runnerRole does not match any entity', () => {
    const entity = makeAgent({
      uid: 'a1::t1::executor::1',
      agentId: 'a1',
      taskId: 't1',
      runnerRole: 'executor',
      attempt: 1,
    });
    const sessions: Record<string, SessionEntity> = { 'a1::t1::executor::1': entity };

    // Search with runnerRole that doesn't match
    const result = resolveSession(sessions, 'a1', 't1', 'reviewer', 1);
    expect(result).toBeUndefined();
  });
});

// ── sessionKey / resolveSession regression ──────────────────────────────────────
// Verify the existing helpers are unchanged.

describe('sessionKey (regression)', () => {
  it('still works as before', () => {
    expect(sessionKey('a1')).toBe('a1');
    expect(sessionKey('a1', 't1')).toBe('a1::t1');
    expect(sessionKey('a1', 't1', 'executor', 0)).toBe('a1::t1::executor::0');
  });
});

describe('resolveSession (regression)', () => {
  it('still resolves sessions by agentId', () => {
    const entity: SessionEntity = {
      uid: 'a1::t1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'phase-1',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
      runnerRole: 'executor',
      attempt: 1,
    };
    const sessions = { 'a1::t1': entity };
    const result = resolveSession(sessions, 'a1', 't1');
    expect(result).toBeDefined();
    expect(result!.key).toBe('a1::t1');
    expect(result!.entity).toBe(entity);
  });
});
