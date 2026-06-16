import { describe, expect, it, mock } from 'bun:test';
import type { StatusCallbacks } from '../../packages/engine/src/core/types.js';
import { STATUS_CALLBACK_METHODS } from '../../packages/engine/src/core/types.js';
import {
  appendReviewFeedback,
  composeStatusCallbacks,
  DEFAULT_TOOLS,
  forwardAgentStatus,
  isEnoentError,
  safeErrorMessage,
  validateWorkflowName,
} from '../../packages/engine/src/core/utils.js';

// ─── validateWorkflowName ──────────────────────────────────────────────────

describe('validateWorkflowName', () => {
  it('accepts valid names without throwing', () => {
    expect(() => validateWorkflowName('my-workflow')).not.toThrow();
    expect(() => validateWorkflowName('workflow_1')).not.toThrow();
    expect(() => validateWorkflowName('simple')).not.toThrow();
  });

  it('throws for names containing "/"', () => {
    expect(() => validateWorkflowName('bad/name')).toThrow();
    try {
      validateWorkflowName('bad/name');
    } catch (err) {
      expect((err as Error).message).toContain('bad/name');
    }
  });

  it('throws for names containing "\\"', () => {
    expect(() => validateWorkflowName('bad\\name')).toThrow();
    try {
      validateWorkflowName('bad\\name');
    } catch (err) {
      expect((err as Error).message).toContain('bad\\name');
    }
  });

  it('throws for names containing ".."', () => {
    expect(() => validateWorkflowName('..')).toThrow();
    expect(() => validateWorkflowName('foo..bar')).toThrow();
    try {
      validateWorkflowName('..');
    } catch (err) {
      expect((err as Error).message).toContain('..');
    }
  });
});

// ─── isEnoentError ─────────────────────────────────────────────────────────

describe('isEnoentError', () => {
  it('returns true for an object with code ENOENT', () => {
    expect(isEnoentError({ code: 'ENOENT' })).toBe(true);
  });

  it('returns false for an object with a different code', () => {
    expect(isEnoentError({ code: 'EACCES' })).toBe(false);
  });

  it('returns false for an object without a code property', () => {
    expect(isEnoentError({})).toBe(false);
  });
});

// ─── safeErrorMessage ──────────────────────────────────────────────────────

describe('safeErrorMessage', () => {
  it('returns the message from an Error instance', () => {
    expect(safeErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the string itself when given a string', () => {
    expect(safeErrorMessage('hello')).toBe('hello');
  });
});

// ─── forwardAgentStatus ───────────────────────────────────────────────────

describe('forwardAgentStatus', () => {
  it('forwards onTurnStart calls', () => {
    const calls: unknown[] = [];
    const onStatus: StatusCallbacks = {
      onTurnStart: (info) => calls.push(['onTurnStart', info]),
    };
    const result = forwardAgentStatus(onStatus);
    const info = { agentId: 'a1', turn: 1 };
    result!.onTurnStart!(info);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['onTurnStart', info]);
  });

  it('forwards onTurnEnd calls', () => {
    const calls: unknown[] = [];
    const onStatus: StatusCallbacks = {
      onTurnEnd: (info) => calls.push(['onTurnEnd', info]),
    };
    const result = forwardAgentStatus(onStatus);
    const info = { agentId: 'a1', turn: 1 };
    result!.onTurnEnd!(info);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['onTurnEnd', info]);
  });

  it('forwards onToolCallStart calls', () => {
    const calls: unknown[] = [];
    const onStatus: StatusCallbacks = {
      onToolCallStart: (info) => calls.push(['onToolCallStart', info]),
    };
    const result = forwardAgentStatus(onStatus);
    const info = { agentId: 'a1', toolName: 'bash', toolCallId: 'tc1', arguments: {} };
    result!.onToolCallStart!(info);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['onToolCallStart', info]);
  });

  it('forwards onToolCallEnd calls', () => {
    const calls: unknown[] = [];
    const onStatus: StatusCallbacks = {
      onToolCallEnd: (info) => calls.push(['onToolCallEnd', info]),
    };
    const result = forwardAgentStatus(onStatus);
    const info = { agentId: 'a1', toolName: 'bash', toolCallId: 'tc1', isError: false };
    result!.onToolCallEnd!(info);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['onToolCallEnd', info]);
  });
});

// ─── STATUS_CALLBACK_METHODS ───────────────────────────────────────────────

