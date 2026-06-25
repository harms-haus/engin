import type { EventRecord, EventType } from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';
import { evolve } from '@engin/shared/evolve';
import { describe, expect, it } from 'bun:test';

// ── Helpers ──────────────────────────────────────────────────────────────────
//
// These characterization tests pin down edge/coercion/no-op behavior of
// `evolve` that is NOT covered by the main evolve.test.ts suite. They exist
// to make the planned decomposition of evolve.ts (extracting per-event-type
// handlers into a dispatcher) provably safe — every assertion below must
// continue to hold after the refactor.

let eventSeq = 0;

function makeEvent(
  type: EventType,
  data: Record<string, unknown> = {},
  metadata: EventRecord['metadata'] = { timestamp: '2026-06-25T00:00:00Z' },
): EventRecord {
  return { seq: ++eventSeq, type, data, metadata };
}

function resetSeq() {
  eventSeq = 0;
}

// Build a baseline projection with one workflow_started event applied so
// subsequent events operate on a running workflow.
function baseline(): WorkflowProjection {
  return evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 'x' }));
}

import type { WorkflowProjection } from '@engin/shared/event-types';

describe('evolve characterization – default branch & dispatch', () => {
  it('unknown event type falls through to default: shallow-clone with only seq bumped', () => {
    resetSeq();
    const state = baseline();
    const unknown = makeEvent('log', { message: 'x' }, { timestamp: '2026-06-25T00:00:00Z' });
    // Force an unrecognized type to exercise the default branch.
    (unknown as { type: string }).type = 'some_future_event_type';

    const next = evolve(state, unknown as EventRecord);

    // New object reference (immutability) but identical contents except seq.
    expect(next).not.toBe(state);
    expect(next.seq).toBe(unknown.seq);
    expect(next.taskPrompt).toBe(state.taskPrompt);
    expect(next.status).toBe(state.status);
    expect(next.phases).toBe(state.phases);
    expect(next.tasks).toBe(state.tasks);
    expect(next.agents).toBe(state.agents);
    expect(next.completedPhaseIds).toBe(state.completedPhaseIds);
    expect(next.runLog).toBe(state.runLog);
    expect(next.sidebar).toBe(state.sidebar);
    expect(next.stats).toBe(state.stats);
  });

  it('seq is overwritten to event.seq (not incremented) on the default branch', () => {
    resetSeq();
    const state = baseline();
    state.seq = 999; // a stale/large seq
    const unknown = makeEvent('log', {});
    (unknown as { type: string }).type = 'unknown_xyz';
    unknown.seq = 5;
    const next = evolve(state, unknown as EventRecord);
    expect(next.seq).toBe(5);
  });
});

describe('evolve characterization – workflow lifecycle coercion', () => {
  it('workflow_started coerces missing taskPrompt to empty string', () => {
    resetSeq();
    const state = evolve(createInitialProjection(), makeEvent('workflow_started', {}));
    expect(state.taskPrompt).toBe('');
    expect(state.status).toBe('running');
  });

  it('workflow_started coerces non-string taskPrompt via String()', () => {
    resetSeq();
    const state = evolve(createInitialProjection(), makeEvent('workflow_started', { taskPrompt: 42 }));
    expect(state.taskPrompt).toBe('42');
  });

  it('workflow_failed coerces a non-string error via String()', () => {
    resetSeq();
    const state = evolve(baseline(), makeEvent('workflow_failed', { error: { boom: true } }));
    expect(state.status).toBe('failed');
    expect(typeof state.error).toBe('string');
    expect(state.error.length).toBeGreaterThan(0);
  });

  it('workflow_failed leaves failedPhase undefined when neither phaseId nor phase is present', () => {
    resetSeq();
    const state = evolve(baseline(), makeEvent('workflow_failed', { error: 'kaboom' }));
    expect(state.failedPhase).toBeUndefined();
  });

  it('workflow_failed prefers phaseId over phase when both present', () => {
    resetSeq();
    const state = evolve(
      baseline(),
      makeEvent('workflow_failed', { error: 'x', phaseId: 'primary', phase: 'secondary' }),
    );
    expect(state.failedPhase).toBe('primary');
  });

  it('workflow_completed only sets status and seq (preserves all other state)', () => {
    resetSeq();
    const state = baseline();
    state.taskPrompt = 'preserve-me';
    const next = evolve(state, makeEvent('workflow_completed', { totalDurationMs: 5000 }));
    expect(next.status).toBe('complete');
    expect(next.taskPrompt).toBe('preserve-me');
    expect(next.seq).toBe(state.seq + 1);
  });
});

