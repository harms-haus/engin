import { describe, expect, it } from 'bun:test';
import type { StatusCallbacks } from '../../src/core/types.js';
import {
  appendReviewFeedback,
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
