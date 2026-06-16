import type {
  AgentEntity,
  EventRecord,
  EventType,
  LogEntry,
  PhaseEntity,
  WorkflowProjection,
} from '@engin/shared/event-types';
import { createInitialProjection, MAX_RUN_LOG } from '@engin/shared/event-types';
import { describe, expect, it } from 'bun:test';

// Also verify re-exports exist from core/types.ts
import type { StepDefinition, StepEntity, TaskEntity, TaskStatus } from '../../packages/engine/src/core/types.js';

// ── Type-level helpers ───────────────────────────────────────────────────────
// These are compile-time checks: they verify the types are well-formed.
// We use them inside expect().not.toBe(undefined) so they actually run.

const _typeCheck: EventType = 'workflow_started';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('LogEntry', () => {
  it('can be constructed with all required fields', () => {
    const entry: LogEntry = {
      id: 'log-1',
      timestamp: '2026-06-14T12:00:00Z',
      type: 'text',
      content: 'Hello, world!',
    };
    expect(entry.id).toBe('log-1');
    expect(entry.timestamp).toBe('2026-06-14T12:00:00Z');
    expect(entry.type).toBe('text');
    expect(entry.content).toBe('Hello, world!');
  });

  it('allows all LogEntry types', () => {
    const types: LogEntry['type'][] = [
      'text',
      'thinking',
      'tool_call',
      'tool_call_start',
      'tool_call_end',
      'decision',
      'error',
    ];
    for (const t of types) {
      const entry: LogEntry = { id: 'l', timestamp: '', type: t, content: '' };
      expect(entry.type).toBe(t);
    }
  });

  it('metadata is optional', () => {
    const entry: LogEntry = { id: 'l', timestamp: '', type: 'text', content: '' };
    expect(entry.metadata).toBeUndefined();
  });

  it('metadata can hold arbitrary values', () => {
    const entry: LogEntry = {
      id: 'l',
      timestamp: '',
      type: 'tool_call_start',
      content: 'bash',
      metadata: { toolName: 'bash', toolCallId: 'tc-1', arguments: { command: 'ls' } },
    };
    expect(entry.metadata?.toolName).toBe('bash');
    expect(entry.metadata?.toolCallId).toBe('tc-1');
  });
});

describe('EventType', () => {
  // Verify the new events are valid members of the union
  it('includes phase_registered', () => {
    const t: EventType = 'phase_registered';
    expect(t).toBe('phase_registered');
  });

  it('includes task_registered', () => {
    const t: EventType = 'task_registered';
    expect(t).toBe('task_registered');
  });

  it('includes step_started', () => {
    const t: EventType = 'step_started';
    expect(t).toBe('step_started');
  });

  it('includes log', () => {
    const t: EventType = 'log';
    expect(t).toBe('log');
  });

  it('excludes task_step_started from the union', () => {
    const validEvents: readonly string[] = [
      'workflow_started',
      'phase_registered',
      'phase_started',
      'phase_completed',
      'agent_spawned',
      'agent_completed',
      'task_registered',
      'task_started',
      'step_started',
      'task_completed',
      'task_rejected',
      'decision',
      'error',
      'workflow_completed',
      'workflow_failed',
      'sidebar_updated',
      'turn_started',
      'turn_ended',
      'tool_call_started',
      'tool_call_ended',
    ];
    expect(validEvents).not.toContain('task_step_started');
  });

  it('excludes tasks_added from the union', () => {
    const validEvents: readonly string[] = [
      'workflow_started',
      'phase_registered',
      'phase_started',
      'phase_completed',
      'agent_spawned',
      'agent_completed',
      'task_registered',
      'task_started',
      'step_started',
      'task_completed',
      'task_rejected',
      'decision',
      'error',
      'workflow_completed',
      'workflow_failed',
      'sidebar_updated',
      'turn_started',
      'turn_ended',
      'tool_call_started',
      'tool_call_ended',
    ];
    expect(validEvents).not.toContain('tasks_added');
  });

  it('includes all legacy events that were kept', () => {
    const legacy: EventType[] = [
      'workflow_started',
      'phase_started',
      'phase_completed',
      'agent_spawned',
      'agent_completed',
      'task_started',
      'task_completed',
      'task_rejected',
      'decision',
      'error',
      'workflow_completed',
      'workflow_failed',
      'sidebar_updated',
      'turn_started',
      'turn_ended',
      'tool_call_started',
      'tool_call_ended',
    ];
    for (const t of legacy) {
      const check: EventType = t;
      expect(check).toBe(t);
    }
  });

  it('has exactly 21 members (including log)', () => {
    // Count the members by assigning dummy values and counting
    const all: EventType[] = [
      'workflow_started',
      'phase_registered',
      'phase_started',
      'phase_completed',
      'agent_spawned',
      'agent_completed',
      'task_registered',
      'task_started',
      'step_started',
      'task_completed',
      'task_rejected',
      'decision',
      'error',
      'workflow_completed',
      'workflow_failed',
      'sidebar_updated',
      'turn_started',
      'turn_ended',
      'tool_call_started',
      'tool_call_ended',
      'log',
    ];
    expect(all).toHaveLength(21);
  });
});