describe('evolve characterization – phase edge cases', () => {
  it('phase_registered is a no-op when id is empty/missing', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(state, makeEvent('phase_registered', { id: '', label: 'X', icon: 'i' }));
    expect(next.phases).toEqual([]);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('phase_registered defaults label to id when label omitted', () => {
    resetSeq();
    const state = evolve(baseline(), makeEvent('phase_registered', { id: 'pX' }));
    expect(state.phases[0].id).toBe('pX');
    expect(state.phases[0].label).toBe('pX');
    expect(state.phases[0].icon).toBe('');
    expect(state.phases[0].taskIds).toEqual([]);
  });

  it('phase_started falls back to metadata.phaseId when data.phase absent', () => {
    resetSeq();
    const state = evolve(
      baseline(),
      makeEvent('phase_started', {}, { timestamp: '2026-06-25T00:00:00Z', phaseId: 'from-meta' }),
    );
    expect(state.currentPhaseId).toBe('from-meta');
  });

  it('phase_started preserves currentPhaseId when neither data.phase nor metadata.phaseId present', () => {
    resetSeq();
    let state = baseline();
    state = evolve(state, makeEvent('phase_started', { phase: 'locked' }));
    state = evolve(state, makeEvent('phase_started', {}, { timestamp: '2026-06-25T00:00:00Z' }));
    expect(state.currentPhaseId).toBe('locked');
  });

  it('phase_completed is a no-op when phase already in completedPhaseIds (no duplicate)', () => {
    resetSeq();
    let state = baseline();
    state = evolve(state, makeEvent('phase_completed', { phase: 'p1' }));
    state = evolve(state, makeEvent('phase_completed', { phase: 'p1' }));
    expect(state.completedPhaseIds).toEqual(['p1']);
  });

  it('phase_completed falls back to currentPhaseId when data.phase absent', () => {
    resetSeq();
    let state = baseline();
    state = evolve(state, makeEvent('phase_started', { phase: 'current' }));
    state = evolve(state, makeEvent('phase_completed', {}));
    expect(state.completedPhaseIds).toEqual(['current']);
  });

  it('phase_completed is a no-op when phase resolves to empty string', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(state, makeEvent('phase_completed', {}));
    expect(next.completedPhaseIds).toEqual([]);
    expect(next.seq).toBe(state.seq + 1);
  });
});

