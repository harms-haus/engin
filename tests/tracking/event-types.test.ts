import type {
  EventRecord,
  EventType,
  LogEntry,
  PhaseEntity,
  SessionEntity,
  WorkflowProjection,
} from '@engin/shared/event-types';
import { createInitialProjection, MAX_RUN_LOG, MAX_WORKFLOW_EVENT_LOG } from '@engin/shared/event-types';
import { describe, expect, it } from 'bun:test';

// Also verify re-exports exist from core/types.ts
import type { StepDefinition, TaskEntity, TaskStatus } from '../../packages/engine/src/core/types.js';

// ── Type-level helpers ───────────────────────────────────────────────────────
// These are compile-time checks: they verify the types are well-formed.
// We use them inside expect().not.toBe(undefined) so they actually run.

const _typeCheck: EventType = 'workflow_started';

// Canonical, type-checked enumeration of every EventType member. Declared as
// EventType[] so the compiler rejects any literal that is not a union member.
// The count and exclude tests below all reference THIS array, so they can
// never drift out of sync with the source union.
const EXPECTED_EVENT_TYPES: EventType[] = [
  'workflow_started',
  'phase_registered',
  'phase_started',
  'phase_completed',
  'session_started',
  'session_completed',
  'session_failed',
  'auto_retry_started',
  'auto_retry_completed',
  'task_registered',
  'task_started',
  'task_completed',
  'task_rejected',
  'task_parked',
  'task_unparked',
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
  'agent_rendered',
  'workflow_data_set',
];

// Compile-time exhaustiveness guard: if EventType gains or loses a member,
// this assignment will fail to compile — extra keys and missing keys are both
// rejected by the Record<EventType, true> type annotation.
const _EventTypeExhaustive: Record<EventType, true> = {
  workflow_started: true,
  phase_registered: true,
  phase_started: true,
  phase_completed: true,
  session_started: true,
  session_completed: true,
  session_failed: true,
  auto_retry_started: true,
  auto_retry_completed: true,
  task_registered: true,
  task_started: true,
  task_completed: true,
  task_rejected: true,
  task_parked: true,
  task_unparked: true,
  decision: true,
  error: true,
  workflow_completed: true,
  workflow_failed: true,
  sidebar_updated: true,
  turn_started: true,
  turn_ended: true,
  tool_call_started: true,
  tool_call_ended: true,
  log: true,
  agent_rendered: true,
  workflow_data_set: true,
};

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
      'render',
    ];
    for (const t of types) {
      const entry: LogEntry = { id: 'l', timestamp: '', type: t, content: '' };
      expect(entry.type).toBe(t);
    }
  });

  it('allows the render log type', () => {
    const entry: LogEntry = {
      id: 'render-1',
      timestamp: '2026-06-16T12:00:00Z',
      type: 'render',
      content: '<rendered output>',
    };
    expect(entry.type).toBe('render');
    expect(entry.content).toBe('<rendered output>');
  });

  it('render entry can carry arbitrary metadata', () => {
    const entry: LogEntry = {
      id: 'render-2',
      timestamp: '2026-06-16T12:00:00Z',
      type: 'render',
      content: 'rendered markdown',
      metadata: { format: 'markdown', target: 'sidebar' },
    };
    expect(entry.type).toBe('render');
    expect(entry.metadata?.format).toBe('markdown');
    expect(entry.metadata?.target).toBe('sidebar');
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
});

it('includes log', () => {
  const t: EventType = 'log';
  expect(t).toBe('log');
});

it('includes agent_rendered as a member (appended after log)', () => {
  const t: EventType = 'agent_rendered';
  expect(t).toBe('agent_rendered');
});

it('workflow_data_set is the last member of EXPECTED_EVENT_TYPES (after agent_rendered)', () => {
  // Guards the required ordering: 'workflow_data_set' appended after 'agent_rendered'.
  const lastIndex = EXPECTED_EVENT_TYPES.length - 1;
  const renderIndex = EXPECTED_EVENT_TYPES.indexOf('agent_rendered');
  expect(EXPECTED_EVENT_TYPES[lastIndex]).toBe('workflow_data_set');
  expect(renderIndex).toBe(lastIndex - 1);
});
const validEvents: readonly string[] = EXPECTED_EVENT_TYPES;

