// ─── Tests for step-state-store.ts (pool-owned per-task step state) ─────────
//
// These tests pin down the StepStateStore class — a pool-owned, taskId-keyed
// store that replaces the closure-local variables (stepAttempts,
// stepExecutions, taskSessions) in linear-steps-runner.ts with durable,
// externally-addressable per-task state.
//
// The store mirrors the disposal semantics of createSessionMap:
//   • setSession() disposes the PREVIOUS session at that stepIndex
//     (swallow + log errors) before overwriting.
//   • disposeAllSessions() / reset() dispose every session with try/catch +
//     console.error so one failing dispose cannot leak the remaining sessions.
//
// The module under test is imported from './step-state-store.js'.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { StepStateStore } from './step-state-store.js';
import type { TrackedSession } from './types.js';

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

// ── getOrCreateTaskState / get ──────────────────────────────────────────────

describe('StepStateStore — getOrCreateTaskState / get', () => {
  it('getOrCreateTaskState returns fresh state when none exists', () => {
    const store = new StepStateStore('agent-1');
    const state = store.getOrCreateTaskState('task-1');

    expect(state).toBeDefined();
    expect(state.activeStepIndex).toBe(0);
    expect(state.execCounts).toBeInstanceOf(Map);
    expect(state.execCounts.size).toBe(0);
    expect(state.attemptCounts).toBeInstanceOf(Map);
    expect(state.attemptCounts.size).toBe(0);
    expect(state.sessions).toBeInstanceOf(Map);
    expect(state.sessions.size).toBe(0);
  });

  it('get returns undefined when no state exists for the task', () => {
    const store = new StepStateStore('agent-1');
    expect(store.get('task-missing')).toBeUndefined();
  });

  it('getOrCreateTaskState returns the SAME object reference on subsequent calls', () => {
    const store = new StepStateStore('agent-1');
    const first = store.getOrCreateTaskState('task-1');
    const second = store.getOrCreateTaskState('task-1');

    expect(second).toBe(first);
  });

  it('get returns the same state object previously created via getOrCreateTaskState', () => {
    const store = new StepStateStore('agent-1');
    const created = store.getOrCreateTaskState('task-1');

    expect(store.get('task-1')).toBe(created);
  });

  it('getOrCreateTaskState returns independent state objects for different tasks', () => {
    const store = new StepStateStore('agent-1');
    const a = store.getOrCreateTaskState('task-a');
    const b = store.getOrCreateTaskState('task-b');

    expect(a).not.toBe(b);
    expect(store.get('task-a')).toBe(a);
    expect(store.get('task-b')).toBe(b);
  });

  it('mutating the returned state object mutates the stored state (shared reference)', () => {
    const store = new StepStateStore('agent-1');
    const state = store.getOrCreateTaskState('task-1');
    state.execCounts.set(2, 7);

    expect(store.getOrCreateTaskState('task-1').execCounts.get(2)).toBe(7);
  });
});

// ── incrementExec / getExecCount ────────────────────────────────────────────

describe('StepStateStore — incrementExec / getExecCount', () => {
  it('getExecCount returns 0 for a step that has never been incremented', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    expect(store.getExecCount('task-1', 0)).toBe(0);
  });

  it('incrementExec increases the exec count by 1 per call', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    store.incrementExec('task-1', 0);
    store.incrementExec('task-1', 0);
    store.incrementExec('task-1', 0);

    expect(store.getExecCount('task-1', 0)).toBe(3);
  });

  it('incrementExec tracks each step index independently', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    store.incrementExec('task-1', 0);
    store.incrementExec('task-1', 0);
    store.incrementExec('task-1', 1);

    expect(store.getExecCount('task-1', 0)).toBe(2);
    expect(store.getExecCount('task-1', 1)).toBe(1);
  });

  it('incrementExec is isolated across tasks', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-a');
    store.getOrCreateTaskState('task-b');

    store.incrementExec('task-a', 0);
    store.incrementExec('task-b', 0);
    store.incrementExec('task-b', 0);

    expect(store.getExecCount('task-a', 0)).toBe(1);
    expect(store.getExecCount('task-b', 0)).toBe(2);
  });

  it('incrementExec creates state for a task that does not yet exist', () => {
    const store = new StepStateStore('agent-1');

    store.incrementExec('task-new', 3);

    expect(store.getExecCount('task-new', 3)).toBe(1);
    expect(store.get('task-new')).toBeDefined();
  });
});