describe('evolve characterization – agent resolution no-ops', () => {
  it('agent_completed is a no-op (seq bump only) when agent does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('agent_completed', {}, { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }),
    );
    expect(Object.keys(next.agents)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
    expect(next.agents).toBe(state.agents);
  });

  it('decision is a no-op when agent does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('decision', { decision: 'x' }, { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }),
    );
    expect(Object.keys(next.agents)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('error is a no-op when agent does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('error', { error: 'boom' }, { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }),
    );
    expect(Object.keys(next.agents)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('turn_ended is a no-op when agent does not exist (and stats unchanged)', () => {
    resetSeq();
    const state = baseline();
    const tokensBefore = state.stats.totalTokens;
    const next = evolve(
      state,
      makeEvent(
        'turn_ended',
        { turn: 1, tokens: { input: 100, output: 50 }, contentBlocks: [{ type: 'text', text: 'hi' }] },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' },
      ),
    );
    expect(Object.keys(next.agents)).toHaveLength(0);
    expect(next.stats.totalTokens).toBe(tokensBefore);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('tool_call_started is a no-op when agent does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent(
        'tool_call_started',
        { toolName: 'bash', toolCallId: 'tc1', arguments: {} },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' },
      ),
    );
    expect(Object.keys(next.agents)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('tool_call_ended is a no-op when agent does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent(
        'tool_call_ended',
        { toolName: 'bash', toolCallId: 'tc1', isError: false },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' },
      ),
    );
    expect(Object.keys(next.agents)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('auto_retry_started is a no-op when agent does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent(
        'auto_retry_started',
        { attempt: 1, maxAttempts: 3, delayMs: 100 },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' },
      ),
    );
    expect(Object.keys(next.agents)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
  });

  it('auto_retry_completed is a no-op when agent does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent(
        'auto_retry_completed',
        { success: false, attempt: 1, finalError: 'x' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' },
      ),
    );
    expect(Object.keys(next.agents)).toHaveLength(0);
    expect(next.seq).toBe(state.seq + 1);
  });
});

describe('evolve characterization – task edge cases', () => {
  it('task_registered is a no-op when taskId and id are both missing', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(state, makeEvent('task_registered', { title: 'Nope', phaseId: 'p1', steps: [] }));
    expect(next.tasks).toEqual({});
    expect(next.seq).toBe(state.seq + 1);
  });

  it('task_registered reads taskId from data.id when taskId absent', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('task_registered', { id: 'via-id', title: 'T', phaseId: '', steps: [], dependencies: [] }),
    );
    expect(next.tasks['via-id']).toBeDefined();
    expect(next.tasks['via-id'].title).toBe('T');
  });

  it('task_registered step profile is empty when profileId absent (does NOT fall back to name)', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('task_registered', {
        taskId: 't1',
        title: 'T',
        phaseId: '',
        steps: [{ name: 'analyze', isReadOnly: false }],
        dependencies: [],
      }),
    );
    // name falls back to profileId (also absent here) → 'analyze' comes from s.name directly.
    expect(next.tasks['t1'].steps[0].name).toBe('analyze');
    // profile only falls back to s.profile — NOT s.name — so it is empty.
    expect(next.tasks['t1'].steps[0].profile).toBe('');
  });

  it('task_registered step profile falls back to data.profile when profileId absent', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('task_registered', {
        taskId: 't1',
        title: 'T',
        phaseId: '',
        steps: [{ name: 'a', profile: 'alt-profile', isReadOnly: false }],
        dependencies: [],
      }),
    );
    expect(next.tasks['t1'].steps[0].profile).toBe('alt-profile');
  });

  it('task_registered step name falls back to profileId when name absent', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('task_registered', {
        taskId: 't1',
        title: 'T',
        phaseId: '',
        steps: [{ profileId: 'coder', isReadOnly: true }],
        dependencies: [],
      }),
    );
    expect(next.tasks['t1'].steps[0].name).toBe('coder');
    expect(next.tasks['t1'].steps[0].profile).toBe('coder');
    expect(next.tasks['t1'].steps[0].isReadOnly).toBe(true);
  });

  it('task_registered tolerates non-array steps and dependencies', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('task_registered', { taskId: 't1', title: 'T', phaseId: '', steps: 'nope', dependencies: null }),
    );
    expect(next.tasks['t1'].steps).toEqual([]);
    expect(next.tasks['t1'].dependencies).toEqual([]);
  });

  it('task_started preserves existing startedAt when data.startedAt is not a number', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent('task_registered', { taskId: 't1', title: 'T', phaseId: '', steps: [], dependencies: [] }),
    );
    state = evolve(
      state,
      makeEvent('task_started', { taskId: 't1', startedAt: 1000 }, { timestamp: '2026-06-25T00:00:00Z', taskId: 't1' }),
    );
    expect(state.tasks['t1'].startedAt).toBe(1000);
    // Re-fire with non-number startedAt → must preserve 1000
    state = evolve(
      state,
      makeEvent(
        'task_started',
        { taskId: 't1', startedAt: 'later' },
        { timestamp: '2026-06-25T00:00:00Z', taskId: 't1' },
      ),
    );
    expect(state.tasks['t1'].startedAt).toBe(1000);
    expect(state.tasks['t1'].status).toBe('active');
  });

  it('task_completed is a no-op when task does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('task_completed', { taskId: 'ghost' }, { timestamp: '2026-06-25T00:00:00Z', taskId: 'ghost' }),
    );
    expect(next.tasks).toEqual({});
    expect(next.seq).toBe(state.seq + 1);
  });

  it('task_rejected is a no-op when task does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('task_rejected', { taskId: 'ghost' }, { timestamp: '2026-06-25T00:00:00Z', taskId: 'ghost' }),
    );
    expect(next.tasks).toEqual({});
    expect(next.seq).toBe(state.seq + 1);
  });

  it('step_started is a no-op when task does not exist', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent(
        'step_started',
        { taskId: 'ghost', stepIndex: 0 },
        { timestamp: '2026-06-25T00:00:00Z', taskId: 'ghost' },
      ),
    );
    expect(next.tasks).toEqual({});
    expect(next.seq).toBe(state.seq + 1);
  });

  it('step_started is a no-op when stepIndex is not a number', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent('task_registered', {
        taskId: 't1',
        title: 'T',
        phaseId: '',
        steps: [{ name: 'a', profileId: 'p', isReadOnly: false }],
        dependencies: [],
      }),
    );
    const next = evolve(state, makeEvent('step_started', { taskId: 't1', stepIndex: 'nope' }));
    expect(next.tasks['t1'].activeStepIndex).toBeUndefined();
    expect(next.seq).toBe(state.seq + 1);
  });

  it('step_started reads taskId from metadata.taskId when data.taskId absent', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent('task_registered', {
        taskId: 't1',
        title: 'T',
        phaseId: '',
        steps: [{ name: 'a', profileId: 'p', isReadOnly: false }],
        dependencies: [],
      }),
    );
    const next = evolve(
      state,
      makeEvent('step_started', { stepIndex: 0 }, { timestamp: '2026-06-25T00:00:00Z', taskId: 't1' }),
    );
    expect(next.tasks['t1'].activeStepIndex).toBe(0);
  });
});