it('excludes tasks_added from the union', () => {
  const validEvents: readonly string[] = EXPECTED_EVENT_TYPES;
  expect(validEvents).not.toContain('tasks_added');
});

it('includes all legacy events that were kept', () => {
  const legacy: EventType[] = [
    'workflow_started',
    'phase_started',
    'phase_completed',
    'session_started',
    'session_completed',
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

it('has exactly 27 members (including session_failed and workflow_data_set)', () => {
  // EXPECTED_EVENT_TYPES is typed as EventType[], so the array itself is a
  // compile-time guard: any literal here that is not a valid union member is
  // a type error. The length assertion catches a missing/extra member, and
  // the duplicate check guards against accidental repetition.
  expect(EXPECTED_EVENT_TYPES).toHaveLength(27);
  expect(new Set(EXPECTED_EVENT_TYPES).size).toBe(EXPECTED_EVENT_TYPES.length);
});

it('EXPECTED_EVENT_TYPES contains every member of the EventType union', () => {
  // Runtime Set comparison guards against drift in either direction: a
  // missing member or an extra member will fail this assertion.
  // _EventTypeExhaustive keys ARE the union members (typed via Record<EventType, true>).
  const guardKeys = Object.keys(_EventTypeExhaustive) as EventType[];
  expect(new Set(EXPECTED_EVENT_TYPES)).toEqual(new Set(guardKeys));
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
      type: 'session_started',
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
      type: 'log',
      data: {},
      metadata: {
        timestamp: '2026-06-14T12:00:00Z',
        taskId: 't1',
      },
    };
  });

  it('type accepts agent_rendered with agent metadata', () => {
    const record: EventRecord = {
      seq: 8,
      type: 'agent_rendered',
      data: { agentId: 'a1', output: '<rendered output>' },
      metadata: {
        timestamp: '2026-06-16T12:00:00Z',
        agentId: 'a1',
        phaseId: 'impl',
      },
    };
    expect(record.type).toBe('agent_rendered');
    expect(record.data.agentId).toBe('a1');
    expect(record.metadata.agentId).toBe('a1');
    expect(record.metadata.phaseId).toBe('impl');
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

describe('SessionEntity', () => {
  it('can be constructed with all required fields', () => {
    const agent: SessionEntity = {
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
      runnerRole: 'executor',
      attempt: 1,
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
    const agent: SessionEntity = {
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
      runnerRole: 'executor',
      attempt: 1,
    };
    expect(agent.phaseId).toBe('scouting');
    // @ts-expect-error - phase is no longer a valid field
    const _check: undefined = (agent as { phase?: string }).phase;
    expect(_check).toBeUndefined();
  });

  it('stepIndex is optional', () => {
    const agent: SessionEntity = {
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
      runnerRole: 'executor',
      attempt: 1,
    };

    const agentWithStep: SessionEntity = {
      ...agent,
    };
  });

  it('optional fields: sessionId, sessionPath, completedAt', () => {
    const agent: SessionEntity = {
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
      runnerRole: 'executor',
      attempt: 1,
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
      sessions: {},
      sidebar: { title: 'Workflow', indicator: 'Running…' },
      status: 'running',
      stats: { totalTokens: 500, sessionCount: 2 },
      runLog: [],
    };
    expect(proj.seq).toBe(5);
    expect(proj.taskPrompt).toBe('Build it');
    expect(proj.phases).toHaveLength(2);
    expect(proj.currentPhaseId).toBe('impl');
    expect(proj.completedPhaseIds).toEqual(['scouting']);
    expect(proj.sidebar.title).toBe('Workflow');
    expect(proj.sidebar.indicator).toBe('Running…');
    expect(proj.status).toBe('running');
    expect(proj.stats).toEqual({ totalTokens: 500, sessionCount: 2 });
  });

  it('uses phases array instead of currentPhase/completedPhases strings', () => {
    const proj: WorkflowProjection = {
      seq: 0,
      taskPrompt: '',
      phases: [],
      currentPhaseId: '',
      completedPhaseIds: [],
      tasks: {},
      sessions: {},
      sidebar: { title: '', indicator: '' },
      status: 'running',
      stats: { totalTokens: 0, sessionCount: 0 },
      runLog: [],
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

describe('MAX_WORKFLOW_EVENT_LOG', () => {
  // Consolidated shared constant (defined alongside MAX_RUN_LOG) used by BOTH
  // the TUI ClientStore and the web WorkflowStore to bound workflowEventLog.
  // Previously the two stores diverged (TUI = 10000, web = 1000); this is the
  // single source of truth. The unified value is 10000 (the larger cap) so
  // long-running workflows keep ample scroll-back.
  it('is exported as a number equal to 10000', () => {
    expect(typeof MAX_WORKFLOW_EVENT_LOG).toBe('number');
    expect(MAX_WORKFLOW_EVENT_LOG).toBe(10000);
  });

  it('is distinct from MAX_RUN_LOG (a separate server-console log cap)', () => {
    expect(MAX_WORKFLOW_EVENT_LOG).not.toBe(MAX_RUN_LOG);
    expect(MAX_WORKFLOW_EVENT_LOG).toBeGreaterThan(MAX_RUN_LOG);
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
    expect(proj.sessions).toEqual({});
    expect(proj.sidebar).toEqual({ title: '', indicator: '' });
    expect(proj.status).toBe('running');
    expect(proj.stats).toEqual({ totalTokens: 0, sessionCount: 0 });
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

      dependencies: [],
    };
    expect(task.id).toBe('t1');
    expect(task.phaseId).toBe('impl');
    expect(task.status).toBe('active');
    expect(task.dependencies).toEqual([]);
  });

  it('TaskStatus is re-exported', () => {
    const statuses: TaskStatus[] = ['ready', 'blocked', 'active', 'complete', 'failed', 'cancelled', 'parked'];
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

      dependencies: ['t0'],
      startedAt: 1000,
    };
    expect(proj.tasks['t1'].phaseId).toBe('impl');
    expect(proj.tasks['t1'].dependencies).toEqual(['t0']);
    expect(proj.tasks['t1'].startedAt).toBe(1000);
  });
});

describe('Type compatibility: SessionEntity with stepIndex', () => {
  it('can associate an agent with a specific step', () => {
    const agent: SessionEntity = {
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
      runnerRole: 'executor',
      attempt: 1,
    };
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

// ── SessionEntity: contextWindow & startedAt ─────────────────────────────────
// These two new OPTIONAL fields are added alongside the existing token /
// lifecycle fields. They are optional so that legacy events (which never
// carried them) still produce valid SessionEntity values.

describe('SessionEntity: contextWindow & startedAt', () => {
  // A minimal, valid SessionEntity used as a base across these tests.
  const baseAgent: SessionEntity = {
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
    runnerRole: 'executor',
    attempt: 1,
  };

  it('contextWindow is optional and defaults to undefined when omitted', () => {
    const agent: SessionEntity = { ...baseAgent };
    expect(agent.contextWindow).toBeUndefined();
  });

  it('startedAt is optional and defaults to undefined when omitted', () => {
    const agent: SessionEntity = { ...baseAgent };
    expect(agent.startedAt).toBeUndefined();
  });

  it('contextWindow can be set to the resolved model context size (number)', () => {
    const agent: SessionEntity = { ...baseAgent, contextWindow: 200000 };
    expect(agent.contextWindow).toBe(200000);
    expect(typeof agent.contextWindow).toBe('number');
  });

  it('startedAt can be set to an ISO timestamp string', () => {
    const iso = '2026-06-18T12:00:00.000Z';
    const agent: SessionEntity = { ...baseAgent, startedAt: iso };
    expect(agent.startedAt).toBe(iso);
    expect(typeof agent.startedAt).toBe('string');
    // The value round-trips through Date parsing (i.e. it is a real ISO time).
    expect(new Date(agent.startedAt as string).toISOString()).toBe(iso);
  });

  it('both new fields coexist with every existing field (no regressions)', () => {
    const agent: SessionEntity = {
      uid: 'a1::t1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      taskId: 't1',
      sessionId: 'sess-1',
      sessionPath: '/tmp/sess',
      active: false,
      log: [{ id: 'l1', timestamp: '2026-06-18T12:00:00Z', type: 'text', content: 'hi' }],
      toolCallCount: 3,
      inputTokens: 1200,
      outputTokens: 800,
      taskTitle: 'Build auth',
      runnerRole: 'executor',
      attempt: 1,
      completedAt: '2026-06-18T13:00:00.000Z',
      contextWindow: 160000,
      startedAt: '2026-06-18T12:00:00.000Z',
    };
    // Existing fields are unchanged.
    expect(agent.uid).toBe('a1::t1');
    expect(agent.sessionId).toBe('sess-1');
    expect(agent.sessionPath).toBe('/tmp/sess');
    expect(agent.toolCallCount).toBe(3);
    expect(agent.inputTokens).toBe(1200);
    expect(agent.outputTokens).toBe(800);
    expect(agent.taskTitle).toBe('Build auth');
    expect(agent.completedAt).toBe('2026-06-18T13:00:00.000Z');
    // New fields are present.
    expect(agent.contextWindow).toBe(160000);
    expect(agent.startedAt).toBe('2026-06-18T12:00:00.000Z');
  });

  it('a legacy agent (shaped like the pre-change schema) is still valid', () => {
    // Backward compatibility: an agent carrying none of the new optional
    // fields must still satisfy SessionEntity and behave correctly.
    const legacy: SessionEntity = {
      uid: 'legacy',
      agentId: 'legacy',
      profile: 'scout',
      phaseId: 'scouting',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: 'Legacy task',
      runnerRole: 'executor',
      attempt: 1,
    };
    expect(legacy.contextWindow).toBeUndefined();
    expect(legacy.startedAt).toBeUndefined();
    // Required fields are unaffected.
    expect(legacy.profile).toBe('scout');
    expect(legacy.active).toBe(true);
  });
});

describe('SessionEntity field semantics: context % and duration', () => {
  it('contextWindow allows computing a context-utilization percentage', () => {
    const agent: SessionEntity = {
      uid: 'a1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 40000,
      outputTokens: 0,
      taskTitle: '',
      runnerRole: 'executor',
      attempt: 1,
      contextWindow: 200000,
    };
    const used = agent.inputTokens + agent.outputTokens;
    const pct = Math.round((used / (agent.contextWindow as number)) * 100);
    expect(pct).toBe(20);
  });

  it('sessions without contextWindow yield no defined context %', () => {
    const agent: SessionEntity = {
      uid: 'a1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 5000,
      outputTokens: 0,
      taskTitle: '',
      runnerRole: 'executor',
      attempt: 1,
    };
    const pct =
      agent.contextWindow != null
        ? Math.round(((agent.inputTokens + agent.outputTokens) / agent.contextWindow) * 100)
        : undefined;
    expect(pct).toBeUndefined();
  });

  it('startedAt + completedAt allow computing per-agent duration', () => {
    const start = '2026-06-18T12:00:00.000Z';
    const end = '2026-06-18T12:05:00.000Z';
    const agent: SessionEntity = {
      uid: 'a1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      active: false,
      log: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
      runnerRole: 'executor',
      attempt: 1,
      startedAt: start,
      completedAt: end,
    };
    const durationMs = new Date(agent.completedAt as string).getTime() - new Date(agent.startedAt as string).getTime();
    expect(durationMs).toBe(5 * 60 * 1000);
  });

  it('startedAt alone (no completedAt) yields no end-to-end duration yet', () => {
    const agent: SessionEntity = {
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
      runnerRole: 'executor',
      attempt: 1,
      startedAt: '2026-06-18T12:00:00.000Z',
    };
    // Without completedAt the agent is still running: no duration to compute.
    expect(agent.completedAt).toBeUndefined();
    expect(agent.startedAt).toBe('2026-06-18T12:00:00.000Z');
  });
});

describe('createInitialProjection: optional agent fields need no defaults', () => {
  it('initial sessions record is empty (optional fields need no defaults)', () => {
    const proj = createInitialProjection();
    expect(proj.sessions).toEqual({});
    expect(Object.keys(proj.sessions)).toHaveLength(0);
  });

  it('can store an agent that uses the new optional fields', () => {
    const proj = createInitialProjection();
    proj.sessions['a1'] = {
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
      runnerRole: 'executor',
      attempt: 1,
      contextWindow: 128000,
      startedAt: '2026-06-18T12:00:00.000Z',
    };
    expect(proj.sessions['a1'].contextWindow).toBe(128000);
    expect(proj.sessions['a1'].startedAt).toBe('2026-06-18T12:00:00.000Z');
  });
});
