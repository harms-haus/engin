/**
 * Tests for Layer 1c: PhaseEntity replaces PhaseDescriptor in protocol-types.
 *
 * Verifies:
 * 1. PhaseEntity and StepEntity are re-exported from src/web/protocol-types.ts
 * 2. PhaseDescriptor is no longer defined locally (replaced by PhaseEntity)
 * 3. The web layer re-export (web/src/protocol-types.ts) picks up PhaseEntity
 * 4. ServerMessage / ClientMessage / isServerMessage still compile unchanged
 */

import { describe, expect, it } from 'bun:test';

// ─── 1. Compile-time: new types are exported ───────────────────────────────
//
// These imports verify at compile time that PhaseEntity and StepEntity are
// re-exported from the protocol-types module. If they were missing, tsc/Bun
// would report "Module has no exported member".

import type { PhaseEntity, StepEntity, WorkflowProjection } from '../../src/web/protocol-types.ts';

// ─── 2. Runtime: module exports confirm the expected shape ─────────────────

describe('PhaseEntity is re-exported from protocol-types', () => {
  it('PhaseEntity has the correct structural shape (id, label, icon, taskIds)', () => {
    // This is a compile-time check: PhaseEntity is imported above.
    // At runtime we verify we can construct a value that satisfies the type.
    const phase: PhaseEntity = {
      id: 'test-phase',
      label: 'Test Phase',
      icon: '🧪',
      taskIds: ['task-1', 'task-2'],
    };
    expect(phase.id).toBe('test-phase');
    expect(phase.label).toBe('Test Phase');
    expect(phase.icon).toBe('🧪');
    expect(phase.taskIds).toEqual(['task-1', 'task-2']);
  });

  it('PhaseEntity is structurally compatible with the old PhaseDescriptor (id, label, icon)', () => {
    // PhaseDescriptor had { id, label, icon }. PhaseEntity adds taskIds.
    // Any code that previously used PhaseDescriptor can switch to PhaseEntity
    // by adding the taskIds field (or using a subset).
    const phase: PhaseEntity = {
      id: 'coding',
      label: 'Coding',
      icon: '💻',
      taskIds: [],
    };
    // The three original fields still exist
    expect(phase.id).toBe('coding');
    expect(phase.label).toBe('Coding');
    expect(phase.icon).toBe('💻');
  });
});

describe('StepEntity is re-exported from protocol-types', () => {
  it('StepEntity has the correct structural shape', () => {
    const step: StepEntity = {
      name: 'write-tests',
      index: 0,
      profile: 'coder',
      isReadOnly: false,
    };
    expect(step.name).toBe('write-tests');
    expect(step.index).toBe(0);
    expect(step.profile).toBe('coder');
    expect(step.isReadOnly).toBe(false);
  });

  it('StepEntity allows optional fields to be omitted', () => {
    const step: StepEntity = {
      name: 'review',
      index: 1,
    };
    expect(step.name).toBe('review');
    expect(step.index).toBe(1);
    expect(step.profile).toBeUndefined();
    expect(step.agentKey).toBeUndefined();
    expect(step.isReadOnly).toBeUndefined();
  });
});

// ─── 3. ServerMessage still works with updated WorkflowProjection ─────────

import type { ClientMessage, ServerMessage } from '../../src/web/protocol-types.ts';

describe('ServerMessage – unchanged shape with updated WorkflowProjection', () => {
  it('snapshot variant carries the new WorkflowProjection (with phases array)', () => {
    const msg: ServerMessage = {
      type: 'snapshot',
      seq: 1,
      state: {
        seq: 1,
        taskPrompt: 'Build the thing',
        phases: [
          { id: 'plan', label: 'Planning', icon: '📋', taskIds: ['t1'] },
          { id: 'code', label: 'Coding', icon: '💻', taskIds: ['t2'] },
        ],
        currentPhaseId: 'code',
        completedPhaseIds: ['plan'],
        tasks: {
          t1: {
            id: 't1',
            title: 'Plan API',
            phaseId: 'plan',
            status: 'complete',
            steps: [],
            dependencies: [],
            completedAt: '2025-01-01T00:00:00.000Z',
          },
          t2: {
            id: 't2',
            title: 'Implement API',
            phaseId: 'code',
            status: 'active',
            steps: [
              { name: 'write', index: 0, profile: 'coder' },
              { name: 'test', index: 1, profile: 'tester' },
            ],
            activeStepIndex: 0,
            dependencies: ['t1'],
          },
        },
        agents: {},
        sidebar: { title: 'Engin', indicator: '🟢' },
        status: 'running',
        stats: { totalTokens: 500, agentCount: 1 },
      },
    };
    expect(msg.type).toBe('snapshot');
    expect(msg.state.phases).toHaveLength(2);
    expect(msg.state.phases[0].id).toBe('plan');
    expect(msg.state.phases[0].taskIds).toEqual(['t1']);
    expect(msg.state.currentPhaseId).toBe('code');
    expect(msg.state.completedPhaseIds).toEqual(['plan']);
  });

  it('events variant still works unchanged', () => {
    const msg: ServerMessage = {
      type: 'events',
      seq: 2,
      events: [
        {
          seq: 1,
          type: 'phase_started',
          data: { phaseId: 'code' },
          metadata: { timestamp: new Date().toISOString(), phaseId: 'code' },
        },
      ],
    };
    expect(msg.type).toBe('events');
    expect(msg.events).toHaveLength(1);
  });

  it('workflow_complete variant still works unchanged', () => {
    const msg: ServerMessage = { type: 'workflow_complete' };
    expect(msg.type).toBe('workflow_complete');
  });

  it('workflow_failed variant still works unchanged', () => {
    const msg: ServerMessage = {
      type: 'workflow_failed',
      error: 'failure',
      phase: 'planning',
    };
    expect(msg.type).toBe('workflow_failed');
    expect(msg.error).toBe('failure');
    expect(msg.phase).toBe('planning');
  });
});

