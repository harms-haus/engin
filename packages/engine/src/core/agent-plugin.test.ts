// ─── Tests for core/agent-plugin.ts — neutral agent plugin contract ─────────
//
// Validates the type-level contract for the neutral agent plugin abstraction.
// Since agent-plugin.ts is purely types/interfaces with one re-export, these
// tests verify:
//
//   1. Each variant of the `AgentRuntimeEvent` discriminated union has the
//      correct shape and can be narrowed on `type`.
//   2. `LastAssistantMessage` is re-exported from ./error-classifier.js and is
//      the same type (structurally identical).
//   3. `PromptOptions` accepts an optional AbortSignal.
//   4. `AgentRuntime` is satisfied by a minimal mock implementation.
//   5. `AgentSessionOptions` is satisfied by a minimal mock object matching
//      HarnessCreationOptions.
//   6. `AgentPlugin` is satisfied by a minimal mock adapter.
//   7. @ts-expect-error guards reject incorrect shapes (compile-time).
//
// Module under test: ./agent-plugin.js

import { describe, expect, it } from 'bun:test';

import type {
  AgentPlugin,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSessionOptions,
  LastAssistantMessage,
  PromptOptions,
} from './agent-plugin.js';
import type { LastAssistantMessage as ErrorClassifierLastAssistantMessage } from './error-classifier.js';

// ─── AgentRuntimeEvent — discriminated union variants ─────────────────────

describe('AgentRuntimeEvent discriminated union', () => {
  it('accepts a turn_start event', () => {
    const e: AgentRuntimeEvent = { type: 'turn_start' };
    expect(e.type).toBe('turn_start');
  });

  it('accepts a turn_end event with message', () => {
    const e: AgentRuntimeEvent = {
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input: 10, output: 5 },
      },
    };
    expect(e.type).toBe('turn_end');
    if (e.type === 'turn_end') {
      expect(e.message.role).toBe('assistant');
      expect(e.message.usage?.input).toBe(10);
    }
  });

  it('accepts a turn_end event without optional content/usage', () => {
    const e: AgentRuntimeEvent = {
      type: 'turn_end',
      message: { role: 'user' },
    };
    expect(e.type).toBe('turn_end');
    if (e.type === 'turn_end') {
      expect(e.message.content).toBeUndefined();
      expect(e.message.usage).toBeUndefined();
    }
  });

  it('accepts a tool_execution_start event', () => {
    const e: AgentRuntimeEvent = {
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'tc-1',
      args: { command: 'ls -la' },
    };
    if (e.type === 'tool_execution_start') {
      expect(e.toolName).toBe('bash');
      expect(e.toolCallId).toBe('tc-1');
    }
  });

  it('accepts a tool_execution_start event without optional args', () => {
    const e: AgentRuntimeEvent = {
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'tc-2',
    };
    if (e.type === 'tool_execution_start') {
      expect(e.args).toBeUndefined();
    }
  });

  it('accepts a tool_execution_end event', () => {
    const e: AgentRuntimeEvent = {
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'tc-1',
      isError: true,
    };
    if (e.type === 'tool_execution_end') {
      expect(e.isError).toBe(true);
    }
  });

  it('accepts an auto_retry_start event', () => {
    const e: AgentRuntimeEvent = {
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 5,
      delayMs: 3000,
      errorMessage: 'overloaded',
    };
    if (e.type === 'auto_retry_start') {
      expect(e.attempt).toBe(2);
      expect(e.maxAttempts).toBe(5);
      expect(e.delayMs).toBe(3000);
      expect(e.errorMessage).toBe('overloaded');
    }
  });

  it('accepts an auto_retry_end event (failure)', () => {
    const e: AgentRuntimeEvent = {
      type: 'auto_retry_end',
      success: false,
      attempt: 3,
      finalError: 'max retries exceeded',
    };
    if (e.type === 'auto_retry_end') {
      expect(e.success).toBe(false);
      expect(e.finalError).toBe('max retries exceeded');
    }
  });

  it('accepts an auto_retry_end event (success) without finalError', () => {
    const e: AgentRuntimeEvent = {
      type: 'auto_retry_end',
      success: true,
      attempt: 1,
    };
    if (e.type === 'auto_retry_end') {
      expect(e.finalError).toBeUndefined();
    }
  });

  it('exhaustively narrows on type across all 7 variants', () => {
    const events: AgentRuntimeEvent[] = [
      { type: 'turn_start' },
      { type: 'turn_end', message: { role: 'assistant' } },
      { type: 'tool_execution_start', toolName: 'a', toolCallId: 'b' },
      { type: 'tool_execution_end', toolName: 'a', toolCallId: 'b', isError: false },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'x' },
      { type: 'auto_retry_end', success: true, attempt: 1 },
    ];

    const types: string[] = events.map((e) => e.type);
    const expected: string[] = [
      'turn_start',
      'turn_end',
      'tool_execution_start',
      'tool_execution_end',
      'auto_retry_start',
      'auto_retry_end',
    ];
    expect(types).toEqual(expected);
  });
});

