import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentLogEntry } from '../../src/tracking/agent-registry.js';
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

    it('initializes entries to empty array', () => {
      const uid = registry.register(makeRegistration());
      const agent = registry.getAgent(uid)!;
      expect(agent.entries).toEqual([]);
    });

    it('initializes toolCallCount, inputTokens, outputTokens to 0', () => {
      const uid = registry.register(makeRegistration());
      const agent = registry.getAgent(uid)!;
      expect(agent.toolCallCount).toBe(0);
      expect(agent.inputTokens).toBe(0);
      expect(agent.outputTokens).toBe(0);
    });

    it('initializes taskTitle to empty string', () => {
      const uid = registry.register(makeRegistration());
      const agent = registry.getAgent(uid)!;
      expect(agent.taskTitle).toBe('');
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

    it('removes the agent from activeByAgentId mapping', () => {
      const uid = registry.register(makeRegistration({ agentId: 'lane-0' }));
      expect(registry.getActiveUid('lane-0')).toBe(uid);

      registry.complete(uid);

      expect(registry.getActiveUid('lane-0')).toBeUndefined();
    });

    it('only cleans up activeByAgentId if the completed uid matches the active mapping', () => {
      // Register agent-1 with lane-0
      const uid1 = registry.register(makeRegistration({ agentId: 'lane-0', phase: 'scouting' }));
      // Register agent-2 with same lane-0 (becomes active)
      registry.register(makeRegistration({ agentId: 'lane-0', phase: 'implementing' }));

      // Completing agent-1 (no longer active) should NOT remove the active mapping
      registry.complete(uid1);

      // The active mapping should still point to agent-2
      expect(registry.getActiveUid('lane-0')).toBe('agent-2');
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

  // ── addEntry ──────────────────────────────────────────────────────────

  describe('addEntry', () => {
    it('pushes a log entry to the correct agent entries array', () => {
      const uid = registry.register(makeRegistration({ agentId: 'lane-0' }));
      const entry: AgentLogEntry = {
        type: 'text',
        content: 'Hello from agent',
      };

      registry.addEntry(uid, entry);

      const agent = registry.getAgent(uid)!;
      expect(agent.entries).toHaveLength(1);
      expect(agent.entries[0].type).toBe('text');
      expect(agent.entries[0].content).toBe('Hello from agent');
    });

    it("does not affect other agents' entries", () => {
      const uid1 = registry.register(makeRegistration({ agentId: 'lane-0' }));
      const uid2 = registry.register(makeRegistration({ agentId: 'lane-1' }));

      registry.addEntry(uid1, { type: 'text', content: 'entry for lane-0' });

      const agent1 = registry.getAgent(uid1)!;
      const agent2 = registry.getAgent(uid2)!;
      expect(agent1.entries).toHaveLength(1);
      expect(agent2.entries).toHaveLength(0);
    });

    it('caps entries at 200, evicting oldest via FIFO', () => {
      const uid = registry.register(makeRegistration({ agentId: 'lane-0' }));

      // Add 201 entries
      for (let i = 0; i < 201; i++) {
        registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
      }

      const agent = registry.getAgent(uid)!;
      expect(agent.entries).toHaveLength(200);
      // The first entry (entry-0) should have been evicted
      expect(agent.entries[0].content).toBe('entry-1');
      // The last entry should be entry-200
      expect(agent.entries[199].content).toBe('entry-200');
    });

    it('is a no-op for unknown uid', () => {
      // Should not throw
      registry.addEntry('unknown-uid', { type: 'text', content: 'test' });
      expect(registry.size).toBe(0);
    });
  });

  // ── updateStats ───────────────────────────────────────────────────────

  describe('updateStats', () => {
    it('accumulates toolCallCount', () => {
      const uid = registry.register(makeRegistration());
      registry.updateStats(uid, { toolCallCount: 1 });
      registry.updateStats(uid, { toolCallCount: 1 });
      expect(registry.getAgent(uid)!.toolCallCount).toBe(2);
    });

    it('accumulates inputTokens', () => {
      const uid = registry.register(makeRegistration());
      registry.updateStats(uid, { inputTokens: 150 });
      registry.updateStats(uid, { inputTokens: 50 });
      expect(registry.getAgent(uid)!.inputTokens).toBe(200);
    });

    it('accumulates outputTokens', () => {
      const uid = registry.register(makeRegistration());
      registry.updateStats(uid, { outputTokens: 100 });
      registry.updateStats(uid, { outputTokens: 75 });
      expect(registry.getAgent(uid)!.outputTokens).toBe(175);
    });

    it('sets taskTitle (overwrites)', () => {
      const uid = registry.register(makeRegistration());
      registry.updateStats(uid, { taskTitle: 'Initial title' });
      expect(registry.getAgent(uid)!.taskTitle).toBe('Initial title');

      registry.updateStats(uid, { taskTitle: 'Updated title' });
      expect(registry.getAgent(uid)!.taskTitle).toBe('Updated title');
    });

    it('sets profile (overwrites)', () => {
      const uid = registry.register(makeRegistration({ profile: 'scout' }));
      expect(registry.getAgent(uid)!.profile).toBe('scout');

      registry.updateStats(uid, { profile: 'coder' });
      expect(registry.getAgent(uid)!.profile).toBe('coder');
    });

    it('handles multiple fields in a single call', () => {
      const uid = registry.register(makeRegistration());
      registry.updateStats(uid, {
        toolCallCount: 3,
        inputTokens: 500,
        outputTokens: 200,
        taskTitle: 'Complex task',
        profile: 'expert',
      });

      const agent = registry.getAgent(uid)!;
      expect(agent.toolCallCount).toBe(3);
      expect(agent.inputTokens).toBe(500);
      expect(agent.outputTokens).toBe(200);
      expect(agent.taskTitle).toBe('Complex task');
      expect(agent.profile).toBe('expert');
    });

    it('only updates provided fields, leaving others unchanged', () => {
      const uid = registry.register(makeRegistration({ profile: 'scout' }));
      // Set some initial values
      registry.updateStats(uid, { toolCallCount: 5, taskTitle: 'Initial task' });

      // Now update only taskTitle
      registry.updateStats(uid, { taskTitle: 'Updated task' });

      const agent = registry.getAgent(uid)!;
      expect(agent.toolCallCount).toBe(5); // unchanged
      expect(agent.taskTitle).toBe('Updated task');
      expect(agent.profile).toBe('scout'); // unchanged
      expect(agent.inputTokens).toBe(0); // never set, still default
    });

    it('is a no-op for unknown uid', () => {
      // Should not throw
      registry.updateStats('unknown-uid', { toolCallCount: 1, taskTitle: 'test' });
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
