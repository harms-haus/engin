import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

import type { AgentPlugin, AgentRuntime, AgentSessionOptions } from '../../packages/engine/src/core/agent-plugin.js';
import { clearAgentPluginRegistry, registerAgentPlugin } from '../../packages/engine/src/core/agent-registry.js';
import type { AgentProfile } from '../../packages/engine/src/core/types.js';
import { makeMockSession } from '../helpers/make-session.js';

// Capture real modules before mocking so we can restore them in afterAll.
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.js'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../packages/engine/src/core/structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import {
  agentLoopUntil,
  parallelAgents,
  retryAgentUntil,
  sequentialAgents,
} from '../../packages/engine/src/core/agent-loop.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Plugin id used by every test config. Registered fresh in beforeEach. */
const TEST_PLUGIN_ID = 'test-agent';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a mock AgentRuntime whose getLastAssistantText follows `textFn`.
 * The returned object exposes the mock functions for inspection.
 */
function makeSession(textFn: (promptText: string) => string | undefined = () => 'ok'): {
  session: AgentRuntime & {
    prompt: ReturnType<typeof mock>;
    getLastAssistantText: ReturnType<typeof mock>;
    dispose: ReturnType<typeof mock>;
  };
} {
  const result = makeMockSession(textFn);
  return {
    session: result.session as unknown as AgentRuntime & {
      prompt: ReturnType<typeof mock>;
      getLastAssistantText: ReturnType<typeof mock>;
      dispose: ReturnType<typeof mock>;
    },
  };
}

const baseProfile: AgentProfile = {
  id: 'test-agent',
  name: 'Test Agent',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium',
  systemPrompt: 'You are a test agent.',
  excludeTools: [],
  includeTools: [],
};

function makeConfig(overrides?: Partial<AgentSessionOptions>): AgentSessionOptions {
  return {
    profile: { ...baseProfile, agent: TEST_PLUGIN_ID },
    cwd: '/tmp',
    ...overrides,
  };
}

/**
 * The mock plugin's `createSession`. Replaced per-test via
 * `mockCreateSession.mockImplementation(...)`.
 */
const mockCreateSession = mock() as ReturnType<typeof mock> & ((opts: AgentSessionOptions) => Promise<AgentRuntime>);

const testPlugin: AgentPlugin = {
  id: TEST_PLUGIN_ID,
  createSession: (opts) => mockCreateSession(opts),
};

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreateSession.mockReset();
  mockPromptForStructured.mockReset();
  // Default: create a plain mock session for every config.
  mockCreateSession.mockImplementation(async () => makeSession().session);
  registerAgentPlugin(testPlugin);
});

afterEach(() => {
  clearAgentPluginRegistry();
});

// ─── agentLoopUntil ────────────────────────────────────────────────────────

