/**
 * evolve-client parity tests.
 *
 * Verifies that the client-side evolveClient produces the same projection
 * transitions as the engine's src/tracking/evolve.ts for every EventType.
 * Also guards against the kb-11 root-cause regression: re-spawn must
 * preserve accumulated log / tokens / toolCallCount.
 */

import { describe, expect, it } from 'vitest';
import type { EventRecord, WorkflowProjection } from '../protocol-types';
import { evolveClient } from './evolve-client';

// ─── Helpers ────────────────────────────────────────────────────────────────

function blankProjection(overrides?: Partial<WorkflowProjection>): WorkflowProjection {
  return {
    seq: 0,
    taskPrompt: '',
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    tasks: {},
    agents: {},
    sidebar: { title: '', indicator: '' },
    status: 'running',
    stats: { totalTokens: 0, agentCount: 0 },
    runLog: [],
    ...overrides,
  };
}

function event(
  type: EventRecord['type'],
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
  seq = 1,
): EventRecord {
  return {
    seq,
    type,
    data,
    metadata: { timestamp: '2025-01-01T00:00:00.000Z', ...meta },
  };
}

// ─── Workflow lifecycle ────────────────────────────────────────────────────

describe('evolveClient – workflow lifecycle', () => {
  it('workflow_started sets taskPrompt and status', () => {
    const s = evolveClient(blankProjection(), event('workflow_started', { taskPrompt: 'hello' }, {}, 1));
    expect(s.taskPrompt).toBe('hello');
    expect(s.status).toBe('running');
    expect(s.seq).toBe(1);
  });

  it('workflow_completed sets status to complete', () => {
    const s = evolveClient(blankProjection({ seq: 5 }), event('workflow_completed', {}, {}, 6));
    expect(s.status).toBe('complete');
    expect(s.seq).toBe(6);
  });

  it('workflow_failed sets status, error, and failedPhase (from phaseId)', () => {
    const s = evolveClient(blankProjection(), event('workflow_failed', { error: 'boom', phaseId: 'planning' }, {}, 1));
    expect(s.status).toBe('failed');
    expect(s.error).toBe('boom');
    expect(s.failedPhase).toBe('planning');
  });

  it('workflow_falled falls back to phase field', () => {
    const s = evolveClient(blankProjection(), event('workflow_failed', { error: 'boom', phase: 'scouting' }, {}, 1));
    expect(s.failedPhase).toBe('scouting');
  });
});

// ─── Phase lifecycle ───────────────────────────────────────────────────────

describe('evolveClient – phase lifecycle', () => {
  it('phase_registered creates a new PhaseEntity and adds to phases array', () => {
    const s = evolveClient(
      blankProjection(),
      event('phase_registered', { id: 'exec', label: 'Execution', icon: '🚀' }, {}, 1),
    );
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0]).toEqual({
      id: 'exec',
      label: 'Execution',
      icon: '🚀',
      taskIds: [],
    });
    expect(s.seq).toBe(1);
  });

  it('phase_registered is a no-op when phase already registered', () => {
    let s = evolveClient(blankProjection(), event('phase_registered', { id: 'exec', label: 'Execution' }, {}, 1));
    s = evolveClient(s, event('phase_registered', { id: 'exec', label: 'Duplicate' }, {}, 2));
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0].label).toBe('Execution');
    expect(s.seq).toBe(2);
  });

  it('phase_registered ordering: phases appear in registration order', () => {
    const s = evolveClient(
      evolveClient(blankProjection(), event('phase_registered', { id: 'scout', label: 'Scouting', icon: '🔍' }, {}, 1)),
      event('phase_registered', { id: 'exec', label: 'Execution', icon: '🚀' }, {}, 2),
    );
    expect(s.phases).toHaveLength(2);
    expect(s.phases[0].id).toBe('scout');
    expect(s.phases[1].id).toBe('exec');
  });

  it('phase_started sets currentPhaseId', () => {
    const s = evolveClient(blankProjection(), event('phase_started', { phase: 'scouting' }, {}, 1));
    expect(s.currentPhaseId).toBe('scouting');
  });

  it('phase_started uses metadata.phaseId when data.phase absent', () => {
    const s = evolveClient(blankProjection(), event('phase_started', {}, { phaseId: 'exec' }, 1));
    expect(s.currentPhaseId).toBe('exec');
  });

  it('phase_completed adds to completedPhaseIds (no duplicate)', () => {
    let s = evolveClient(blankProjection(), event('phase_completed', { phase: 'scouting' }, {}, 1));
    expect(s.completedPhaseIds).toEqual(['scouting']);

    // Same phase again — should not duplicate
    s = evolveClient(s, event('phase_completed', { phase: 'scouting' }, {}, 2));
    expect(s.completedPhaseIds).toEqual(['scouting']);

    // Different phase
    s = evolveClient(s, event('phase_completed', { phase: 'planning' }, {}, 3));
    expect(s.completedPhaseIds).toEqual(['scouting', 'planning']);
  });

  it('phase_completed defaults to currentPhaseId when no phase given', () => {
    let s = evolveClient(blankProjection(), event('phase_started', { phase: 'exec' }, {}, 1));
    s = evolveClient(s, event('phase_completed', {}, {}, 2));
    expect(s.completedPhaseIds).toEqual(['exec']);
  });
});

