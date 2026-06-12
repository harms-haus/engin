import { describe, expect, it } from 'bun:test';
import { agentKey } from '../../src/web/run-registry.js';

describe('agentKey', () => {
  it('returns agentId when taskId is omitted', () => {
    expect(agentKey('a1')).toBe('a1');
  });

  it('returns agentId::taskId when taskId is provided', () => {
    expect(agentKey('a1', 't1')).toBe('a1::t1');
  });

  it('returns agentId when taskId is explicitly undefined', () => {
    expect(agentKey('a1', undefined)).toBe('a1');
  });

  it('is deterministic for the same inputs', () => {
    const first = agentKey('a1', 't1');
    const second = agentKey('a1', 't1');
    expect(first).toBe(second);
    expect(first).toBe('a1::t1');
  });

  it('returns just the agentId when taskId is an empty string', () => {
    // Empty string is falsy, so the function should return just agentId
    expect(agentKey('a1', '')).toBe('a1');
  });

  it('handles special characters in agentId and taskId', () => {
    expect(agentKey('agent:special', 'task/special')).toBe('agent:special::task/special');
  });

  it('differentiates between no taskId and a valid taskId', () => {
    const withoutTask = agentKey('a1');
    const withTask = agentKey('a1', 't1');
    expect(withoutTask).not.toBe(withTask);
    expect(withoutTask).toBe('a1');
    expect(withTask).toBe('a1::t1');
  });
});