// ── incrementAttempt / getAttemptCount ──────────────────────────────────────

describe('StepStateStore — incrementAttempt / getAttemptCount', () => {
  it('getAttemptCount returns 0 for a step that has never been incremented', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    expect(store.getAttemptCount('task-1', 0)).toBe(0);
  });

  it('incrementAttempt increases the attempt count by 1 per call', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    store.incrementAttempt('task-1', 2);
    store.incrementAttempt('task-1', 2);

    expect(store.getAttemptCount('task-1', 2)).toBe(2);
  });

  it('incrementAttempt tracks each step index independently', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    store.incrementAttempt('task-1', 0);
    store.incrementAttempt('task-1', 1);
    store.incrementAttempt('task-1', 1);

    expect(store.getAttemptCount('task-1', 0)).toBe(1);
    expect(store.getAttemptCount('task-1', 1)).toBe(2);
  });

  it('incrementAttempt is isolated across tasks', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-a');
    store.getOrCreateTaskState('task-b');

    store.incrementAttempt('task-a', 0);
    store.incrementAttempt('task-b', 0);

    expect(store.getAttemptCount('task-a', 0)).toBe(1);
    expect(store.getAttemptCount('task-b', 0)).toBe(1);
  });

  it('incrementAttempt creates state for a task that does not yet exist', () => {
    const store = new StepStateStore('agent-1');

    store.incrementAttempt('task-new', 1);

    expect(store.getAttemptCount('task-new', 1)).toBe(1);
    expect(store.get('task-new')).toBeDefined();
  });

  it('attempt counts are independent from exec counts at the same step', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    store.incrementExec('task-1', 0);
    store.incrementExec('task-1', 0);
    store.incrementAttempt('task-1', 0);

    expect(store.getExecCount('task-1', 0)).toBe(2);
    expect(store.getAttemptCount('task-1', 0)).toBe(1);
  });
});

// ── advance ─────────────────────────────────────────────────────────────────

describe('StepStateStore — advance', () => {
  it('advance increments activeStepIndex by 1', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    store.advance('task-1');

    expect(store.getOrCreateTaskState('task-1').activeStepIndex).toBe(1);
  });

  it('advance accumulates across multiple calls', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    store.advance('task-1');
    store.advance('task-1');
    store.advance('task-1');

    expect(store.getOrCreateTaskState('task-1').activeStepIndex).toBe(3);
  });

  it('advance is isolated across tasks', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-a');
    store.getOrCreateTaskState('task-b');

    store.advance('task-a');
    store.advance('task-b');
    store.advance('task-b');

    expect(store.getOrCreateTaskState('task-a').activeStepIndex).toBe(1);
    expect(store.getOrCreateTaskState('task-b').activeStepIndex).toBe(2);
  });

  it('advance creates state for a task that does not yet exist', () => {
    const store = new StepStateStore('agent-1');

    store.advance('task-new');

    expect(store.get('task-new')).toBeDefined();
    expect(store.get('task-new')!.activeStepIndex).toBe(1);
  });
});

// ── setSession / getSession ─────────────────────────────────────────────────