describe('STATUS_CALLBACK_METHODS', () => {
  it('is defined as a frozen array of string literals', () => {
    expect(STATUS_CALLBACK_METHODS).toBeInstanceOf(Array);
    expect(Object.isFrozen(STATUS_CALLBACK_METHODS)).toBe(true);
    expect(STATUS_CALLBACK_METHODS.length).toBeGreaterThan(0);
  });

  it('contains all method names from the StatusCallbacks interface', () => {
    const expectedMethods = [
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
      'onError',
      'onWorkflowComplete',
      'onWorkflowFailed',
      'onTurnStart',
      'onTurnEnd',
      'onToolCallStart',
      'onToolCallEnd',
      'onSidebarUpdate',
    ];
    expect([...STATUS_CALLBACK_METHODS].sort()).toEqual([...expectedMethods].sort());
  });

  it('contains no duplicate entries', () => {
    const unique = new Set(STATUS_CALLBACK_METHODS);
    expect(unique.size).toBe(STATUS_CALLBACK_METHODS.length);
  });

  it('each method name starts with "on" and is camelCase', () => {
    for (const name of STATUS_CALLBACK_METHODS) {
      expect(name).toMatch(/^on[A-Z]/);
    }
  });
});

// ─── composeStatusCallbacks ───────────────────────────────────────────────

