import { describe, expect, it } from 'bun:test';
import type { ServerMessage } from '../../src/web/protocol-types.ts';

// ─── ServerMessage union validation ────────────────────────────────────────
//
// These tests verify the shape of the ServerMessage union type at runtime.
// TypeScript guarantees compile-time safety; the runtime checks below
// confirm that the expected literal shapes are correct.

describe('ServerMessage – agent_stats variant', () => {
  it('accepts an agent_stats message without optional fields', () => {
    const msg: ServerMessage = {
      type: 'agent_stats',
      agentId: 'agent-1',
    };
    expect(msg.type).toBe('agent_stats');
    expect(msg.agentId).toBe('agent-1');
  });

  it('accepts an agent_stats message with toolCallCount', () => {
    const msg: ServerMessage = {
      type: 'agent_stats',
      agentId: 'agent-1',
      toolCallCount: 5,
    };
    expect(msg.toolCallCount).toBe(5);
  });

  it('accepts an agent_stats message with token counters', () => {
    const msg: ServerMessage = {
      type: 'agent_stats',
      agentId: 'agent-1',
      inputTokens: 100,
      outputTokens: 50,
    };
    expect(msg.inputTokens).toBe(100);
    expect(msg.outputTokens).toBe(50);
  });

  it('accepts an agent_stats message with all optional fields including taskId', () => {
    const msg: ServerMessage = {
      type: 'agent_stats',
      agentId: 'agent-1',
      toolCallCount: 3,
      inputTokens: 200,
      outputTokens: 75,
      taskId: 'task-42',
    };
    expect(msg.type).toBe('agent_stats');
    expect(msg.agentId).toBe('agent-1');
    expect(msg.toolCallCount).toBe(3);
    expect(msg.inputTokens).toBe(200);
    expect(msg.outputTokens).toBe(75);
    expect(msg.taskId).toBe('task-42');
  });

  it('accepts an agent_stats message with only taskId (no other optionals)', () => {
    const msg: ServerMessage = {
      type: 'agent_stats',
      agentId: 'agent-1',
      taskId: 'task-99',
    };
    expect(msg.taskId).toBe('task-99');
  });
});

describe('ServerMessage – other variants still work correctly', () => {
  it('agent_log variant still accepts taskId', () => {
    const msg: ServerMessage = {
      type: 'agent_log',
      agentId: 'agent-1',
      entry: {
        id: 'log-1',
        timestamp: new Date().toISOString(),
        type: 'text',
        content: 'hello',
      },
      taskId: 'task-42',
    };
    expect(msg.type).toBe('agent_log');
    expect(msg.taskId).toBe('task-42');
  });

  it('agent_complete variant still accepts taskId', () => {
    const msg: ServerMessage = {
      type: 'agent_complete',
      agentId: 'agent-1',
      taskId: 'task-42',
    };
    expect(msg.type).toBe('agent_complete');
    expect(msg.taskId).toBe('task-42');
  });

  it('init variant works unchanged', () => {
    const msg: ServerMessage = {
      type: 'init',
      currentPhase: 'scouting',
      completedPhases: [],
      tasks: [],
      agents: [],
      sidebar: { title: 'Test', indicator: '🟢' },
    };
    expect(msg.currentPhase).toBe('scouting');
    expect(msg.sidebar.title).toBe('Test');
  });

  it('workflow_complete variant works unchanged', () => {
    const msg: ServerMessage = { type: 'workflow_complete' };
    expect(msg.type).toBe('workflow_complete');
  });

  it('workflow_failed variant works unchanged', () => {
    const msg: ServerMessage = {
      type: 'workflow_failed',
      error: 'something broke',
      phase: 'planning',
    };
    expect(msg.error).toBe('something broke');
    expect(msg.phase).toBe('planning');
  });
});
