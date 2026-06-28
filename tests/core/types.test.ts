// ─── Task-tracking type contract tests ─────────────────────────────────────
//
// These tests pin the EXACT structural shape of the four task-tracking types
// that live (after the shared-package refactor) in packages/shared/src/types.ts
// and are re-exported from src/core/types.ts:
//
//   - TaskStatus      (string union)
//   - StepDefinition  (generic interface)
//   -       (projection shape)
//   - TaskEntity      (projection shape)
//
// Because src/core/types.ts re-exports these types, every downstream consumer
// keeps importing them from ../core/types.js unchanged. We therefore assert
// against the STABLE re-export path (../../src/core/types.js): the suite
// compiles and passes both BEFORE the types are physically relocated to the
// shared package and AFTER the move. If the refactor drops a union member,
// renames a field, flips optionality, or forgets the re-export, these tests
// fail — proving the move is behaviour-preserving.
//
// === How it works ===
//
// 1. Equal<X, Y>  — exact structural type equality via the function-call-
//    signature trick. Resolves to `true` iff X and Y are structurally
//    identical (catches extra/missing fields, optionality, type changes).
//
// 2. assertEqual  — compile-time assertion that a type-level boolean is `true`.
//    when the two types diverge. Enforced by `tsc --noEmit` on this file and
//    by IDEs; matches the pattern in tests/web/protocol-types-parity.test.ts.
//
// 3. Runtime checks — sample objects (assignability + field values), JSON
//    round-trips, and the TaskStatus member set — run under `bun test`.

import { describe, expect, it } from 'bun:test';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { StepDefinition, TaskEntity, TaskStatus } from '../../packages/engine/src/core/types.js';
import { STATUS_CALLBACK_METHODS } from '../../packages/engine/src/core/types.js';

// ─── Type-level exact equality utility ─────────────────────────────────────

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// ─── Independent "expected" copies ─────────────────────────────────────────
//
// Defined WITHOUT referencing the imported types, so Equal<Imported, Expected>
// is a genuine independent structural comparison (not identity). Keeping these
// in sync with the real definitions is exactly what guards the refactor.

type ExpectedTaskStatus = 'ready' | 'blocked' | 'active' | 'complete' | 'failed' | 'cancelled' | 'parked';

interface Expected {
  name: string;
  index: number; // 0-based position within the task
  profile?: string; // profileId this step runs as
  agentKey?: string; // key into projection.sessions once spawned
  isReadOnly?: boolean;
}

interface ExpectedTaskEntity {
  id: string;
  title: string;
  phaseId: string; // REQUIRED
  status: ExpectedTaskStatus;
  dependencies: string[]; // task ids
  startedAt?: number;
  completedAt?: string;
  sessionPlan?: { role: string; profile: string }[];
}

interface ExpectedStepDefinition<T = unknown> {
  name: string;
  profileId: string;
  isReadOnly: boolean;
  schema?: ZodType<T>;
  isApproved?: (result: T) => boolean;
  getFeedback?: (result: T) => string;
}

// ─── Compile-time structural equality assertions ───────────────────────────

assertEqual<Equal<TaskStatus, ExpectedTaskStatus>>('TaskStatus union members are unchanged');
assertEqual<Equal<TaskEntity, ExpectedTaskEntity>>('TaskEntity shape is unchanged');
assertEqual<Equal<StepDefinition, ExpectedStepDefinition>>('StepDefinition<unknown> shape is unchanged');
assertEqual<Equal<StepDefinition<string>, ExpectedStepDefinition<string>>>(
  'StepDefinition<string> generic instantiation is unchanged',
);

// ─── TaskStatus ─────────────────────────────────────────────────────────────

describe('TaskStatus', () => {
  it('contains exactly the seven expected lifecycle states', () => {
    // Each literal must be assignable to TaskStatus (compile-time) and the set
    // must contain exactly seven distinct members (runtime).
    const all: TaskStatus[] = ['ready', 'blocked', 'active', 'complete', 'failed', 'cancelled', 'parked'];
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
  });

  it('every member is a string literal', () => {
    // Covariance check: every TaskStatus is assignable to string. The fact that
    // the union is CLOSED (no extra members like 'paused') is enforced at
    // compile time by the Equal<TaskStatus, ExpectedTaskStatus> assertion above.
    const all: TaskStatus[] = ['ready', 'blocked', 'active', 'complete', 'failed', 'cancelled', 'parked'];
    for (const s of all) {
      expect(typeof s).toBe('string');
    }
  });
});

// ─── TaskEntity ─────────────────────────────────────────────────────────────