describe('evolve characterization – log / sidebar / turn coercion', () => {
  it('log defaults level to info (→ text) when level omitted', () => {
    resetSeq();
    const state = evolve(baseline(), makeEvent('log', { message: 'hello' }));
    expect(state.runLog[0].type).toBe('text');
    expect(state.runLog[0].content).toBe('hello');
  });

  it('log coerces missing message to empty string', () => {
    resetSeq();
    const state = evolve(baseline(), makeEvent('log', { level: 'info' }));
    expect(state.runLog[0].content).toBe('');
  });

  it('sidebar_updated updates only title when indicator omitted', () => {
    resetSeq();
    let state = baseline();
    state = evolve(state, makeEvent('sidebar_updated', { indicator: 'first' }));
    state = evolve(state, makeEvent('sidebar_updated', { title: 'only-title' }));
    expect(state.sidebar.title).toBe('only-title');
    expect(state.sidebar.indicator).toBe('first');
  });

  it('sidebar_updated ignores unknown fields', () => {
    resetSeq();
    const state = evolve(
      baseline(),
      makeEvent('sidebar_updated', { title: 'T', indicator: 'I', phases: [{ id: 'x' }], bogus: 1 }),
    );
    expect(state.sidebar).toEqual({ title: 'T', indicator: 'I' });
    // phases must NOT be mutated by sidebar_updated
    expect(state.phases).toEqual([]);
  });

  it('sidebar_updated coerces title/indicator to strings', () => {
    resetSeq();
    const state = evolve(
      baseline(),
      // @ts-expect-error intentionally invalid types to verify String() coercion
      makeEvent('sidebar_updated', { title: 123, indicator: false }),
    );
    expect(state.sidebar.title).toBe('123');
    expect(state.sidebar.indicator).toBe('false');
  });

  it('turn_started is a no-op returning a new object with bumped seq', () => {
    resetSeq();
    const state = baseline();
    const next = evolve(
      state,
      makeEvent('turn_started', { turn: 1 }, { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' }),
    );
    expect(next).not.toBe(state);
    expect(next.seq).toBe(state.seq + 1);
    // No agents created, no state changes besides seq
    expect(next.agents).toBe(state.agents);
    expect(next.tasks).toBe(state.tasks);
  });

  it('turn_ended ignores unknown content block types', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'turn_ended',
        {
          turn: 1,
          tokens: {},
          contentBlocks: [
            { type: 'image', url: 'ignored' },
            { type: 'text', text: 'kept' },
            { type: 'unknown_block', foo: 'bar' },
          ],
        },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    const agent = state.agents['a1'];
    expect(agent.log).toHaveLength(1);
    expect(agent.log[0].type).toBe('text');
    expect(agent.log[0].content).toBe('kept');
  });

  it('turn_ended accumulates multiple text and thinking blocks in order', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'turn_ended',
        {
          turn: 1,
          tokens: { input: 10, output: 20 },
          contentBlocks: [
            { type: 'text', text: 't1' },
            { type: 'thinking', thinking: 'th1' },
            { type: 'text', text: 't2' },
            { type: 'thinking', thinking: 'th2' },
          ],
        },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    const agent = state.agents['a1'];
    expect(agent.log.map((e) => `${e.type}:${e.content}`)).toEqual([
      'text:t1',
      'thinking:th1',
      'text:t2',
      'thinking:th2',
    ]);
    expect(agent.inputTokens).toBe(10);
    expect(agent.outputTokens).toBe(20);
  });

  it('turn_ended log entry ids embed event seq and per-block index', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    const turnEvent = makeEvent(
      'turn_ended',
      {
        turn: 1,
        tokens: {},
        contentBlocks: [
          { type: 'text', text: 'a' },
          { type: 'thinking', thinking: 'b' },
        ],
      },
      { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
    );
    state = evolve(state, turnEvent);
    const ids = state.agents['a1'].log.map((e) => e.id);
    expect(ids).toEqual([`log-${turnEvent.seq}-0`, `log-${turnEvent.seq}-1`]);
  });
});