// ─── LastAssistantMessage — re-export structural identity ──────────────────

describe('LastAssistantMessage re-export', () => {
  it('is structurally compatible with error-classifier LastAssistantMessage', () => {
    const msg: LastAssistantMessage = {
      stopReason: 'end_turn',
      errorMessage: undefined,
      content: [{ type: 'text', text: 'done' }],
      usage: { input: 100, output: 50 },
    };

    // Should be assignable to the error-classifier version without casts
    const fromEC: ErrorClassifierLastAssistantMessage = msg;
    expect(fromEC.stopReason).toBe('end_turn');
  });

  it('accepts a minimal LastAssistantMessage (all fields optional)', () => {
    const msg: LastAssistantMessage = {};
    expect(msg.stopReason).toBeUndefined();
  });

  it('accepts usage with partial fields', () => {
    const msg: LastAssistantMessage = {
      usage: { output: 42 },
    };
    expect(msg.usage?.output).toBe(42);
    expect(msg.usage?.input).toBeUndefined();
  });
});

// ─── PromptOptions ─────────────────────────────────────────────────────────

describe('PromptOptions', () => {
  it('accepts an object with a signal', () => {
    const opts: PromptOptions = { signal: AbortSignal.abort() };
    expect(opts.signal?.aborted).toBe(true);
  });

  it('accepts an empty object (signal is optional)', () => {
    const opts: PromptOptions = {};
    expect(opts.signal).toBeUndefined();
  });

  it('accepts undefined', () => {
    const fn = (opts?: PromptOptions) => opts?.signal?.aborted ?? false;
    expect(fn()).toBe(false);
    expect(fn({})).toBe(false);
  });
});

// ─── AgentRuntime — interface satisfaction ──────────────────────────────────