describe('TaskEntity', () => {
  it('accepts a fully-populated projection with nested steps', () => {
    const task: TaskEntity = {
      id: 't1',
      title: 'Implement feature',
      phaseId: 'coding',
      status: 'active',

      dependencies: ['t0'],
      startedAt: 1700000000000,
    };
    expect(task.phaseId).toBe('coding');
    expect(task.status).toBe('active');
    expect(task.dependencies).toEqual(['t0']);
    expect(task.startedAt).toBe(1700000000000);
  });

  it('accepts a minimal object with only the required fields', () => {
    const task: TaskEntity = {
      id: 't2',
      title: 'Tiny task',
      phaseId: 'planning',
      status: 'ready',

      dependencies: [],
    };
    expect(task.dependencies).toEqual([]);
    expect(task.startedAt).toBeUndefined();
    expect(task.completedAt).toBeUndefined();
  });

  it('accepts every TaskStatus value for the status field', () => {
    const base = {
      id: 't3',
      title: 'T',
      phaseId: 'p',
      dependencies: [] as string[],
    };
    const ready: TaskEntity = { ...base, status: 'ready' };
    const blocked: TaskEntity = { ...base, status: 'blocked' };
    const active: TaskEntity = { ...base, status: 'active' };
    const complete: TaskEntity = { ...base, status: 'complete', completedAt: '2025-01-01T00:00:00.000Z' };
    const failed: TaskEntity = { ...base, status: 'failed' };
    const cancelled: TaskEntity = { ...base, status: 'cancelled' };
    const parked: TaskEntity = { ...base, status: 'parked' };
    expect([ready, blocked, active, complete, failed, cancelled, parked].map((t) => t.status)).toEqual([
      'ready',
      'blocked',
      'active',
      'complete',
      'failed',
      'cancelled',
      'parked',
    ]);
  });

  it('survives a JSON round-trip', () => {
    const task: TaskEntity = {
      id: 't4',
      title: 'Round-trip',
      phaseId: 'phase-x',
      status: 'complete',

      dependencies: [],
      startedAt: 1,
      completedAt: '2025-06-15T00:00:00.000Z',
    };
    expect(JSON.parse(JSON.stringify(task))).toEqual(task);
  });
});

// ─── StepDefinition ─────────────────────────────────────────────────────────

describe('StepDefinition', () => {
  it('accepts a minimal definition (name, profileId, isReadOnly)', () => {
    const step: StepDefinition = { name: 'write-tests', profileId: 'tester', isReadOnly: true };
    expect(step.name).toBe('write-tests');
    expect(step.profileId).toBe('tester');
    expect(step.isReadOnly).toBe(true);
    expect(step.schema).toBeUndefined();
    expect(step.isApproved).toBeUndefined();
    expect(step.getFeedback).toBeUndefined();
  });

  it('accepts a read-only flag of false for write steps', () => {
    const step: StepDefinition = { name: 'implement', profileId: 'coder', isReadOnly: false };
    expect(step.isReadOnly).toBe(false);
  });

  it('accepts a structured-output definition with schema and callbacks', () => {
    const schema = z.object({ approved: z.boolean(), feedback: z.string() });
    const step: StepDefinition<{ approved: boolean; feedback: string }> = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
      schema,
      isApproved: (result) => result.approved === true,
      getFeedback: (result) => result.feedback ?? 'No feedback provided',
    };

    // The ZodObject is assignable to schema?: ZodType<T>.
    expect(step.schema).toBe(schema);
    expect(step.isApproved!({ approved: true, feedback: '' })).toBe(true);
    expect(step.isApproved!({ approved: false, feedback: '' })).toBe(false);
    expect(step.getFeedback!({ approved: false, feedback: 'broken tests' })).toBe('broken tests');
    expect(step.getFeedback!({ approved: false, feedback: 'No feedback provided' })).toBe('No feedback provided');
  });
});

// ─── Re-export surface integrity ────────────────────────────────────────────

describe('src/core/types.js re-export surface', () => {
  it('remains a loadable runtime module after the shared-package move', () => {
    // After the refactor, core/types.ts gains `import ... from '@engin/shared/types'`.
    // This assertion guarantees the module still loads without a runtime error
    // (e.g. an unresolvable bare specifier) and keeps exporting its values.
    expect(Array.isArray(STATUS_CALLBACK_METHODS)).toBe(true);
    expect(STATUS_CALLBACK_METHODS.length).toBeGreaterThan(0);
  });

  it('still re-exports all four moved types (named imports resolve)', () => {
    // The `import type { StepDefinition, TaskEntity, TaskStatus }`
    // at the top of this file is itself the guard: if the refactor forgets to
    // re-export any of these, `tsc --noEmit` on this file fails with
    // "Module ... has no exported member". Constructing values annotated with
    // each type guarantees every imported name is referenced (not dead code).
    const status: TaskStatus = 'ready';
    const taskEntity: TaskEntity = {
      id: 'x',
      title: 'T',
      phaseId: 'p',
      status,

      dependencies: [],
    };
    const stepDef: StepDefinition = { name: 'n', profileId: 'p', isReadOnly: true };
    expect(stepDef.isReadOnly).toBe(true);
  });
});