describe('StepStateStore — setSession / getSession', () => {
  it('setSession stores a session under the step index key', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a').ts;

    store.setSession('task-1', 0, a);

    expect(store.getSession('task-1', 0)).toBe(a);
  });

  it('getSession returns undefined when no session exists for that step', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    expect(store.getSession('task-1', 0)).toBeUndefined();
  });

  it('getSession returns undefined when no state exists for the task', () => {
    const store = new StepStateStore('agent-1');
    expect(store.getSession('task-missing', 0)).toBeUndefined();
  });

  it('setSession does not throw when no previous entry exists at the key', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a').ts;

    expect(() => store.setSession('task-1', 0, a)).not.toThrow();
    expect(errorCalls).toHaveLength(0);
  });

  it('setSession disposes the previous entry before overwriting the same key', () => {
    const store = new StepStateStore('agent-1');
    const old = makeTrackedSession('old');
    const next = makeTrackedSession('next');

    store.setSession('task-1', 1, old.ts);
    store.setSession('task-1', 1, next.ts);

    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(store.getSession('task-1', 1)).toBe(next.ts);
  });

  it('setSession swallows a throwing dispose of the previous entry and still stores the new one', () => {
    const store = new StepStateStore('agent-1');
    const old = makeTrackedSession('old', () => {
      throw new Error('dispose-failed');
    });
    const next = makeTrackedSession('next');

    store.setSession('task-1', 2, old.ts);
    expect(() => store.setSession('task-1', 2, next.ts)).not.toThrow();

    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(store.getSession('task-1', 2)).toBe(next.ts);
    expect(errorCalls).toHaveLength(1);
    expect(String(errorCalls[0])).toContain('dispose-failed');
  });

  it('setSession at different keys does not dispose unrelated entries', () => {
    const store = new StepStateStore('agent-1');
    const zero = makeTrackedSession('zero');
    const one = makeTrackedSession('one');

    store.setSession('task-1', 0, zero.ts);
    store.setSession('task-1', 1, one.ts);

    expect(zero.dispose).not.toHaveBeenCalled();
    expect(one.dispose).not.toHaveBeenCalled();
    expect(store.getSession('task-1', 0)).toBe(zero.ts);
    expect(store.getSession('task-1', 1)).toBe(one.ts);
  });

  it('setSession is isolated across tasks (same step index, different tasks)', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a').ts;
    const b = makeTrackedSession('b').ts;

    store.setSession('task-a', 0, a);
    store.setSession('task-b', 0, b);

    expect(store.getSession('task-a', 0)).toBe(a);
    expect(store.getSession('task-b', 0)).toBe(b);
  });

  it('setSession creates state for a task that does not yet exist', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a').ts;

    store.setSession('task-new', 0, a);

    expect(store.get('task-new')).toBeDefined();
    expect(store.getSession('task-new', 0)).toBe(a);
  });
});

// ── disposeAllSessions ──────────────────────────────────────────────────────

