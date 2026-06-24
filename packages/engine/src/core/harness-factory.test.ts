// ─── Tests for createAgentEventForwarder — auto_retry event mapping ─────────
//
// Verifies that the exported `createAgentEventForwarder` maps pi-coding-agent
// `auto_retry_start` / `auto_retry_end` events to the corresponding
// `AgentStatusCallbacks` methods, and that the fields are defensively captured
// (coerced numbers, optional strings).
//
// This function is the pure event-mapping core of the `session.subscribe`
// handler inside `createHarness`. Testing it directly avoids the need to mock
// npm-package dependencies (AuthStorage, createAgentSession, etc.) that cause
// cross-test-file pollution in the full `bun test` run.

import { describe, expect, it } from 'bun:test';
import { createAgentEventForwarder } from './harness-factory.js';
import type { AgentStatusCallbacks } from './types.js';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createAgentEventForwarder — auto_retry_start', () => {
  it('forwards auto_retry_start to onAutoRetryStart with correct fields', () => {
    const captured: Array<{
      agentId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage?: string;
    }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'agent-1');
    forwarder({
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 5,
      delayMs: 4000,
      errorMessage: 'overloaded',
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      agentId: 'agent-1',
      attempt: 2,
      maxAttempts: 5,
      delayMs: 4000,
      errorMessage: 'overloaded',
    });
  });

  it('defensively coerces numeric fields', () => {
    const captured: Array<{ attempt: number; maxAttempts: number; delayMs: number }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({
      type: 'auto_retry_start',
      attempt: '3' as unknown as number,
      maxAttempts: '7' as unknown as number,
      delayMs: '1000' as unknown as number,
      errorMessage: 'err',
    } as any);

    expect(captured[0].attempt).toBe(3);
    expect(captured[0].maxAttempts).toBe(7);
    expect(captured[0].delayMs).toBe(1000);
  });

  it('falls back to 1/1/0 when numeric fields are falsy', () => {
    const captured: Array<{ attempt: number; maxAttempts: number; delayMs: number }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({
      type: 'auto_retry_start',
      attempt: 0,
      maxAttempts: 0,
      delayMs: 0,
      errorMessage: '',
    } as any);

    expect(captured[0].attempt).toBe(1);
    expect(captured[0].maxAttempts).toBe(1);
    expect(captured[0].delayMs).toBe(0);
  });

  it('does not fire when onAutoRetryStart is not provided', () => {
    let fired = false;
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {
        fired = true;
      },
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: '' } as any);

    expect(fired).toBe(false);
  });
});

describe('createAgentEventForwarder — auto_retry_end', () => {
  it('forwards auto_retry_end (failure) to onAutoRetryCompleted', () => {
    const captured: Array<{ agentId: string; success: boolean; attempt: number; finalError?: string }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryCompleted: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'agent-2');
    forwarder({
      type: 'auto_retry_end',
      success: false,
      attempt: 5,
      finalError: 'rate limit exceeded after max retries',
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      agentId: 'agent-2',
      success: false,
      attempt: 5,
      finalError: 'rate limit exceeded after max retries',
    });
  });

  it('forwards auto_retry_end (success) with no finalError', () => {
    const captured: Array<{ agentId: string; success: boolean; attempt: number; finalError?: string }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryCompleted: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'agent-3');
    forwarder({ type: 'auto_retry_end', success: true, attempt: 1 } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].agentId).toBe('agent-3');
    expect(captured[0].success).toBe(true);
    expect(captured[0].attempt).toBe(1);
    expect(captured[0].finalError).toBeUndefined();
  });

  it('defensively coerces attempt to number', () => {
    const captured: Array<{ attempt: number }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryCompleted: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({ type: 'auto_retry_end', success: false, attempt: '2' as unknown as number, finalError: 'err' } as any);

    expect(captured[0].attempt).toBe(2);
  });

  it('does not fire when onAutoRetryCompleted is not provided', () => {
    let fired = false;
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {
        fired = true;
      },
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({ type: 'auto_retry_end', success: true, attempt: 1 } as any);

    expect(fired).toBe(false);
  });
});

// ─── Regression: existing event types still forwarded ───────────────────────

describe('createAgentEventForwarder — existing events (regression)', () => {
  it('still forwards turn_start to onTurnStart', () => {
    const captured: Array<{ agentId: string; turn: number }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ agentId: 'a1', turn: 1 });
  });

  it('still forwards tool_execution_start to onToolCallStart', () => {
    const captured: Array<{ toolName: string; toolCallId: string }> = [];
    const onStatus: AgentStatusCallbacks = {
      onToolCallStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'tc1', args: { command: 'ls' } } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].toolName).toBe('bash');
  });

  it('still forwards tool_execution_end to onToolCallEnd', () => {
    const captured: Array<{ isError: boolean }> = [];
    const onStatus: AgentStatusCallbacks = {
      onToolCallEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'tc1', isError: true } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].isError).toBe(true);
  });

  it('ignores unrecognized event types without crashing', () => {
    const onStatus: AgentStatusCallbacks = {};
    const forwarder = createAgentEventForwarder(onStatus, 'a1');

    expect(() => {
      forwarder({ type: 'unknown_event' } as any);
    }).not.toThrow();
  });
});

// ─── Integration: forwarder → store-callbacks ───────────────────────────────

describe('createAgentEventForwarder → store-callbacks integration', () => {
  it('auto_retry_start via store-callbacks appends auto_retry_started', async () => {
    const { createStoreCallbacks } = await import('../tracking/store-callbacks.js');

    interface RecordedCall {
      type: string;
      data: Record<string, unknown>;
      metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number };
    }
    const calls: RecordedCall[] = [];
    const store = {
      append: (type: string, data: Record<string, unknown>, metadata?: RecordedCall['metadata']) =>
        calls.push({ type, data, metadata }),
    };
    const onStatus = createStoreCallbacks(store as any);

    const forwarder = createAgentEventForwarder(onStatus, 'agent-e2e');
    forwarder({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: 'server error',
    } as any);

    const event = calls.find((c) => c.type === 'auto_retry_started');
    expect(event, 'auto_retry_started event should be appended').toBeDefined();
    expect(event!.data.attempt).toBe(1);
    expect(event!.data.maxAttempts).toBe(3);
    expect(event!.data.delayMs).toBe(2000);
    expect(event!.data.errorMessage).toBe('server error');
    expect(event!.metadata?.agentId).toBe('agent-e2e');
  });

  it('auto_retry_end via store-callbacks appends auto_retry_completed', async () => {
    const { createStoreCallbacks } = await import('../tracking/store-callbacks.js');

    interface RecordedCall {
      type: string;
      data: Record<string, unknown>;
      metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number };
    }
    const calls: RecordedCall[] = [];
    const store = {
      append: (type: string, data: Record<string, unknown>, metadata?: RecordedCall['metadata']) =>
        calls.push({ type, data, metadata }),
    };
    const onStatus = createStoreCallbacks(store as any);

    const forwarder = createAgentEventForwarder(onStatus, 'agent-e2e-2');
    forwarder({
      type: 'auto_retry_end',
      success: false,
      attempt: 3,
      finalError: 'max retries exceeded',
    } as any);

    const event = calls.find((c) => c.type === 'auto_retry_completed');
    expect(event, 'auto_retry_completed event should be appended').toBeDefined();
    expect(event!.data.success).toBe(false);
    expect(event!.data.attempt).toBe(3);
    expect(event!.data.finalError).toBe('max retries exceeded');
    expect(event!.metadata?.agentId).toBe('agent-e2e-2');
  });
});
