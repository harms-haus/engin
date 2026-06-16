// ─── Barrel verification: packages/shared/src/index.ts ──────────────────────
//
// The shared package gains a barrel entry point at `packages/shared/src/index.ts`
// that re-exports the public surface of every module in the package:
//
//   - types.js                 TaskStatus, StepDefinition, StepEntity, TaskEntity
//   - event-types.js           LogEntry, EventType, EventRecord, PhaseEntity,
//                              AgentEntity, WorkflowProjection, createInitialProjection
//                              (and re-exports the four types.js types)
//   - evolve.js                evolve, MAX_AGENT_LOG
//   - format-workflow-event.js formatWorkflowEventLine
//   - format-tool-call.js      formatToolCall
//   - protocol-types.js        ServerMessage, ClientMessage, isServerMessage
//                              (and re-exports the event-types.js types)
//
// COLLISIONS — several names are exported by MORE THAN ONE module:
//   • StepEntity / TaskEntity / TaskStatus / StepDefinition → types.js AND event-types.js
//   • AgentEntity / EventRecord / EventType / LogEntry / PhaseEntity /
//     WorkflowProjection / StepEntity / TaskEntity          → event-types.js AND protocol-types.js
//   (StepEntity and TaskEntity appear in all three.)
//
// A naive `export * from './types.js'` + `export * from './event-types.js'` would
// make those names AMBIGUOUS and TypeScript would silently DROP them from the
// barrel. This suite enforces that the barrel resolves every collision (via
// explicit named exports) so that ALL public symbols remain reachable from the
// package root.
//
// CONTRACT UNDER TEST: every shared export is reachable through a bare import
// from `@engin/shared`.
//
// NOTE on resolution: the bare specifier `@engin/shared` must resolve to
// `packages/shared/src/index.ts`. As of this refactor the root tsconfig only
// declares the `@engin/shared/*` subpath alias, so a bare entry such as
//   "@engin/shared": ["./packages/shared/src/index.ts"]
// is required for these imports to resolve at runtime/typecheck time.
//
// This suite verifies:
//   1. Every VALUE export is present, well-shaped, and is the IDENTICAL runtime
//      binding (===) of its canonical source module (a true re-export, not a
//      re-declaration).
//   2. Every TYPE export is importable from the barrel (compile-time) and is
//      structurally identical to its canonical source type — catching any name
//      masked by an ambiguous wildcard re-export.
//   3. The barrel's runtime namespace exposes EXACTLY the union of the source
//      modules' value exports — nothing dropped, nothing extra.
//   4. A behaviour smoke-test: the barrel's functions work end-to-end.

import { describe, expect, it } from 'bun:test';

// ── Barrel under test (bare package specifier) ──────────────────────────────
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
  formatToolCall,
  formatWorkflowEventLine,
  isServerMessage,
} from '@engin/shared';

// ── Canonical source modules (identity / structural comparison) ─────────────
import { createInitialProjection as srcCreateInitialProjection } from '@engin/shared/event-types';
import { evolve as srcEvolve, MAX_AGENT_LOG as srcMAX_AGENT_LOG } from '@engin/shared/evolve';
import { formatToolCall as srcFormatToolCall } from '@engin/shared/format-tool-call';
import { formatWorkflowEventLine as srcFormatWorkflowEventLine } from '@engin/shared/format-workflow-event';
import { isServerMessage as srcIsServerMessage } from '@engin/shared/protocol-types';

// ── Canonical type homes (where each type is *defined*) ─────────────────────
import type {
  AgentEntity as CanonicalAgentEntity,
  EventRecord as CanonicalEventRecord,
  EventType as CanonicalEventType,
  LogEntry as CanonicalLogEntry,
  PhaseEntity as CanonicalPhaseEntity,
  WorkflowProjection as CanonicalWorkflowProjection,
} from '@engin/shared/event-types';
import type {
  ClientMessage as CanonicalClientMessage,
  ServerMessage as CanonicalServerMessage,
} from '@engin/shared/protocol-types';
import type {
  StepDefinition as CanonicalStepDefinition,
  StepEntity as CanonicalStepEntity,
  TaskEntity as CanonicalTaskEntity,
  TaskStatus as CanonicalTaskStatus,
} from '@engin/shared/types';

