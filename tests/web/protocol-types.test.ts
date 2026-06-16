import type { ServerMessage } from '@engin/shared/protocol-types';
import { describe, expect, it } from 'bun:test';

// ─── ServerMessage union validation ────────────────────────────────────────
//
// These tests verify the shape of the ServerMessage union type at runtime.
// TypeScript guarantees compile-time safety; the runtime checks below
// confirm that the expected literal shapes are correct.
//
// After the snapshot/delta refactor (kb-13–17) the protocol only carries:
//   - snapshot          (full WorkflowProjection on connect / full resync)
//   - events            (batched EventRecord deltas)
//   - run_complete / run_failed      (run-scoped terminal lifecycle signals)
//
// The old per-event WS message types (init, workflow_phase, agent_spawned,
// agent_log, agent_complete, agent_stats, tasks_updated, workflow_sidebar)
// have been removed — their data now travels inside snapshot/events.

describe('ServerMessage – retained variants', () => {
  it('snapshot variant', () => {
    const msg: ServerMessage = {
      type: 'snapshot',
      runId: 'r1',
      seq: 10,
      state: {
        seq: 10,
        taskPrompt: 'Build it',
        phases: [],
        currentPhaseId: 'coding',
        completedPhaseIds: ['scouting'],
        tasks: {},
        agents: {},
        sidebar: { title: 'Engin', indicator: '🟢' },
        status: 'running',
        stats: { totalTokens: 0, agentCount: 0 },
        runLog: [],
      },
    };
    expect(msg.type).toBe('snapshot');
    expect(msg.seq).toBe(10);
    expect(msg.state.currentPhaseId).toBe('coding');
  });

  it('events variant', () => {
    const msg: ServerMessage = {
      type: 'events',
      runId: 'r1',
      seq: 3,
      events: [
        {
          seq: 3,
          type: 'phase_started',
          data: { phase: 'coding' },
          metadata: { timestamp: new Date().toISOString(), phaseId: 'coding' },
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
      runId: 'r1',
      seq: 0,
      events: [],
    };
    expect(msg.type).toBe('events');
    expect(msg.events).toHaveLength(0);
  });

  it('run_complete variant works unchanged', () => {
    const msg: ServerMessage = { type: 'run_complete', runId: 'r1' };
    expect(msg.type).toBe('run_complete');
    expect(msg.runId).toBe('r1');
  });

  it('run_failed variant works unchanged', () => {
    const msg: ServerMessage = {
      type: 'run_failed',
      runId: 'r1',
      error: 'something broke',
      phase: 'planning',
    };
    expect(msg.error).toBe('something broke');
    expect(msg.phase).toBe('planning');
    expect(msg.runId).toBe('r1');
  });
});