describe('composeStatusCallbacks', () => {
  it('calls both callbacks in order for onWorkflowStart', () => {
    const calls1: unknown[] = [];
    const calls2: unknown[] = [];
    const cb1: StatusCallbacks = {
      onWorkflowStart: (info) => calls1.push(info),
    };
    const cb2: StatusCallbacks = {
      onWorkflowStart: (info) => calls2.push(info),
    };
    const composed = composeStatusCallbacks([cb1, cb2]);
    const info = { taskPrompt: 'test', resumed: false, workDir: '/tmp' };
    composed.onWorkflowStart?.(info);
    expect(calls1).toHaveLength(1);
    expect(calls1[0]).toBe(info);
    expect(calls2).toHaveLength(1);
    expect(calls2[0]).toBe(info);
  });

  it('calls both callbacks in order for onPhaseStart', () => {
    const order: number[] = [];
    const cb1: StatusCallbacks = {
      onPhaseStart: () => order.push(1),
    };
    const cb2: StatusCallbacks = {
      onPhaseStart: () => order.push(2),
    };
    const composed = composeStatusCallbacks([cb1, cb2]);
    composed.onPhaseStart?.({ phase: 'test', round: 1 });
    expect(order).toEqual([1, 2]);
  });

  it('calls a method only on cb1 when cb2 does not define it', () => {
    const calls1: unknown[] = [];
    const cb1: StatusCallbacks = {
      onWorkflowStart: (info) => calls1.push(info),
    };
    // cb2 has no onWorkflowStart
    const cb2: StatusCallbacks = {};
    const composed = composeStatusCallbacks([cb1, cb2]);
    const info = { taskPrompt: 'test', resumed: false, workDir: '/tmp' };
    composed.onWorkflowStart?.(info);
    expect(calls1).toHaveLength(1);
    expect(calls1[0]).toBe(info);
  });

  it('calls all methods on multiple callbacks in array order', () => {
    const log: string[] = [];
    const cb1: StatusCallbacks = {
      onWorkflowStart: () => log.push('cb1.onWorkflowStart'),
      onPhaseStart: () => log.push('cb1.onPhaseStart'),
      onPhaseComplete: () => log.push('cb1.onPhaseComplete'),
      onPhaseRegister: () => log.push('cb1.onPhaseRegister'),
      onAgentSpawn: () => log.push('cb1.onAgentSpawn'),
      onAgentComplete: () => log.push('cb1.onAgentComplete'),
      onTaskStart: () => log.push('cb1.onTaskStart'),
      onTaskRegister: () => log.push('cb1.onTaskRegister'),
      onStepStart: () => log.push('cb1.onStepStart'),
      onTaskComplete: () => log.push('cb1.onTaskComplete'),
      onTaskRejected: () => log.push('cb1.onTaskRejected'),
      onDecision: () => log.push('cb1.onDecision'),
      onError: () => log.push('cb1.onError'),
      onWorkflowComplete: () => log.push('cb1.onWorkflowComplete'),
      onWorkflowFailed: () => log.push('cb1.onWorkflowFailed'),
      onTurnStart: () => log.push('cb1.onTurnStart'),
      onTurnEnd: () => log.push('cb1.onTurnEnd'),
      onToolCallStart: () => log.push('cb1.onToolCallStart'),
      onToolCallEnd: () => log.push('cb1.onToolCallEnd'),
      onSidebarUpdate: () => log.push('cb1.onSidebarUpdate'),
    };
    const cb2: StatusCallbacks = {
      onWorkflowStart: () => log.push('cb2.onWorkflowStart'),
      onPhaseStart: () => log.push('cb2.onPhaseStart'),
      onPhaseComplete: () => log.push('cb2.onPhaseComplete'),
      onPhaseRegister: () => log.push('cb2.onPhaseRegister'),
      onAgentSpawn: () => log.push('cb2.onAgentSpawn'),
      onAgentComplete: () => log.push('cb2.onAgentComplete'),
      onTaskStart: () => log.push('cb2.onTaskStart'),
      onTaskRegister: () => log.push('cb2.onTaskRegister'),
      onStepStart: () => log.push('cb2.onStepStart'),
      onTaskComplete: () => log.push('cb2.onTaskComplete'),
      onTaskRejected: () => log.push('cb2.onTaskRejected'),
      onDecision: () => log.push('cb2.onDecision'),
      onError: () => log.push('cb2.onError'),
      onWorkflowComplete: () => log.push('cb2.onWorkflowComplete'),
      onWorkflowFailed: () => log.push('cb2.onWorkflowFailed'),
      onTurnStart: () => log.push('cb2.onTurnStart'),
      onTurnEnd: () => log.push('cb2.onTurnEnd'),
      onToolCallStart: () => log.push('cb2.onToolCallStart'),
      onToolCallEnd: () => log.push('cb2.onToolCallEnd'),
      onSidebarUpdate: () => log.push('cb2.onSidebarUpdate'),
    };
    const composed = composeStatusCallbacks([cb1, cb2]);

    // Call each method on the composed object
    composed.onWorkflowStart?.({} as any);
    composed.onPhaseStart?.({} as any);
    composed.onPhaseComplete?.({} as any);
    composed.onPhaseRegister?.({} as any);
    composed.onAgentSpawn?.({} as any);
    composed.onAgentComplete?.({} as any);
    composed.onTaskStart?.({} as any);
    composed.onTaskRegister?.({} as any);
    composed.onStepStart?.({} as any);
    composed.onTaskComplete?.({} as any);
    composed.onTaskRejected?.({} as any);
    composed.onDecision?.({} as any);
    composed.onError?.({} as any);
    composed.onWorkflowComplete?.({} as any);
    composed.onWorkflowFailed?.({} as any);
    composed.onTurnStart?.({} as any);
    composed.onTurnEnd?.({} as any);
    composed.onToolCallStart?.({} as any);
    composed.onToolCallEnd?.({} as any);
    composed.onSidebarUpdate?.({} as any);

    // Each method should invoke both cb1 and cb2 in order
    expect(log).toHaveLength(40);
    for (let i = 0; i < 20; i++) {
      const methodIndex = i * 2;
      expect(log[methodIndex]).toBe(`cb1.${STATUS_CALLBACK_METHODS[i]}`);
      expect(log[methodIndex + 1]).toBe(`cb2.${STATUS_CALLBACK_METHODS[i]}`);
    }
  });

  it('calls a method only on cb1 when cb2 does not define it', () => {
    const calls1: unknown[] = [];
    const cb1: StatusCallbacks = {
      onWorkflowStart: (info) => calls1.push(info),
    };
    // cb2 has no onWorkflowStart
    const cb2: StatusCallbacks = {};
    const composed = composeStatusCallbacks([cb1, cb2]);
    const info = { taskPrompt: 'test', resumed: false, workDir: '/tmp' };
    composed.onWorkflowStart?.(info);
    expect(calls1).toHaveLength(1);
    expect(calls1[0]).toBe(info);
  });

  it('returns a no-op object when the array is empty', () => {
    const composed = composeStatusCallbacks([]);
    // All methods should exist and be callable without throwing
    expect(() => {
      composed.onWorkflowStart?.({ taskPrompt: '', resumed: false, workDir: '' });
      composed.onPhaseStart?.({ phase: '', round: 0 });
      composed.onPhaseComplete?.({ phase: '', durationMs: 0 });
      composed.onPhaseRegister?.({ id: '', label: '', icon: '' });
      composed.onAgentSpawn?.({ agentId: '', profile: '', phaseId: '' });
      composed.onAgentComplete?.({ agentId: '', profile: '', phaseId: '' });
      composed.onTaskStart?.({ taskId: '', title: '', agentId: '' });
      composed.onTaskRegister?.({ taskId: '', phaseId: '', title: '', dependencies: [], steps: [] });
      composed.onStepStart?.({ taskId: '', stepIndex: 0, stepName: '', agentId: '' });
      composed.onTaskComplete?.({ taskId: '', title: '' });
      composed.onTaskRejected?.({ taskId: '', title: '', reason: '' });
      composed.onDecision?.({ agentId: '', decision: '', reasoning: '' });
      composed.onError?.({ agentId: '', error: '', phaseId: '' });
      composed.onWorkflowComplete?.({ totalDurationMs: 0, agentCount: 0 });
      composed.onWorkflowFailed?.({ error: new Error(), phaseId: '' });
      composed.onTurnStart?.({ agentId: '', turn: 0 });
      composed.onTurnEnd?.({ agentId: '', turn: 0 });
      composed.onToolCallStart?.({ agentId: '', toolName: '', toolCallId: '', arguments: {} });
      composed.onToolCallEnd?.({ agentId: '', toolName: '', toolCallId: '', isError: false });
      composed.onSidebarUpdate?.({});
    }).not.toThrow();
  });

  it('empty no-op object has all STATUS_CALLBACK_METHODS as keys', () => {
    const composed = composeStatusCallbacks([]);
    for (const methodName of STATUS_CALLBACK_METHODS) {
      expect(composed).toHaveProperty(methodName);
      expect(typeof (composed as any)[methodName]).toBe('function');
    }
  });

  it('returns the same object reference when the array has exactly one element', () => {
    const cb: StatusCallbacks = {
      onWorkflowStart: () => {},
    };
    const result = composeStatusCallbacks([cb]);
    expect(result).toBe(cb);
  });

  it('continues to invoke remaining callbacks when a prior callback throws (error isolation)', () => {
    const calls: unknown[] = [];
    const cb1: StatusCallbacks = {
      onWorkflowStart: () => {
        throw new Error('cb1 failure');
      },
    };
    const cb2: StatusCallbacks = {
      onWorkflowStart: (info) => calls.push(info),
    };
    const composed = composeStatusCallbacks([cb1, cb2]);
    const info = { taskPrompt: 'test', resumed: false, workDir: '/tmp' };

    const originalError = console.error;
    const consoleSpy = mock((_msg: string, _err: Error) => {});
    console.error = consoleSpy;
    try {
      composed.onWorkflowStart?.(info);
    } finally {
      console.error = originalError;
    }

    // cb2 must have been called despite cb1 throwing
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(info);

    // console.error must have been called with the descriptive message
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0][0]).toBe('[composeStatusCallbacks] Error in onWorkflowStart:');
    expect(consoleSpy.mock.calls[0][1]).toBeInstanceOf(Error);
    expect(consoleSpy.mock.calls[0][1].message).toBe('cb1 failure');
  });
});