// ── Type-level exact-equality utility (mirrors tests/core/types.test.ts) ────

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// Compile-time: each barrel type must be EXACTLY its canonical source type.
// These fail to compile if a name was masked by an ambiguous `export *`
// (the `import type` itself would error) OR if the barrel re-declared a
// divergent copy.
assertEqual<Equal<TaskStatus, CanonicalTaskStatus>>('barrel TaskStatus === types.ts TaskStatus');
assertEqual<Equal<StepEntity, CanonicalStepEntity>>('barrel StepEntity === types.ts StepEntity');
assertEqual<Equal<TaskEntity, CanonicalTaskEntity>>('barrel TaskEntity === types.ts TaskEntity');
assertEqual<Equal<StepDefinition, CanonicalStepDefinition>>('barrel StepDefinition === types.ts StepDefinition');
assertEqual<Equal<StepDefinition<string>, CanonicalStepDefinition<string>>>(
  'barrel StepDefinition<string> === types.ts StepDefinition<string>',
);

assertEqual<Equal<LogEntry, CanonicalLogEntry>>('barrel LogEntry === event-types.ts LogEntry');
assertEqual<Equal<EventType, CanonicalEventType>>('barrel EventType === event-types.ts EventType');
assertEqual<Equal<EventRecord, CanonicalEventRecord>>('barrel EventRecord === event-types.ts EventRecord');
assertEqual<Equal<PhaseEntity, CanonicalPhaseEntity>>('barrel PhaseEntity === event-types.ts PhaseEntity');
assertEqual<Equal<AgentEntity, CanonicalAgentEntity>>('barrel AgentEntity === event-types.ts AgentEntity');
assertEqual<Equal<WorkflowProjection, CanonicalWorkflowProjection>>(
  'barrel WorkflowProjection === event-types.ts WorkflowProjection',
);

assertEqual<Equal<ServerMessage, CanonicalServerMessage>>('barrel ServerMessage === protocol-types.ts ServerMessage');
assertEqual<Equal<ClientMessage, CanonicalClientMessage>>('barrel ClientMessage === protocol-types.ts ClientMessage');

// ── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function ev(
  type: EventType,
  data: Record<string, unknown> = {},
  metadata: EventRecord['metadata'] = { timestamp: '2026-06-15T00:00:00Z' },
): EventRecord {
  return { seq: ++seq, type, data, metadata };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('@engin/shared barrel — value exports present & well-shaped', () => {
  it('exports evolve as a function', () => {
    expect(typeof evolve).toBe('function');
  });

  it('exports MAX_AGENT_LOG equal to 500', () => {
    expect(MAX_AGENT_LOG).toBe(500);
    expect(typeof MAX_AGENT_LOG).toBe('number');
  });

  it('exports formatToolCall as a function', () => {
    expect(typeof formatToolCall).toBe('function');
  });

  it('exports formatWorkflowEventLine as a function', () => {
    expect(typeof formatWorkflowEventLine).toBe('function');
  });

  it('exports createInitialProjection as a function', () => {
    expect(typeof createInitialProjection).toBe('function');
  });

  it('exports isServerMessage as a function', () => {
    expect(typeof isServerMessage).toBe('function');
  });
});

describe('@engin/shared barrel — value exports are the canonical bindings (identity)', () => {
  it('evolve is the SAME binding as @engin/shared/evolve evolve', () => {
    expect(evolve).toBe(srcEvolve);
  });

  it('MAX_AGENT_LOG is the SAME binding as @engin/shared/evolve MAX_AGENT_LOG', () => {
    expect(MAX_AGENT_LOG).toBe(srcMAX_AGENT_LOG);
  });

  it('formatToolCall is the SAME binding as @engin/shared/format-tool-call formatToolCall', () => {
    expect(formatToolCall).toBe(srcFormatToolCall);
  });

  it('formatWorkflowEventLine is the SAME binding as @engin/shared/format-workflow-event formatWorkflowEventLine', () => {
    expect(formatWorkflowEventLine).toBe(srcFormatWorkflowEventLine);
  });

  it('createInitialProjection is the SAME binding as @engin/shared/event-types createInitialProjection', () => {
    expect(createInitialProjection).toBe(srcCreateInitialProjection);
  });

  it('isServerMessage is the SAME binding as @engin/shared/protocol-types isServerMessage', () => {
    expect(isServerMessage).toBe(srcIsServerMessage);
  });
});

describe('@engin/shared barrel — collision-prone types remain reachable (not masked)', () => {
  // Each of these names is exported by TWO or THREE source modules. A
  // wildcard-only barrel would mask them. Constructing a value of each type
  // proves the import resolved — otherwise this file would not compile.

  it('exposes the types.js ⇄ event-types.js shared names', () => {
    const status: TaskStatus = 'ready';
    const step: StepEntity = { name: 'write-tests', index: 0 };
    const task: TaskEntity = {
      id: 't1',
      title: 'T',
      phaseId: 'p1',
      status,
      steps: [step],
      dependencies: [],
    };
    const def: StepDefinition = { name: 'write-tests', profileId: 'tester', isReadOnly: true };
    expect(task.steps[0]).toBe(step);
    expect(def.isReadOnly).toBe(true);
  });

  it('exposes the event-types.js ⇄ protocol-types.js shared names', () => {
    const rec: EventRecord = {
      seq: 1,
      type: 'workflow_started',
      data: {},
      metadata: { timestamp: 't' },
    };
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
    expect(rec.type).toBe('workflow_started');
    expect(projection.status).toBe('running');
    expect(agent.active).toBe(true);
    expect(phase.id).toBe('p1');
    expect(entry.content).toBe('hi');
  });

  it('exposes the protocol-only message types and EventType', () => {
    const server: ServerMessage = { type: 'workflow_complete' };
    const client: ClientMessage = { type: 'resync' };
    const evt: EventType = 'workflow_started';
    expect(server.type).toBe('workflow_complete');
    expect(client.type).toBe('resync');
    expect(evt).toBe('workflow_started');
  });
});

describe('@engin/shared barrel — runtime namespace completeness', () => {
  it('exposes exactly the union of all source modules value exports', async () => {
    const [barrel, evolveMod, fmtWf, fmtTc, evtTypes, proto] = await Promise.all([
      import('@engin/shared'),
      import('@engin/shared/evolve'),
      import('@engin/shared/format-workflow-event'),
      import('@engin/shared/format-tool-call'),
      import('@engin/shared/event-types'),
      import('@engin/shared/protocol-types'),
    ]);

    // types.js exports only types → contributes no runtime keys.
    const expected = new Set<string>([
      ...Object.keys(evolveMod),
      ...Object.keys(fmtWf),
      ...Object.keys(fmtTc),
      ...Object.keys(evtTypes),
      ...Object.keys(proto),
    ]);

    expect(new Set(Object.keys(barrel))).toEqual(expected);
  });

  it('exposes all six public value exports by name', async () => {
    const barrel = (await import('@engin/shared')) as Record<string, unknown>;
    const names = Object.keys(barrel);
    for (const name of [
      'evolve',
      'MAX_AGENT_LOG',
      'formatToolCall',
      'formatWorkflowEventLine',
      'createInitialProjection',
      'isServerMessage',
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe('@engin/shared barrel — behaviour smoke tests', () => {
  it('createInitialProjection returns a valid default projection', () => {
    const proj = createInitialProjection();
    expect(proj.seq).toBe(0);
    expect(proj.status).toBe('running');
    expect(proj.tasks).toEqual({});
    expect(proj.agents).toEqual({});
  });

  it('evolve drives a minimal workflow_started event immutably', () => {
    seq = 0;
    const state = createInitialProjection();
    const next = evolve(state, ev('workflow_started', { taskPrompt: 'hello' }));
    expect(next).not.toBe(state);
    expect(next.taskPrompt).toBe('hello');
    expect(next.status).toBe('running');
  });

  it('formatToolCall renders a read tool call', () => {
    expect(formatToolCall('read', { path: './src/index.ts' })).toBe('📖 read → ./src/index.ts');
  });

  it('formatWorkflowEventLine renders a workflow_started event', () => {
    const line = formatWorkflowEventLine(ev('workflow_started', { taskPrompt: 'Build it', resumed: false }));
    expect(line).toBe('🚀 Workflow started: "Build it" (resumed: false)');
  });

  it('isServerMessage recognises valid and rejects invalid payloads', () => {
    expect(isServerMessage({ type: 'snapshot', seq: 0, state: createInitialProjection() })).toBe(true);
    expect(isServerMessage({ type: 'workflow_complete' })).toBe(true);
    expect(isServerMessage({ type: 'nope' })).toBe(false);
    expect(isServerMessage(null)).toBe(false);
    expect(isServerMessage(undefined)).toBe(false);
  });
});
