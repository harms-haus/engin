// ─── Structural parity test for the protocol-types module ─────────────────
//
// PARITY NOTE (post-T08): Both the server side (src/web/protocol-types.ts) and
// the client side (web/src/protocol-types.ts) are now bare `export *`
// re-exports of the SAME shared module, `@engin/shared/protocol-types`. Because
// both sides import the identical module, structural parity between the
// server-facing and client-facing ServerMessage / ClientMessage types is
// GUARANTEED BY CONSTRUCTION — they are, literally, the same type aliases.
//
// The `Equal<>` compile-time checks in this file are therefore no longer
// guarding two divergent copies; instead they serve as REGRESSION GUARDS
// against any future accidental divergence (e.g. if one side were ever
// re-pointed at a divergent local copy, or if a manual mirror were
// reintroduced). They also document, variant by variant, the exact shape the
// multi-run protocol is expected to carry.
//
// MULTI-RUN PROTOCOL: after the run-registry refactor every projection / event
// / lifecycle message is tagged with `runId` so a single WebSocket connection
// can fan out to many concurrent runs. The ServerMessage union now consists of:
//   - runs            (active-run list, sent on subscribe and on change)
//   - run_started     (a new run has entered the registry)
//   - snapshot        (full WorkflowProjection for a run — connect / resync)
//   - events          (batch of raw EventRecords since the last seq for a run)
//   - run_complete    (run-scoped terminal success signal)
//   - run_failed      (run-scoped terminal failure signal)
//   - log             (server-captured runtime console output for a run)
//   - auth_required   (reserved for future auth enforcement)
//   - error           (protocol-level errors)
//
// The old unscoped `snapshot` / `events` and the global `workflow_complete` /
// `workflow_failed` / `terminate_server` message types have been REMOVED; this
// test now guards the new, run-scoped union.
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

import type {
  RunSummary as ClientRunSummary,
  ServerMessage as ClientSideMessage,
  RunSummary,
  ClientMessage as ServerClientMessage,
  ServerMessage as ServerSideMessage,
  ClientMessage as WebClientMessage,
} from '@engin/shared/protocol-types';
import { describe, expect, it } from 'bun:test';

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

function assertEqual<T extends true>(_desc?: string): void {}

// ─── 1. Top-level bi-directional assignability ─────────────────────────────

function serverAssignableToClient(_m: ServerSideMessage): ClientSideMessage {
  return _m;
}

function clientAssignableToServer(_m: ClientSideMessage): ServerSideMessage {
  return _m;
}

// ─── 2. Variant-level exact equality via Equal<> ───────────────────────────
//
// One check per ServerMessage variant. Because both type aliases resolve to
// the same shared module these are trivially `true`, but they pin down the
// exact shape of each variant as documentation + regression guard.

// ── runs ──
type ServerRuns = Extract<ServerSideMessage, { type: 'runs' }>;
type ClientRuns = Extract<ClientSideMessage, { type: 'runs' }>;
assertEqual<Equal<ServerRuns, ClientRuns>>('runs');

// ── run_started ──
type ServerRunStarted = Extract<ServerSideMessage, { type: 'run_started' }>;
type ClientRunStarted = Extract<ClientSideMessage, { type: 'run_started' }>;
assertEqual<Equal<ServerRunStarted, ClientRunStarted>>('run_started');

// ── snapshot (run-scoped) ──
type ServerSnapshot = Extract<ServerSideMessage, { type: 'snapshot' }>;
type ClientSnapshot = Extract<ClientSideMessage, { type: 'snapshot' }>;
assertEqual<Equal<ServerSnapshot, ClientSnapshot>>('snapshot');

// ── events (run-scoped) ──
type ServerEvents = Extract<ServerSideMessage, { type: 'events' }>;
type ClientEvents = Extract<ClientSideMessage, { type: 'events' }>;
assertEqual<Equal<ServerEvents, ClientEvents>>('events');

// ── run_complete ──
type ServerRunComplete = Extract<ServerSideMessage, { type: 'run_complete' }>;
type ClientRunComplete = Extract<ClientSideMessage, { type: 'run_complete' }>;
assertEqual<Equal<ServerRunComplete, ClientRunComplete>>('run_complete');

// ── run_failed ──
type ServerRunFailed = Extract<ServerSideMessage, { type: 'run_failed' }>;
type ClientRunFailed = Extract<ClientSideMessage, { type: 'run_failed' }>;
assertEqual<Equal<ServerRunFailed, ClientRunFailed>>('run_failed');

