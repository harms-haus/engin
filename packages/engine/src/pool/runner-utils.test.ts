// ─── Tests for runner-utils.ts (shared pool runner boilerplate) ─────────────
//
// These tests pin down the four extracted helpers used to de-duplicate the
// ~80% identical boilerplate across branch/council/map/reflection/linear
// runners:
//
//   1. createSessionTracker(agentId, taskId)  → array-backed session tracking
//   2. createSessionMap(agentId, taskId)       → Map<number, TrackedSession>
//   3. buildExecCtx(ctx)                       → StepExecutionContext builder
//   4. settleResult(ctx, result, disposeAll)   → approved/rejected settle
//   5. handleRunnerError(err, ctx, disposeAll) → try/catch error envelope
//
// The module under test is imported from './runner-utils.js'.

import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RendererRegistry } from '../core/renderer-registry.js';
import type { AgentProfile, Task } from '../core/types.js';
import { AuditLog } from '../tracking/audit-log.js';
import {
  buildExecCtx,
  createSessionMap,
  createSessionTracker,
  handleRunnerError,
  settleResult,
} from './runner-utils.js';
import type { StepExecutionContext } from './step-execution.js';
import type { StepResult, TaskOutcome, TaskRunnerContext, TrackedSession } from './types.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** A mock `dispose` function (the TrackedSession wrapper's dispose, not the
 *  inner session.dispose). Captures calls and optionally throws. */
type DisposeMock = ReturnType<typeof mock> & (() => void);

/** Build a minimal TrackedSession with a spyable wrapper `dispose`. */
function makeTrackedSession(id: string, disposeImpl?: () => void): { ts: TrackedSession; dispose: DisposeMock } {
  const dispose = mock(disposeImpl ?? (() => {})) as DisposeMock;
  const ts: TrackedSession = {
    session: {
      abort: mock(async () => {}),
      dispose: mock(() => {}),
      subscribe: mock(() => () => {}),
      prompt: mock(async () => {}),
      getLastAssistantText: mock(() => undefined),
      getLastAssistantMessage: mock(() => undefined),
      sessionId: id,
    },
    dispose,
    sessionPath: `/tmp/sessions/${id}`,
  };
  return { ts, dispose };
}

/** Build a TaskRunnerContext with mock completeTask/failTask callbacks. */
function makeCtx(overrides?: Partial<TaskRunnerContext>): TaskRunnerContext {
  const task: Task = {
    id: 'task-1',
    title: 'Do thing',
    prompt: 'please do the thing',
    profile: 'default',
    files: [],
    dependencies: [],
    status: 'active',
    phaseId: 'code',
  };
  const profiles = new Map<string, AgentProfile>();
  const activeSessions = new Set<{ abort(): Promise<void> }>();
  return {
    task,
    agentId: 'agent-7',
    profiles,
    onStatus: undefined,
    activeSessions,
    phaseId: 'code',
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    apiKeys: { openai: 'sk-test' },
    maxStepRetries: 3,
    completeTask: mock((_result?: unknown) => true),
    failTask: mock((_result?: unknown) => undefined),
    ...overrides,
  };
}

// ── console.error spy (manual, version-safe) ────────────────────────────────

let errorCalls: unknown[][] = [];
let realError: typeof console.error;

beforeEach(() => {
  realError = console.error;
  errorCalls = [];
  console.error = ((...args: unknown[]) => {
    errorCalls.push(args);
  }) as unknown as typeof console.error;
});

afterEach(() => {
  console.error = realError;
});

// ── createSessionTracker ────────────────────────────────────────────────────