describe('agentLoopUntil', () => {
  it('returns on the first attempt when condition is immediately met', async () => {
    const { session } = makeSession(() => 'done');

    const result = await agentLoopUntil(
      session,
      () => 'hello',
      () => true,
    );

    expect(result).toEqual({ lastText: 'done', attempts: 1 });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledWith('hello');
  });

  it('loops until condition is met on a later attempt', async () => {
    let callCount = 0;
    const { session } = makeSession(() => {
      callCount++;
      return callCount < 3 ? 'not yet' : 'done now';
    });

    const result = await agentLoopUntil(
      session,
      (attempt) => `attempt-${attempt}`,
      (_text) => callCount >= 3,
    );

    expect(result).toEqual({ lastText: 'done now', attempts: 3 });
    expect(session.prompt).toHaveBeenCalledTimes(3);
    expect(session.prompt).toHaveBeenCalledWith('attempt-1');
    expect(session.prompt).toHaveBeenCalledWith('attempt-2');
    expect(session.prompt).toHaveBeenCalledWith('attempt-3');
  });

  it('passes lastText to promptFn on subsequent attempts', async () => {
    let callCount = 0;
    const { session } = makeSession(() => {
      callCount++;
      return callCount === 1 ? 'first' : 'second';
    });

    const prompts: { attempt: number; lastText?: string }[] = [];
    await agentLoopUntil(
      session,
      (attempt, lastText) => {
        prompts.push({ attempt, lastText });
        return 'go';
      },
      (_text) => callCount >= 2,
    );

    expect(prompts[0]).toEqual({ attempt: 1, lastText: undefined });
    expect(prompts[1]).toEqual({ attempt: 2, lastText: 'first' });
  });

  it('uses default maxAttempts of 10', async () => {
    const { session } = makeSession(() => 'nope');

    await expect(
      agentLoopUntil(
        session,
        () => 'test',
        () => false,
      ),
    ).rejects.toThrow(/condition not met after 10 attempts/);
    expect(session.prompt).toHaveBeenCalledTimes(10);
  });

  it('throws when maxAttempts is exceeded', async () => {
    const { session } = makeSession(() => 'nope');

    await expect(
      agentLoopUntil(
        session,
        () => 'test',
        () => false,
        { maxAttempts: 5 },
      ),
    ).rejects.toThrow(/condition not met after 5 attempts/);
    expect(session.prompt).toHaveBeenCalledTimes(5);
  });

  it('respects custom maxAttempts', async () => {
    const { session } = makeSession(() => 'ok');

    const result = await agentLoopUntil(
      session,
      () => 'test',
      () => true,
      { maxAttempts: 3 },
    );

    expect(result.attempts).toBe(1);
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });
});

// ─── retryAgentUntil ───────────────────────────────────────────────────────

describe('retryAgentUntil', () => {
  const schema = z.object({ name: z.string(), score: z.number() });

  it('delegates to promptForStructured and wraps result in AgentLoopResult', async () => {
    const session = { prompt: mock(), getLastAssistantText: mock() };
    const expectedResult = { name: 'Alice', score: 95 };
    mockPromptForStructured.mockResolvedValue({ result: expectedResult, attempts: 1 });

    const result = await retryAgentUntil(session, 'get a result', schema);

    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    expect(mockPromptForStructured).toHaveBeenCalledWith(session, 'get a result', schema, undefined);
    expect(result).toEqual({
      result: expectedResult,
      attempts: 1,
      totalTokens: { input: 0, output: 0 },
    });
  });

  it('passes maxRetries to promptForStructured', async () => {
    const session = { prompt: mock(), getLastAssistantText: mock() };
    mockPromptForStructured.mockResolvedValue({ result: { name: 'Bob', score: 80 }, attempts: 1 });

    await retryAgentUntil(session, 'prompt', schema, { maxRetries: 5 });

    expect(mockPromptForStructured).toHaveBeenCalledWith(session, 'prompt', schema, { maxRetries: 5 });
  });

  it('uses actual attempts from promptForStructured, not maxRetries config value', async () => {
    const session = { prompt: mock(), getLastAssistantText: mock() };
    // promptForStructured made 3 attempts before succeeding
    mockPromptForStructured.mockResolvedValue({ result: { name: 'C', score: 1 }, attempts: 3 });

    const result = await retryAgentUntil(session, 'p', schema, {
      maxRetries: 7,
    });

    // attempts should be 3 (actual attempts), NOT 7 (the maxRetries config)
    expect(result.attempts).toBe(3);
  });

  it('propagates errors from promptForStructured', async () => {
    const session = { prompt: mock(), getLastAssistantText: mock() };
    mockPromptForStructured.mockRejectedValue(new Error('Failed to produce structured output after 3 attempts'));

    await expect(retryAgentUntil(session, 'bad prompt', schema)).rejects.toThrow('Failed to produce structured output');
  });

  it('reports attempts=2 when promptForStructured retries once', async () => {
    const session = { prompt: mock(), getLastAssistantText: mock() };
    mockPromptForStructured.mockResolvedValue({ result: { name: 'D', score: 50 }, attempts: 2 });

    const result = await retryAgentUntil(session, 'p', schema);
    expect(result.attempts).toBe(2);
  });

  it('reports attempts=1 for first-try success regardless of maxRetries', async () => {
    const session = { prompt: mock(), getLastAssistantText: mock() };
    mockPromptForStructured.mockResolvedValue({ result: { name: 'E', score: 100 }, attempts: 1 });

    const result = await retryAgentUntil(session, 'p', schema, { maxRetries: 10 });
    // Even though maxRetries is 10, it only took 1 attempt
    expect(result.attempts).toBe(1);
  });

  it('reports attempts from promptForStructured when maxRetries is not provided', async () => {
    const session = { prompt: mock(), getLastAssistantText: mock() };
    mockPromptForStructured.mockResolvedValue({ result: { name: 'F', score: 75 }, attempts: 2 });

    const result = await retryAgentUntil(session, 'p', schema);
    // No maxRetries provided — attempts comes from promptForStructured, not the default 3
    expect(result.attempts).toBe(2);
  });
});