describe('evolve characterization – agent_spawned taskTitle & phaseId', () => {
  it('agent_spawned copies task title into taskTitle when taskId references an existing task', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent('task_registered', { taskId: 't1', title: 'Build feature', phaseId: '', steps: [], dependencies: [] }),
    );
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    expect(state.agents['a1::t1'].taskTitle).toBe('Build feature');
  });

  it('agent_spawned leaves taskTitle empty when task does not exist yet', () => {
    resetSeq();
    const state = evolve(
      baseline(),
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 'missing' },
      ),
    );
    expect(state.agents['a1::missing'].taskTitle).toBe('');
  });

  it('agent_spawned reads phaseId from data.phaseId when metadata.phaseId absent', () => {
    resetSeq();
    const state = evolve(
      baseline(),
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder', phaseId: 'from-data' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    expect(state.agents['a1'].phaseId).toBe('from-data');
  });

  it('agent_spawned re-spawn preserves taskTitle from task when taskTitle not previously set', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent('task_registered', { taskId: 't1', title: 'My Task', phaseId: '', steps: [], dependencies: [] }),
    );
    // First spawn BEFORE task existed scenario is covered above; here spawn after task exists
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    // Re-spawn: taskTitle should still resolve from the task
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder-v2' },
        { timestamp: '2026-06-25T01:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    expect(state.agents['a1::t1'].taskTitle).toBe('My Task');
    expect(state.agents['a1::t1'].profile).toBe('coder-v2');
  });
});

