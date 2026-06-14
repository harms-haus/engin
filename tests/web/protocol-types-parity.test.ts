// ─── Structural parity test for the two copies of protocol-types.ts ────────
//
// src/web/protocol-types.ts      – server-side (Bun)
// web/src/protocol-types.ts      – client-side (Vite/React)
//
// The client copy includes the comment "Mirror copy – keep in sync" but
// there is no automated guard against divergence.  This file uses TypeScript's
// structural type system to verify at compile time that both ServerMessage
// types (and their shared value types) remain structurally identical.
//
// After the snapshot/delta refactor (kb-13–17) the protocol only carries:
//   - snapshot          (full WorkflowProjection on connect / full resync)
//   - events            (batched EventRecord deltas)
//   - workflow_complete / workflow_failed  (top-level lifecycle signals)
//
// The old per-event WS message types have been removed; this test now guards
// the SMALLER retained union.
//
// === How it works ===
//
// 1. Top-level bi-directional assignability functions catch:
//    - A variant added/removed in one side but not the other
//    - A required field added/removed/changed in a variant
//
// 2. A type-level `Equal<X, Y>` utility (using the function-call-signature
//    trick) performs an *exact* structural comparison on each isolated
//    variant.  This catches optional-field divergence that simple
//    assignability would miss (e.g. `{type, a?: string}` vs `{type}`).
//    `assertEqual` calls produce a compile error when the types differ.
//
// 3. Sample objects for every message variant are checked against both type
//    imports and verified to exist at runtime via bun:test.
//
// === Which tools enforce the guard ===
//
// - `bun test`                     → runs the runtime assertions (passes)
// - `bun run build` (tsc)          → compiles src/ (passes)
// - `tsc --noEmit` on this file    → catches divergence via Equal<> checks
// - IDEs (VS Code, etc.)           → show inline errors via Equal<> checks

import { describe, expect, it } from 'bun:test';
import type {
  ClientMessage as ServerClientMessage,
  ServerMessage as ServerSideMessage,
} from '../../src/web/protocol-types.ts';
import type {
  ServerMessage as ClientSideMessage,
  ClientMessage as WebClientMessage,
} from '../../web/src/protocol-types.ts';

// ─── Type-level exact equality utility ─────────────────────────────────────
//
// Uses the well-known function-call-signature trick.  Equal<X, Y> resolves to
// `true` iff X and Y are structurally identical (catches extra optional
// fields, different field types, etc.).

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * Compile-time assertion that a type-level boolean is `true`.
 * If the type argument resolves to `false`, a compile error results:
 *   "Type 'false' does not satisfy the constraint 'true'."
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- T is a compile-time assertion parameter used at call sites
function assertEqual<T extends true>(_desc?: string): void {}

// ─── 1. Top-level bi-directional assignability ─────────────────────────────

function serverAssignableToClient(_m: ServerSideMessage): ClientSideMessage {
  return _m;
}

function clientAssignableToServer(_m: ClientSideMessage): ServerSideMessage {
  return _m;
}

// ─── 2. Variant-level exact equality via Equal<> ───────────────────────────

// ── snapshot ──
type ServerSnapshot = Extract<ServerSideMessage, { type: 'snapshot' }>;
type ClientSnapshot = Extract<ClientSideMessage, { type: 'snapshot' }>;
assertEqual<Equal<ServerSnapshot, ClientSnapshot>>('snapshot');

// ── events ──
type ServerEvents = Extract<ServerSideMessage, { type: 'events' }>;
type ClientEvents = Extract<ClientSideMessage, { type: 'events' }>;
assertEqual<Equal<ServerEvents, ClientEvents>>('events');

// ── workflow_complete ──
type ServerWorkflowComplete = Extract<ServerSideMessage, { type: 'workflow_complete' }>;
type ClientWorkflowComplete = Extract<ClientSideMessage, { type: 'workflow_complete' }>;
assertEqual<Equal<ServerWorkflowComplete, ClientWorkflowComplete>>('workflow_complete');

// ── workflow_failed ──
type ServerWorkflowFailed = Extract<ServerSideMessage, { type: 'workflow_failed' }>;
type ClientWorkflowFailed = Extract<ClientSideMessage, { type: 'workflow_failed' }>;
assertEqual<Equal<ServerWorkflowFailed, ClientWorkflowFailed>>('workflow_failed');