// ─── Agent lifecycle ──────────────────────────────────────────────────────

describe('evolveClient – agent lifecycle', () => {
  it('agent_spawned creates a new agent and increments agentCount', () => {
    const s = evolveClient(
      blankProjection(),
      event('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', phaseId: 'exec' }, 1),
    );
    expect(Object.keys(s.agents)).toHaveLength(1);
    expect(s.agents['a1::t1']).toBeDefined();
    expect(s.agents['a1::t1'].agentId).toBe('a1');
    expect(s.agents['a1::t1'].profile).toBe('coder');
    expect(s.agents['a1::t1'].phaseId).toBe('exec');
    expect(s.agents['a1::t1'].active).toBe(true);
    expect(s.agents['a1::t1'].toolCallCount).toBe(0);
    expect(s.agents['a1::t1'].inputTokens).toBe(0);
    expect(s.agents['a1::t1'].outputTokens).toBe(0);
    expect(s.stats.agentCount).toBe(1);
  });

  it('agent_spawned without taskId uses plain key', () => {
    const s = evolveClient(blankProjection(), event('agent_spawned', { profile: 'legacy' }, { agentId: 'legacy' }, 1));
    expect(s.agents['legacy']).toBeDefined();
    expect(s.agents['legacy'].uid).toBe('legacy');
    expect(s.stats.agentCount).toBe(1);
  });

  it('agent_spawned UPSERT preserves accumulated state (kb-11 root-cause)', () => {
    // 1. First spawn
    let s = evolveClient(
      blankProjection(),
      event('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 1),
    );

    // 2. Accumulate some state (simulating turn/tool events)
    s = evolveClient(
      s,
      event(
        'turn_ended',
        { tokens: { input: 100, output: 50 }, contentBlocks: [{ type: 'text', text: 'hello' }] },
        { agentId: 'a1', taskId: 't1' },
        2,
      ),
    );
    s = evolveClient(s, event('tool_call_started', { toolName: 'read' }, { agentId: 'a1', taskId: 't1' }, 3));

    // Verify accumulation
    expect(s.agents['a1::t1'].inputTokens).toBe(100);
    expect(s.agents['a1::t1'].outputTokens).toBe(50);
    expect(s.agents['a1::t1'].toolCallCount).toBe(1);
    expect(s.agents['a1::t1'].log.length).toBe(2); // text + tool_call_start

    // 3. Re-spawn (same agentId + taskId) — should preserve accumulated state
    s = evolveClient(s, event('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 4));

    // Accumulated values must be preserved
    expect(s.agents['a1::t1'].inputTokens).toBe(100);
    expect(s.agents['a1::t1'].outputTokens).toBe(50);
    expect(s.agents['a1::t1'].toolCallCount).toBe(1);
    expect(s.agents['a1::t1'].log.length).toBe(2);
    expect(s.agents['a1::t1'].active).toBe(true);
    // agentCount should NOT increment (same agent re-spawned)
    expect(s.stats.agentCount).toBe(1);
  });

  it('agent_spawned preserves taskTitle from existing task', () => {
    // 1. Register a task
    let s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'My Task',
          phaseId: 'exec',
          steps: [{ name: 'write-tests', profileId: 'coder' }],
        },
        {},
        1,
      ),
    );

    // 2. Spawn agent for that task
    s = evolveClient(s, event('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2));
    expect(s.agents['a1::t1'].taskTitle).toBe('My Task');
  });

  it('agent_completed marks agent inactive', () => {
    let s = evolveClient(
      blankProjection(),
      event('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 1),
    );
    s = evolveClient(s, event('agent_completed', {}, { agentId: 'a1', taskId: 't1', timestamp: '2025-01-01' }, 2));
    expect(s.agents['a1::t1'].active).toBe(false);
    expect(s.agents['a1::t1'].completedAt).toBe('2025-01-01');
  });

  it('agent_completed resolves agent without taskId via search', () => {
    let s = evolveClient(blankProjection(), event('agent_spawned', { profile: 'coder' }, { agentId: 'a1' }, 1));
    // Complete without taskId — should find a1 by agentId search
    s = evolveClient(s, event('agent_completed', {}, { agentId: 'a1', timestamp: '2025-01-01' }, 2));
    expect(s.agents['a1'].active).toBe(false);
  });

  it('agent_completed on unknown agent is a no-op', () => {
    const s = evolveClient(blankProjection(), event('agent_completed', {}, { agentId: 'ghost' }, 1));
    expect(Object.keys(s.agents)).toHaveLength(0);
    expect(s.seq).toBe(1);
  });
});

// ─── Task lifecycle ─────────────────────────────────────────────────────

describe('evolveClient – task lifecycle', () => {
  it('task_registered inserts a new task with steps, phaseId, and dependencies', () => {
    const s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'Task 1',
          phaseId: 'exec',
          steps: [
            { name: 'write', profileId: 'coder' },
            { name: 'review', profileId: 'reviewer', isReadOnly: true },
          ],
          dependencies: ['t0'],
        },
        {},
        1,
      ),
    );
    expect(Object.keys(s.tasks)).toHaveLength(1);
    expect(s.tasks['t1'].title).toBe('Task 1');
    expect(s.tasks['t1'].phaseId).toBe('exec');
    expect(s.tasks['t1'].status).toBe('ready');
    expect(s.tasks['t1'].steps).toHaveLength(2);
    expect(s.tasks['t1'].steps[0].name).toBe('write');
    expect(s.tasks['t1'].steps[0].profile).toBe('coder');
    expect(s.tasks['t1'].steps[0].isReadOnly).toBeFalsy();
    expect(s.tasks['t1'].steps[1].name).toBe('review');
    expect(s.tasks['t1'].steps[1].profile).toBe('reviewer');
    expect(s.tasks['t1'].steps[1].isReadOnly).toBe(true);
    expect(s.tasks['t1'].dependencies).toEqual(['t0']);
    expect(s.tasks['t1'].activeStepIndex).toBeUndefined();
  });

  it('task_registered does not overwrite existing tasks', () => {
    let s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'Original',
          phaseId: 'exec',
          steps: [{ name: 'write', profileId: 'coder' }],
        },
        {},
        1,
      ),
    );
    s = evolveClient(
      s,
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'New',
          phaseId: 'other',
          steps: [{ name: 'write', profileId: 'coder' }],
        },
        {},
        2,
      ),
    );
    expect(s.tasks['t1'].title).toBe('Original');
    expect(s.tasks['t1'].phaseId).toBe('exec');
  });

  it('task_registered appends taskId to owning PhaseEntity.taskIds', () => {
    let s = evolveClient(blankProjection(), event('phase_registered', { id: 'exec', label: 'Exec' }, {}, 1));
    s = evolveClient(
      s,
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'Task',
          phaseId: 'exec',
          steps: [{ name: 'write', profileId: 'coder' }],
        },
        {},
        2,
      ),
    );
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0].taskIds).toEqual(['t1']);
  });

  it('task_registered with data.id as fallback key', () => {
    const s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          id: 't-fallback',
          title: 'Fallback',
          phaseId: 'exec',
          steps: [{ name: 'write', profileId: 'coder' }],
        },
        {},
        1,
      ),
    );
    expect(s.tasks['t-fallback']).toBeDefined();
    expect(s.tasks['t-fallback'].title).toBe('Fallback');
  });

  it('task_started sets status to active', () => {
    let s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'Task',
          phaseId: 'exec',
          steps: [{ name: 'write', profileId: 'coder' }],
        },
        {},
        1,
      ),
    );
    s = evolveClient(s, event('task_started', { taskId: 't1', title: 'Task', agentId: 'a1' }, {}, 2));
    expect(s.tasks['t1'].status).toBe('active');
  });

  it('task_started is a no-op when task does not exist', () => {
    const s = evolveClient(blankProjection(), event('task_started', { taskId: 'ghost', title: 'Ghost' }, {}, 1));
    expect(s.tasks['ghost']).toBeUndefined();
    expect(s.seq).toBe(1);
  });

  it('step_started sets activeStepIndex on the task', () => {
    let s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'T',
          phaseId: 'exec',
          steps: [
            { name: 'write', profileId: 'coder' },
            { name: 'review', profileId: 'reviewer' },
          ],
        },
        {},
        1,
      ),
    );
    s = evolveClient(s, event('step_started', { taskId: 't1', stepIndex: 1 }, {}, 2));
    expect(s.tasks['t1'].activeStepIndex).toBe(1);
  });

  it('step_started links agentKey when agentId provided in metadata', () => {
    let s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'T',
          phaseId: 'exec',
          steps: [
            { name: 'write', profileId: 'coder' },
            { name: 'review', profileId: 'reviewer' },
          ],
        },
        {},
        1,
      ),
    );
    // Spawn agent for step 0
    s = evolveClient(s, event('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', stepIndex: 0 }, 2));
    // Start step 0 with agent link
    s = evolveClient(s, event('step_started', { taskId: 't1', stepIndex: 0, agentId: 'a1' }, { taskId: 't1' }, 3));
    expect(s.tasks['t1'].activeStepIndex).toBe(0);
    expect(s.tasks['t1'].steps[0].agentKey).toBe('a1::t1');
  });

  it('step_started is a no-op when task does not exist', () => {
    const s = evolveClient(blankProjection(), event('step_started', { taskId: 'ghost', stepIndex: 0 }, {}, 1));
    expect(s.seq).toBe(1);
  });

  it('step_started is a no-op when stepIndex is not a number', () => {
    let s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'T',
          phaseId: 'exec',
          steps: [{ name: 'write', profileId: 'coder' }],
        },
        {},
        1,
      ),
    );
    s = evolveClient(s, event('step_started', { taskId: 't1', stepIndex: 'invalid' }, {}, 2));
    expect(s.tasks['t1'].activeStepIndex).toBeUndefined();
  });

  it('task_completed sets status to complete and clears activeStepIndex', () => {
    let s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'T',
          phaseId: 'exec',
          steps: [{ name: 'write', profileId: 'coder' }],
        },
        {},
        1,
      ),
    );
    s = evolveClient(s, event('task_started', { taskId: 't1', title: 'T' }, {}, 2));
    s = evolveClient(s, event('step_started', { taskId: 't1', stepIndex: 0 }, {}, 3));
    s = evolveClient(s, event('task_completed', { taskId: 't1' }, { timestamp: '2025-01-01' }, 4));
    expect(s.tasks['t1'].status).toBe('complete');
    expect(s.tasks['t1'].completedAt).toBe('2025-01-01');
    // activeStepIndex is NOT automatically cleared by task_completed (handled by consumer)
  });

  it('task_rejected sets status failed', () => {
    let s = evolveClient(
      blankProjection(),
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'T',
          phaseId: 'exec',
          steps: [{ name: 'write', profileId: 'coder' }],
        },
        {},
        1,
      ),
    );
    s = evolveClient(s, event('task_started', { taskId: 't1', title: 'T' }, {}, 2));
    s = evolveClient(s, event('task_rejected', { taskId: 't1' }, {}, 3));
    expect(s.tasks['t1'].status).toBe('failed');
  });

  it('task_completed on unknown task is a no-op', () => {
    const s = evolveClient(blankProjection(), event('task_completed', { taskId: 'ghost' }, {}, 1));
    expect(Object.keys(s.tasks)).toHaveLength(0);
    expect(s.seq).toBe(1);
  });
});