describe('createSessionTracker', () => {
  it('starts with an empty sessions array', () => {
    const tracker = createSessionTracker('agent-1', 'task-1');
    expect(tracker.sessions).toEqual([]);
    expect(tracker.sessions.length).toBe(0);
  });

  it('add() appends tracked sessions in order', () => {
    const tracker = createSessionTracker('agent-1', 'task-1');
    const a = makeTrackedSession('a').ts;
    const b = makeTrackedSession('b').ts;

    tracker.add(a);
    tracker.add(b);

    expect(tracker.sessions).toEqual([a, b]);
  });

  it('disposeAll() calls dispose() on every tracked session exactly once', () => {
    const tracker = createSessionTracker('agent-1', 'task-1');
    const a = makeTrackedSession('a');
    const b = makeTrackedSession('b');
    tracker.add(a.ts);
    tracker.add(b.ts);

    tracker.disposeAll();

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposeAll() clears the sessions array', () => {
    const tracker = createSessionTracker('agent-1', 'task-1');
    tracker.add(makeTrackedSession('a').ts);
    tracker.add(makeTrackedSession('b').ts);

    tracker.disposeAll();

    expect(tracker.sessions.length).toBe(0);
  });

  it('disposeAll() continues disposing remaining sessions when one throws', () => {
    const tracker = createSessionTracker('agent-1', 'task-1');
    const a = makeTrackedSession('a', () => {
      throw new Error('boom-a');
    });
    const b = makeTrackedSession('b'); // must still be disposed
    const c = makeTrackedSession('c', () => {
      throw new Error('boom-c');
    });
    tracker.add(a.ts);
    tracker.add(b.ts);
    tracker.add(c.ts);

    tracker.disposeAll();

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(c.dispose).toHaveBeenCalledTimes(1);
    // Both throwing sessions logged an error (one console.error per throw).
    expect(errorCalls).toHaveLength(2);
  });

  it('disposeAll() logs the agentId, taskId and error message via console.error', () => {
    const tracker = createSessionTracker('agent-42', 'task-99');
    tracker.add(
      makeTrackedSession('bad', () => {
        throw new Error('kaboom');
      }).ts,
    );

    tracker.disposeAll();

    expect(errorCalls).toHaveLength(1);
    const flat = String(errorCalls[0]);
    expect(flat).toContain('agent-42');
    expect(flat).toContain('task-99');
    expect(flat).toContain('kaboom');
  });

  it('disposeAll() is a no-op when there are no sessions', () => {
    const tracker = createSessionTracker('agent-1', 'task-1');
    expect(() => tracker.disposeAll()).not.toThrow();
    expect(errorCalls).toHaveLength(0);
  });

  it('disposeAll() is idempotent (second call disposes nothing)', () => {
    const tracker = createSessionTracker('agent-1', 'task-1');
    const a = makeTrackedSession('a');
    tracker.add(a.ts);

    tracker.disposeAll();
    tracker.disposeAll();

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(tracker.sessions.length).toBe(0);
  });
});

// ── createSessionMap ────────────────────────────────────────────────────────

