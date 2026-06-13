import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AgentRegistry } from '../../src/tracking/agent-registry.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRegistration(overrides: Partial<Parameters<AgentRegistry['register']>[0]> = {}) {
  return {
    agentId: 'lane-0',
    profile: 'coder',
    phase: 'implementing',
    ...overrides,
  };
}

// ─── AgentRegistry ───────────────────────────────────────────────────────────

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  // ── register ──────────────────────────────────────────────────────────

  describe('register', () => {
    it('returns a unique UID on first registration', () => {
      const uid = registry.register(makeRegistration());
      expect(uid).toBe('agent-1');
    });

    it('increments UIDs sequentially for multiple registrations', () => {
      const uid1 = registry.register(makeRegistration({ agentId: 'lane-0' }));
      const uid2 = registry.register(makeRegistration({ agentId: 'lane-1' }));
      const uid3 = registry.register(makeRegistration({ agentId: 'lane-2' }));

      expect(uid1).toBe('agent-1');
      expect(uid2).toBe('agent-2');
      expect(uid3).toBe('agent-3');
    });

    it('assigns unique UIDs even when same agentId is reused across phases', () => {
      const uid1 = registry.register(makeRegistration({ agentId: 'lane-0', phase: 'scouting' }));
      const uid2 = registry.register(makeRegistration({ agentId: 'lane-0', phase: 'implementing' }));

      expect(uid1).toBe('agent-1');
      expect(uid2).toBe('agent-2');
      expect(uid1).not.toBe(uid2);
    });

    it('stores sessionId and sessionPath when provided', () => {
      const uid = registry.register(makeRegistration({ sessionId: 'sess-abc', sessionPath: '/tmp/sessions/sess-abc' }));

      const agent = registry.getAgent(uid)!;
      expect(agent.sessionId).toBe('sess-abc');
      expect(agent.sessionPath).toBe('/tmp/sessions/sess-abc');
    });

    it('stores taskId when provided', () => {
      const uid = registry.register(makeRegistration({ taskId: 'task-1' }));
      const agent = registry.getAgent(uid)!;
      expect(agent.taskId).toBe('task-1');
    });

    it('defaults status to active', () => {
      const uid = registry.register(makeRegistration());
      const agent = registry.getAgent(uid)!;
      expect(agent.status).toBe('active');
    });

    it('updates activeByAgentId map, overwriting previous mapping for same agentId', () => {
      const uid1 = registry.register(makeRegistration({ agentId: 'lane-0', phase: 'scouting' }));
      const uid2 = registry.register(makeRegistration({ agentId: 'lane-0', phase: 'implementing' }));

      // getActiveUid should return the latest UID for lane-0
      expect(registry.getActiveUid('lane-0')).toBe(uid2);
      expect(registry.getActiveUid('lane-0')).not.toBe(uid1);
    });

    it('indexes byTaskId when taskId is provided', () => {
      registry.register(makeRegistration({ agentId: 'lane-0', taskId: 'task-42' }));
      expect(registry.getUidByTaskId('task-42')).toBe('agent-1');
    });

    it('does not index byTaskId when taskId is omitted', () => {
      registry.register(makeRegistration({ agentId: 'lane-0' }));
      expect(registry.getUidByTaskId('task-42')).toBeUndefined();
    });
  });

  // ── complete ──────────────────────────────────────────────────────────

  describe('complete', () => {
    it('marks the agent as completed and sets completedAt', () => {
      const uid = registry.register(makeRegistration());
      expect(registry.getAgent(uid)!.status).toBe('active');

      registry.complete(uid);

      const agent = registry.getAgent(uid)!;
      expect(agent.status).toBe('completed');
      expect(agent.completedAt).toBeDefined();
      expect(agent.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('is a no-op when uid does not exist', () => {
      // Should not throw
      registry.complete('non-existent-uid');
    });
  });

  // ── completeByAgentId ─────────────────────────────────────────────────

  describe('completeByAgentId', () => {
    it('completes the latest agent for the given raw agentId', () => {
      registry.register(makeRegistration({ agentId: 'lane-0', phase: 'scouting' }));
      const uid2 = registry.register(makeRegistration({ agentId: 'lane-0', phase: 'implementing' }));

      registry.completeByAgentId('lane-0');

      // The first agent should still be active
      const agent1 = registry.getAgent('agent-1')!;
      expect(agent1.status).toBe('active');

      // The second (latest) agent should be completed
      const agent2 = registry.getAgent(uid2)!;
      expect(agent2.status).toBe('completed');
    });

    it('is a no-op when agentId has no active mapping', () => {
      // Should not throw
      registry.completeByAgentId('unknown-agent');
    });
  });

  // ── getActiveUid ──────────────────────────────────────────────────────

  describe('getActiveUid', () => {
    it('returns undefined for an unknown agentId', () => {
      expect(registry.getActiveUid('non-existent')).toBeUndefined();
    });

    it('returns the latest uid for a registered agentId', () => {
      registry.register(makeRegistration({ agentId: 'scout-topic' }));
      const uid = registry.getActiveUid('scout-topic');
      expect(uid).toBe('agent-1');
    });

    it('returns the newest uid after re-registration with same agentId', () => {
      registry.register(makeRegistration({ agentId: 'lane-0', phase: 'scouting' }));
      registry.register(makeRegistration({ agentId: 'lane-0', phase: 'implementing' }));

      expect(registry.getActiveUid('lane-0')).toBe('agent-2');
    });
  });

  // ── getUidByTaskId ────────────────────────────────────────────────────

  describe('getUidByTaskId', () => {
    it('returns undefined for an unknown taskId', () => {
      expect(registry.getUidByTaskId('no-such-task')).toBeUndefined();
    });

    it('returns the uid mapped to a taskId', () => {
      registry.register(makeRegistration({ taskId: 'task-99' }));
      expect(registry.getUidByTaskId('task-99')).toBe('agent-1');
    });

    it('overwrites previous taskId mapping when taskId is reused', () => {
      registry.register(makeRegistration({ taskId: 'task-1' })); // agent-1
      registry.register(makeRegistration({ taskId: 'task-1' })); // agent-2
      expect(registry.getUidByTaskId('task-1')).toBe('agent-2');
    });
  });

  // ── getAgents ─────────────────────────────────────────────────────────

  describe('getAgents', () => {
    it('returns an empty array for a fresh registry', () => {
      expect(registry.getAgents()).toEqual([]);
    });

    it('returns a shallow copy of all registered agents', () => {
      registry.register(makeRegistration({ agentId: 'lane-0' }));
      registry.register(makeRegistration({ agentId: 'lane-1' }));

      const agents = registry.getAgents();
      expect(agents).toHaveLength(2);
      expect(agents[0].agentId).toBe('lane-0');
      expect(agents[1].agentId).toBe('lane-1');
    });

    it('returned array mutations do not affect internal state', () => {
      registry.register(makeRegistration({ agentId: 'lane-0' }));
      const agents = registry.getAgents();
      agents.pop();
      expect(registry.size).toBe(1);
    });
  });

  // ── getAgentsByPhase ──────────────────────────────────────────────────

  describe('getAgentsByPhase', () => {
    it('returns an empty array when no agents match the phase', () => {
      const agents = registry.getAgentsByPhase('scouting');
      expect(agents).toEqual([]);
    });

    it('filters agents by phase', () => {
      registry.register(makeRegistration({ agentId: 'lane-0', phase: 'scouting' }));
      registry.register(makeRegistration({ agentId: 'lane-1', phase: 'implementing' }));
      registry.register(makeRegistration({ agentId: 'lane-0', phase: 'implementing' }));

      const scouting = registry.getAgentsByPhase('scouting');
      expect(scouting).toHaveLength(1);
      expect(scouting[0].uid).toBe('agent-1');

      const implementing = registry.getAgentsByPhase('implementing');
      expect(implementing).toHaveLength(2);
      expect(implementing.map((a) => a.uid)).toEqual(['agent-2', 'agent-3']);
    });
  });

  // ── getAgent ──────────────────────────────────────────────────────────

  describe('getAgent', () => {
    it('returns undefined for an unknown uid', () => {
      expect(registry.getAgent('unknown')).toBeUndefined();
    });

    it('returns the agent record for a known uid', () => {
      const uid = registry.register(makeRegistration({ agentId: 'lane-0', profile: 'scout', phase: 'scouting' }));
      const agent = registry.getAgent(uid);
      expect(agent).toBeDefined();
      expect(agent!.uid).toBe(uid);
      expect(agent!.agentId).toBe('lane-0');
      expect(agent!.profile).toBe('scout');
      expect(agent!.phase).toBe('scouting');
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('resets agents, maps, and counter', () => {
      registry.register(makeRegistration({ agentId: 'lane-0' }));
      registry.register(makeRegistration({ agentId: 'lane-1' }));
      expect(registry.size).toBe(2);

      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.getAgents()).toEqual([]);
      expect(registry.getActiveUid('lane-0')).toBeUndefined();
      expect(registry.getUidByTaskId('task-1')).toBeUndefined();
    });

    it('allows fresh registrations after clear', () => {
      registry.register(makeRegistration({ agentId: 'lane-0' }));
      registry.clear();

      const uid = registry.register(makeRegistration({ agentId: 'lane-0' }));
      expect(uid).toBe('agent-1');
      expect(registry.size).toBe(1);
    });
  });

  // ── size getter ───────────────────────────────────────────────────────

  describe('size', () => {
    it('starts at 0', () => {
      expect(registry.size).toBe(0);
    });

    it('increments on each registration', () => {
      registry.register(makeRegistration());
      expect(registry.size).toBe(1);
      registry.register(makeRegistration());
      expect(registry.size).toBe(2);
      registry.register(makeRegistration());
      expect(registry.size).toBe(3);
    });

    it('is not affected by completing agents', () => {
      const uid = registry.register(makeRegistration());
      expect(registry.size).toBe(1);
      registry.complete(uid);
      expect(registry.size).toBe(1);
    });
  });
});