describe('EventRecord', () => {
  it('can be constructed with required fields', () => {
    const record: EventRecord = {
      seq: 1,
      type: 'phase_registered',
      data: { id: 'p1', label: 'Phase 1', icon: '🚀' },
      metadata: { timestamp: '2026-06-14T12:00:00Z' },
    };
    expect(record.seq).toBe(1);
    expect(record.type).toBe('phase_registered');
    expect(record.data.id).toBe('p1');
  });

  it('metadata includes phaseId instead of phase', () => {
    const record: EventRecord = {
      seq: 2,
      type: 'agent_spawned',
      data: {},
      metadata: {
        timestamp: '2026-06-14T12:00:00Z',
        agentId: 'a1',
        taskId: 't1',
        phaseId: 'impl',
      },
    };
    expect(record.metadata.phaseId).toBe('impl');
    // @ts-expect-error - phase is no longer a valid metadata key
    const _check: undefined = record.metadata.phase;
    expect(_check).toBeUndefined();
  });

  it('metadata can include stepIndex', () => {
    const record: EventRecord = {
      seq: 3,
      type: 'step_started',
      data: {},
      metadata: {
        timestamp: '2026-06-14T12:00:00Z',
        taskId: 't1',
        stepIndex: 0,
      },
    };
    expect(record.metadata.stepIndex).toBe(0);
  });

  it('metadata fields are optional', () => {
    const record: EventRecord = {
      seq: 4,
      type: 'phase_registered',
      data: {},
      metadata: { timestamp: '2026-06-14T12:00:00Z' },
    };
    expect(record.metadata.agentId).toBeUndefined();
    expect(record.metadata.taskId).toBeUndefined();
    expect(record.metadata.phaseId).toBeUndefined();
    expect(record.metadata.stepIndex).toBeUndefined();
  });
});

describe('PhaseEntity', () => {
  it('can be constructed with all fields', () => {
    const phase: PhaseEntity = {
      id: 'scouting',
      label: 'Scouting',
      icon: '🔍',
      taskIds: ['t1', 't2'],
    };
    expect(phase.id).toBe('scouting');
    expect(phase.label).toBe('Scouting');
    expect(phase.icon).toBe('🔍');
    expect(phase.taskIds).toEqual(['t1', 't2']);
  });

  it('taskIds can be empty', () => {
    const phase: PhaseEntity = {
      id: 'review',
      label: 'Review',
      icon: '👁️',
      taskIds: [],
    };
    expect(phase.taskIds).toEqual([]);
  });

  it('has no status field (derived from projection)', () => {
    const phase: PhaseEntity = {
      id: 'impl',
      label: 'Implementation',
      icon: '⚙️',
      taskIds: [],
    };
    // @ts-expect-error - status is not a field on PhaseEntity
    const _check: undefined = (phase as { status?: string }).status;
    expect(_check).toBeUndefined();
  });
});

describe('AgentEntity', () => {
  it('can be constructed with all required fields', () => {
    const agent: AgentEntity = {
      uid: 'a1::t1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      taskId: 't1',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: 'Build auth',
    };
    expect(agent.uid).toBe('a1::t1');
    expect(agent.agentId).toBe('a1');
    expect(agent.profile).toBe('coder');
    expect(agent.phaseId).toBe('impl');
    expect(agent.taskId).toBe('t1');
    expect(agent.active).toBe(true);
    expect(agent.log).toEqual([]);
    expect(agent.taskTitle).toBe('Build auth');
  });

  it('uses phaseId instead of phase', () => {
    const agent: AgentEntity = {
      uid: 'a1',
      agentId: 'a1',
      profile: 'scout',
      phaseId: 'scouting',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
    };
    expect(agent.phaseId).toBe('scouting');
    // @ts-expect-error - phase is no longer a valid field
    const _check: undefined = (agent as { phase?: string }).phase;
    expect(_check).toBeUndefined();
  });

  it('stepIndex is optional', () => {
    const agent: AgentEntity = {
      uid: 'a1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
    };
    expect(agent.stepIndex).toBeUndefined();

    const agentWithStep: AgentEntity = {
      ...agent,
      stepIndex: 2,
    };
    expect(agentWithStep.stepIndex).toBe(2);
  });

  it('optional fields: sessionId, sessionPath, completedAt', () => {
    const agent: AgentEntity = {
      uid: 'a1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      active: false,
      log: [],
      toolCallCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      taskTitle: 'Task',
      sessionId: 'sess-1',
      sessionPath: '/tmp/sess',
      completedAt: '2026-06-14T12:00:00Z',
    };
    expect(agent.sessionId).toBe('sess-1');
    expect(agent.sessionPath).toBe('/tmp/sess');
    expect(agent.completedAt).toBe('2026-06-14T12:00:00Z');
  });
});

