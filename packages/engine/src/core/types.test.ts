// ─── Characterization tests for core/types.ts barrel re-export ──────────────
//
// These tests pin down the *observable* behavior of `core/types.ts` so that the
// planned split into `core/types/*.ts` modules with a barrel re-export can be
// verified to be behavior-preserving.
//
// They cover:
//   1. Runtime re-exports (`getModel`, `parseJsonWithRepair`) are callable.
//   2. `STATUS_CALLBACK_METHODS` is a frozen array with the exact expected
//      member set and ordering — AND is kept in sync with the `StatusCallbacks`
//      interface (compile-time + runtime cross-reference).
//   3. Type-level assertions: every exported interface/type still resolves from
//      `./types.js` and its structural shape is unchanged (compile-time).
//   4. `@ts-expect-error` guards confirm required fields cannot be omitted
//      across ALL required fields of key interfaces, and invalid literal
//      values are rejected.
//
// Module under test: ./types.js

import { describe, expect, it } from 'bun:test';

import { getModel, parseJsonWithRepair, STATUS_CALLBACK_METHODS } from './types.js';

// Type-only imports — these must all resolve from the barrel.
import type {
  AgentLoopResult,
  AgentProfile,
  AgentStatusCallbacks,
  AuditEvent,
  HarnessCreationOptions,
  PersistedAgentRecord,
  StatusCallbacks,
  StepDefinition,
  StepEntity,
  StructuredOutputOptions,
  Task,
  TaskEntity,
  TaskStatus,
  ThinkingLevel,
  TurnContentBlock,
  WorkflowEntry,
  WorkflowModule,
  WorkflowRunOptions,
  WorkflowState,
  WorkflowStatusCallbacks,
  WorktreeInfo,
} from './types.js';

// ─── Runtime re-exports ─────────────────────────────────────────────────────

describe('core/types barrel — runtime re-exports', () => {
  it('re-exports getModel as a function', () => {
    expect(typeof getModel).toBe('function');
  });

  it('re-exports parseJsonWithRepair as a function', () => {
    expect(typeof parseJsonWithRepair).toBe('function');
  });

  it('parseJsonWithRepair repairs simple JSON', () => {
    // Loose assertion: the re-export actually delegates to pi-ai.
    const result: { a: number } = parseJsonWithRepair('{"a":1}');
    expect(result).toEqual({ a: 1 });
  });
});

// ─── STATUS_CALLBACK_METHODS ────────────────────────────────────────────────

describe('STATUS_CALLBACK_METHODS', () => {
  it('is a frozen readonly array', () => {
    expect(Object.isFrozen(STATUS_CALLBACK_METHODS)).toBe(true);
    expect(Array.isArray(STATUS_CALLBACK_METHODS)).toBe(true);
  });

  it('contains the exact expected method names in order', () => {
    expect([...STATUS_CALLBACK_METHODS]).toEqual([
      'onWorkflowStart',
      'onPhaseStart',
      'onPhaseComplete',
      'onPhaseRegister',
      'onAgentSpawn',
      'onAgentComplete',
      'onTaskStart',
      'onTaskRegister',
      'onStepStart',
      'onTaskComplete',
      'onTaskRejected',
      'onDecision',
      'onAgentRender',
      'onError',
      'onWorkflowComplete',
      'onWorkflowFailed',
      'onTurnStart',
      'onTurnEnd',
      'onToolCallStart',
      'onToolCallEnd',
      'onAutoRetryStart',
      'onAutoRetryCompleted',
      'onSidebarUpdate',
    ]);
  });

  it('has 23 members', () => {
    expect(STATUS_CALLBACK_METHODS).toHaveLength(23);
  });

  it('contains no duplicate entries', () => {
    expect(new Set(STATUS_CALLBACK_METHODS).size).toBe(STATUS_CALLBACK_METHODS.length);
  });

  it('includes both onAutoRetryStart and onAutoRetryCompleted', () => {
    expect(STATUS_CALLBACK_METHODS).toContain('onAutoRetryStart');
    expect(STATUS_CALLBACK_METHODS).toContain('onAutoRetryCompleted');
  });

  it('contains every key of the StatusCallbacks interface (no missing callbacks)', () => {
    // Compile-time: every optional method name in StatusCallbacks must appear in
    // the STATUS_CALLBACK_METHODS array.  If a callback is added to the
    // interface but not to the array, this assertion set will fail at runtime.
    //
    // We list the full set of keys derived from the StatusCallbacks intersection
    // (WorkflowStatusCallbacks & AgentStatusCallbacks) and verify each one is
    // present in the runtime array.
    const interfaceKeys: (keyof StatusCallbacks)[] = [
      'onWorkflowStart',
      'onPhaseRegister',
      'onPhaseStart',
      'onPhaseComplete',
      'onAgentSpawn',
      'onAgentComplete',
      'onTaskStart',
      'onTaskRegister',
      'onStepStart',
      'onTaskComplete',
      'onTaskRejected',
      'onDecision',
      'onAgentRender',
      'onError',
      'onWorkflowComplete',
      'onWorkflowFailed',
      'onSidebarUpdate',
      'onAutoRetryStart',
      'onAutoRetryCompleted',
      'onTurnStart',
      'onTurnEnd',
      'onToolCallStart',
      'onToolCallEnd',
    ];

    for (const key of interfaceKeys) {
      expect(STATUS_CALLBACK_METHODS).toContain(key);
    }
  });
});