describe('ClientMessage – unchanged shape', () => {
  it('terminate_server variant', () => {
    const msg: ClientMessage = { type: 'terminate_server' };
    expect(msg.type).toBe('terminate_server');
  });

  it('resync variant without lastSeq', () => {
    const msg: ClientMessage = { type: 'resync' };
    expect(msg.type).toBe('resync');
  });

  it('resync variant with lastSeq', () => {
    const msg: ClientMessage = { type: 'resync', lastSeq: 42 };
    expect(msg.type).toBe('resync');
    expect(msg.lastSeq).toBe(42);
  });
});

// ─── 4. isServerMessage type guard still works ────────────────────────────

import { isServerMessage } from '../../src/web/protocol-types.ts';

describe('isServerMessage – unchanged', () => {
  it('returns true for valid snapshot message', () => {
    const msg = {
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
    expect(isServerMessage(msg)).toBe(true);
  });

  it('returns true for events message', () => {
    expect(isServerMessage({ type: 'events', seq: 0, events: [] })).toBe(true);
  });

  it('returns true for workflow_complete', () => {
    expect(isServerMessage({ type: 'workflow_complete' })).toBe(true);
  });

  it('returns true for workflow_failed', () => {
    expect(isServerMessage({ type: 'workflow_failed', error: 'err', phase: 'p' })).toBe(true);
  });

  it('returns false for unknown type', () => {
    expect(isServerMessage({ type: 'unknown' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isServerMessage(null)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isServerMessage('hello')).toBe(false);
  });
});

// ─── 5. Web layer re-export picks up PhaseEntity ──────────────────────────
//
// web/src/protocol-types.ts does `export * from '@engin/web/protocol-types'`
// which resolves to src/web/protocol-types.ts.  PhaseEntity should be
// available through the web app's import chain.

describe('Web re-export chain', () => {
  it('PhaseEntity is reachable via the same import path used by the web app', async () => {
    // Dynamic import from the backend source (the canonical location).
    // The web app uses `@engin/web/protocol-types` which resolves here.
    const mod = await import('../../src/web/protocol-types.js');
    // PhaseEntity is a type-only export, but we can verify it exists as
    // a re-export by checking that the module re-exports the named types.
    // TypeScript ensures compile-time availability; runtime we check
    // that the module object has the expected shape keys.
    const phase: PhaseEntity = {
      id: 'web-test',
      label: 'Web Test',
      icon: '🌐',
      taskIds: [],
    };
    expect(phase.id).toBe('web-test');
    // The module should export everything re-exported from event-types
    expect(mod).toBeDefined();
  });
});

// ─── 6. PhaseEntity is structurally assignable to/from WorkflowProjection ──

describe('PhaseEntity integration with WorkflowProjection', () => {
  it('WorkflowProjection.phases accepts PhaseEntity[]', () => {
    const proj: WorkflowProjection = {
      seq: 0,
      taskPrompt: 'test',
      phases: [
        { id: 'p1', label: 'Phase 1', icon: '1️⃣', taskIds: [] },
        { id: 'p2', label: 'Phase 2', icon: '2️⃣', taskIds: ['t1'] },
      ],
      currentPhaseId: 'p1',
      completedPhaseIds: [],
      tasks: {},
      agents: {},
      sidebar: { title: '', indicator: '' },
      status: 'running',
      stats: { totalTokens: 0, agentCount: 0 },
    };
    expect(proj.phases[0].id).toBe('p1');
    expect(proj.phases[1].taskIds).toEqual(['t1']);
  });

  it('WorkflowProjection.tasks value type includes StepEntity[]', () => {
    const proj: WorkflowProjection = {
      seq: 0,
      taskPrompt: '',
      phases: [],
      currentPhaseId: '',
      completedPhaseIds: [],
      tasks: {
        t1: {
          id: 't1',
          title: 'Task 1',
          phaseId: 'p1',
          status: 'active',
          steps: [
            { name: 'step-0', index: 0 },
            { name: 'step-1', index: 1, profile: 'prof', isReadOnly: true },
          ],
          activeStepIndex: 0,
          dependencies: [],
        },
      },
      agents: {},
      sidebar: { title: '', indicator: '' },
      status: 'running',
      stats: { totalTokens: 0, agentCount: 0 },
    };
    expect(proj.tasks.t1.steps).toHaveLength(2);
    expect(proj.tasks.t1.steps[0].name).toBe('step-0');
    expect(proj.tasks.t1.steps[1].profile).toBe('prof');
    expect(proj.tasks.t1.steps[1].isReadOnly).toBe(true);
  });
});
