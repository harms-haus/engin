/**
 * Web migration verification: protocol-types → @engin/shared/protocol-types.
 *
 * `web/src/protocol-types.ts` re-exports the WebSocket protocol surface. After
 * the migration its body becomes:
 *
 *   export * from '@engin/shared/protocol-types';
 *
 * (previously sourced from '@engin/web/protocol-types'). The engine-side
 * `src/web/protocol-types.ts` is itself now a backward-compat shim re-exporting
 * from `@engin/shared/protocol-types`, so the old and new web import paths both
 * resolve to the shared package.
 *
 * This suite proves the move is behaviour-preserving from the web app's
 * perspective by:
 *
 *   1. Importing the runtime type-guard `isServerMessage` from the shared
 *      package and from the web re-export layer, asserting they are the
 *      IDENTICAL binding (===).
 *   2. Verifying at the type level that the web re-exported types are
 *      structurally identical to the shared package types (no drift).
 *   3. Runtime behaviour of isServerMessage for all ServerMessage variants plus
 *      negative cases, asserting the web guard agrees with the shared guard.
 */

import { describe, expect, it } from 'vitest';

// ── NEW canonical home: shared package ──────────────────────────────────────
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

// ── Web re-export layer (the module under migration) ────────────────────────
import type {
  AgentEntity as WebAgentEntity,
  ClientMessage as WebClientMessage,
  EventRecord as WebEventRecord,
  EventType as WebEventType,
  LogEntry as WebLogEntry,
  PhaseEntity as WebPhaseEntity,
  ServerMessage as WebServerMessage,
  StepEntity as WebStepEntity,
  TaskEntity as WebTaskEntity,
  WorkflowProjection as WebWorkflowProjection,
} from './protocol-types';
import { isServerMessage as webIsServerMessage } from './protocol-types';

// ── Type-level exact-equality utility ───────────────────────────────────────
// Bidirectional structural equality. If any field drifts between the web
// re-export and the shared canonical type, compilation fails here.

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertType<T extends true>(_desc?: string): void {}

assertType<Equal<ServerMessage, WebServerMessage>>('web ServerMessage === shared ServerMessage');
assertType<Equal<ClientMessage, WebClientMessage>>('web ClientMessage === shared ClientMessage');
assertType<Equal<EventRecord, WebEventRecord>>('web EventRecord === shared EventRecord');
assertType<Equal<WorkflowProjection, WebWorkflowProjection>>('web WorkflowProjection === shared WorkflowProjection');
assertType<Equal<EventType, WebEventType>>('web EventType === shared EventType');
assertType<Equal<LogEntry, WebLogEntry>>('web LogEntry === shared LogEntry');
assertType<Equal<PhaseEntity, WebPhaseEntity>>('web PhaseEntity === shared PhaseEntity');
assertType<Equal<AgentEntity, WebAgentEntity>>('web AgentEntity === shared AgentEntity');
assertType<Equal<StepEntity, WebStepEntity>>('web StepEntity === shared StepEntity');
assertType<Equal<TaskEntity, WebTaskEntity>>('web TaskEntity === shared TaskEntity');

// ── Helpers ──────────────────────────────────────────────────────────────────

function snapshotMsg(): ServerMessage {
  return {
    type: 'snapshot',
    runId: 'run-1',
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
    runId: 'run-1',
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

describe('protocol-types — web re-export binds @engin/shared/protocol-types', () => {
  it('isServerMessage is the identical binding as the shared guard (===)', () => {
    // === proves the web module does `export * from '@engin/shared/protocol-types'`
    // rather than re-declaring its own guard.
    expect(webIsServerMessage).toBe(isServerMessage);
    expect(typeof webIsServerMessage).toBe('function');
  });
});

describe('isServerMessage — runtime behaviour (shared == web)', () => {
  it('accepts all ServerMessage variants', () => {
    expect(isServerMessage(snapshotMsg())).toBe(true);
    expect(isServerMessage(eventsMsg())).toBe(true);
    expect(isServerMessage({ type: 'run_complete', runId: 'run-1' })).toBe(true);
    expect(isServerMessage({ type: 'run_failed', runId: 'run-1', error: 'boom', phase: 'coding' })).toBe(true);
  });

  it('rejects null, primitives, and malformed objects', () => {
    const negatives: unknown[] = [null, undefined, 'snapshot', 42, true, {}, { seq: 1 }, { type: 5 }];
    for (const n of negatives) {
      expect(isServerMessage(n)).toBe(false);
    }
  });

  it('rejects unknown message types (e.g. ClientMessage shapes)', () => {
    expect(isServerMessage({ type: 'cancel_run', runId: 'run-1' })).toBe(false);
    expect(isServerMessage({ type: 'resync', runId: 'run-1', lastSeq: 1 })).toBe(false);
  });

  it('web guard agrees with shared guard across a mixed sample set', () => {
    const samples: unknown[] = [
      snapshotMsg(),
      eventsMsg(),
      { type: 'run_complete', runId: 'run-1' },
      { type: 'run_failed', runId: 'run-1', error: 'e', phase: 'p' },
      null,
      'snapshot',
      42,
      undefined,
      true,
      {},
      { seq: 1 },
      { type: 5 },
      { type: 'cancel_run', runId: 'run-1' },
      { type: 'resync', runId: 'run-1', lastSeq: 1 },
    ];
    for (const s of samples) {
      expect(webIsServerMessage(s)).toBe(isServerMessage(s));
    }
  });

  it('ClientMessage variants are constructible from the re-exported type', () => {
    const cancel: ClientMessage = { type: 'cancel_run', runId: 'run-1' };
    const resync: ClientMessage = { type: 'resync', runId: 'run-1', lastSeq: 42 };
    expect(cancel.type).toBe('cancel_run');
    expect(resync.type).toBe('resync');
  });
});