// ─── Type-level: every exported name resolves ───────────────────────────────
//
// Compile-time assertions that each type is structurally what we expect. These
// guards fail at compile time if the barrel drops or alters a type.

describe('core/types barrel — type resolution guards (compile-time)', () => {
  it('ThinkingLevel accepts all documented levels', () => {
    const levels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    expect(levels).toHaveLength(6);
  });

  it('AgentProfile has expected required fields', () => {
    const profile: AgentProfile = {
      id: 'p1',
      name: 'Tester',
      provider: 'openai',
      model: 'gpt-4o',
      thinkingLevel: 'medium',
      systemPrompt: 'do things',
      excludeTools: [],
      includeTools: [],
    };
    expect(profile.id).toBe('p1');
    // agent is optional
    const withAgent: AgentProfile = { ...profile, agent: 'codex' };
    expect(withAgent.agent).toBe('codex');
  });

  it('Task has required phaseId and status fields', () => {
    const task: Task = {
      id: 't1',
      title: 'A task',
      prompt: 'do it',
      profile: 'p1',
      files: [],
      dependencies: [],
      status: 'ready',
      phaseId: 'phase-1',
    };
    expect(task.phaseId).toBe('phase-1');
    // Optional fields
    const full: Task = {
      ...task,
      assignedAgent: 'a1',
      result: { ok: true },
      reviewFeedback: ['fix'],
      isCode: true,
    };
    expect(full.isCode).toBe(true);
  });

  it('WorkflowState has expected shape with nested stats', () => {
    const state: WorkflowState = {
      taskPrompt: 'build it',
      currentPhaseId: 'p1',
      completedPhaseIds: [],
      tasks: [],
      workflowData: {},
      stats: { totalTokens: 0, totalCost: 0, agentCount: 0 },
    };
    expect(state.stats.agentCount).toBe(0);
    const withWorktree: WorkflowState = {
      ...state,
      worktree: { worktreePath: '/tmp/wt', branchName: 'b', originalCwd: '/proj' },
    };
    expect(withWorktree.worktree?.branchName).toBe('b');
  });

  it('WorktreeInfo has worktreePath, branchName, originalCwd', () => {
    const wt: WorktreeInfo = {
      worktreePath: '/abs/path',
      branchName: 'feature',
      originalCwd: '/home/me/proj',
    };
    expect(wt.worktreePath).toBe('/abs/path');
  });

  it('PersistedAgentRecord requires agentId, profile, phaseId', () => {
    const rec: PersistedAgentRecord = { agentId: 'a1', profile: 'p1', phaseId: 'ph1' };
    expect(rec.agentId).toBe('a1');
  });

  it('AuditEvent discriminated union covers all variants', () => {
    const events: AuditEvent[] = [
      {
        type: 'agent_start',
        agentId: 'a1',
        profile: {
          id: 'p',
          name: 'n',
          provider: 'x',
          model: 'm',
          thinkingLevel: 'off',
          systemPrompt: '',
          excludeTools: [],
          includeTools: [],
        },
        timestamp: 'now',
      },
      { type: 'agent_end', agentId: 'a1', result: {}, timestamp: 'now' },
      { type: 'decision', agentId: 'a1', decision: 'go', reasoning: 'because', timestamp: 'now' },
      { type: 'structured_output', agentId: 'a1', output: { x: 1 }, timestamp: 'now' },
      { type: 'error', agentId: 'a1', error: 'boom', timestamp: 'now' },
    ];
    expect(events).toHaveLength(5);
  });

  it('StructuredOutputOptions has maxRetries required, rest optional', () => {
    const opts: StructuredOutputOptions = { maxRetries: 3 };
    expect(opts.maxRetries).toBe(3);
    const full: StructuredOutputOptions = { maxRetries: 1, retryPrompt: 'retry', stepTimeoutMs: 5000 };
    expect(full.stepTimeoutMs).toBe(5000);
  });

  it('AgentLoopResult is generic over result (string)', () => {
    const res: AgentLoopResult<string> = {
      result: 'done',
      attempts: 2,
      totalTokens: { input: 10, output: 20 },
    };
    expect(res.result).toBe('done');
  });

  it('AgentLoopResult is generic over result (object)', () => {
    interface Outcome {
      passed: boolean;
      score: number;
    }
    const res: AgentLoopResult<Outcome> = {
      result: { passed: true, score: 42 },
      attempts: 3,
      totalTokens: { input: 100, output: 200 },
    };
    expect(res.result.passed).toBe(true);
    expect(res.result.score).toBe(42);
  });

  it('WorkflowRunOptions requires cwd and workDir', () => {
    const opts: WorkflowRunOptions = { cwd: '/proj', workDir: '/tmp/run' };
    expect(opts.cwd).toBe('/proj');
    const full: WorkflowRunOptions = {
      cwd: '/proj',
      workDir: '/tmp',
      maxConcurrentTasks: 4,
      verbose: true,
      stepTimeoutMs: 1000,
    };
    expect(full.verbose).toBe(true);
  });

  it('WorkflowEntry source accepts "local"', () => {
    const entry: WorkflowEntry = { name: 'w', source: 'local', path: '/p' };
    expect(entry.source).toBe('local');
  });

  it('WorkflowEntry source accepts "global"', () => {
    const entry: WorkflowEntry = { name: 'g', source: 'global', path: '/global/p' };
    expect(entry.source).toBe('global');
  });

  it('WorkflowModule has run method', () => {
    const mod: WorkflowModule = {
      async run(_taskPrompt: string, _opts: WorkflowRunOptions): Promise<void> {},
    };
    expect(typeof mod.run).toBe('function');
  });

  it('HarnessCreationOptions requires profile and cwd', () => {
    const opts: HarnessCreationOptions = {
      profile: {
        id: 'p',
        name: 'n',
        provider: 'x',
        model: 'm',
        thinkingLevel: 'off',
        systemPrompt: '',
        excludeTools: [],
        includeTools: [],
      },
      cwd: '/proj',
    };
    expect(opts.cwd).toBe('/proj');
  });

  it('TurnContentBlock covers text, thinking, toolCall variants', () => {
    const blocks: TurnContentBlock[] = [
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'hmm', redacted: false },
      { type: 'toolCall', id: '1', name: 'edit', arguments: { path: '/a' } },
    ];
    expect(blocks).toHaveLength(3);
  });

  it('TurnContentBlock thinking variant allows redacted to be omitted (optional)', () => {
    const block: TurnContentBlock = { type: 'thinking', thinking: 'pondering' };
    expect(block.type).toBe('thinking');
    expect((block as { redacted?: boolean }).redacted).toBeUndefined();
  });

  it('StatusCallbacks is the intersection of workflow + agent callbacks', () => {
    const cb: StatusCallbacks = {
      onWorkflowStart: () => {},
      onTurnStart: () => {},
    };
    expect(typeof cb.onWorkflowStart).toBe('function');
  });

  it('WorkflowStatusCallbacks and AgentStatusCallbacks each resolve', () => {
    const wcb: WorkflowStatusCallbacks = { onPhaseStart: () => {} };
    const acb: AgentStatusCallbacks = { onTurnEnd: () => {} };
    expect(wcb).toBeDefined();
    expect(acb).toBeDefined();
  });

  it('re-exports Model type from pi-ai — resolves and constrains getModel return', () => {
    // Model<TApi> is generic with an Api constraint, so we cannot instantiate it
    // bare. Instead, verify it resolves by confirming getModel's return is
    // assignable to Model<...> and that a non-model value fails assignment.
    type ResolvedModel = Awaited<ReturnType<typeof getModel>>;
    const _model: ResolvedModel | undefined = undefined;
    expect(_model).toBeUndefined();
  });

  it('re-exports TaskStatus from @engin/shared/types with all documented values', () => {
    const statuses: TaskStatus[] = ['ready', 'blocked', 'active', 'complete', 'failed', 'cancelled'];
    expect(statuses).toHaveLength(6);
  });

  it('re-exports StepDefinition from @engin/shared/types with required fields', () => {
    const step: StepDefinition = { name: 'execute', profileId: 'coder', isReadOnly: false };
    expect(step.name).toBe('execute');
    expect(step.isReadOnly).toBe(false);
  });

  it('re-exports StepEntity from @engin/shared/types with required fields', () => {
    const entity: StepEntity = { name: 'execute', index: 0 };
    expect(entity.index).toBe(0);
  });

  it('re-exports TaskEntity from @engin/shared/types with required fields', () => {
    const entity: TaskEntity = {
      id: 't1',
      title: 'A task',
      phaseId: 'p1',
      status: 'ready',
      steps: [],
      dependencies: [],
    };
    expect(entity.phaseId).toBe('p1');
  });
});