// ─── parallelAgents ────────────────────────────────────────────────────────

describe('parallelAgents', () => {
  it('creates sessions via the registered plugin and runs prompts in parallel', async () => {
    const config1 = makeConfig();
    const config2 = makeConfig();

    let sessionIndex = 0;
    mockCreateSession.mockImplementation(async () => {
      const idx = sessionIndex++;
      return makeSession((_text) => `response-${idx}`).session;
    });

    const results = await parallelAgents([config1, config2], (_session, i) => `prompt-${i}`);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');

    if (results[0].status === 'fulfilled') {
      expect(results[0].value).toBe('response-0');
    }
    if (results[1].status === 'fulfilled') {
      expect(results[1].value).toBe('response-1');
    }

    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(mockCreateSession).toHaveBeenCalledWith(config1);
    expect(mockCreateSession).toHaveBeenCalledWith(config2);
  });

  it('passes the AgentRuntime directly to promptFn (no .session wrapper)', async () => {
    const seen: AgentRuntime[] = [];
    const session = makeSession(() => 'ok').session;
    mockCreateSession.mockResolvedValue(session);

    await parallelAgents([makeConfig()], (s) => {
      seen.push(s);
      return 'test';
    });

    expect(seen[0]).toBe(session);
  });

  it('uses promptForStructured when schema is provided', async () => {
    const schema = z.object({ value: z.number() });
    mockPromptForStructured.mockResolvedValue({ result: { value: 42 }, attempts: 1 });

    const results = await parallelAgents<{ result: { value: number }; attempts: number }>(
      [makeConfig()],
      () => 'get value',
      { schema },
    );

    expect(results).toHaveLength(1);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe('fulfilled');
    if (results[0].status === 'fulfilled') {
      expect(results[0].value).toEqual({ result: { value: 42 }, attempts: 1 });
    }
  });

  it('handles mixed fulfilled and rejected results', async () => {
    let callCount = 0;
    mockCreateSession.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeSession(() => 'ok').session;
      }
      return makeSession(() => {
        throw new Error('failed');
      }).session;
    });

    const results = await parallelAgents([makeConfig(), makeConfig()], () => 'test');

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
  });

  it('passes promptFn result as the prompt text', async () => {
    const session = makeSession(() => 'ok').session;
    mockCreateSession.mockResolvedValue(session);

    await parallelAgents([makeConfig()], (_s, i) => `custom-prompt-${i}`);

    expect(session.prompt).toHaveBeenCalledWith('custom-prompt-0');
  });

  it('disposes every session in the finally block', async () => {
    const s0 = makeSession(() => 'ok').session;
    const s1 = makeSession(() => 'ok').session;
    mockCreateSession.mockResolvedValueOnce(s0).mockResolvedValueOnce(s1);

    await parallelAgents([makeConfig(), makeConfig()], () => 'test');

    expect(s0.dispose).toHaveBeenCalledTimes(1);
    expect(s1.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes sessions even when a prompt rejects', async () => {
    const s0 = makeSession(() => 'ok').session;
    const s1 = makeSession(() => 'ok').session;
    (s1.prompt as ReturnType<typeof mock>).mockRejectedValue(new Error('boom'));
    mockCreateSession.mockResolvedValueOnce(s0).mockResolvedValueOnce(s1);

    const results = await parallelAgents([makeConfig(), makeConfig()], () => 'test');

    // Promise.allSettled — failures surface as rejected entries.
    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    // Disposal still occurs for both.
    expect(s0.dispose).toHaveBeenCalledTimes(1);
    expect(s1.dispose).toHaveBeenCalledTimes(1);
  });
});