// ─── Agent log / decisions / errors ─────────────────────────────────────

describe('evolveClient – agent log, decisions, errors', () => {
  it('decision adds a log entry', () => {
    let s = evolveClient(blankProjection(), event('agent_spawned', { profile: 'p' }, { agentId: 'a1' }, 1));
    s = evolveClient(s, event('decision', { decision: 'go left', reasoning: 'because' }, { agentId: 'a1' }, 2));
    expect(s.agents['a1'].log).toHaveLength(1);
    expect(s.agents['a1'].log[0].type).toBe('decision');
    expect(s.agents['a1'].log[0].content).toBe('go left');
  });

  it('error adds a log entry', () => {
    let s = evolveClient(blankProjection(), event('agent_spawned', { profile: 'p' }, { agentId: 'a1' }, 1));
    s = evolveClient(s, event('error', { error: 'oops' }, { agentId: 'a1' }, 2));
    expect(s.agents['a1'].log).toHaveLength(1);
    expect(s.agents['a1'].log[0].type).toBe('error');
    expect(s.agents['a1'].log[0].content).toBe('oops');
  });

  it('decision on unknown agent is a no-op', () => {
    const s = evolveClient(blankProjection(), event('decision', { decision: 'x' }, { agentId: 'ghost' }, 1));
    expect(Object.keys(s.agents)).toHaveLength(0);
    expect(s.seq).toBe(1);
  });
});