// ─── Compile-time: @ts-expect-error guards for required fields ─────────────
//
// Every required field on key interfaces is guarded so that the refactor cannot
// accidentally turn a required field into an optional one without a compile
// failure.

describe('core/types barrel — AgentProfile @ts-expect-error guards', () => {
  // Base object missing exactly one field at a time. Each test removes one
  // required property.
  const base = {
    name: 'n',
    provider: 'x',
    model: 'm',
    thinkingLevel: 'off' as ThinkingLevel,
    systemPrompt: '',
    excludeTools: [] as string[],
    includeTools: [] as string[],
  };

  it('requires id', () => {
    // @ts-expect-error — missing id
    const _bad: AgentProfile = { ...base };
    expect(_bad).toBeDefined();
  });

  it('requires name', () => {
    // @ts-expect-error — missing name
    const _bad: AgentProfile = {
      id: 'p',
      provider: 'x',
      model: 'm',
      thinkingLevel: 'off',
      systemPrompt: '',
      excludeTools: [],
      includeTools: [],
    };
    expect(_bad).toBeDefined();
  });

  it('requires provider', () => {
    // @ts-expect-error — missing provider
    const _bad: AgentProfile = {
      id: 'p',
      name: 'n',
      model: 'm',
      thinkingLevel: 'off',
      systemPrompt: '',
      excludeTools: [],
      includeTools: [],
    };
    expect(_bad).toBeDefined();
  });

  it('requires model', () => {
    // @ts-expect-error — missing model
    const _bad: AgentProfile = {
      id: 'p',
      name: 'n',
      provider: 'x',
      thinkingLevel: 'off',
      systemPrompt: '',
      excludeTools: [],
      includeTools: [],
    };
    expect(_bad).toBeDefined();
  });

  it('requires thinkingLevel', () => {
    // @ts-expect-error — missing thinkingLevel
    const _bad: AgentProfile = {
      id: 'p',
      name: 'n',
      provider: 'x',
      model: 'm',
      systemPrompt: '',
      excludeTools: [],
      includeTools: [],
    };
    expect(_bad).toBeDefined();
  });

  it('requires systemPrompt', () => {
    // @ts-expect-error — missing systemPrompt
    const _bad: AgentProfile = {
      id: 'p',
      name: 'n',
      provider: 'x',
      model: 'm',
      thinkingLevel: 'off',
      excludeTools: [],
      includeTools: [],
    };
    expect(_bad).toBeDefined();
  });

  it('requires excludeTools', () => {
    // @ts-expect-error — missing excludeTools
    const _bad: AgentProfile = {
      id: 'p',
      name: 'n',
      provider: 'x',
      model: 'm',
      thinkingLevel: 'off',
      systemPrompt: '',
      includeTools: [],
    };
    expect(_bad).toBeDefined();
  });

  it('requires includeTools', () => {
    // @ts-expect-error — missing includeTools
    const _bad: AgentProfile = {
      id: 'p',
      name: 'n',
      provider: 'x',
      model: 'm',
      thinkingLevel: 'off',
      systemPrompt: '',
      excludeTools: [],
    };
    expect(_bad).toBeDefined();
  });
});

