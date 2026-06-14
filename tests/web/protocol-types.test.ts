import { describe, expect, it } from 'bun:test';
import type { ServerMessage } from '../../src/web/protocol-types.ts';

// ─── ServerMessage union validation ────────────────────────────────────────
//
// These tests verify the shape of the ServerMessage union type at runtime.
// TypeScript guarantees compile-time safety; the runtime checks below
// confirm that the expected literal shapes are correct.
//
// After the snapshot/delta refactor (kb-13–17) the protocol only carries:
//   - snapshot          (full WorkflowProjection on connect / full resync)
//   - events            (batched EventRecord deltas)
//   - workflow_complete / workflow_failed  (top-level lifecycle signals)
//
// The old per-event WS message types (init, workflow_phase, agent_spawned,
// agent_log, agent_complete, agent_stats, tasks_updated, workflow_sidebar)
// have been removed — their data now travels inside snapshot/events.

describe('ServerMessage – retained variants', () => {
  it('snapshot variant', () => {
    const msg: ServerMessage = {
      type: 'snapshot',
      seq: 10,
      state: {
        seq: 10,
        taskPrompt: 'Build it',
        currentPhase: 'coding',
        completedPhases: ['scouting'],
        tasks: {},
        agents: {},
        sidebar: { title: 'Engin', indicator: '🟢' },
        status: 'running',
        stats: { totalTokens: 0, agentCount: 0 },
      },
    };
    expect(msg.type).toBe('snapshot');
    expect(msg.seq).toBe(10);
    expect(msg.state.currentPhase).toBe('coding');
  });

  it('events variant', () => {
    const msg: ServerMessage = {
      type: 'events',
      seq: 3,
      events: [
        {
          seq: 3,
          type: 'phase_started',
          data: { phase: 'coding' },
          metadata: { timestamp: new Date().toISOString(), phase: 'coding' },
        },
      ],
    };
    expect(msg.type).toBe('events');
    expect(msg.seq).toBe(3);
    expect(msg.events).toHaveLength(1);
  });

  it('events variant with empty batch', () => {
    const msg: ServerMessage = {
      type: 'events',
      seq: 0,
      events: [],
    };
    expect(msg.type).toBe('events');
    expect(msg.events).toHaveLength(0);
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