describe('createSessionMap', () => {
  it('starts with an empty sessions map', () => {
    const map = createSessionMap('agent-1', 'task-1');
    expect(map.sessions.size).toBe(0);
  });

  it('set() stores a session under the step index key', () => {
    const map = createSessionMap('agent-1', 'task-1');
    const a = makeTrackedSession('a').ts;

    map.set(0, a);

    expect(map.sessions.get(0)).toBe(a);
    expect(map.sessions.size).toBe(1);
  });

  it('set() does not throw when no previous entry exists at the key', () => {
    const map = createSessionMap('agent-1', 'task-1');
    const a = makeTrackedSession('a').ts;
    expect(() => map.set(0, a)).not.toThrow();
    expect(errorCalls).toHaveLength(0);
  });

  it('set() disposes the previous entry before overwriting the same key', () => {
    const map = createSessionMap('agent-1', 'task-1');
    const old = makeTrackedSession('old');
    const next = makeTrackedSession('next');

    map.set(1, old.ts);
    map.set(1, next.ts);

    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(map.sessions.get(1)).toBe(next.ts);
    expect(map.sessions.size).toBe(1);
  });

  it('set() swallows a throwing dispose of the previous entry and still stores the new one', () => {
    const map = createSessionMap('agent-1', 'task-1');
    const old = makeTrackedSession('old', () => {
      throw new Error('dispose-failed');
    });
    const next = makeTrackedSession('next');

    map.set(2, old.ts);
    expect(() => map.set(2, next.ts)).not.toThrow();

    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(map.sessions.get(2)).toBe(next.ts);
    expect(errorCalls).toHaveLength(1);
    expect(String(errorCalls[0])).toContain('dispose-failed');
  });

  it('set() at different keys does not dispose unrelated entries', () => {
    const map = createSessionMap('agent-1', 'task-1');
    const zero = makeTrackedSession('zero');
    const one = makeTrackedSession('one');

    map.set(0, zero.ts);
    map.set(1, one.ts);

    expect(zero.dispose).not.toHaveBeenCalled();
    expect(one.dispose).not.toHaveBeenCalled();
    expect(map.sessions.size).toBe(2);
  });

  it('disposeAll() calls dispose() on every tracked session value', () => {
    const map = createSessionMap('agent-1', 'task-1');
    const a = makeTrackedSession('a');
    const b = makeTrackedSession('b');
    map.set(0, a.ts);
    map.set(3, b.ts);

    map.disposeAll();

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposeAll() clears the map', () => {
    const map = createSessionMap('agent-1', 'task-1');
    map.set(0, makeTrackedSession('a').ts);
    map.set(1, makeTrackedSession('b').ts);

    map.disposeAll();

    expect(map.sessions.size).toBe(0);
  });

  it('disposeAll() continues and logs when a session throws', () => {
    const map = createSessionMap('agent-7', 'task-3');
    const bad = makeTrackedSession('bad', () => {
      throw new Error('nope');
    });
    const good = makeTrackedSession('good');
    map.set(0, bad.ts);
    map.set(1, good.ts);

    map.disposeAll();

    expect(bad.dispose).toHaveBeenCalledTimes(1);
    expect(good.dispose).toHaveBeenCalledTimes(1);
    expect(errorCalls).toHaveLength(1);
    const flat = String(errorCalls[0]);
    expect(flat).toContain('agent-7');
    expect(flat).toContain('task-3');
    expect(flat).toContain('nope');
  });

  it('disposeAll() is a no-op on an empty map', () => {
    const map = createSessionMap('agent-1', 'task-1');
    expect(() => map.disposeAll()).not.toThrow();
    expect(errorCalls).toHaveLength(0);
  });
});

// ── buildExecCtx ────────────────────────────────────────────────────────────

