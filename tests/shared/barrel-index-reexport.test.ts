// ─── Barrel smoke test: packages/shared/src/index.ts ────────────────────────
//
// The `@engin/shared` barrel re-exports from multiple source modules. Several
// type names are shared across modules, so a naive wildcard barrel could drop
// them. This suite verifies the behavioral contract, not exhaustive identity.

import type {
  AgentEntity,
  ClientMessage,
  EventRecord,
  EventType,
  LogEntry,
  PhaseEntity,
  ServerMessage,
  StepDefinition,
  StepEntity,
  TaskEntity,
  TaskStatus,
  WorkflowProjection,
} from '@engin/shared';
import {
  MAX_AGENT_LOG,
  createInitialProjection,
  evolve,
  formatWorkflowEventLine,
  isServerMessage,
} from '@engin/shared';
import { describe, expect, it } from 'bun:test';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}): EventRecord {
  return { seq: ++seq, type, data, metadata: { timestamp: '2026-06-15T00:00:00Z' } };
}

describe('@engin/shared barrel', () => {
  it('exposes expected value exports', () => {
    expect(typeof evolve).toBe('function');
    expect(typeof createInitialProjection).toBe('function');
    expect(typeof formatWorkflowEventLine).toBe('function');
    expect(typeof isServerMessage).toBe('function');
    expect(MAX_AGENT_LOG).toBe(500);
  });

  it('drives exported functions end-to-end', () => {
    seq = 0;
    let state = createInitialProjection();
    state = evolve(state, ev('workflow_started', { taskPrompt: 'Build it' }));
    state = evolve(state, ev('phase_registered', { id: 'p1', label: 'Implement', icon: '🔨' }));
    state = evolve(state, ev('task_registered', { taskId: 't1', title: 'Write tests', phaseId: 'p1' }));
    expect(state.seq).toBe(3);
    expect(state.taskPrompt).toBe('Build it');
    expect(state.status).toBe('running');
    expect(state.phases[0].id).toBe('p1');
    expect(state.tasks['t1']?.title).toBe('Write tests');
    expect(state.phases[0].taskIds).toEqual(['t1']);
    expect(formatWorkflowEventLine(ev('workflow_started', { taskPrompt: 'Build it', resumed: false }))).toBe(
      '🚀 Workflow started: "Build it" (resumed: false)',
    );
    expect(isServerMessage({ type: 'run_complete', runId: 'r1' })).toBe(true);
    expect(isServerMessage({ type: 'snapshot', runId: 'r1', seq: 0, state: createInitialProjection() })).toBe(true);
    expect(isServerMessage({ type: 'nope' })).toBe(false);
    expect(isServerMessage(null)).toBe(false);
  });

  it('keeps collision-prone type names reachable', () => {
    // Constructing values of each type proves the barrel import resolves.
    const status: TaskStatus = 'ready';
    const step: StepEntity = { name: 's', index: 0 };
    const def: StepDefinition = { name: 's', profileId: 'p', isReadOnly: true };
    const task: TaskEntity = { id: 't1', title: 'T', phaseId: 'p1', status, steps: [step], dependencies: [] };
    const rec: EventRecord = { seq: 1, type: 'workflow_started', data: {}, metadata: { timestamp: 't' } };
    const projection: WorkflowProjection = createInitialProjection();
    const agent: AgentEntity = {
      uid: 'a1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'p1',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
    };
    const phase: PhaseEntity = { id: 'p1', label: 'P', icon: '', taskIds: [] };
    const entry: LogEntry = { id: 'l1', timestamp: 't', type: 'text', content: 'hi' };
    const server: ServerMessage = { type: 'run_complete', runId: 'r1' };
    const client: ClientMessage = { type: 'resync', runId: 'r1' };
    // Touch each binding to suppress unused warnings.
    void [status, step, def, task, rec, projection, agent, phase, entry, server, client];
  });
});