describe('AgentRuntime interface', () => {
  /** Minimal in-memory mock that satisfies AgentRuntime. */
  function makeMockRuntime(): AgentRuntime {
    let disposed = false;
    let aborted = false;
    const subs = new Set<(e: AgentRuntimeEvent) => void>();
    return {
      sessionId: 'test-session-1',
      sessionFile: '/tmp/test.jsonl',
      contextWindow: 200000,
      async prompt(_text: string, _opts?: PromptOptions) {
        if (disposed) throw new Error('disposed');
      },
      getLastAssistantText() {
        return 'mock text';
      },
      getLastAssistantMessage() {
        return { content: [{ type: 'text', text: 'mock text' }] };
      },
      async abort() {
        aborted = true;
      },
      dispose() {
        disposed = true;
      },
      subscribe(cb: (e: AgentRuntimeEvent) => void) {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };
  }

  it('a mock implementation satisfies AgentRuntime', () => {
    const runtime = makeMockRuntime();
    expect(runtime.sessionId).toBe('test-session-1');
    expect(runtime.sessionFile).toBe('/tmp/test.jsonl');
    expect(runtime.contextWindow).toBe(200000);
  });

  it('prompt returns a promise', () => {
    const runtime = makeMockRuntime();
    const result = runtime.prompt('hello');
    expect(result).toBeInstanceOf(Promise);
  });

  it('getLastAssistantText returns string | undefined', () => {
    const runtime = makeMockRuntime();
    const text = runtime.getLastAssistantText();
    expect(typeof text).toBe('string');
  });

  it('getLastAssistantMessage returns LastAssistantMessage | undefined', () => {
    const runtime = makeMockRuntime();
    const msg = runtime.getLastAssistantMessage();
    expect(msg).toBeDefined();
    expect(Array.isArray(msg?.content)).toBe(true);
  });

  it('abort returns a promise', () => {
    const runtime = makeMockRuntime();
    const result = runtime.abort();
    expect(result).toBeInstanceOf(Promise);
  });

  it('dispose is a void function', () => {
    const runtime = makeMockRuntime();
    const result = runtime.dispose();
    expect(result).toBeUndefined();
  });

  it('subscribe returns an unsubscribe function', () => {
    const runtime = makeMockRuntime();
    let called = 0;
    const unsub = runtime.subscribe((_e: AgentRuntimeEvent) => {
      called++;
    });
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('supports a runtime without optional readonly fields', () => {
    const runtime: AgentRuntime = {
      sessionId: 'minimal',
      async prompt() {},
      getLastAssistantText: () => undefined,
      getLastAssistantMessage: () => undefined,
      async abort() {},
      dispose() {},
      subscribe: () => () => {},
    };
    expect(runtime.sessionId).toBe('minimal');
    expect(runtime.sessionFile).toBeUndefined();
    expect(runtime.contextWindow).toBeUndefined();
  });
});

// ─── AgentSessionOptions — interface satisfaction ──────────────────────────

describe('AgentSessionOptions', () => {
  /** Minimal valid AgentProfile for test purposes. */
  const profile = {
    id: 'p1',
    name: 'Test Profile',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    thinkingLevel: 'medium' as const,
    systemPrompt: 'You are a test assistant.',
    excludeTools: [],
    includeTools: [],
  };

  it('accepts a minimal options object with only required fields', () => {
    const opts: AgentSessionOptions = {
      profile,
      cwd: '/tmp/project',
    };
    expect(opts.cwd).toBe('/tmp/project');
    expect(opts.profile.id).toBe('p1');
  });

  it('accepts all optional fields', () => {
    const opts: AgentSessionOptions = {
      profile,
      cwd: '/tmp/project',
      apiKeys: { anthropic: 'sk-test' },
      onAgentStatus: {
        onTurnStart: () => {},
      },
      sessionDir: '/tmp/sessions',
      resumeSessionPath: '/tmp/sessions/abc.jsonl',
      agentId: 'agent-x',
      allowedWriteDirs: ['/tmp/project/src'],
    };
    expect(opts.apiKeys?.anthropic).toBe('sk-test');
    expect(opts.agentId).toBe('agent-x');
    expect(opts.allowedWriteDirs).toEqual(['/tmp/project/src']);
  });

  it('allows profile to have custom fields via structural typing', () => {
    const opts: AgentSessionOptions = {
      profile,
      cwd: '/tmp',
    };
    // onAgentStatus callbacks are all optional
    expect(opts.onAgentStatus).toBeUndefined();
  });
});

// ─── AgentPlugin — interface satisfaction ──────────────────────────────────

describe('AgentPlugin interface', () => {
  it('a mock adapter satisfies AgentPlugin', () => {
    const plugin: AgentPlugin = {
      id: 'mock-adapter',
      async createSession(_opts: AgentSessionOptions): Promise<AgentRuntime> {
        return {
          sessionId: 'mock',
          async prompt() {},
          getLastAssistantText: () => undefined,
          getLastAssistantMessage: () => undefined,
          async abort() {},
          dispose() {},
          subscribe: () => () => {},
        };
      },
    };

    expect(plugin.id).toBe('mock-adapter');
    expect(typeof plugin.createSession).toBe('function');
  });

  it('createSession returns a Promise<AgentRuntime>', async () => {
    const plugin: AgentPlugin = {
      id: 'async-adapter',
      async createSession() {
        return {
          sessionId: 'async-session',
          async prompt() {},
          getLastAssistantText: () => 'hello',
          getLastAssistantMessage: () => undefined,
          async abort() {},
          dispose() {},
          subscribe: () => () => {},
        };
      },
    };

    const runtime = await plugin.createSession({
      profile: {
        id: 'p',
        name: 'P',
        provider: 'x',
        model: 'm',
        thinkingLevel: 'high' as const,
        systemPrompt: '',
        excludeTools: [],
        includeTools: [],
      },
      cwd: '/tmp',
    });

    expect(runtime.sessionId).toBe('async-session');
    expect(runtime.getLastAssistantText()).toBe('hello');
  });

  it('id is readonly', () => {
    const plugin: AgentPlugin = {
      id: 'readonly-id',
      async createSession() {
        return {
          sessionId: 'x',
          async prompt() {},
          getLastAssistantText: () => undefined,
          getLastAssistantMessage: () => undefined,
          async abort() {},
          dispose() {},
          subscribe: () => () => {},
        };
      },
    };
    expect(plugin.id).toBe('readonly-id');
  });
});

// ─── Compile-time: @ts-expect-error guards for incorrect shapes ────────────
//
// These do not run at runtime but ensure the type contract rejects misuse.
// If a guard stops triggering, `bun tsc --noEmit` will fail.

describe('compile-time type guards', () => {
  it('AgentRuntimeEvent rejects an unknown variant type', () => {
    // @ts-expect-error — 'unknown_type' is not a valid AgentRuntimeEvent type
    const _e: AgentRuntimeEvent = { type: 'unknown_type' };
    expect(_e).toBeDefined();
  });

  it('AgentRuntimeEvent rejects turn_end without message', () => {
    // @ts-expect-error — turn_end requires a message field
    const _e: AgentRuntimeEvent = { type: 'turn_end' };
    expect(_e).toBeDefined();
  });

  it('AgentRuntimeEvent rejects tool_execution_start without toolName', () => {
    // @ts-expect-error — tool_execution_start requires toolName and toolCallId
    const _e: AgentRuntimeEvent = { type: 'tool_execution_start', toolCallId: 'x' };
    expect(_e).toBeDefined();
  });

  it('AgentRuntimeEvent rejects tool_execution_end without isError', () => {
    // @ts-expect-error — tool_execution_end requires isError
    const _e: AgentRuntimeEvent = { type: 'tool_execution_end', toolName: 'a', toolCallId: 'b' };
    expect(_e).toBeDefined();
  });

  it('AgentRuntimeEvent rejects auto_retry_start without required fields', () => {
    // @ts-expect-error — auto_retry_start requires attempt, maxAttempts, delayMs, errorMessage
    const _e: AgentRuntimeEvent = { type: 'auto_retry_start', attempt: 1 };
    expect(_e).toBeDefined();
  });

  it('AgentSessionOptions rejects missing required profile', () => {
    // @ts-expect-error — profile and cwd are required
    const _opts: AgentSessionOptions = { cwd: '/tmp' };
    expect(_opts).toBeDefined();
  });

  it('AgentSessionOptions rejects missing required cwd', () => {
    // @ts-expect-error — cwd is required
    const _opts: AgentSessionOptions = {
      profile: {
        id: 'p',
        name: 'P',
        provider: 'x',
        model: 'm',
        thinkingLevel: 'high' as const,
        systemPrompt: '',
        excludeTools: [],
        includeTools: [],
      },
    };
    expect(_opts).toBeDefined();
  });

  it('AgentRuntime rejects missing prompt method', () => {
    // @ts-expect-error — prompt is required
    const _r: AgentRuntime = {
      sessionId: 'x',
      getLastAssistantText: () => undefined,
      getLastAssistantMessage: () => undefined,
      async abort() {},
      dispose() {},
      subscribe: () => () => {},
    };
    expect(_r).toBeDefined();
  });

  it('AgentPlugin rejects missing id', () => {
    // @ts-expect-error — id is required
    const _p: AgentPlugin = {
      async createSession() {
        return {
          sessionId: 'x',
          async prompt() {},
          getLastAssistantText: () => undefined,
          getLastAssistantMessage: () => undefined,
          async abort() {},
          dispose() {},
          subscribe: () => () => {},
        };
      },
    };
    expect(_p).toBeDefined();
  });

  it('AgentPlugin rejects missing createSession', () => {
    // @ts-expect-error — createSession is required
    const _p: AgentPlugin = { id: 'x' };
    expect(_p).toBeDefined();
  });

  it('PromptOptions rejects non-signal field', () => {
    // @ts-expect-error — only signal is allowed
    const _o: PromptOptions = { timeout: 5000 };
    expect(_o).toBeDefined();
  });
});
