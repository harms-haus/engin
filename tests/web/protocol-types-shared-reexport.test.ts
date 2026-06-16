// ─── protocol-types: canonical @engin/shared exports ────────────────────────
//
// Verifies the canonical exports from @engin/shared/protocol-types and their
// structural equivalence to the event-types defined in shared/event-types.ts.

import { describe, expect, it } from 'bun:test';

// ── Canonical shared package ────────────────────────────────────────────────
import type {
  AgentEntity,
  ClientMessage,
  EventRecord,
  EventType,
  LogEntry,
  PhaseEntity,
  ServerMessage,
  StepEntity,
  TaskEntity,
  WorkflowProjection,
} from '@engin/shared/protocol-types';
import { isServerMessage } from '@engin/shared/protocol-types';

// ── Canonical tracking-core types from shared/event-types.ts ────────────────
import type {
  AgentEntity as CanonicalAgentEntity,
  EventRecord as CanonicalEventRecord,
  EventType as CanonicalEventType,
  LogEntry as CanonicalLogEntry,
  PhaseEntity as CanonicalPhaseEntity,
  StepEntity as CanonicalStepEntity,
  TaskEntity as CanonicalTaskEntity,
  WorkflowProjection as CanonicalWorkflowProjection,
} from '@engin/shared/event-types';

// ── Type-level exact-equality utility ───────────────────────────────────────

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// Compile-time: the re-exported types must be structurally identical to the
// canonical ones defined in packages/shared/src/event-types.ts.
assertEqual<Equal<EventRecord, CanonicalEventRecord>>('EventRecord sourced from ./event-types.js');
assertEqual<Equal<WorkflowProjection, CanonicalWorkflowProjection>>('WorkflowProjection sourced from ./event-types.js');
assertEqual<Equal<EventType, CanonicalEventType>>('EventType sourced from ./event-types.js');
assertEqual<Equal<LogEntry, CanonicalLogEntry>>('LogEntry sourced from ./event-types.js');
assertEqual<Equal<PhaseEntity, CanonicalPhaseEntity>>('PhaseEntity sourced from ./event-types.js');
assertEqual<Equal<AgentEntity, CanonicalAgentEntity>>('AgentEntity sourced from ./event-types.js');
assertEqual<Equal<StepEntity, CanonicalStepEntity>>('StepEntity sourced from ./event-types.js');
assertEqual<Equal<TaskEntity, CanonicalTaskEntity>>('TaskEntity sourced from ./event-types.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function snapshotMsg(): ServerMessage {
  return {
    type: 'snapshot',
    runId: 'test-run',
    seq: 1,
    state: {
      seq: 1,
      taskPrompt: 'Build it',
      phases: [],
      currentPhaseId: '',
      completedPhaseIds: [],
      tasks: {},
      agents: {},
      sidebar: { title: 'Engin', indicator: '🟢' },
      status: 'running',
      stats: { totalTokens: 0, agentCount: 0 },
      runLog: [],
    },
  };
}