// ─── 2b. ClientMessage variant-level exact equality ────────────────────────

assertEqual<Equal<ServerClientMessage, WebClientMessage>>('ClientMessage');

// ─── 3. Sample objects for each variant ────────────────────────────────────
//
// Each sample is checked at compile time via checkVariant (which requires
// assignability to BOTH type imports) and at runtime via bun:test assertions.

/** Accept an object that satisfies *both* ServerMessage type imports. */
function checkVariant<T extends ServerSideMessage & ClientSideMessage>(_obj: T): void {
  // no-op: compile-time check only
}

describe('ServerMessage – variant parity (sample objects)', () => {
  it('snapshot variant', () => {
    const sample = {
      type: 'snapshot',
      seq: 42,
      state: {
        seq: 42,
        taskPrompt: 'Build the thing',
        phases: [{ id: 'coding', label: 'Coding', icon: '💻', taskIds: ['t1'] }],
        currentPhaseId: 'coding',
        completedPhaseIds: ['scouting', 'planning'],
        tasks: {
          t1: {
            id: 't1',
            title: 'Implement API',
            phaseId: 'coding',
            status: 'running',
            steps: [],
            dependencies: [],
            startedAt: Date.now(),
          },
        },
        agents: {
          a1: {
            uid: 'uid-1',
            agentId: 'a1',
            profile: 'coder',
            phaseId: 'coding',
            taskId: 't1',
            active: true,
            log: [
              {
                id: 'log-1',
                timestamp: new Date().toISOString(),
                type: 'text',
                content: 'working on it',
              },
            ],
            toolCallCount: 3,
            inputTokens: 500,
            outputTokens: 200,
            taskTitle: 'Implement API',
          },
        },
        sidebar: {
          title: 'Engin',
          indicator: '🟢',
        },
        status: 'running',
        stats: { totalTokens: 700, agentCount: 1 },
      },
    };
    checkVariant(sample);
    expect(sample.type).toBe('snapshot');
    expect(sample.seq).toBe(42);
    expect(sample.state.currentPhaseId).toBe('coding');
    expect(sample.state.status).toBe('running');
    expect(Object.keys(sample.state.tasks)).toHaveLength(1);
    expect(Object.keys(sample.state.agents)).toHaveLength(1);
  });

  it('events variant', () => {
    const sample = {
      type: 'events',
      seq: 5,
      events: [
        {
          seq: 4,
          type: 'phase_started',
          data: { phase: 'coding' },
          metadata: {
            timestamp: new Date().toISOString(),
            phaseId: 'coding',
          },
        },
        {
          seq: 5,
          type: 'agent_spawned',
          data: { agentId: 'a1', profile: 'coder' },
          metadata: {
            timestamp: new Date().toISOString(),
            agentId: 'a1',
            phaseId: 'coding',
          },
        },
      ],
    };
    checkVariant(sample);
    expect(sample.type).toBe('events');
    expect(sample.seq).toBe(5);
    expect(sample.events).toHaveLength(2);
    expect(sample.events[0].type).toBe('phase_started');
    expect(sample.events[1].type).toBe('agent_spawned');
  });

  it('workflow_complete variant', () => {
    const sample = { type: 'workflow_complete' };
    checkVariant(sample);
    expect(sample.type).toBe('workflow_complete');
  });

  it('workflow_failed variant', () => {
    const sample = {
      type: 'workflow_failed',
      error: 'Something went wrong',
      phase: 'planning',
    };
    checkVariant(sample);
    expect(sample.type).toBe('workflow_failed');
    expect(sample.error).toBe('Something went wrong');
    expect(sample.phase).toBe('planning');
  });

  it('snapshot variant – minimal (no optional sidebar phases)', () => {
    const sample = {
      type: 'snapshot',
      seq: 0,
      state: {
        seq: 0,
        taskPrompt: '',
        phases: [],
        currentPhaseId: '',
        completedPhaseIds: [],
        tasks: {},
        agents: {},
        sidebar: { title: '', indicator: '' },
        status: 'running' as const,
        stats: { totalTokens: 0, agentCount: 0 },
      },
    };
    checkVariant(sample);
    expect(sample.type).toBe('snapshot');
    expect(sample.state.tasks).toEqual({});
    expect(sample.state.agents).toEqual({});
  });

  it('events variant – empty batch', () => {
    const sample = {
      type: 'events',
      seq: 3,
      events: [],
    };
    checkVariant(sample);
    expect(sample.type).toBe('events');
    expect(sample.events).toHaveLength(0);
  });
});

