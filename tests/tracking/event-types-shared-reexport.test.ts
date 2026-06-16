// ─── Move verification: event-types → @engin/shared/event-types ──────────────
//
// After the refactor, `event-types.ts` physically lives in
// packages/shared/src/event-types.ts and is consumed via the bare specifier
// `@engin/shared/event-types`. The OLD path src/tracking/event-types.ts is
// kept as a backward-compat shim that re-exports EVERYTHING from the shared
// package, so all existing consumers (src/index.ts barrel, TUI components,
// web/status-bridge, etc.) keep compiling unchanged.
//
// This suite proves the move is behaviour-preserving by:
//
//   1. Importing every export directly from @engin/shared/event-types and
//      asserting each is present and well-shaped (the "new canonical home").
//   2. Importing the same exports from the OLD shim path and asserting they
//      are the IDENTICAL runtime binding (===) — proving the shim is a true
//      re-export, not a re-declaration.
//   3. Verifying, at the type level, that the four re-exported core types
//      (StepDefinition, StepEntity, TaskEntity, TaskStatus) sourced by the
//      shared event-types.ts are structurally identical to those exported by
//      @engin/shared/types — i.e. the import was switched from ../core/types.js
//      to ./types.js (sibling within the shared package).
//

import { describe, expect, it } from 'bun:test';

// ── NEW canonical home: shared package ──────────────────────────────────────
import type {
  AgentEntity,
  EventRecord,
  EventType,
  LogEntry,
  PhaseEntity,
  StepDefinition,
  StepEntity,
  TaskEntity,
  TaskStatus,
  WorkflowProjection,
} from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';

// ── Canonical core types, sourced straight from shared/types.ts ─────────────
import type {
  StepDefinition as CanonicalStepDefinition,
  StepEntity as CanonicalStepEntity,
  TaskEntity as CanonicalTaskEntity,
  TaskStatus as CanonicalTaskStatus,
} from '@engin/shared/types';

// ── OLD backward-compat shim path ───────────────────────────────────────────
import type {
  AgentEntity as ShimAgentEntity,
  EventRecord as ShimEventRecord,
  EventType as ShimEventType,
  LogEntry as ShimLogEntry,
  PhaseEntity as ShimPhaseEntity,
  StepDefinition as ShimStepDefinition,
  StepEntity as ShimStepEntity,
  TaskEntity as ShimTaskEntity,
  TaskStatus as ShimTaskStatus,
  WorkflowProjection as ShimWorkflowProjection,
} from '../../packages/engine/src/tracking/event-types.js';
import { createInitialProjection as shimCreateInitialProjection } from '../../packages/engine/src/tracking/event-types.js';

// ── Type-level exact-equality utility (mirrors tests/core/types.test.ts) ────

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// Compile-time: the re-exported core types must be structurally identical to
// the canonical ones defined in packages/shared/src/types.ts. This guards the
// import-path switch from ../core/types.js → ./types.js inside the moved file.
assertEqual<Equal<TaskStatus, CanonicalTaskStatus>>('TaskStatus sourced from ./types.js');
assertEqual<Equal<StepEntity, CanonicalStepEntity>>('StepEntity sourced from ./types.js');
assertEqual<Equal<TaskEntity, CanonicalTaskEntity>>('TaskEntity sourced from ./types.js');
assertEqual<Equal<StepDefinition, CanonicalStepDefinition>>('StepDefinition<unknown> sourced from ./types.js');
assertEqual<Equal<StepDefinition<string>, CanonicalStepDefinition<string>>>(
  'StepDefinition<string> sourced from ./types.js',
);

// Compile-time: the shim re-exported types are structurally identical to the
// shared package types (no shape drift introduced by the shim).
assertEqual<Equal<EventType, ShimEventType>>('shim EventType === shared EventType');
assertEqual<Equal<EventRecord, ShimEventRecord>>('shim EventRecord === shared EventRecord');
assertEqual<Equal<LogEntry, ShimLogEntry>>('shim LogEntry === shared LogEntry');
assertEqual<Equal<PhaseEntity, ShimPhaseEntity>>('shim PhaseEntity === shared PhaseEntity');
assertEqual<Equal<AgentEntity, ShimAgentEntity>>('shim AgentEntity === shared AgentEntity');
assertEqual<Equal<WorkflowProjection, ShimWorkflowProjection>>('shim WorkflowProjection === shared WorkflowProjection');
assertEqual<Equal<TaskStatus, ShimTaskStatus>>('shim TaskStatus === shared TaskStatus');
assertEqual<Equal<StepEntity, ShimStepEntity>>('shim StepEntity === shared StepEntity');
assertEqual<Equal<TaskEntity, ShimTaskEntity>>('shim TaskEntity === shared TaskEntity');
assertEqual<Equal<StepDefinition, ShimStepDefinition>>('shim StepDefinition === shared StepDefinition');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('@engin/shared/event-types — canonical exports', () => {
  it('exports createInitialProjection as a function', () => {
    expect(typeof createInitialProjection).toBe('function');
  });

  it('createInitialProjection returns a valid default WorkflowProjection', () => {
    const proj = createInitialProjection();
    expect(proj.seq).toBe(0);
    expect(proj.taskPrompt).toBe('');
    expect(proj.phases).toEqual([]);
    expect(proj.currentPhaseId).toBe('');
    expect(proj.completedPhaseIds).toEqual([]);
    expect(proj.tasks).toEqual({});
    expect(proj.agents).toEqual({});
    expect(proj.sidebar).toEqual({ title: '', indicator: '' });
    expect(proj.status).toBe('running');
    expect(proj.stats).toEqual({ totalTokens: 0, agentCount: 0 });
    expect(proj.error).toBeUndefined();
    expect(proj.failedPhase).toBeUndefined();
  });

  it('createInitialProjection returns a fresh object each call', () => {
    const a = createInitialProjection();
    const b = createInitialProjection();
    expect(a).not.toBe(b);
    a.seq = 99;
    expect(b.seq).toBe(0);
  });

  it('re-exports the four core types from ./types.js (runtime constructability)', () => {
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

  it('EventType includes the post-refactor event names', () => {
    const names: EventType[] = ['phase_registered', 'task_registered', 'step_started'];
    expect(names).toHaveLength(3);
  });
});

describe('src/tracking/event-types shim — re-exports from @engin/shared/event-types', () => {
  it('re-exports the SAME createInitialProjection binding (identity)', () => {
    // === proves the shim does `export ... from '@engin/shared/event-types'`
    // rather than re-declaring its own copy.
    expect(shimCreateInitialProjection).toBe(createInitialProjection);
  });

  it('shim createInitialProjection produces the same default projection', () => {
    const proj = shimCreateInitialProjection();
    expect(proj).toEqual(createInitialProjection());
  });
});