// ─── Turn lifecycle ─────────────────────────────────────────────────────

describe('evolveClient – turn lifecycle', () => {
  it('turn_started is a no-op (just bumps seq)', () => {
    const s = evolveClient(blankProjection(), event('turn_started', {}, { agentId: 'a1' }, 1));
    expect(s.seq).toBe(1);
  });

  it('turn_ended accumulates tokens and adds text/thinking log entries', () => {
    let s = evolveClient(blankProjection(), event('agent_spawned', { profile: 'p' }, { agentId: 'a1' }, 1));
    s = evolveClient(
      s,
      event(
        'turn_ended',
        {
          tokens: { input: 200, output: 100 },
          contentBlocks: [
            { type: 'text', text: 'Hello world' },
            { type: 'thinking', thinking: 'Hmm...' },
          ],
        },
        { agentId: 'a1' },
        2,
      ),
    );
    expect(s.agents['a1'].inputTokens).toBe(200);
    expect(s.agents['a1'].outputTokens).toBe(100);
    expect(s.agents['a1'].log).toHaveLength(2);
    expect(s.agents['a1'].log[0].type).toBe('text');
    expect(s.agents['a1'].log[0].content).toBe('Hello world');
    expect(s.agents['a1'].log[1].type).toBe('thinking');
    expect(s.agents['a1'].log[1].content).toBe('Hmm...');
    expect(s.stats.totalTokens).toBe(300);
  });

  it('turn_ended on unknown agent is a no-op', () => {
    const s = evolveClient(
      blankProjection(),
      event('turn_ended', { tokens: { input: 10, output: 5 } }, { agentId: 'ghost' }, 1),
    );
    expect(s.seq).toBe(1);
    expect(s.stats.totalTokens).toBe(0);
  });
});