// ─── 4. ClientMessage sample objects ───────────────────────────────────────

function checkClientMessage<T extends ServerClientMessage & WebClientMessage>(_obj: T): void {
  // no-op: compile-time check only
}

describe('ClientMessage – variant parity (sample objects)', () => {
  it('terminate_server variant', () => {
    const sample = { type: 'terminate_server' as const };
    checkClientMessage(sample);
    expect(sample.type).toBe('terminate_server');
  });

  it('resync variant without lastSeq', () => {
    const sample = { type: 'resync' as const };
    checkClientMessage(sample);
    expect(sample.type).toBe('resync');
  });

  it('resync variant with lastSeq', () => {
    const sample = { type: 'resync' as const, lastSeq: 42 };
    checkClientMessage(sample);
    expect(sample.type).toBe('resync');
    expect(sample.lastSeq).toBe(42);
  });
});

// ─── Shared value types structural check ───────────────────────────────────
//
// Ensure the supporting types are also in sync.  PhaseEntity, StepEntity,
// LogEntry, EventType, EventRecord, AgentEntity, TaskEntity, and
// WorkflowProjection are the shared value/mirror types used by both sides.
// PhaseDescriptor has been replaced by PhaseEntity.

import type {
  AgentEntity,
  EventRecord,
  EventType,
  LogEntry,
  PhaseEntity,
  StepEntity,
  TaskEntity,
  WorkflowProjection,
} from '../../src/web/protocol-types.ts';
import type {
  AgentEntity as ClientAgentEntity,
  EventRecord as ClientEventRecord,
  EventType as ClientEventType,
  LogEntry as ClientLogEntry,
  PhaseEntity as ClientPhaseEntity,
  StepEntity as ClientStepEntity,
  TaskEntity as ClientTaskEntity,
  WorkflowProjection as ClientWorkflowProjection,
} from '../../web/src/protocol-types.ts';

assertEqual<Equal<PhaseEntity, ClientPhaseEntity>>('PhaseEntity');
assertEqual<Equal<StepEntity, ClientStepEntity>>('StepEntity');
assertEqual<Equal<LogEntry, ClientLogEntry>>('LogEntry');
assertEqual<Equal<EventType, ClientEventType>>('EventType');
assertEqual<Equal<EventRecord, ClientEventRecord>>('EventRecord');
assertEqual<Equal<AgentEntity, ClientAgentEntity>>('AgentEntity');
assertEqual<Equal<TaskEntity, ClientTaskEntity>>('TaskEntity');
assertEqual<Equal<WorkflowProjection, ClientWorkflowProjection>>('WorkflowProjection');

// Also keep bi-directional assignability as a secondary check.
// These functions will fail to compile if the types are not structurally
// compatible in both directions.

function phaseEntityAssignableFromServer(_p: PhaseEntity): ClientPhaseEntity {
  return _p;
}
function phaseEntityAssignableFromClient(_p: ClientPhaseEntity): PhaseEntity {
  return _p;
}

function stepEntityAssignableFromServer(_s: StepEntity): ClientStepEntity {
  return _s;
}
function stepEntityAssignableFromClient(_s: ClientStepEntity): StepEntity {
  return _s;
}

function logEntryAssignableFromServer(_e: LogEntry): ClientLogEntry {
  return _e;
}
function logEntryAssignableFromClient(_e: ClientLogEntry): LogEntry {
  return _e;
}

function eventRecordAssignableFromServer(_e: EventRecord): ClientEventRecord {
  return _e;
}
function eventRecordAssignableFromClient(_e: ClientEventRecord): EventRecord {
  return _e;
}

function agentEntityAssignableFromServer(_a: AgentEntity): ClientAgentEntity {
  return _a;
}
function agentEntityAssignableFromClient(_a: ClientAgentEntity): AgentEntity {
  return _a;
}