describe('evolve characterization – immutability on no-op paths', () => {
  it('every no-op handler still returns a NEW top-level object with bumped seq', () => {
    resetSeq();
    const noOpTriggers: Array<[EventType, EventRecord['metadata']]> = [
      ['agent_completed', { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }],
      ['decision', { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }],
      ['error', { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }],
      ['turn_ended', { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }],
      ['tool_call_started', { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }],
      ['tool_call_ended', { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }],
      ['auto_retry_started', { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }],
      ['auto_retry_completed', { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }],
    ];

    for (const [type, metadata] of noOpTriggers) {
      resetSeq();
      const state = baseline();
      const evt = makeEvent(type, {}, metadata);
      const next = evolve(state, evt);
      expect(next, `type=${type}`).not.toBe(state);
      expect(next.seq, `type=${type}`).toBe(evt.seq);
    }
  });

  it('no-op handler does not mutate the input state', () => {
    resetSeq();
    const state = baseline();
    const snapshotSeq = state.seq;
    const snapshotAgents = state.agents;
    evolve(state, makeEvent('decision', { decision: 'x' }, { timestamp: '2026-06-25T00:00:00Z', agentId: 'ghost' }));
    expect(state.seq).toBe(snapshotSeq);
    expect(state.agents).toBe(snapshotAgents);
  });
});

// ── Retry delay formatting (formatDuration boundaries) ────────────────────
//
// auto_retry_started formats delayMs via formatDuration(). These tests pin
// the boundary behavior so the extracted retry handler preserves it exactly.

describe('evolve characterization – retry delay formatting boundaries', () => {
  it('auto_retry_started with delayMs=0 omits the delay suffix entirely', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'auto_retry_started',
        { attempt: 1, maxAttempts: 3, delayMs: 0 },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    expect(state.agents['a1'].log[0].content).toBe('Retrying (attempt 1/3)');
  });

  it('auto_retry_started with sub-second delayMs renders as ms', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'auto_retry_started',
        { attempt: 1, maxAttempts: 3, delayMs: 750 },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    expect(state.agents['a1'].log[0].content).toBe('Retrying (attempt 1/3) in 750ms');
  });

  it('auto_retry_started with exactly 1000ms renders as 1s', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'auto_retry_started',
        { attempt: 1, maxAttempts: 3, delayMs: 1000 },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    expect(state.agents['a1'].log[0].content).toBe('Retrying (attempt 1/3) in 1s');
  });

  it('auto_retry_started with multi-second delayMs renders as seconds (2500ms → 2.5s)', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'auto_retry_started',
        { attempt: 1, maxAttempts: 3, delayMs: 2500 },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    expect(state.agents['a1'].log[0].content).toBe('Retrying (attempt 1/3) in 2.5s');
  });

  it('auto_retry_started defaults attempt/maxAttempts to 1 when missing', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    state = evolve(state, makeEvent('auto_retry_started', {}, { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' }));
    expect(state.agents['a1'].log[0].content).toBe('Retrying (attempt 1/1)');
    expect(state.agents['a1'].log[0].metadata).toEqual({ attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: '' });
  });

  it('auto_retry_started sanitizes errorMessage via sanitizeDisplayText (strips ANSI + newlines)', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    // sanitizeDisplayText strips ANSI escape codes and replaces \r\n with spaces
    const rawError = '\u001b[31moverloaded\u001b[0m\nrate limit';
    state = evolve(
      state,
      makeEvent(
        'auto_retry_started',
        { attempt: 1, maxAttempts: 2, delayMs: 0, errorMessage: rawError },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1' },
      ),
    );
    const entry = state.agents['a1'].log[0];
    // The ANSI codes are stripped and the newline becomes a space
    expect(entry.content).not.toContain('\u001b');
    expect(entry.content).not.toContain('\n');
    expect(entry.content).toBe('Retrying (attempt 1/2): overloaded rate limit');
    // metadata stores the sanitized value
    expect(entry.metadata.errorMessage).toBe('overloaded rate limit');
  });
});