describe('StepStateStore — disposeAllSessions', () => {
  it('disposeAllSessions calls dispose() on every tracked session for the task', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a');
    const b = makeTrackedSession('b');
    store.setSession('task-1', 0, a.ts);
    store.setSession('task-1', 3, b.ts);

    store.disposeAllSessions('task-1');

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposeAllSessions clears the sessions map for the task', () => {
    const store = new StepStateStore('agent-1');
    store.setSession('task-1', 0, makeTrackedSession('a').ts);
    store.setSession('task-1', 1, makeTrackedSession('b').ts);

    store.disposeAllSessions('task-1');

    expect(store.getOrCreateTaskState('task-1').sessions.size).toBe(0);
    expect(store.getSession('task-1', 0)).toBeUndefined();
  });

  it('disposeAllSessions continues disposing remaining sessions when one throws', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a', () => {
      throw new Error('boom-a');
    });
    const b = makeTrackedSession('b'); // must still be disposed
    const c = makeTrackedSession('c', () => {
      throw new Error('boom-c');
    });
    store.setSession('task-1', 0, a.ts);
    store.setSession('task-1', 1, b.ts);
    store.setSession('task-1', 2, c.ts);

    store.disposeAllSessions('task-1');

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(c.dispose).toHaveBeenCalledTimes(1);
    expect(errorCalls).toHaveLength(2);
  });

  it('disposeAllSessions logs the agentId, taskId and error message via console.error', () => {
    const store = new StepStateStore('agent-42');
    store.setSession(
      'task-99',
      0,
      makeTrackedSession('bad', () => {
        throw new Error('kaboom');
      }).ts,
    );

    store.disposeAllSessions('task-99');

    expect(errorCalls).toHaveLength(1);
    const flat = String(errorCalls[0]);
    expect(flat).toContain('agent-42');
    expect(flat).toContain('task-99');
    expect(flat).toContain('kaboom');
  });

  it('disposeAllSessions does not affect other tasks', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a');
    const b = makeTrackedSession('b');
    store.setSession('task-a', 0, a.ts);
    store.setSession('task-b', 0, b.ts);

    store.disposeAllSessions('task-a');

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();
    expect(store.getSession('task-b', 0)).toBe(b.ts);
  });

  it('disposeAllSessions is a no-op when there are no sessions', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    expect(() => store.disposeAllSessions('task-1')).not.toThrow();
    expect(errorCalls).toHaveLength(0);
  });

  it('disposeAllSessions is a no-op when no state exists for the task', () => {
    const store = new StepStateStore('agent-1');
    expect(() => store.disposeAllSessions('task-missing')).not.toThrow();
    expect(errorCalls).toHaveLength(0);
  });
});

// ── reset ───────────────────────────────────────────────────────────────────

describe('StepStateStore — reset', () => {
  it('reset zeroes activeStepIndex back to 0', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');
    store.advance('task-1');
    store.advance('task-1');

    store.reset('task-1');

    expect(store.getOrCreateTaskState('task-1').activeStepIndex).toBe(0);
  });

  it('reset clears execCounts', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');
    store.incrementExec('task-1', 0);
    store.incrementExec('task-1', 1);

    store.reset('task-1');

    expect(store.getOrCreateTaskState('task-1').execCounts.size).toBe(0);
    expect(store.getExecCount('task-1', 0)).toBe(0);
    expect(store.getExecCount('task-1', 1)).toBe(0);
  });

  it('reset clears attemptCounts', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');
    store.incrementAttempt('task-1', 0);
    store.incrementAttempt('task-1', 0);

    store.reset('task-1');

    expect(store.getOrCreateTaskState('task-1').attemptCounts.size).toBe(0);
    expect(store.getAttemptCount('task-1', 0)).toBe(0);
  });

  it('reset disposes all sessions for the task', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a');
    const b = makeTrackedSession('b');
    store.setSession('task-1', 0, a.ts);
    store.setSession('task-1', 1, b.ts);

    store.reset('task-1');

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it('reset clears the sessions map for the task', () => {
    const store = new StepStateStore('agent-1');
    store.setSession('task-1', 0, makeTrackedSession('a').ts);

    store.reset('task-1');

    expect(store.getOrCreateTaskState('task-1').sessions.size).toBe(0);
    expect(store.getSession('task-1', 0)).toBeUndefined();
  });

  it('reset preserves the state object identity (same reference after reset)', () => {
    const store = new StepStateStore('agent-1');
    const before = store.getOrCreateTaskState('task-1');

    store.reset('task-1');

    expect(store.getOrCreateTaskState('task-1')).toBe(before);
  });

  it('reset leaves the state entry in the store (does not delete)', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    store.reset('task-1');

    expect(store.get('task-1')).toBeDefined();
  });

  it('reset does not affect other tasks', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-a');
    store.getOrCreateTaskState('task-b');
    store.advance('task-a');
    store.advance('task-b');
    store.advance('task-b');
    store.incrementExec('task-b', 0);

    store.reset('task-a');

    expect(store.getOrCreateTaskState('task-a').activeStepIndex).toBe(0);
    expect(store.getOrCreateTaskState('task-b').activeStepIndex).toBe(2);
    expect(store.getExecCount('task-b', 0)).toBe(1);
  });

  it('reset continues disposing remaining sessions when one throws', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a', () => {
      throw new Error('boom');
    });
    const b = makeTrackedSession('b');
    store.setSession('task-1', 0, a.ts);
    store.setSession('task-1', 1, b.ts);

    expect(() => store.reset('task-1')).not.toThrow();

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(errorCalls).toHaveLength(1);
    expect(String(errorCalls[0])).toContain('boom');
  });

  it('reset is a no-op when no state exists for the task', () => {
    const store = new StepStateStore('agent-1');
    expect(() => store.reset('task-missing')).not.toThrow();
    expect(errorCalls).toHaveLength(0);
  });

  it('reset allows the task to start fresh from step 0 after prior activity', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');
    store.advance('task-1');
    store.incrementExec('task-1', 0);
    store.incrementAttempt('task-1', 1);

    store.reset('task-1');

    // After reset, all counters read as 0 / empty — ready for a fresh run.
    expect(store.getOrCreateTaskState('task-1').activeStepIndex).toBe(0);
    expect(store.getExecCount('task-1', 0)).toBe(0);
    expect(store.getAttemptCount('task-1', 1)).toBe(0);
    expect(store.getSession('task-1', 0)).toBeUndefined();
  });
});