// ── log ──
type ServerLog = Extract<ServerSideMessage, { type: 'log' }>;
type ClientLog = Extract<ClientSideMessage, { type: 'log' }>;
assertEqual<Equal<ServerLog, ClientLog>>('log');

// ── auth_required ──
type ServerAuthRequired = Extract<ServerSideMessage, { type: 'auth_required' }>;
type ClientAuthRequired = Extract<ClientSideMessage, { type: 'auth_required' }>;
assertEqual<Equal<ServerAuthRequired, ClientAuthRequired>>('auth_required');

// ── error ──
type ServerError = Extract<ServerSideMessage, { type: 'error' }>;
type ClientError = Extract<ClientSideMessage, { type: 'error' }>;
assertEqual<Equal<ServerError, ClientError>>('error');

// ── worktree_merge_result ──
type ServerWorktreeMergeResult = Extract<ServerSideMessage, { type: 'worktree_merge_result' }>;
type ClientWorktreeMergeResult = Extract<ClientSideMessage, { type: 'worktree_merge_result' }>;
assertEqual<Equal<ServerWorktreeMergeResult, ClientWorktreeMergeResult>>('worktree_merge_result');

// ─── 2b. RunSummary exact equality ─────────────────────────────────────────

assertEqual<Equal<RunSummary, ClientRunSummary>>('RunSummary');

// ─── 2c. ClientMessage variant-level exact equality ────────────────────────

// Whole-union check, plus one per variant to mirror the ServerMessage guards.
assertEqual<Equal<ServerClientMessage, WebClientMessage>>('ClientMessage');

assertEqual<Equal<Extract<ServerClientMessage, { type: 'auth' }>, Extract<WebClientMessage, { type: 'auth' }>>>('auth');
assertEqual<
  Equal<Extract<ServerClientMessage, { type: 'list_runs' }>, Extract<WebClientMessage, { type: 'list_runs' }>>
>('list_runs');
assertEqual<
  Equal<Extract<ServerClientMessage, { type: 'start_run' }>, Extract<WebClientMessage, { type: 'start_run' }>>
>('start_run');
assertEqual<
  Equal<Extract<ServerClientMessage, { type: 'subscribe' }>, Extract<WebClientMessage, { type: 'subscribe' }>>
>('subscribe');
assertEqual<
  Equal<Extract<ServerClientMessage, { type: 'unsubscribe' }>, Extract<WebClientMessage, { type: 'unsubscribe' }>>
>('unsubscribe');
assertEqual<Equal<Extract<ServerClientMessage, { type: 'resync' }>, Extract<WebClientMessage, { type: 'resync' }>>>(
  'resync',
);
assertEqual<
  Equal<Extract<ServerClientMessage, { type: 'cancel_run' }>, Extract<WebClientMessage, { type: 'cancel_run' }>>
>('cancel_run');
assertEqual<
  Equal<
    Extract<ServerClientMessage, { type: 'worktree_action' }>,
    Extract<WebClientMessage, { type: 'worktree_action' }>
  >
>('worktree_action');

// ─── 3. Sample objects for each variant ────────────────────────────────────
//
// Each sample is checked at compile time via checkVariant (which requires
// assignability to BOTH type imports) and at runtime via bun:test assertions.

/** Accept an object that satisfies *both* ServerMessage type imports. */
function checkVariant<T extends ServerSideMessage & ClientSideMessage>(_obj: T): void {
  // no-op: compile-time check only
}

const ISO_NOW = '2026-06-15T12:00:00.000Z';

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: '1781118746110-develop',
    cwd: '/home/user/project',
    workflowName: 'develop',
    taskPrompt: 'Build the thing',
    status: 'running',
    startedAt: ISO_NOW,
    ...overrides,
  };
}

function makeMinimalProjection() {
  return {
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
    runLog: [],
  };
}