function eventsMsg(): ServerMessage {
  return {
    type: 'events',
    runId: 'test-run',
    seq: 2,
    events: [
      {
        seq: 2,
        type: 'phase_started',
        data: { phase: 'coding' },
        metadata: { timestamp: '2026-06-15T00:00:00Z', phaseId: 'coding' },
      },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('@engin/shared/protocol-types — canonical exports', () => {
  it('exports isServerMessage as a function', () => {
    expect(typeof isServerMessage).toBe('function');
  });

  it('ServerMessage snapshot variant round-trips', () => {
    const msg: ServerMessage = snapshotMsg();
    expect(msg.type).toBe('snapshot');
    if (msg.type === 'snapshot') {
      expect(msg.seq).toBe(1);
      expect(msg.state.currentPhaseId).toBe('');
    }
  });

  it('ServerMessage events variant round-trips', () => {
    const msg: ServerMessage = eventsMsg();
    expect(msg.type).toBe('events');
    if (msg.type === 'events') {
      expect(msg.seq).toBe(2);
      expect(msg.events).toHaveLength(1);
    }
  });

  it('ServerMessage run_complete / run_failed variants', () => {
    const complete: ServerMessage = { type: 'run_complete', runId: 'r1' };
    const failed: ServerMessage = { type: 'run_failed', runId: 'r1', error: 'boom', phase: 'coding' };
    expect(complete.type).toBe('run_complete');
    if (failed.type === 'run_failed') {
      expect(failed.error).toBe('boom');
      expect(failed.phase).toBe('coding');
      expect(failed.runId).toBe('r1');
    }
  });

  it('ClientMessage variants are constructible', () => {
    const cancel: ClientMessage = { type: 'cancel_run', runId: 'r1' };
    const resync: ClientMessage = { type: 'resync', runId: 'r1', lastSeq: 42 };
    expect(cancel.type).toBe('cancel_run');
    expect(resync.type).toBe('resync');
  });

  it('re-exports the tracking-core types from ./event-types.js (runtime constructability)', () => {
    const entry: LogEntry = {
      id: 'l1',
      timestamp: 't',
      type: 'tool_call_start',
      content: 'c',
    };
    const phase: PhaseEntity = { id: 'p1', label: 'Phase', icon: '🔧', taskIds: [] };
    const step: StepEntity = { name: 'write-tests', index: 0 };
    const task: TaskEntity = {
      id: 't1',
      title: 'T',
      phaseId: 'p1',
      status: 'ready',
      steps: [step],
      dependencies: [],
    };
    const agent: AgentEntity = {
      uid: 'u',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'p1',
      active: true,
      log: [entry],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: 'T',
    };
    const event: EventRecord = {
      seq: 1,
      type: 'workflow_started',
      data: {},
      metadata: { timestamp: 't' },
    };
    const et: EventType = 'workflow_started';
    expect(phase.taskIds).toEqual([]);
    expect(task.steps[0]).toBe(step);
    expect(agent.log[0]).toBe(entry);
    expect(event.seq).toBe(1);
    expect(et).toBe('workflow_started');
    // WorkflowProjection is exercised structurally by snapshotMsg() above.
    const raw = snapshotMsg();
    if (raw.type === 'snapshot') {
      const proj: WorkflowProjection = raw.state;
      expect(proj.status).toBe('running');
    }
  });
});

describe('isServerMessage type guard — runtime behaviour', () => {
  it('accepts the snapshot variant', () => {
    expect(isServerMessage(snapshotMsg())).toBe(true);
  });

  it('accepts the events variant', () => {
    expect(isServerMessage(eventsMsg())).toBe(true);
  });

  it('accepts the run_complete variant', () => {
    expect(isServerMessage({ type: 'run_complete', runId: 'r1' })).toBe(true);
  });

  it('accepts the run_failed variant', () => {
    expect(isServerMessage({ type: 'run_failed', runId: 'r1', error: 'e', phase: 'p' })).toBe(true);
  });

  it('rejects null', () => {
    expect(isServerMessage(null)).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isServerMessage('snapshot')).toBe(false);
    expect(isServerMessage(42)).toBe(false);
    expect(isServerMessage(undefined)).toBe(false);
    expect(isServerMessage(true)).toBe(false);
  });

  it('rejects objects without a string type field', () => {
    expect(isServerMessage({})).toBe(false);
    expect(isServerMessage({ seq: 1 })).toBe(false);
    expect(isServerMessage({ type: 5 })).toBe(false);
  });

  it('rejects unknown message types (e.g. ClientMessage shapes)', () => {
    expect(isServerMessage({ type: 'terminate_server' })).toBe(false);
    expect(isServerMessage({ type: 'resync', lastSeq: 1 })).toBe(false);
  });

  it('narrows unknown → ServerMessage for a valid variant', () => {
    const data: unknown = { type: 'run_complete', runId: 'r1' };
    expect(isServerMessage(data)).toBe(true);
    // Type-level proof: after the guard, `data` is assignable to ServerMessage.
    if (isServerMessage(data)) {
      const narrowed: ServerMessage = data;
      expect(narrowed.type).toBe('run_complete');
    }
  });
});

describe('export surface — runtime values', () => {
  it('the shared module exports isServerMessage at runtime', async () => {
    const mod = (await import('@engin/shared/protocol-types')) as Record<string, unknown>;
    expect(mod.isServerMessage).toBe(isServerMessage);
  });
});