// ─── sequentialAgents ──────────────────────────────────────────────────────

describe('sequentialAgents', () => {
  it('preserves order of results', async () => {
    const configs = [makeConfig(), makeConfig(), makeConfig()];
    const callOrder: number[] = [];

    mockCreateSession.mockImplementation(async () => {
      return makeSession((text: string) => {
        const idx = parseInt(text.split('-')[1], 10);
        callOrder.push(idx);
        return `result-${idx}`;
      }).session;
    });

    const results = await sequentialAgents(configs, (_session, i) => `prompt-${i}`);

    expect(results).toHaveLength(3);
    // Each result should be the last assistant text string in order
    expect(results[0]).toBe('result-0');
    expect(results[1]).toBe('result-1');
    expect(results[2]).toBe('result-2');

    // Execution was sequential
    expect(callOrder).toEqual([0, 1, 2]);
  });

  it('throws on the first failure and stops', async () => {
    const configs = [makeConfig(), makeConfig(), makeConfig()];
    let callCount = 0;

    mockCreateSession.mockImplementation(async () => {
      return makeSession(() => {
        callCount++;
        if (callCount === 2) {
          throw new Error('second agent failed');
        }
        return 'ok';
      }).session;
    });

    await expect(sequentialAgents(configs, (_s, i) => `prompt-${i}`)).rejects.toThrow('second agent failed');

    // Should only have attempted 2 (first succeeded, second failed)
    expect(callCount).toBe(2);
  });

  it('uses promptForStructured when schema is provided', async () => {
    const schema = z.object({ answer: z.string() });
    mockPromptForStructured
      .mockResolvedValueOnce({ result: { answer: 'first' }, attempts: 1 })
      .mockResolvedValueOnce({ result: { answer: 'second' }, attempts: 1 });

    mockCreateSession.mockImplementation(async () => makeSession(() => 'ignored').session);

    const results = await sequentialAgents<{ result: { answer: string }; attempts: number }>(
      [makeConfig(), makeConfig()],
      (_s, i) => `question-${i}`,
      { schema },
    );

    expect(results).toEqual([
      { result: { answer: 'first' }, attempts: 1 },
      { result: { answer: 'second' }, attempts: 1 },
    ]);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(2);
  });

  it('creates and disposes a session for each config', async () => {
    const s0 = makeSession(() => 'ok').session;
    const s1 = makeSession(() => 'ok').session;
    mockCreateSession.mockResolvedValueOnce(s0).mockResolvedValueOnce(s1);

    await sequentialAgents([makeConfig(), makeConfig()], () => 'test');

    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(s0.dispose).toHaveBeenCalledTimes(1);
    expect(s1.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the session even when a prompt rejects and rethrows', async () => {
    const s0 = makeSession(() => 'ok').session;
    (s0.prompt as ReturnType<typeof mock>).mockRejectedValue(new Error('first agent crashed'));
    mockCreateSession.mockResolvedValueOnce(s0);

    await expect(sequentialAgents([makeConfig(), makeConfig(), makeConfig()], () => 'test')).rejects.toThrow(
      'first agent crashed',
    );

    // Disposed before rethrowing.
    expect(s0.dispose).toHaveBeenCalledTimes(1);
    // Only the first session was created.
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });
});

// ─── parallelAgents edge cases ─────────────────────────────────────────────

describe('parallelAgents edge cases', () => {
  it('returns empty array for empty configs', async () => {
    const results = await parallelAgents([], () => 'test');
    expect(results).toEqual([]);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('disposes already-created sessions when createSession throws for one config', async () => {
    const disposedSessions: string[] = [];
    const config1 = makeConfig();
    const config2 = makeConfig();
    const config3 = makeConfig();

    let sessionIndex = 0;
    mockCreateSession.mockImplementation(async (cfg: AgentSessionOptions) => {
      const idx = sessionIndex++;
      if (idx === 1) {
        throw new Error('session creation failed');
      }
      const inner = makeSession(() => 'ok').session;
      // Override dispose so we can track which sessions were rolled back.
      (inner as unknown as { dispose: ReturnType<typeof mock> }).dispose = mock(() => {
        disposedSessions.push(cfg.profile.id);
      });
      return inner;
    });

    await expect(parallelAgents([config1, config2, config3], () => 'test')).rejects.toThrow('session creation failed');

    // The first session should have been created and then disposed when the second failed
    expect(disposedSessions).toContain('test-agent');
    expect(disposedSessions.length).toBe(1);
  });
});

// ─── sequentialAgents edge cases ────────────────────────────────────────────

describe('sequentialAgents edge cases', () => {
  it('returns empty array for empty configs', async () => {
    const results = await sequentialAgents([], () => 'test');
    expect(results).toEqual([]);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});

// ─── agentIdPrefix passthrough ─────────────────────────────────────────────

describe('parallelAgents agentIdPrefix', () => {
  it('passes agentId as {prefix}-{index} to each createSession call', async () => {
    const configs = [makeConfig(), makeConfig(), makeConfig()];
    mockCreateSession.mockImplementation(async () => makeSession(() => 'ok').session);

    await parallelAgents(configs, () => 'test', { agentIdPrefix: 'worker' });

    const calls = mockCreateSession.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toMatchObject({ agentId: 'worker-0' });
    expect(calls[1][0]).toMatchObject({ agentId: 'worker-1' });
    expect(calls[2][0]).toMatchObject({ agentId: 'worker-2' });
  });

  it('does not modify configs when agentIdPrefix is absent', async () => {
    const configs = [makeConfig(), makeConfig()];
    mockCreateSession.mockImplementation(async () => makeSession(() => 'ok').session);

    await parallelAgents(configs, () => 'test');

    const calls = mockCreateSession.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).not.toHaveProperty('agentId');
    expect(calls[1][0]).not.toHaveProperty('agentId');
  });
});

describe('sequentialAgents agentIdPrefix', () => {
  it('passes agentId as {prefix}-{index} to each createSession call', async () => {
    const configs = [makeConfig(), makeConfig(), makeConfig()];
    mockCreateSession.mockImplementation(async () => makeSession(() => 'ok').session);

    await sequentialAgents(configs, () => 'test', { agentIdPrefix: 'step' });

    const calls = mockCreateSession.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toMatchObject({ agentId: 'step-0' });
    expect(calls[1][0]).toMatchObject({ agentId: 'step-1' });
    expect(calls[2][0]).toMatchObject({ agentId: 'step-2' });
  });

  it('does not modify configs when agentIdPrefix is absent', async () => {
    const configs = [makeConfig(), makeConfig()];
    mockCreateSession.mockImplementation(async () => makeSession(() => 'ok').session);

    await sequentialAgents(configs, () => 'test');

    const calls = mockCreateSession.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).not.toHaveProperty('agentId');
    expect(calls[1][0]).not.toHaveProperty('agentId');
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../packages/engine/src/core/structured-output.js', () => realStructuredOutput);
});