describe('buildExecCtx', () => {
  it('propagates all StepExecutionContext fields from TaskRunnerContext', () => {
    const rendererRegistry = { get: () => undefined } as unknown as RendererRegistry;
    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const onStatus = { onStepStart: () => undefined } as unknown as TaskRunnerContext['onStatus'];
    const ctx = makeCtx({
      sessionBaseDir: '/var/sessions',
      cwd: '/home/work',
      apiKeys: { anthropic: 'sk-ant' },
      onStatus,
      activeSessions,
      phaseId: 'review',
      rendererRegistry,
    });

    const execCtx: StepExecutionContext = buildExecCtx(ctx);

    expect(execCtx.sessionBaseDir).toBe('/var/sessions');
    expect(execCtx.cwd).toBe('/home/work');
    expect(execCtx.apiKeys).toEqual({ anthropic: 'sk-ant' });
    expect(execCtx.onStatus).toBe(onStatus);
    expect(execCtx.activeSessions).toBe(activeSessions);
    expect(execCtx.phaseId).toBe('review');
    expect(execCtx.rendererRegistry).toBe(rendererRegistry);
  });

  it('preserves reference identity of activeSessions and onStatus (no copy)', () => {
    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const onStatus = {} as TaskRunnerContext['onStatus'];
    const ctx = makeCtx({ activeSessions, onStatus });

    const execCtx = buildExecCtx(ctx);

    expect(execCtx.activeSessions).toBe(activeSessions);
    expect(execCtx.onStatus).toBe(onStatus);
  });

  it('leaves rendererRegistry undefined when ctx omits it', () => {
    const ctx = makeCtx();
    expect(ctx.rendererRegistry).toBeUndefined();

    const execCtx = buildExecCtx(ctx);

    expect(execCtx.rendererRegistry).toBeUndefined();
  });

  it('leaves apiKeys undefined when ctx omits it', () => {
    const ctx = makeCtx({ apiKeys: undefined });

    const execCtx = buildExecCtx(ctx);

    expect(execCtx.apiKeys).toBeUndefined();
  });

  it('returns a fresh object each call (no shared mutable instance)', () => {
    const ctx = makeCtx();
    const a = buildExecCtx(ctx);
    const b = buildExecCtx(ctx);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  // ── auditLog forwarding (default-auditor wiring) ───────────────────────
  //
  // NOTE (TDD): `auditLog` is a PLANNED optional field on TaskRunnerContext /
  // StepExecutionContext (the "Wire default auditor" task). Until those types
  // declare it, the field is set via a plain-object ctx (spread + cast to the
  // interface, which is a valid superset cast) and read off execCtx via a
  // minimal cast — so this file type-checks today and goes GREEN once
  // buildExecCtx forwards `auditLog` alongside the other optional fields.

  it('forwards auditLog from ctx to execCtx (reference identity)', () => {
    const auditLog = new AuditLog(tmpdir());
    const ctx = { ...makeCtx(), auditLog } as TaskRunnerContext;

    const execCtx = buildExecCtx(ctx);

    expect((execCtx as { auditLog?: AuditLog }).auditLog).toBe(auditLog);
  });

  it('leaves auditLog undefined when ctx omits it', () => {
    const ctx = makeCtx();

    const execCtx = buildExecCtx(ctx);

    expect((execCtx as { auditLog?: AuditLog }).auditLog).toBeUndefined();
  });
});

// ── settleResult ────────────────────────────────────────────────────────────

describe('settleResult', () => {
  it('approved → calls completeTask with the output, disposes, returns completed', () => {
    const sequence: string[] = [];
    const completeTask = mock((result?: unknown) => {
      sequence.push('completeTask');
      return true;
    });
    const disposeAll = mock(() => {
      sequence.push('disposeAll');
    });
    const ctx = makeCtx({ completeTask });
    const result: StepResult = { type: 'approved', output: { answer: 42 } };

    const outcome: TaskOutcome = settleResult(ctx, result, disposeAll);

    expect(completeTask).toHaveBeenCalledTimes(1);
    expect(completeTask).toHaveBeenCalledWith({ answer: 42 });
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'completed', output: { answer: 42 } });
    // Per spec: completeTask happens before disposal.
    expect(sequence).toEqual(['completeTask', 'disposeAll']);
  });

  it('approved → does not call failTask', () => {
    const failTask = mock((_r?: unknown) => undefined);
    const ctx = makeCtx({ completeTask: mock(() => true), failTask });
    const result: StepResult = { type: 'approved', output: 'ok' };

    settleResult(
      ctx,
      result,
      mock(() => {}),
    );

    expect(failTask).not.toHaveBeenCalled();
  });

  it('rejected → calls failTask with feedback, disposes, returns failed', () => {
    const sequence: string[] = [];
    const failTask = mock((r?: unknown) => {
      sequence.push('failTask');
    });
    const disposeAll = mock(() => {
      sequence.push('disposeAll');
    });
    const ctx = makeCtx({ failTask });
    const result: StepResult = { type: 'rejected', feedback: 'not good enough' };

    const outcome = settleResult(ctx, result, disposeAll);

    expect(failTask).toHaveBeenCalledTimes(1);
    expect((failTask as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toMatchObject({
      feedback: 'not good enough',
    });
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'failed', feedback: 'not good enough' });
    // Per spec: failTask happens before disposal.
    expect(sequence).toEqual(['failTask', 'disposeAll']);
  });

  it('rejected → does not call completeTask', () => {
    const completeTask = mock((_r?: unknown) => true);
    const ctx = makeCtx({ completeTask });

    settleResult(
      ctx,
      { type: 'rejected', feedback: 'nope' },
      mock(() => {}),
    );

    expect(completeTask).not.toHaveBeenCalled();
  });

  it('approved → when completeTask returns false, settles as failed (task was cancelled/raced)', () => {
    const completeTask = mock((_r?: unknown) => false);
    const failTask = mock((_r?: unknown) => undefined);
    const disposeAll = mock(() => {});
    const ctx = makeCtx({ completeTask, failTask });

    const outcome = settleResult(ctx, { type: 'approved', output: 'done' }, disposeAll);

    expect(completeTask).toHaveBeenCalledTimes(1);
    expect(completeTask).toHaveBeenCalledWith('done');
    expect(failTask).toHaveBeenCalledTimes(1);
    expect(failTask).toHaveBeenCalledWith({ completed: false, error: 'Failed to submit' });
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'failed', error: 'Failed to submit' });
  });

  it('rejected → preserves optional output alongside feedback in the failed outcome', () => {
    const ctx = makeCtx();
    const result: StepResult = { type: 'rejected', feedback: 'revise', output: { severity: 'medium' } };

    const outcome = settleResult(
      ctx,
      result,
      mock(() => {}),
    );

    expect(outcome.status).toBe('failed');
    expect((outcome as { feedback?: string }).feedback).toBe('revise');
  });
});