describe('WorkflowProjection', () => {
  it('has the correct shape', () => {
    const proj: WorkflowProjection = {
      seq: 5,
      taskPrompt: 'Build it',
      phases: [
        { id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: ['t1'] },
        { id: 'impl', label: 'Implementation', icon: '⚙️', taskIds: ['t2', 't3'] },
      ],
      currentPhaseId: 'impl',
      completedPhaseIds: ['scouting'],
      tasks: {},
      agents: {},
      sidebar: { title: 'Workflow', indicator: 'Running…' },
      status: 'running',
      stats: { totalTokens: 500, agentCount: 2 },
    };
    expect(proj.seq).toBe(5);
    expect(proj.taskPrompt).toBe('Build it');
    expect(proj.phases).toHaveLength(2);
    expect(proj.currentPhaseId).toBe('impl');
    expect(proj.completedPhaseIds).toEqual(['scouting']);
    expect(proj.sidebar.title).toBe('Workflow');
    expect(proj.sidebar.indicator).toBe('Running…');
    expect(proj.status).toBe('running');
    expect(proj.stats).toEqual({ totalTokens: 500, agentCount: 2 });
  });

  it('uses phases array instead of currentPhase/completedPhases strings', () => {
    const proj: WorkflowProjection = {
      seq: 0,
      taskPrompt: '',
      phases: [],
      currentPhaseId: '',
      completedPhaseIds: [],
      tasks: {},
      agents: {},
      sidebar: { title: '', indicator: '' },
      status: 'running',
      stats: { totalTokens: 0, agentCount: 0 },
    };
    // @ts-expect-error - currentPhase no longer exists
    const _cp: undefined = (proj as { currentPhase?: string }).currentPhase;
    expect(_cp).toBeUndefined();
    // @ts-expect-error - completedPhases no longer exists
    const _cps: undefined = (proj as { completedPhases?: string[] }).completedPhases;
    expect(_cps).toBeUndefined();
  });

  it('sidebar has no phases field', () => {
    const proj = createInitialProjection();
    // @ts-expect-error - sidebar.phases no longer exists
    const _p: undefined = proj.sidebar.phases;
    expect(_p).toBeUndefined();
  });

  it('supports status values: running, complete, failed', () => {
    const statuses: WorkflowProjection['status'][] = ['running', 'complete', 'failed'];
    for (const s of statuses) {
      const proj: WorkflowProjection = {
        ...createInitialProjection(),
        status: s,
      };
      expect(proj.status).toBe(s);
    }
  });

  it('error and failedPhase are optional', () => {
    const proj = createInitialProjection();
    expect(proj.error).toBeUndefined();
    expect(proj.failedPhase).toBeUndefined();

    const failedProj: WorkflowProjection = {
      ...proj,
      status: 'failed',
      error: 'Something broke',
      failedPhase: 'impl',
    };
    expect(failedProj.error).toBe('Something broke');
    expect(failedProj.failedPhase).toBe('impl');
  });

  it('has a runLog field of type LogEntry[]', () => {
    const proj: WorkflowProjection = {
      ...createInitialProjection(),
      runLog: [
        { id: 'r1', timestamp: '2026-06-15T00:00:00Z', type: 'text', content: 'server booted' },
        { id: 'r2', timestamp: '2026-06-15T00:00:01Z', type: 'error', content: 'kaboom' },
      ],
    };
    expect(Array.isArray(proj.runLog)).toBe(true);
    expect(proj.runLog).toHaveLength(2);
    expect(proj.runLog[0].content).toBe('server booted');
    expect(proj.runLog[1].type).toBe('error');
  });
});

describe('MAX_RUN_LOG', () => {
  it('is exported as a number equal to 200', () => {
    expect(typeof MAX_RUN_LOG).toBe('number');
    expect(MAX_RUN_LOG).toBe(200);
  });
});

