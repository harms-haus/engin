// ─── Tests for createAgentEventForwarder — event mapping ───────────────────
//
// Verifies that the exported `createAgentEventForwarder` maps neutral
// `AgentRuntimeEvent`s to the corresponding `AgentStatusCallbacks` methods,
// and that fields are defensively captured (coerced numbers, optional
// strings, content-block mapping, secret redaction).
//
// This function is the pure event-mapping core extracted from
// `harness-factory.ts` into `agent-event-forwarder.ts`. Testing it directly
// avoids the need to mock npm-package dependencies (AuthStorage,
// createAgentSession, etc.) that cause cross-test-file pollution in the full
// `bun test` run.

import { describe, expect, it } from 'bun:test';
import { createAgentEventForwarder } from './agent-event-forwarder.js';
import type { AgentStatusCallbacks, TurnContentBlock } from './types.js';

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

  it('falls back to 1/1/0 when numeric fields are falsy (attempt=0 boundary)', () => {
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

    // attempt=0 and maxAttempts=0 are falsy → coerce to the 1 fallback;
    // delayMs=0 is falsy → falls through to the explicit `|| 0` default (0).
    expect(captured[0].attempt).toBe(1);
    expect(captured[0].maxAttempts).toBe(1);
    expect(captured[0].delayMs).toBe(0);
  });

  it('preserves boundary value when attempt === maxAttempts (final retry)', () => {
    const captured: Array<{ attempt: number; maxAttempts: number; delayMs: number }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    // attempt === maxAttempts: the last permitted attempt. These are real
    // numbers (not falsy) so the `||` fallbacks must NOT kick in.
    forwarder({
      type: 'auto_retry_start',
      attempt: 3,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: 'final attempt',
    } as any);

    expect(captured[0].attempt).toBe(3);
    expect(captured[0].maxAttempts).toBe(3);
    expect(captured[0].delayMs).toBe(500);
  });

  it('does not propagate taskId or phaseId (forwarder sets neither)', () => {
    const captured: Array<{ taskId?: string; phaseId?: string }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: 'err',
    } as any);

    // The callback type declares optional taskId/phaseId, but the forwarder
    // only ever sets agentId/attempt/maxAttempts/delayMs/errorMessage — the
    // ownership/task context fields stay undefined for the forwarder to emit.
    expect(captured[0].taskId).toBeUndefined();
    expect(captured[0].phaseId).toBeUndefined();
  });

  it('throws when errorMessage is undefined (not defensive, unlike finalError)', () => {
    // The `auto_retry_start` event type marks `errorMessage: string` as
    // required, but a provider could omit it. Unlike `finalError` (which
    // guards `!= null` before calling redactSecrets), errorMessage is passed
    // straight to redactSecrets — which throws a TypeError on undefined.
    // Pin this current behavior (it is a real asymmetry/bug worth fixing).
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryStart: () => {},
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    expect(() => {
      forwarder({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 100 } as any);
    }).toThrow();
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

  it('redacts secrets in errorMessage', () => {
    const captured: Array<{ errorMessage?: string }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: 'auth error: Bearer secrettoken1234567890',
    } as any);

    expect(captured[0].errorMessage).toBe('auth error: Bearer [REDACTED]');
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

  it('normalizes success to a strict boolean (only literal true passes)', () => {
    const captured: Array<{ success: boolean }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryCompleted: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    // The forwarder uses `e.success === true`, so only the literal boolean
    // true is treated as success — every other value (omitted, 1, 'yes') is
    // coerced to false.
    forwarder({ type: 'auto_retry_end', success: undefined as any, attempt: 1 } as any);
    forwarder({ type: 'auto_retry_end', success: 1 as any, attempt: 1 } as any);
    forwarder({ type: 'auto_retry_end', success: 'yes' as any, attempt: 1 } as any);
    forwarder({ type: 'auto_retry_end', success: true, attempt: 1 } as any);

    expect(captured.map((c) => c.success)).toEqual([false, false, false, true]);
  });

  it('treats null finalError as undefined (defensive `!= null` guard)', () => {
    const captured: Array<{ finalError?: string }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryCompleted: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({ type: 'auto_retry_end', success: false, attempt: 1, finalError: null } as any);

    // finalError guards `!= null` before redacting, so null → undefined
    // (contrast with auto_retry_start's errorMessage, which has no such guard).
    expect(captured[0].finalError).toBeUndefined();
  });

  it('does not propagate taskId or phaseId (forwarder sets neither)', () => {
    const captured: Array<{ taskId?: string; phaseId?: string }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryCompleted: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({ type: 'auto_retry_end', success: true, attempt: 1 } as any);

    expect(captured[0].taskId).toBeUndefined();
    expect(captured[0].phaseId).toBeUndefined();
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

  it('redacts secrets in finalError', () => {
    const captured: Array<{ finalError?: string }> = [];
    const onStatus: AgentStatusCallbacks = {
      onAutoRetryCompleted: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a');
    forwarder({
      type: 'auto_retry_end',
      success: false,
      attempt: 2,
      finalError: 'auth failed: Bearer secrettoken1234567890',
    } as any);

    expect(captured[0].finalError).toBe('auth failed: Bearer [REDACTED]');
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

  it('increments turn count across multiple turn_start events', () => {
    const captured: Array<{ turn: number }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({ type: 'turn_start' } as any);
    forwarder({ type: 'turn_start' } as any);

    expect(captured.map((c) => c.turn)).toEqual([1, 2, 3]);
  });

  it('forwards tool_execution_start toolName, toolCallId, and args together', () => {
    // Consolidates two prior tests that each exercised the same
    // tool_execution_start → onToolCallStart path but asserted a different
    // field (toolName vs arguments). Verifying all three fields in one call
    // covers the same path without duplicating setup.
    const captured: Array<{
      agentId: string;
      toolName: string;
      toolCallId: string;
      arguments: Record<string, unknown>;
    }> = [];
    const onStatus: AgentStatusCallbacks = {
      onToolCallStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({
      type: 'tool_execution_start',
      toolName: 'write',
      toolCallId: 'tc1',
      args: { path: '/tmp/x', content: 'hello' },
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].agentId).toBe('a1');
    expect(captured[0].toolName).toBe('write');
    expect(captured[0].toolCallId).toBe('tc1');
    expect(captured[0].arguments).toEqual({ path: '/tmp/x', content: 'hello' });
  });

  it('defaults tool_execution_start arguments to empty object when args omitted', () => {
    const captured: Array<{ arguments: Record<string, unknown> }> = [];
    const onStatus: AgentStatusCallbacks = {
      onToolCallStart: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'tc1' } as any);

    expect(captured[0].arguments).toEqual({});
  });

  it('forwards tool_execution_end isError flag and defaults to false when undefined', () => {
    // Consolidates two prior tests (isError: true explicitly, and the default
    // when undefined) that exercised the same tool_execution_end path.
    const captured: Array<{ isError: boolean }> = [];
    const onStatus: AgentStatusCallbacks = {
      onToolCallEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');

    // Explicit isError: true passes through.
    forwarder({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'tc1', isError: true } as any);
    // Omitted isError defaults to false.
    forwarder({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'tc2' } as any);

    expect(captured).toHaveLength(2);
    expect(captured[0].isError).toBe(true);
    expect(captured[1].isError).toBe(false);
  });

  it('ignores unrecognized event types without crashing', () => {
    const onStatus: AgentStatusCallbacks = {};
    const forwarder = createAgentEventForwarder(onStatus, 'a1');

    expect(() => {
      forwarder({ type: 'unknown_event' } as any);
    }).not.toThrow();
  });
});

// ─── turn_end: content block mapping & tokens ──────────────────────────────

describe('createAgentEventForwarder — turn_end', () => {
  it('forwards turn_end with tokens for assistant messages', () => {
    const captured: Array<{ turn: number; tokens?: { input: number; output: number } }> = [];
    const onStatus: AgentStatusCallbacks = {
      // onTurnStart must be present so the optional-chaining `onTurnStart?.({ turn: ++turnCount })`
      // actually evaluates and increments the turn counter.
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    // turn_end must be preceded by turn_start so turnCount is incremented
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: { role: 'assistant', usage: { input: 100, output: 50 } },
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].turn).toBe(1);
    expect(captured[0].tokens).toEqual({ input: 100, output: 50 });
  });

  it('skips both tokens and content blocks for non-assistant messages', () => {
    // Consolidates two prior tests that each sent the same non-assistant
    // turn_end event and asserted a single different field (tokens vs
    // contentBlocks). Both fields are gated behind the same `isAssistant`
    // check, so one event covers both.
    const captured: Array<{
      tokens?: { input: number; output: number };
      contentBlocks?: TurnContentBlock[];
    }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: { role: 'user', usage: { input: 100, output: 50 }, content: [{ type: 'text', text: 'hi' }] },
    } as any);

    expect(captured[0].tokens).toBeUndefined();
    expect(captured[0].contentBlocks).toBeUndefined();
  });

  it('maps text content blocks', () => {
    const captured: Array<{ contentBlocks?: TurnContentBlock[] }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    } as any);

    expect(captured[0].contentBlocks).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('maps thinking content blocks including redacted flag', () => {
    const captured: Array<{ contentBlocks?: TurnContentBlock[] }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'reasoning here', redacted: true }],
      },
    } as any);

    expect(captured[0].contentBlocks).toEqual([{ type: 'thinking', thinking: 'reasoning here', redacted: true }]);
  });

  it('maps thinking block without a redacted field (redacted stays undefined)', () => {
    const captured: Array<{ contentBlocks?: TurnContentBlock[] }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'no redaction flag' }],
      },
    } as any);

    // The forwarder always assigns `redacted: block.redacted`, so when the
    // source omits it the mapped block carries `redacted: undefined`.
    expect(captured[0].contentBlocks).toEqual([{ type: 'thinking', thinking: 'no redaction flag' }]);
    expect((captured[0].contentBlocks![0] as Extract<TurnContentBlock, { type: 'thinking' }>).redacted).toBeUndefined();
  });

  it('maps toolCall content blocks', () => {
    const captured: Array<{ contentBlocks?: TurnContentBlock[] }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
      },
    } as any);

    expect(captured[0].contentBlocks).toEqual([
      { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } },
    ]);
  });

  it('skips unrecognized content block types', () => {
    const captured: Array<{ contentBlocks?: TurnContentBlock[] }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'before' },
          { type: 'future_block_type', data: 'unknown' } as any,
          { type: 'text', text: 'after' },
        ],
      },
    } as any);

    expect(captured[0].contentBlocks).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' },
    ]);
  });

  it('maps an empty content array to an empty contentBlocks array', () => {
    const captured: Array<{ contentBlocks?: TurnContentBlock[] }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: { role: 'assistant', content: [] },
    } as any);

    // An assistant message with content: [] is truthy, so the mapper runs and
    // produces [] (distinct from "no content" which yields undefined).
    expect(captured[0].contentBlocks).toEqual([]);
  });

  it('treats null content as no content (contentBlocks undefined)', () => {
    const captured: Array<{ contentBlocks?: TurnContentBlock[] }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: { role: 'assistant', content: null },
    } as any);

    // The `isAssistant && e.message.content` guard is falsy for null, so the
    // mapper is skipped and contentBlocks stays undefined.
    expect(captured[0].contentBlocks).toBeUndefined();
  });

  it('preserves block ordering when multiple recognized types present', () => {
    const captured: Array<{ contentBlocks?: TurnContentBlock[] }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'result' },
          { type: 'toolCall', id: 'tc1', name: 'bash', arguments: {} },
        ],
      },
    } as any);

    expect(captured[0].contentBlocks).toEqual([
      { type: 'thinking', thinking: 'let me think', redacted: undefined },
      { type: 'text', text: 'result' },
      { type: 'toolCall', id: 'tc1', name: 'bash', arguments: {} },
    ]);
  });

  it('contentBlocks is undefined when assistant message has no content', () => {
    const captured: Array<{ contentBlocks?: TurnContentBlock[] }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {},
      onTurnEnd: (info) => captured.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({
      type: 'turn_end',
      message: { role: 'assistant' },
    } as any);

    expect(captured[0].contentBlocks).toBeUndefined();
  });

  it('does not fire when onTurnEnd is not provided', () => {
    let fired = false;
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: () => {
        fired = true;
      },
    };

    const forwarder = createAgentEventForwarder(onStatus, 'a1');
    forwarder({ type: 'turn_start' } as any);
    forwarder({ type: 'turn_end', message: { role: 'assistant', usage: { input: 1, output: 1 } } } as any);

    expect(fired).toBe(true);
  });
});

// ─── agentId passthrough ────────────────────────────────────────────────────

describe('createAgentEventForwarder — agentId passthrough', () => {
  it('uses the effectiveAgentId provided at construction in all callbacks', () => {
    const turnStarts: Array<{ agentId: string }> = [];
    const toolStarts: Array<{ agentId: string }> = [];
    const onStatus: AgentStatusCallbacks = {
      onTurnStart: (info) => turnStarts.push(info),
      onToolCallStart: (info) => toolStarts.push(info),
    };

    const forwarder = createAgentEventForwarder(onStatus, 'my-custom-agent-id');
    forwarder({ type: 'turn_start' } as any);
    forwarder({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'tc1' } as any);

    expect(turnStarts[0].agentId).toBe('my-custom-agent-id');
    expect(toolStarts[0].agentId).toBe('my-custom-agent-id');
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