// ─── Tool call lifecycle ────────────────────────────────────────────────

describe('evolveClient – tool call lifecycle', () => {
  it('tool_call_started increments toolCallCount and adds log', () => {
    let s = evolveClient(blankProjection(), event('agent_spawned', { profile: 'p' }, { agentId: 'a1' }, 1));
    s = evolveClient(
      s,
      event(
        'tool_call_started',
        { toolName: 'read_file', toolCallId: 'tc1', arguments: { path: 'a.ts' } },
        { agentId: 'a1' },
        2,
      ),
    );
    expect(s.agents['a1'].toolCallCount).toBe(1);
    expect(s.agents['a1'].log).toHaveLength(1);
    expect(s.agents['a1'].log[0].type).toBe('tool_call_start');
    expect(s.agents['a1'].log[0].content).toBe('read_file');
    expect(s.agents['a1'].log[0].metadata?.toolCallId).toBe('tc1');
    // arguments are preserved so the UI can render a human-readable summary
    expect(s.agents['a1'].log[0].metadata?.arguments).toEqual({ path: 'a.ts' });
  });

  it('tool_call_ended adds a log entry (no count increment)', () => {
    let s = evolveClient(blankProjection(), event('agent_spawned', { profile: 'p' }, { agentId: 'a1' }, 1));
    s = evolveClient(s, event('tool_call_started', { toolName: 'read_file' }, { agentId: 'a1' }, 2));
    s = evolveClient(s, event('tool_call_ended', { toolName: 'read_file', isError: false }, { agentId: 'a1' }, 3));
    // toolCallCount only incremented on started, not ended
    expect(s.agents['a1'].toolCallCount).toBe(1);
    expect(s.agents['a1'].log).toHaveLength(2);
    expect(s.agents['a1'].log[1].type).toBe('tool_call_end');
  });

  it('tool_call_started on unknown agent is a no-op', () => {
    const s = evolveClient(blankProjection(), event('tool_call_started', { toolName: 'x' }, { agentId: 'ghost' }, 1));
    expect(s.seq).toBe(1);
  });
});