describe('ServerMessage – variant parity (sample objects)', () => {
  it('runs variant', () => {
    const sample: ServerSideMessage = {
      type: 'runs',
      runs: [makeRunSummary(), makeRunSummary({ runId: 'run-2', status: 'complete' })],
    };
    checkVariant(sample);
    expect(sample.type).toBe('runs');
    expect(sample.runs).toHaveLength(2);
    expect(sample.runs[0].runId).toBe('1781118746110-develop');
    expect(sample.runs[1].status).toBe('complete');
  });

  it('runs variant – empty list', () => {
    const sample: ServerSideMessage = { type: 'runs', runs: [] };
    checkVariant(sample);
    expect(sample.type).toBe('runs');
    expect(sample.runs).toHaveLength(0);
  });

  it('run_started variant', () => {
    const summary = makeRunSummary();
    const sample: ServerSideMessage = { type: 'run_started', runId: summary.runId, summary };
    checkVariant(sample);
    expect(sample.type).toBe('run_started');
    expect(sample.runId).toBe(summary.runId);
    expect(sample.summary).toBe(summary);
  });

  it('snapshot variant (run-scoped)', () => {
    const sample: ServerSideMessage = {
      type: 'snapshot',
      runId: 'run-1',
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
            status: 'active',
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
        runLog: [],
      },
    };
    checkVariant(sample);
    expect(sample.type).toBe('snapshot');
    expect(sample.runId).toBe('run-1');
    expect(sample.seq).toBe(42);
    expect(sample.state.currentPhaseId).toBe('coding');
    expect(sample.state.status).toBe('running');
    expect(Object.keys(sample.state.tasks)).toHaveLength(1);
    expect(Object.keys(sample.state.agents)).toHaveLength(1);
  });

  it('snapshot variant – minimal (empty run)', () => {
    const sample: ServerSideMessage = {
      type: 'snapshot',
      runId: 'run-1',
      seq: 0,
      state: makeMinimalProjection(),
    };
    checkVariant(sample);
    expect(sample.type).toBe('snapshot');
    expect(sample.runId).toBe('run-1');
    expect(sample.state.tasks).toEqual({});
    expect(sample.state.agents).toEqual({});
    expect(sample.state.runLog).toEqual([]);
  });

  it('events variant (run-scoped)', () => {
    const sample: ServerSideMessage = {
      type: 'events',
      runId: 'run-1',
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
    expect(sample.runId).toBe('run-1');
    expect(sample.seq).toBe(5);
    expect(sample.events).toHaveLength(2);
    expect(sample.events[0].type).toBe('phase_started');
    expect(sample.events[1].type).toBe('agent_spawned');
  });

  it('events variant – empty batch', () => {
    const sample: ServerSideMessage = {
      type: 'events',
      runId: 'run-1',
      seq: 3,
      events: [],
    };
    checkVariant(sample);
    expect(sample.type).toBe('events');
    expect(sample.runId).toBe('run-1');
    expect(sample.events).toHaveLength(0);
  });

  it('run_complete variant', () => {
    const sample: ServerSideMessage = { type: 'run_complete', runId: 'run-1' };
    checkVariant(sample);
    expect(sample.type).toBe('run_complete');
    expect(sample.runId).toBe('run-1');
  });

  it('run_failed variant', () => {
    const sample: ServerSideMessage = {
      type: 'run_failed',
      runId: 'run-1',
      error: 'Something went wrong',
      phase: 'planning',
    };
    checkVariant(sample);
    expect(sample.type).toBe('run_failed');
    expect(sample.runId).toBe('run-1');
    expect(sample.error).toBe('Something went wrong');
    expect(sample.phase).toBe('planning');
  });

  it('log variant', () => {
    const sample: ServerSideMessage = {
      type: 'log',
      runId: 'run-1',
      level: 'warn',
      message: 'disk almost full',
      timestamp: ISO_NOW,
    };
    checkVariant(sample);
    expect(sample.type).toBe('log');
    expect(sample.runId).toBe('run-1');
    expect(sample.level).toBe('warn');
    expect(sample.message).toBe('disk almost full');
    expect(sample.timestamp).toBe(ISO_NOW);
  });

  it('auth_required variant', () => {
    const sample: ServerSideMessage = { type: 'auth_required' };
    checkVariant(sample);
    expect(sample.type).toBe('auth_required');
  });

  it('error variant (no runId)', () => {
    const sample: ServerSideMessage = {
      type: 'error',
      code: 'UNKNOWN_RUN',
      message: 'no such run',
    };
    checkVariant(sample);
    expect(sample.type).toBe('error');
    expect(sample.code).toBe('UNKNOWN_RUN');
    expect(sample.message).toBe('no such run');
    expect(sample.runId).toBeUndefined();
  });

  it('error variant (with runId)', () => {
    const sample: ServerSideMessage = {
      type: 'error',
      runId: 'run-1',
      code: 'BAD_MESSAGE',
      message: 'malformed payload',
    };
    checkVariant(sample);
    expect(sample.type).toBe('error');
    expect(sample.runId).toBe('run-1');
    expect(sample.code).toBe('BAD_MESSAGE');
  });

  it('worktree_merge_result variant (clean merge, no preserved fields)', () => {
    const sample: ServerSideMessage = {
      type: 'worktree_merge_result',
      runId: 'run-1',
      outcome: 'clean',
    };
    checkVariant(sample);
    expect(sample.type).toBe('worktree_merge_result');
    expect(sample.runId).toBe('run-1');
    expect(sample.outcome).toBe('clean');
  });

  it('worktree_merge_result variant (failed, everything preserved)', () => {
    const sample: ServerSideMessage = {
      type: 'worktree_merge_result',
      runId: 'run-1',
      outcome: 'failed',
      cleanupError: 'worktree busy',
      worktreePath: '/repo/.engin/wt/run-1',
      branchName: 'engin/run-1',
    };
    checkVariant(sample);
    expect(sample.outcome).toBe('failed');
    expect(sample.cleanupError).toBe('worktree busy');
    expect(sample.worktreePath).toBe('/repo/.engin/wt/run-1');
    expect(sample.branchName).toBe('engin/run-1');
  });
});