// ── delete ──────────────────────────────────────────────────────────────────

describe('StepStateStore — delete', () => {
  it('delete removes the task state entirely', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-1');

    store.delete('task-1');

    expect(store.get('task-1')).toBeUndefined();
  });

  it('delete allows getOrCreateTaskState to create a FRESH state object afterward', () => {
    const store = new StepStateStore('agent-1');
    const before = store.getOrCreateTaskState('task-1');
    store.advance('task-1');

    store.delete('task-1');
    const after = store.getOrCreateTaskState('task-1');

    expect(after).not.toBe(before);
    expect(after.activeStepIndex).toBe(0);
    expect(after.execCounts.size).toBe(0);
  });

  it('delete disposes all sessions for the task before removing', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a');
    const b = makeTrackedSession('b');
    store.setSession('task-1', 0, a.ts);
    store.setSession('task-1', 1, b.ts);

    store.delete('task-1');

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it('delete does not affect other tasks', () => {
    const store = new StepStateStore('agent-1');
    store.getOrCreateTaskState('task-a');
    store.getOrCreateTaskState('task-b');

    store.delete('task-a');

    expect(store.get('task-a')).toBeUndefined();
    expect(store.get('task-b')).toBeDefined();
  });

  it('delete disposes all sessions even when one dispose throws (swallow + log)', () => {
    const store = new StepStateStore('agent-1');
    const a = makeTrackedSession('a', () => {
      throw new Error('delete-boom-a');
    });
    const b = makeTrackedSession('b'); // must still be disposed
    const c = makeTrackedSession('c', () => {
      throw new Error('delete-boom-c');
    });
    store.setSession('task-1', 0, a.ts);
    store.setSession('task-1', 1, b.ts);
    store.setSession('task-1', 2, c.ts);

    expect(() => store.delete('task-1')).not.toThrow();

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(c.dispose).toHaveBeenCalledTimes(1);
    // Two throwing disposes → two logged errors.
    expect(errorCalls).toHaveLength(2);
    expect(String(errorCalls[0])).toContain('delete-boom-a');
    expect(String(errorCalls[1])).toContain('delete-boom-c');
    // State is still removed entirely despite dispose errors.
    expect(store.get('task-1')).toBeUndefined();
  });

  it('delete is a no-op when no state exists for the task', () => {
    const store = new StepStateStore('agent-1');
    expect(() => store.delete('task-missing')).not.toThrow();
    expect(errorCalls).toHaveLength(0);
  });
});

// ── agentId constructor param ───────────────────────────────────────────────

describe('StepStateStore — agentId', () => {
  it('accepts an agentId constructor argument', () => {
    expect(() => new StepStateStore('agent-99')).not.toThrow();
  });
});