// ─── Sidebar ────────────────────────────────────────────────────────────

describe('evolveClient – sidebar', () => {
  it('sidebar_updated patches title and indicator', () => {
    const s = evolveClient(blankProjection(), event('sidebar_updated', { title: 'My App', indicator: 'green' }, {}, 1));
    expect(s.sidebar.title).toBe('My App');
    expect(s.sidebar.indicator).toBe('green');
  });

  it('sidebar_updated no longer updates phases (use phase_registered)', () => {
    const s = evolveClient(
      blankProjection(),
      event('sidebar_updated', { phases: [{ id: 'p1', label: 'Phase 1' }] }, {}, 1),
    );
    // phases should NOT be present on sidebar; they live on projection.phases
    expect((s.sidebar as Record<string, unknown>).phases).toBeUndefined();
  });
});

// ─── Log cap at 500 ────────────────────────────────────────────────────

describe('evolveClient – log cap', () => {
  it('caps agent log at 500 entries', () => {
    let s = evolveClient(blankProjection(), event('agent_spawned', { profile: 'p' }, { agentId: 'a1' }, 1));

    // Add 510 decisions to exceed the cap
    for (let i = 2; i <= 511; i++) {
      s = evolveClient(s, event('decision', { decision: `d-${i}` }, { agentId: 'a1' }, i));
    }

    expect(s.agents['a1'].log.length).toBe(500);
    // First retained entry should be d-12 (entries 12..511 = 500 entries)
    expect(s.agents['a1'].log[0].content).toBe('d-12');
    expect(s.agents['a1'].log[499].content).toBe('d-511');
  });
});