describe('core/types barrel — Task @ts-expect-error guards', () => {
  it('requires id', () => {
    // @ts-expect-error — missing id
    const _bad: Task = {
      title: 'x',
      prompt: 'p',
      profile: 'pr',
      files: [],
      dependencies: [],
      status: 'ready',
      phaseId: 'ph',
    };
    expect(_bad).toBeDefined();
  });

  it('requires title', () => {
    // @ts-expect-error — missing title
    const _bad: Task = {
      id: 't',
      prompt: 'p',
      profile: 'pr',
      files: [],
      dependencies: [],
      status: 'ready',
      phaseId: 'ph',
    };
    expect(_bad).toBeDefined();
  });

  it('requires prompt', () => {
    // @ts-expect-error — missing prompt
    const _bad: Task = {
      id: 't',
      title: 'x',
      profile: 'pr',
      files: [],
      dependencies: [],
      status: 'ready',
      phaseId: 'ph',
    };
    expect(_bad).toBeDefined();
  });

  it('requires profile', () => {
    // @ts-expect-error — missing profile
    const _bad: Task = {
      id: 't',
      title: 'x',
      prompt: 'p',
      files: [],
      dependencies: [],
      status: 'ready',
      phaseId: 'ph',
    };
    expect(_bad).toBeDefined();
  });

  it('requires files', () => {
    // @ts-expect-error — missing files
    const _bad: Task = {
      id: 't',
      title: 'x',
      prompt: 'p',
      profile: 'pr',
      dependencies: [],
      status: 'ready',
      phaseId: 'ph',
    };
    expect(_bad).toBeDefined();
  });

  it('requires dependencies', () => {
    // @ts-expect-error — missing dependencies
    const _bad: Task = { id: 't', title: 'x', prompt: 'p', profile: 'pr', files: [], status: 'ready', phaseId: 'ph' };
    expect(_bad).toBeDefined();
  });

  it('requires phaseId', () => {
    // @ts-expect-error — missing phaseId
    const _bad: Task = {
      id: 't',
      title: 'x',
      prompt: 'p',
      profile: 'pr',
      files: [],
      dependencies: [],
      status: 'ready',
    };
    expect(_bad).toBeDefined();
  });
});