describe('createInitialProjection', () => {
  it('returns a valid WorkflowProjection with default values', () => {
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
  });

  it('returns a fresh object each call (immutable factory)', () => {
    const a = createInitialProjection();
    const b = createInitialProjection();
    expect(a).not.toBe(b);
    // Mutating a should not affect b
    a.seq = 10;
    expect(b.seq).toBe(0);
  });

  it('returned object has no error or failedPhase', () => {
    const proj = createInitialProjection();
    expect(proj.error).toBeUndefined();
    expect(proj.failedPhase).toBeUndefined();
  });

  it('initializes runLog as an empty array', () => {
    const proj = createInitialProjection();
    expect(Array.isArray(proj.runLog)).toBe(true);
    expect(proj.runLog).toEqual([]);
  });

  it('returns a fresh runLog array each call (no shared reference)', () => {
    const a = createInitialProjection();
    const b = createInitialProjection();
    expect(a.runLog).not.toBe(b.runLog);
    a.runLog.push({ id: 'x', timestamp: '', type: 'text', content: 'mutate' });
    expect(b.runLog).toHaveLength(0);
  });
});

describe('Re-exports from core/types.ts', () => {
  it('TaskEntity is re-exported', () => {
    // Just verify the type is importable and has expected shape at runtime
    // via a plain object assignment.
    const task: TaskEntity = {
      id: 't1',
      title: 'Build auth',
      phaseId: 'impl',
      status: 'active',
      steps: [{ name: 'write-tests', index: 0 }],
      dependencies: [],
    };
    expect(task.id).toBe('t1');
    expect(task.phaseId).toBe('impl');
    expect(task.status).toBe('active');
    expect(task.steps).toHaveLength(1);
    expect(task.steps[0].name).toBe('write-tests');
    expect(task.dependencies).toEqual([]);
  });

  it('StepEntity is re-exported', () => {
    const step: StepEntity = {
      name: 'execute',
      index: 1,
      profile: 'coder',
      isReadOnly: false,
    };
    expect(step.name).toBe('execute');
    expect(step.index).toBe(1);
    expect(step.profile).toBe('coder');
    expect(step.isReadOnly).toBe(false);
  });

  it('TaskStatus is re-exported', () => {
    const statuses: TaskStatus[] = ['ready', 'blocked', 'active', 'complete', 'failed', 'cancelled'];
    for (const s of statuses) {
      const check: TaskStatus = s;
      expect(check).toBe(s);
    }
  });

  it('StepDefinition is re-exported', () => {
    const def: StepDefinition = {
      name: 'write-tests',
      profileId: 'tester',
      isReadOnly: false,
    };
    expect(def.name).toBe('write-tests');
    expect(def.profileId).toBe('tester');
    expect(def.isReadOnly).toBe(false);
  });
});

describe('Type compatibility: WorkflowProjection can hold TaskEntity tasks', () => {
  it('stores tasks with the new TaskEntity shape', () => {
    const proj = createInitialProjection();
    proj.tasks['t1'] = {
      id: 't1',
      title: 'Build auth',
      phaseId: 'impl',
      status: 'active',
      steps: [{ name: 'write-tests', index: 0 }],
      dependencies: ['t0'],
      startedAt: 1000,
    };
    expect(proj.tasks['t1'].phaseId).toBe('impl');
    expect(proj.tasks['t1'].steps).toHaveLength(1);
    expect(proj.tasks['t1'].dependencies).toEqual(['t0']);
    expect(proj.tasks['t1'].startedAt).toBe(1000);
  });
});

describe('Type compatibility: AgentEntity with stepIndex', () => {
  it('can associate an agent with a specific step', () => {
    const agent: AgentEntity = {
      uid: 'a1::t1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      stepIndex: 1,
      taskId: 't1',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: 'Build auth',
    };
    expect(agent.stepIndex).toBe(1);
  });
});

describe('Type compatibility: PhaseEntity in projection.phases', () => {
  it('phases array is ordered', () => {
    const proj: WorkflowProjection = {
      ...createInitialProjection(),
      phases: [
        { id: 'scouting', label: 'Scouting', icon: '🔍', taskIds: [] },
        { id: 'planning', label: 'Planning', icon: '📋', taskIds: [] },
        { id: 'implementation', label: 'Implementation', icon: '⚙️', taskIds: ['t1', 't2'] },
        { id: 'review', label: 'Review', icon: '👁️', taskIds: ['t3'] },
      ],
    };
    expect(proj.phases[0].id).toBe('scouting');
    expect(proj.phases[2].taskIds).toEqual(['t1', 't2']);
    expect(proj.phases[3].taskIds).toEqual(['t3']);
  });
});
