import { describe, expect, it } from 'bun:test';
import type { StatusCallbacks } from '../../src/core/types.js';
import {
  appendReviewFeedback,
  composeStatusCallbacks,
  DEFAULT_TOOLS,
  forwardAgentStatus,
  isEnoentError,
  safeErrorMessage,
  validateWorkflowName,
} from '../../src/core/utils.js';

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

  it('returns false for null', () => {
    expect(isEnoentError(null)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isEnoentError('ENOENT')).toBe(false);
  });

  it('returns false for an object without a code property', () => {
    expect(isEnoentError({})).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isEnoentError(undefined)).toBe(false);
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

  it('returns the stringified number when given a number', () => {
    expect(safeErrorMessage(42)).toBe('42');
  });

  it('returns "undefined" for undefined', () => {
    expect(safeErrorMessage(undefined)).toBe('undefined');
  });
});

// ─── forwardAgentStatus ───────────────────────────────────────────────────

describe('forwardAgentStatus', () => {
  it('returns undefined when onStatus is undefined', () => {
    expect(forwardAgentStatus(undefined)).toBeUndefined();
  });

  it('returns callbacks that forward to the corresponding onStatus methods', () => {
    const onTurnStart = () => {};
    const onTurnEnd = () => {};
    const onToolCallStart = () => {};
    const onToolCallEnd = () => {};

    const onStatus: StatusCallbacks = { onTurnStart, onTurnEnd, onToolCallStart, onToolCallEnd };
    const result = forwardAgentStatus(onStatus);

    expect(result).toBeDefined();
    expect(result!.onTurnStart).toBeInstanceOf(Function);
    expect(result!.onTurnEnd).toBeInstanceOf(Function);
    expect(result!.onToolCallStart).toBeInstanceOf(Function);
    expect(result!.onToolCallEnd).toBeInstanceOf(Function);
  });

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

  it('returns a no-op object when the array is empty', () => {
    const composed = composeStatusCallbacks([]);
    // All methods should exist and be callable without throwing
    expect(() => {
      composed.onWorkflowStart?.({ taskPrompt: '', resumed: false, workDir: '' });
      composed.onPhaseStart?.({ phase: '', round: 0 });
      composed.onPhaseComplete?.({ phase: '', durationMs: 0 });
      composed.onAgentSpawn?.({ agentId: '', profile: '', phase: '' });
      composed.onAgentComplete?.({ agentId: '', profile: '', phase: '' });
      composed.onTaskStart?.({ taskId: '', title: '', agentId: '' });
      composed.onTaskComplete?.({ taskId: '', title: '' });
      composed.onTaskRejected?.({ taskId: '', title: '', reason: '' });
      composed.onDecision?.({ agentId: '', decision: '', reasoning: '' });
      composed.onError?.({ agentId: '', error: '', phase: '' });
      composed.onWorkflowComplete?.({ totalDurationMs: 0, agentCount: 0 });
      composed.onWorkflowFailed?.({ error: new Error(), phase: '' });
      composed.onTurnStart?.({ agentId: '', turn: 0 });
      composed.onTurnEnd?.({ agentId: '', turn: 0 });
      composed.onToolCallStart?.({ agentId: '', toolName: '', toolCallId: '', arguments: {} });
      composed.onToolCallEnd?.({ agentId: '', toolName: '', toolCallId: '', isError: false });
      composed.onTasksAdded?.({ tasks: [] });
      composed.onSidebarUpdate?.({});
    }).not.toThrow();
  });

  it('returns the same object reference when the array has exactly one element', () => {
    const cb: StatusCallbacks = {
      onWorkflowStart: () => {},
    };
    const result = composeStatusCallbacks([cb]);
    expect(result).toBe(cb);
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

  it('has exactly 7 entries', () => {
    expect(DEFAULT_TOOLS).toHaveLength(7);
  });
});