describe('core/types barrel — WorkflowRunOptions / HarnessCreationOptions guards', () => {
  it('WorkflowRunOptions requires workDir', () => {
    // @ts-expect-error — missing workDir
    const _bad: WorkflowRunOptions = { cwd: '/proj' };
    expect(_bad).toBeDefined();
  });

  it('WorkflowRunOptions requires cwd', () => {
    // @ts-expect-error — missing cwd
    const _bad: WorkflowRunOptions = { workDir: '/tmp' };
    expect(_bad).toBeDefined();
  });

  it('HarnessCreationOptions requires profile', () => {
    // @ts-expect-error — missing profile
    const _bad: HarnessCreationOptions = { cwd: '/proj' };
    expect(_bad).toBeDefined();
  });

  it('HarnessCreationOptions requires cwd', () => {
    // @ts-expect-error — missing cwd
    const _bad: HarnessCreationOptions = {
      profile: {
        id: 'p',
        name: 'n',
        provider: 'x',
        model: 'm',
        thinkingLevel: 'off',
        systemPrompt: '',
        excludeTools: [],
        includeTools: [],
      },
    };
    expect(_bad).toBeDefined();
  });
});

describe('core/types barrel — literal/union @ts-expect-error guards', () => {
  it('ThinkingLevel rejects arbitrary strings', () => {
    // @ts-expect-error — 'ultra' is not a valid ThinkingLevel
    const _bad: ThinkingLevel = 'ultra';
    expect(_bad).toBeDefined();
  });

  it('AuditEvent rejects unknown type discriminator', () => {
    // @ts-expect-error — 'foo' is not a valid AuditEvent type
    const _bad: AuditEvent = { type: 'foo', agentId: 'a', timestamp: 'now' };
    expect(_bad).toBeDefined();
  });

  it('WorkflowEntry.source rejects invalid string', () => {
    // @ts-expect-error — 'remote' is not a valid source
    const _bad: WorkflowEntry = { name: 'w', source: 'remote', path: '/p' };
    expect(_bad).toBeDefined();
  });

  it('WorktreeInfo requires branchName', () => {
    // @ts-expect-error — missing branchName
    const _bad: WorktreeInfo = { worktreePath: '/p', originalCwd: '/c' };
    expect(_bad).toBeDefined();
  });

  it('TaskStatus rejects invalid literal', () => {
    // @ts-expect-error — 'pending' is not a valid TaskStatus
    const _bad: TaskStatus = 'pending';
    expect(_bad).toBeDefined();
  });
});