// ─── appendReviewFeedback ──────────────────────────────────────────────────

describe('appendReviewFeedback', () => {
  it('initializes reviewFeedback array when absent and pushes feedback', () => {
    const task: { reviewFeedback?: string[] } = {};
    appendReviewFeedback(task, 'first feedback');
    expect(task.reviewFeedback).toEqual(['first feedback']);
  });

  it('appends to existing reviewFeedback without replacing entries', () => {
    const task: { reviewFeedback?: string[] } = { reviewFeedback: ['existing'] };
    appendReviewFeedback(task, 'new feedback');
    expect(task.reviewFeedback).toEqual(['existing', 'new feedback']);
  });
});

// ─── DEFAULT_TOOLS ─────────────────────────────────────────────────────────

describe('DEFAULT_TOOLS', () => {
  it('contains all expected tool names', () => {
    expect(DEFAULT_TOOLS).toContain('read');
    expect(DEFAULT_TOOLS).toContain('bash');
    expect(DEFAULT_TOOLS).toContain('edit');
    expect(DEFAULT_TOOLS).toContain('write');
    expect(DEFAULT_TOOLS).toContain('grep');
    expect(DEFAULT_TOOLS).toContain('find');
    expect(DEFAULT_TOOLS).toContain('ls');
  });
});