function taskEntityAssignableFromServer(_t: TaskEntity): ClientTaskEntity {
  return _t;
}
function taskEntityAssignableFromClient(_t: ClientTaskEntity): TaskEntity {
  return _t;
}

function workflowProjectionAssignableFromServer(_w: WorkflowProjection): ClientWorkflowProjection {
  return _w;
}
function workflowProjectionAssignableFromClient(_w: ClientWorkflowProjection): WorkflowProjection {
  return _w;
}

// Suppress "unused variable" warnings so the guards remain active.
// Each function is referenced individually to prevent tree-shaking.
void serverAssignableToClient;
void clientAssignableToServer;
void phaseEntityAssignableFromServer;
void phaseEntityAssignableFromClient;
void stepEntityAssignableFromServer;
void stepEntityAssignableFromClient;
void logEntryAssignableFromServer;
void logEntryAssignableFromClient;
void eventRecordAssignableFromServer;
void eventRecordAssignableFromClient;
void agentEntityAssignableFromServer;
void agentEntityAssignableFromClient;
void taskEntityAssignableFromServer;
void taskEntityAssignableFromClient;
void workflowProjectionAssignableFromServer;
void workflowProjectionAssignableFromClient;

// ─── 5. Serialization round-trip ──────────────────────────────────────────
//
// Confirm that WorkflowProjection (and its nested types) are fully
// JSON-serializable: no Map, no class instances, no functions.
// JSON.parse(JSON.stringify(obj)) should produce a deep-equal copy.

describe('WorkflowProjection – JSON round-trip', () => {
  it('survives JSON.parse(JSON.stringify()) with full data', () => {
    const projection: WorkflowProjection = {
      seq: 7,
      taskPrompt: 'Build the thing',
      phases: [{ id: 'coding', label: 'Coding', icon: '💻', taskIds: ['t1'] }],
      currentPhaseId: 'coding',
      completedPhaseIds: ['scouting', 'planning'],
      tasks: {
        t1: {
          id: 't1',
          title: 'Implement API',
          phaseId: 'coding',
          status: 'running',
          steps: [],
          dependencies: [],
          startedAt: 1700000000000,
        },
      },
      agents: {
        a1: {
          uid: 'uid-1',
          agentId: 'a1',
          profile: 'coder',
          phaseId: 'coding',
          taskId: 't1',
          active: true,
          log: [
            {
              id: 'log-1',
              timestamp: '2025-01-01T00:00:00.000Z',
              type: 'text',
              content: 'working on it',
              metadata: { key: 'value' },
            },
          ],
          toolCallCount: 3,
          inputTokens: 500,
          outputTokens: 200,
          taskTitle: 'Implement API',
        },
      },
      sidebar: {
        title: 'Engin',
        indicator: '🟢',
      },
      status: 'running',
      stats: { totalTokens: 700, agentCount: 1 },
    };

    const roundTripped = JSON.parse(JSON.stringify(projection));
    expect(roundTripped).toEqual(projection);
  });

  it('survives round-trip with optional fields populated', () => {
    const projection: WorkflowProjection = {
      seq: 1,
      taskPrompt: '',
      phases: [],
      currentPhaseId: '',
      completedPhaseIds: [],
      tasks: {},
      agents: {},
      sidebar: { title: '', indicator: '' },
      status: 'failed',
      error: 'Something broke',
      failedPhase: 'planning',
      stats: { totalTokens: 0, agentCount: 0 },
    };

    const roundTripped = JSON.parse(JSON.stringify(projection));
    expect(roundTripped).toEqual(projection);
    expect(roundTripped.error).toBe('Something broke');
    expect(roundTripped.failedPhase).toBe('planning');
  });

  it('EventRecord survives JSON round-trip', () => {
    const record = {
      seq: 42,
      type: 'phase_started' as const,
      data: { phase: 'coding' },
      metadata: {
        timestamp: '2025-01-01T00:00:00.000Z',
        agentId: 'a1',
        phaseId: 'coding',
      },
    };

    const roundTripped = JSON.parse(JSON.stringify(record));
    expect(roundTripped).toEqual(record);
  });
});
