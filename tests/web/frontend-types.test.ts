/**
 * Tests for the frontend mirror types in web/src/types.ts.
 *
 * Verifies that the frontend types mirror the backend types from
 * src/web/types.ts, particularly the phase propagation additions.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentWindowState, ServerMessage } from '../../web/src/types.ts';

// ─── Frontend AgentWindowState ──────────────────────────────────────────────

describe('frontend AgentWindowState', () => {
  it('is assignable with phase set to a string', () => {
    const state: AgentWindowState = {
      agentId: 'agent-1',
      profile: 'coder',
      active: true,
      log: [],
      phase: 'implementing',
    };

    expect(state.phase).toBe('implementing');
  });

  it('phase is optional and defaults to undefined', () => {
    const state: AgentWindowState = {
      agentId: 'agent-2',
      profile: 'scout',
      active: true,
      log: [],
    };

    expect(state.phase).toBeUndefined();
  });

  it('serializes and round-trips with phase', () => {
    const state: AgentWindowState = {
      agentId: 'agent-3',
      profile: 'reviewer',
      active: false,
      log: [],
      phase: 'review',
    };

    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as AgentWindowState;

    expect(parsed.phase).toBe('review');
  });

  it('round-trips agents without phase for backward compatibility', () => {
    const legacyData = {
      agentId: 'legacy-agent',
      profile: 'coder',
      active: true,
      log: [],
    };

    const state = legacyData as AgentWindowState;
    expect(state.phase).toBeUndefined();
  });
});

// ─── Frontend ServerMessage agent_complete ───────────────────────────────────

describe('frontend ServerMessage agent_complete', () => {
  it('agent_complete message narrows by type', () => {
    const msg: ServerMessage = {
      type: 'agent_complete',
      workflowId: 'wf-1',
      agentId: 'agent-1',
    };

    if (msg.type === 'agent_complete') {
      expect(msg.workflowId).toBe('wf-1');
      expect(msg.agentId).toBe('agent-1');
    } else {
      expect.unreachable('Should have narrowed to agent_complete');
    }
  });

  it('agent_complete message can carry optional phase', () => {
    const msg: ServerMessage = {
      type: 'agent_complete',
      workflowId: 'wf-2',
      agentId: 'agent-2',
      phase: 'implementing',
    };

    if (msg.type === 'agent_complete') {
      expect(msg.workflowId).toBe('wf-2');
      expect(msg.agentId).toBe('agent-2');
      expect(msg.phase).toBe('implementing');
    } else {
      expect.unreachable('Should have narrowed to agent_complete');
    }
  });

  it('agent_complete message is valid without phase (backward compat)', () => {
    const msg: ServerMessage = {
      type: 'agent_complete',
      workflowId: 'wf-3',
      agentId: 'agent-3',
    };

    if (msg.type === 'agent_complete') {
      expect(msg.phase).toBeUndefined();
    } else {
      expect.unreachable('Should have narrowed to agent_complete');
    }
  });
});

// ─── Frontend ServerMessage agent_spawned with phase ─────────────────────────

describe('frontend ServerMessage agent_spawned with phase', () => {
  it('agent_spawned message can carry agent with phase', () => {
    const msg: ServerMessage = {
      type: 'agent_spawned',
      workflowId: 'wf-4',
      agent: {
        agentId: 'agent-new',
        profile: 'reviewer',
        active: true,
        log: [],
        phase: 'review',
      },
    };

    if (msg.type === 'agent_spawned') {
      expect(msg.agent.phase).toBe('review');
    } else {
      expect.unreachable('Should have narrowed to agent_spawned');
    }
  });
});