// ── handleRunnerError ───────────────────────────────────────────────────────

describe('handleRunnerError', () => {
  it('disposes sessions, calls failTask, and returns a failed outcome', () => {
    const sequence: string[] = [];
    const failTask = mock((r?: unknown) => {
      sequence.push('failTask');
    });
    const disposeAll = mock(() => {
      sequence.push('disposeAll');
    });
    const ctx = makeCtx({ failTask });

    const outcome: TaskOutcome = handleRunnerError(new Error('unexpected crash'), ctx, disposeAll);

    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(failTask).toHaveBeenCalledTimes(1);
    // Per spec: dispose happens before failTask.
    expect(sequence).toEqual(['disposeAll', 'failTask']);
    expect(outcome).toEqual({ status: 'failed', error: 'unexpected crash' });
  });

  it('passes the Error.message as the failure reason', () => {
    const failTask = mock((_r?: unknown) => undefined);
    const ctx = makeCtx({ failTask });

    handleRunnerError(
      new Error('boom'),
      ctx,
      mock(() => {}),
    );

    const arg = (failTask as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(arg).toMatchObject({ error: 'boom' });
  });

  it('handles non-Error thrown values using safeErrorMessage', () => {
    const failTask = mock((_r?: unknown) => undefined);
    const ctx = makeCtx({ failTask });

    const outcome = handleRunnerError(
      'a plain string failure',
      ctx,
      mock(() => {}),
    );

    expect(outcome).toEqual({ status: 'failed', error: 'a plain string failure' });
    const arg = (failTask as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(arg).toMatchObject({ error: 'a plain string failure' });
  });

  it('handles nullish/number thrown values via String()', () => {
    const ctx = makeCtx();
    const outcome = handleRunnerError(
      404,
      ctx,
      mock(() => {}),
    );
    expect(outcome).toEqual({ status: 'failed', error: '404' });
  });

  it('never re-throws the original error', () => {
    const ctx = makeCtx();
    const disposeAll = mock(() => {});

    const call = () => handleRunnerError(new Error('do not propagate'), ctx, disposeAll);
    expect(call).not.toThrow();
  });
});