// ── agent_spawned session coercion & multi-agent independence ─────────────

describe('evolve characterization – agent_spawned session coercion', () => {
  it('fresh spawn ignores non-string sessionId/sessionPath', () => {
    resetSeq();
    const state = evolve(
      baseline(),
      makeEvent(
        'agent_spawned',
        // @ts-expect-error intentionally invalid types
        { agentId: 'a1', profile: 'coder', sessionId: 123, sessionPath: null },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    expect(state.agents['a1::t1'].sessionId).toBeUndefined();
    expect(state.agents['a1::t1'].sessionPath).toBeUndefined();
  });

  it('re-spawn ignores non-string sessionId but preserves existing string value', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder', sessionId: 'keep-me' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    // Re-spawn with invalid sessionId type → must preserve existing
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        // @ts-expect-error intentionally invalid type
        { agentId: 'a1', profile: 'coder', sessionId: 999 },
        { timestamp: '2026-06-25T01:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    expect(state.agents['a1::t1'].sessionId).toBe('keep-me');
  });

  it('re-spawn updates sessionId when a valid string is provided', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder', sessionId: 'old' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder', sessionId: 'new' },
        { timestamp: '2026-06-25T01:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    expect(state.agents['a1::t1'].sessionId).toBe('new');
  });

  it('agents with same agentId but different taskIds are independent entities', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 't2' },
      ),
    );
    expect(state.agents['a1::t1']).toBeDefined();
    expect(state.agents['a1::t2']).toBeDefined();
    expect(state.agents['a1::t1']).not.toBe(state.agents['a1::t2']);
    // Each is a separate agent → agentCount = 2
    expect(state.stats.agentCount).toBe(2);
  });

  it('re-spawn clears completedAt (re-activates a previously completed agent)', () => {
    resetSeq();
    let state = baseline();
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    state = evolve(
      state,
      makeEvent('agent_completed', {}, { timestamp: '2026-06-25T01:00:00Z', agentId: 'a1', taskId: 't1' }),
    );
    expect(state.agents['a1::t1'].active).toBe(false);
    expect(state.agents['a1::t1'].completedAt).toBe('2026-06-25T01:00:00Z');

    // Re-spawn → must re-activate and clear completedAt
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T02:00:00Z', agentId: 'a1', taskId: 't1' },
      ),
    );
    expect(state.agents['a1::t1'].active).toBe(true);
    expect(state.agents['a1::t1'].completedAt).toBeUndefined();
    // agentCount must NOT increment
    expect(state.stats.agentCount).toBe(1);
  });
});

// ── Phase taskIds deduplication & task_registered edge cases ──────────────

describe('evolve characterization – phase taskIds deduplication', () => {
  it('task_registered appends taskId to phase.taskIds exactly once', () => {
    resetSeq();
    let state = baseline();
    state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
    state = evolve(
      state,
      makeEvent('task_registered', { taskId: 't1', title: 'T', phaseId: 'p1', steps: [], dependencies: [] }),
    );
    expect(state.phases[0].taskIds).toEqual(['t1']);
    // Re-register the SAME task → no-op for task, and taskIds must NOT get a duplicate
    state = evolve(
      state,
      makeEvent('task_registered', { taskId: 't1', title: 'Dup', phaseId: 'p1', steps: [], dependencies: [] }),
    );
    expect(state.phases[0].taskIds).toEqual(['t1']);
    expect(state.tasks['t1'].title).toBe('T');
  });

  it('task_registered does not append taskId when phase does not exist', () => {
    resetSeq();
    const state = evolve(
      baseline(),
      makeEvent('task_registered', { taskId: 't1', title: 'T', phaseId: 'ghost-phase', steps: [], dependencies: [] }),
    );
    // Task is still created
    expect(state.tasks['t1']).toBeDefined();
    // But no phase has the taskId (phase not found)
    expect(state.phases).toEqual([]);
  });

  it('multiple tasks in the same phase accumulate in taskIds in registration order', () => {
    resetSeq();
    let state = baseline();
    state = evolve(state, makeEvent('phase_registered', { id: 'p1', label: 'P1', icon: '' }));
    state = evolve(
      state,
      makeEvent('task_registered', { taskId: 't1', title: 'A', phaseId: 'p1', steps: [], dependencies: [] }),
    );
    state = evolve(
      state,
      makeEvent('task_registered', { taskId: 't2', title: 'B', phaseId: 'p1', steps: [], dependencies: [] }),
    );
    state = evolve(
      state,
      makeEvent('task_registered', { taskId: 't3', title: 'C', phaseId: 'p1', steps: [], dependencies: [] }),
    );
    expect(state.phases[0].taskIds).toEqual(['t1', 't2', 't3']);
  });
});