// ─── Full event sequence parity ─────────────────────────────────────────

describe('evolveClient – full sequence parity', () => {
  it('spawn → turn → tool_call → turn accumulates correctly', () => {
    let s = blankProjection();

    // 1. workflow_started
    s = evolveClient(s, event('workflow_started', { taskPrompt: 'build it' }, {}, 1));
    expect(s.taskPrompt).toBe('build it');
    expect(s.status).toBe('running');

    // 2. phase_started
    s = evolveClient(s, event('phase_started', { phase: 'exec' }, {}, 2));
    expect(s.currentPhaseId).toBe('exec');

    // 3. task_registered
    s = evolveClient(
      s,
      event(
        'task_registered',
        {
          taskId: 't1',
          title: 'Task 1',
          phaseId: 'exec',
          steps: [{ name: 'write', profileId: 'coder' }],
        },
        {},
        3,
      ),
    );
    expect(s.tasks['t1'].title).toBe('Task 1');

    // 4. task_started
    s = evolveClient(
      s,
      event('task_started', { taskId: 't1', title: 'Task 1', agentId: 'a1' }, { phaseId: 'exec' }, 4),
    );
    expect(s.tasks['t1'].status).toBe('active');

    // 5. agent_spawned
    s = evolveClient(
      s,
      event('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', phaseId: 'exec' }, 5),
    );
    expect(s.agents['a1::t1'].active).toBe(true);
    expect(s.stats.agentCount).toBe(1);

    // 6. turn_ended with tokens
    s = evolveClient(
      s,
      event('turn_ended', { tokens: { input: 500, output: 200 } }, { agentId: 'a1', taskId: 't1' }, 6),
    );
    expect(s.agents['a1::t1'].inputTokens).toBe(500);
    expect(s.agents['a1::t1'].outputTokens).toBe(200);
    expect(s.stats.totalTokens).toBe(700);

    // 7. tool_call_started
    s = evolveClient(s, event('tool_call_started', { toolName: 'write_file' }, { agentId: 'a1', taskId: 't1' }, 7));
    expect(s.agents['a1::t1'].toolCallCount).toBe(1);

    // 8. tool_call_ended
    s = evolveClient(
      s,
      event('tool_call_ended', { toolName: 'write_file', isError: false }, { agentId: 'a1', taskId: 't1' }, 8),
    );
    expect(s.agents['a1::t1'].log).toHaveLength(2); // tool_call_start + tool_call_end

    // 9. turn_ended with more tokens + content
    s = evolveClient(
      s,
      event(
        'turn_ended',
        {
          tokens: { input: 300, output: 100 },
          contentBlocks: [{ type: 'text', text: 'done' }],
        },
        { agentId: 'a1', taskId: 't1' },
        9,
      ),
    );
    expect(s.agents['a1::t1'].inputTokens).toBe(800);
    expect(s.agents['a1::t1'].outputTokens).toBe(300);
    expect(s.agents['a1::t1'].log).toHaveLength(3); // + text
    expect(s.stats.totalTokens).toBe(1100);

    // 10. agent_completed
    s = evolveClient(s, event('agent_completed', {}, { agentId: 'a1', taskId: 't1', timestamp: '2025-01-01' }, 10));
    expect(s.agents['a1::t1'].active).toBe(false);

    // 11. task_completed
    s = evolveClient(s, event('task_completed', { taskId: 't1' }, { timestamp: '2025-01-01' }, 11));
    expect(s.tasks['t1'].status).toBe('complete');

    // 12. phase_completed
    s = evolveClient(s, event('phase_completed', { phase: 'exec' }, {}, 12));
    expect(s.completedPhaseIds).toEqual(['exec']);

    // 13. workflow_completed
    s = evolveClient(s, event('workflow_completed', {}, {}, 13));
    expect(s.status).toBe('complete');
    expect(s.seq).toBe(13);
  });

  it('spawn → re-spawn preserves accumulated state (kb-11 regression)', () => {
    let s = blankProjection();

    // First spawn
    s = evolveClient(s, event('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 1));

    // Accumulate state
    s = evolveClient(s, event('tool_call_started', { toolName: 'a' }, { agentId: 'a1', taskId: 't1' }, 2));
    s = evolveClient(s, event('tool_call_started', { toolName: 'b' }, { agentId: 'a1', taskId: 't1' }, 3));
    s = evolveClient(s, event('turn_ended', { tokens: { input: 50, output: 25 } }, { agentId: 'a1', taskId: 't1' }, 4));
    s = evolveClient(s, event('decision', { decision: 'proceed' }, { agentId: 'a1', taskId: 't1' }, 5));

    // Verify pre-re-spawn state
    expect(s.agents['a1::t1'].toolCallCount).toBe(2);
    expect(s.agents['a1::t1'].inputTokens).toBe(50);
    expect(s.agents['a1::t1'].outputTokens).toBe(25);
    expect(s.agents['a1::t1'].log.length).toBe(3); // 2 tool_starts + 1 decision
    expect(s.agents['a1::t1'].active).toBe(true);
    expect(s.stats.agentCount).toBe(1);

    // Re-spawn
    s = evolveClient(s, event('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 6));

    // ALL accumulated state must be preserved
    expect(s.agents['a1::t1'].toolCallCount).toBe(2);
    expect(s.agents['a1::t1'].inputTokens).toBe(50);
    expect(s.agents['a1::t1'].outputTokens).toBe(25);
    expect(s.agents['a1::t1'].log.length).toBe(3);
    expect(s.agents['a1::t1'].active).toBe(true); // re-activated
    expect(s.agents['a1::t1'].completedAt).toBeUndefined(); // cleared
    // agentCount must NOT increment
    expect(s.stats.agentCount).toBe(1);

    // Continue accumulating after re-spawn
    s = evolveClient(s, event('tool_call_started', { toolName: 'c' }, { agentId: 'a1', taskId: 't1' }, 7));
    s = evolveClient(
      s,
      event(
        'turn_ended',
        { tokens: { input: 30, output: 15 }, contentBlocks: [{ type: 'text', text: 'done' }] },
        { agentId: 'a1', taskId: 't1' },
        8,
      ),
    );

    expect(s.agents['a1::t1'].toolCallCount).toBe(3);
    expect(s.agents['a1::t1'].inputTokens).toBe(80);
    expect(s.agents['a1::t1'].outputTokens).toBe(40);
    expect(s.agents['a1::t1'].log.length).toBe(5); // 3 prior + tool_start + text
  });
});

// ── Shared evolve-parity fixture ─────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ParityScenario {
  name: string;
  events: EventRecord[];
  expect: Record<string, unknown>;
}

const scenarios: ParityScenario[] = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../tests/fixtures/evolve-parity.json'), 'utf-8'),
);

/**
 * Deep subset assertion. Recursively walks `expected` and asserts that
 * every leaf value matches `actual`.  Supports a special `{ length: N }
 * sentinel for asserting array lengths without enumerating every entry.
 */
function assertSubset(actual: unknown, expected: unknown): void {
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
      assertSubset((actual as unknown[])[i], expected[i]);
    }
    return;
  }
  // Plain object
  expect(actual && typeof actual === 'object').toBe(true);
  for (const [key, val] of Object.entries(expected)) {
    if (val === undefined) {
      expect((actual as Record<string, unknown>)[key]).toBeUndefined();
    } else {
      assertSubset((actual as Record<string, unknown>)[key], val);
    }
  }
}

describe('evolveClient – shared parity fixture', () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      let s = blankProjection();
      for (const evt of scenario.events) {
        s = evolveClient(s, evt);
      }
      assertSubset(s, scenario.expect);
    });
  }
});