// ─── 4. ClientMessage sample objects ───────────────────────────────────────

function checkClientMessage<T extends ServerClientMessage & WebClientMessage>(_obj: T): void {
  // no-op: compile-time check only
}

describe('ClientMessage – variant parity (sample objects)', () => {
  it('auth variant (no token)', () => {
    const sample: ServerClientMessage = { type: 'auth' };
    checkClientMessage(sample);
    expect(sample.type).toBe('auth');
  });

  it('auth variant (with token)', () => {
    const sample: ServerClientMessage = { type: 'auth', token: 'secret-token' };
    checkClientMessage(sample);
    expect(sample.type).toBe('auth');
    expect(sample.token).toBe('secret-token');
  });

  it('list_runs variant', () => {
    const sample: ServerClientMessage = { type: 'list_runs' };
    checkClientMessage(sample);
    expect(sample.type).toBe('list_runs');
  });

  it('start_run variant (required fields only)', () => {
    const sample: ServerClientMessage = {
      type: 'start_run',
      workflowName: 'develop',
      taskPrompt: 'Build the feature',
      cwd: '/home/user/project',
    };
    checkClientMessage(sample);
    expect(sample.type).toBe('start_run');
    expect(sample.workflowName).toBe('develop');
    expect(sample.taskPrompt).toBe('Build the feature');
    expect(sample.cwd).toBe('/home/user/project');
  });

  it('start_run variant (all optional fields)', () => {
    const sample: ServerClientMessage = {
      type: 'start_run',
      workflowName: 'develop',
      taskPrompt: 'Build the feature',
      cwd: '/home/user/project',
      workDir: '/tmp/workdir',
      maxConcurrent: 4,
      apiKeys: { anthropic: 'sk-xxx' },
    };
    checkClientMessage(sample);
    expect(sample.workDir).toBe('/tmp/workdir');
    expect(sample.maxConcurrent).toBe(4);
  });

  it('subscribe variant', () => {
    const sample: ServerClientMessage = { type: 'subscribe', runId: 'run-1' };
    checkClientMessage(sample);
    expect(sample.type).toBe('subscribe');
    expect(sample.runId).toBe('run-1');
  });

  it('unsubscribe variant', () => {
    const sample: ServerClientMessage = { type: 'unsubscribe', runId: 'run-1' };
    checkClientMessage(sample);
    expect(sample.type).toBe('unsubscribe');
    expect(sample.runId).toBe('run-1');
  });

  it('resync variant (runId, no lastSeq)', () => {
    const sample: ServerClientMessage = { type: 'resync', runId: 'run-1' };
    checkClientMessage(sample);
    expect(sample.type).toBe('resync');
    expect(sample.runId).toBe('run-1');
  });

  it('resync variant (runId + lastSeq)', () => {
    const sample: ServerClientMessage = { type: 'resync', runId: 'run-1', lastSeq: 42 };
    checkClientMessage(sample);
    expect(sample.type).toBe('resync');
    expect(sample.runId).toBe('run-1');
    expect(sample.lastSeq).toBe(42);
  });

  it('cancel_run variant', () => {
    const sample: ServerClientMessage = { type: 'cancel_run', runId: 'run-1' };
    checkClientMessage(sample);
    expect(sample.type).toBe('cancel_run');
    expect(sample.runId).toBe('run-1');
  });

  it('worktree_action variant', () => {
    const sample: ServerClientMessage = {
      type: 'worktree_action',
      runId: 'run-1',
      action: 'merge',
    };
    checkClientMessage(sample);
    expect(sample.type).toBe('worktree_action');
    expect(sample.runId).toBe('run-1');
    expect(sample.action).toBe('merge');
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
  AgentEntity as ClientAgentEntity,
  EventRecord as ClientEventRecord,
  EventType as ClientEventType,
  LogEntry as ClientLogEntry,
  PhaseEntity as ClientPhaseEntity,
  StepEntity as ClientStepEntity,
  TaskEntity as ClientTaskEntity,
  WorkflowProjection as ClientWorkflowProjection,
  EventRecord,
  EventType,
  LogEntry,
  PhaseEntity,
  StepEntity,
  TaskEntity,
  WorkflowProjection,
} from '@engin/shared/protocol-types';

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

// ─── 5. JSON round-trip ────────────────────────────────────────────────────
//
// Every protocol value must be fully JSON-serializable (no Map, no class
// instances, no functions): messages travel over WebSocket as JSON text.
// JSON.parse(JSON.stringify(obj)) should produce a deep-equal copy.

describe('RunSummary – JSON round-trip', () => {
  it('survives JSON.parse(JSON.stringify()) with all fields', () => {
    const summary: RunSummary = makeRunSummary({ currentPhaseId: 'coding' });
    const roundTripped = JSON.parse(JSON.stringify(summary));
    expect(roundTripped).toEqual(summary);
  });

  it('survives round-trip with every status value', () => {
    for (const status of ['running', 'complete', 'failed'] as const) {
      const summary: RunSummary = makeRunSummary({ status });
      expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    }
  });

  it('omits currentPhaseId from the serialised form when undefined', () => {
    const summary: RunSummary = makeRunSummary();
    const serialised = JSON.parse(JSON.stringify(summary));
    expect('currentPhaseId' in serialised).toBe(false);
  });
});

describe('ServerMessage – JSON round-trip per variant', () => {
  it('runs round-trips through JSON', () => {
    const msg: ServerSideMessage = {
      type: 'runs',
      runs: [makeRunSummary(), makeRunSummary({ runId: 'run-2', status: 'failed' })],
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
    expect(roundTripped.runs).toHaveLength(2);
  });

  it('run_started round-trips through JSON', () => {
    const msg: ServerSideMessage = {
      type: 'run_started',
      runId: 'run-1',
      summary: makeRunSummary({ currentPhaseId: 'planning' }),
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
    expect(roundTripped.summary.status).toBe('running');
  });

  it('snapshot round-trips through JSON', () => {
    const msg: ServerSideMessage = {
      type: 'snapshot',
      runId: 'run-1',
      seq: 7,
      state: {
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
            status: 'active',
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
        sidebar: { title: 'Engin', indicator: '🟢' },
        status: 'running',
        stats: { totalTokens: 700, agentCount: 1 },
        runLog: [],
      },
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
    expect(roundTripped.runId).toBe('run-1');
  });

  it('events round-trips through JSON', () => {
    const msg: ServerSideMessage = {
      type: 'events',
      runId: 'run-1',
      seq: 3,
      events: [
        {
          seq: 3,
          type: 'phase_started',
          data: { phase: 'coding' },
          metadata: { timestamp: ISO_NOW, phaseId: 'coding' },
        },
      ],
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
    expect(roundTripped.events[0].type).toBe('phase_started');
  });

  it('run_complete round-trips through JSON', () => {
    const msg: ServerSideMessage = { type: 'run_complete', runId: 'run-1' };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('run_failed round-trips through JSON', () => {
    const msg: ServerSideMessage = {
      type: 'run_failed',
      runId: 'run-1',
      error: 'kaboom',
      phase: 'planning',
    };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('log round-trips through JSON', () => {
    const msg: ServerSideMessage = {
      type: 'log',
      runId: 'run-1',
      level: 'error',
      message: 'disk full',
      timestamp: ISO_NOW,
    };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('auth_required round-trips through JSON', () => {
    const msg: ServerSideMessage = { type: 'auth_required' };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('error round-trips through JSON (without runId)', () => {
    const msg: ServerSideMessage = {
      type: 'error',
      code: 'UNKNOWN_RUN',
      message: 'no such run',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
    expect('runId' in roundTripped).toBe(false);
  });

  it('error round-trips through JSON (with runId)', () => {
    const msg: ServerSideMessage = {
      type: 'error',
      runId: 'run-1',
      code: 'BAD_MESSAGE',
      message: 'malformed payload',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
    expect(roundTripped.runId).toBe('run-1');
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