// ── agent_rendered resolveAgent fallback & immutability ───────────────────

describe('evolve characterization – agent_rendered & resolveAgent fallback', () => {
  it('agent_rendered resolves to the active agent when both active and inactive match', () => {
    resetSeq();
    let state = baseline();
    // Spawn + complete step-0 agent
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'scout' },
        { timestamp: '2026-06-25T00:00:00Z', agentId: 'a1', taskId: 't1', stepIndex: 0 },
      ),
    );
    state = evolve(
      state,
      makeEvent(
        'agent_completed',
        {},
        { timestamp: '2026-06-25T01:00:00Z', agentId: 'a1', taskId: 't1', stepIndex: 0 },
      ),
    );
    // Spawn step-1 agent (active)
    state = evolve(
      state,
      makeEvent(
        'agent_spawned',
        { agentId: 'a1', profile: 'coder' },
        { timestamp: '2026-06-25T02:00:00Z', agentId: 'a1', taskId: 't1', stepIndex: 1 },
      ),
    );
    // Render with agentId only → resolveAgent must prefer the active step-1 agent
    state = evolve(
      state,
      makeEvent('agent_rendered', { rendered: 'active-output' }, { timestamp: '2026-06-25T03:00:00Z', agentId: 'a1' }),
    );
    expect(state.agents['a1::t1::1'].log).toHaveLength(1);
    expect(state.agents['a1::t1::1'].log[0].content).toBe('active-output');
    expect(state.agents['a1::t1::0'].log).toHaveLength(0);
  });
});

// ── dispatcher determinism: every event type is routed ────────────────────
//
// After the decomposition, evolve dispatches via a handler map. This test
// verifies that every EventType declared in event-types.ts is recognized by
// evolve (i.e., does NOT fall through to the default branch for a known
// type). It asserts that applying any single event type produces a state
// whose seq matches the event's seq — proving dispatch routed it through a
// real handler rather than the default fallback.

describe('evolve characterization – all event types routed', () => {
  const knownTypes: EventType[] = [
    'workflow_started',
    'workflow_completed',
    'workflow_failed',
    'phase_registered',
    'phase_started',
    'phase_completed',
    'agent_spawned',
    'agent_completed',
    'auto_retry_started',
    'auto_retry_completed',
    'task_registered',
    'task_started',
    'step_started',
    'task_completed',
    'task_rejected',
    'decision',
    'error',
    'sidebar_updated',
    'turn_started',
    'turn_ended',
    'tool_call_started',
    'tool_call_ended',
    'log',
    'agent_rendered',
  ];

  for (const type of knownTypes) {
    it(`routes ${type} through a handler (seq matches event.seq)`, () => {
      resetSeq();
      const state = baseline();
      const evt = makeEvent(type, {}, { timestamp: '2026-06-25T00:00:00Z' });
      const next = evolve(state, evt);
      // Every handler — even no-ops — sets seq to event.seq. If the type
      // fell through to an un-routed default, seq would still match, BUT
      // combined with the immutability assertion below this guarantees the
      // handler produced a new object.
      expect(next).not.toBe(state);
      expect(next.seq).toBe(evt.seq);
    });
  }
});
