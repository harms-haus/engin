// ─── Tests for runWithValidationRetry (core/validation-retry.ts) ────────────
//
// These are test-first specs for the helper extracted from the `validateOutput`
// branch of `runStepTask` (packages/engine/src/core/phase-tasks.ts) and the
// equivalent branch of `runMultiStepTask`.
//
// The contract under test:
//
//   export async function runWithValidationRetry(
//     session: { prompt(text: string): Promise<void>; getLastAssistantText(): string | undefined },
//     prompt: string,
//     validateOutput: () =>
//       | Promise<{ error?: string } | undefined>
//       | ({ error?: string } | undefined),
//     maxAttempts?: number,
//   ): Promise<string>
//
// Behaviour (mirrors the inline loop it replaces):
//   - The first turn always sends the BARE `prompt`.
//   - On a validation error, the next turn re-prompts within the SAME session
//     using `buildValidationRetryPrompt(prompt, error)` (imported from
//     ../pool/prompt-builder.js).
//   - `validateOutput` is called once per turn, AFTER the prompt.
//   - Acceptance: `validateOutput` returns `undefined` or `{}` (no `error`) →
//     the loop breaks and the last assistant text is returned.
//   - Exhaustion: after `maxAttempts` turns (default 3) the last error is still
//     set → throws `Error("Agent output failed validation after N attempts: E")`.
//   - Returns `session.getLastAssistantText()`.

import { describe, expect, it, mock } from 'bun:test';
import { runWithValidationRetry } from '../../packages/engine/src/core/validation-retry.js';

// ─── Mock session helper ────────────────────────────────────────────────────
//
// The function under test accepts a NARROW session interface (just `prompt` and
// `getLastAssistantText`). We build a spy-backed mock that records every prompt
// call and lets each test control what `getLastAssistantText` returns.

interface MockSession {
  prompt: ReturnType<typeof mock> & ((text: string) => Promise<void>);
  getLastAssistantText: ReturnType<typeof mock> & (() => string | undefined);
}

function makeSession(textFn: (promptText: string) => string | undefined = () => 'output'): MockSession {
  let lastText: string | undefined;
  return {
    prompt: mock(async (text: string) => {
      lastText = textFn(text);
    }),
    getLastAssistantText: mock(() => lastText),
  };
}

// ─── Default prompt + first-turn behaviour ──────────────────────────────────

describe('runWithValidationRetry — first turn', () => {
  it('sends the bare prompt on the first turn', async () => {
    const session = makeSession();
    const validateOutput = mock(() => undefined);

    await runWithValidationRetry(session, 'Do the thing', validateOutput);

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledWith('Do the thing');
  });

  it('does not append validation feedback to the first turn prompt', async () => {
    const session = makeSession();
    const validateOutput = mock(() => undefined);

    await runWithValidationRetry(session, 'base prompt', validateOutput);

    const sentText = (session.prompt.mock.calls[0] as unknown[])[0] as string;
    expect(sentText).toBe('base prompt');
    expect(sentText).not.toContain('Previous attempt failed validation');
  });

  it('accepts on the first attempt and never re-prompts', async () => {
    const session = makeSession();
    const validateOutput = mock(() => undefined);

    await runWithValidationRetry(session, 'prompt', validateOutput);

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(validateOutput).toHaveBeenCalledTimes(1);
  });
});

// ─── Retry prompt construction ──────────────────────────────────────────────

describe('runWithValidationRetry — retry prompt', () => {
  it('re-prompts within the SAME session with buildValidationRetryPrompt on failure', async () => {
    const session = makeSession();
    let calls = 0;
    const validateOutput = mock(() => {
      calls++;
      // Fail once, then accept.
      return calls < 2 ? { error: 'plan missing' } : undefined;
    });

    await runWithValidationRetry(session, 'Do the thing', validateOutput);

    // 2 turns: initial + 1 retry.
    expect(session.prompt).toHaveBeenCalledTimes(2);
    const prompts = (session.prompt.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(prompts[0]).toBe('Do the thing'); // first attempt is the bare prompt
    expect(prompts[1]).toContain('Previous attempt failed validation');
    expect(prompts[1]).toContain('plan missing');
  });

  it('appends the most recent error to each subsequent retry prompt', async () => {
    const session = makeSession();
    let calls = 0;
    const validateOutput = mock(() => {
      calls++;
      // Fail twice with different errors, then accept.
      if (calls === 1) return { error: 'first error' };
      if (calls === 2) return { error: 'second error' };
      return undefined;
    });

    await runWithValidationRetry(session, 'base', validateOutput);

    expect(session.prompt).toHaveBeenCalledTimes(3);
    const prompts = (session.prompt.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(prompts[0]).toBe('base');
    expect(prompts[1]).toContain('first error');
    expect(prompts[2]).toContain('second error');
  });

  it('keeps the original prompt text in the retry prompt', async () => {
    const session = makeSession();
    let calls = 0;
    const validateOutput = mock(() => (calls++ < 0 ? { error: 'bad' } : undefined));

    await runWithValidationRetry(session, 'ORIGINAL PROMPT', validateOutput);

    const prompts = (session.prompt.mock.calls as unknown[][]).map((c) => c[0] as string);
    // Every retry prompt must retain the original prompt text.
    for (const p of prompts) {
      expect(p).toContain('ORIGINAL PROMPT');
    }
  });
});

// ─── Acceptance conditions ──────────────────────────────────────────────────

describe('runWithValidationRetry — acceptance', () => {
  it('treats validateOutput returning undefined as acceptance', async () => {
    const session = makeSession();
    const validateOutput = mock(() => undefined);

    await runWithValidationRetry(session, 'p', validateOutput);

    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it('treats validateOutput returning an empty object {} as acceptance', async () => {
    const session = makeSession();
    const validateOutput = mock(() => ({}));

    await runWithValidationRetry(session, 'p', validateOutput);

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(validateOutput).toHaveBeenCalledTimes(1);
  });

  it('stops retrying as soon as validateOutput passes', async () => {
    const session = makeSession();
    let calls = 0;
    const validateOutput = mock(() => {
      calls++;
      // Fail once then pass.
      return calls < 2 ? { error: 'nope' } : undefined;
    });

    await runWithValidationRetry(session, 'p', validateOutput);

    // Exactly 2 turns — does NOT run a third turn after acceptance.
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(validateOutput).toHaveBeenCalledTimes(2);
  });

  it('supports an async validateOutput returning a Promise', async () => {
    const session = makeSession();
    let calls = 0;
    const validateOutput = mock(async () => {
      calls++;
      await Promise.resolve();
      return calls < 2 ? { error: 'async fail' } : undefined;
    });

    await runWithValidationRetry(session, 'p', validateOutput);

    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(validateOutput).toHaveBeenCalledTimes(2);
  });

  it('supports a validateOutput that returns a Promise of an empty object', async () => {
    const session = makeSession();
    const validateOutput = mock(async () => {
      await Promise.resolve();
      return {};
    });

    await runWithValidationRetry(session, 'p', validateOutput);

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(validateOutput).toHaveBeenCalledTimes(1);
  });
});

// ─── Exhaustion / throwing ──────────────────────────────────────────────────

describe('runWithValidationRetry — exhaustion', () => {
  it('throws after the default 3 attempts when validation never passes', async () => {
    const session = makeSession();
    const validateOutput = mock(() => ({ error: 'invalid schema' }));

    await expect(runWithValidationRetry(session, 'p', validateOutput)).rejects.toThrow(
      /failed validation after 3 attempts: invalid schema/,
    );

    expect(session.prompt).toHaveBeenCalledTimes(3);
    expect(validateOutput).toHaveBeenCalledTimes(3);
  });

  it('includes the LAST validation error in the thrown message', async () => {
    const session = makeSession();
    let calls = 0;
    const validateOutput = mock(() => {
      calls++;
      return { error: `err-${calls}` };
    });

    let caught: unknown;
    try {
      await runWithValidationRetry(session, 'p', validateOutput);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // The last error (err-3) is the one surfaced, not err-1.
    expect(message).toContain('err-3');
    expect(message).not.toContain('err-1');
    expect(message).toMatch(/failed validation after 3 attempts/);
  });

  it('uses the provided maxAttempts when supplied', async () => {
    const session = makeSession();
    const validateOutput = mock(() => ({ error: 'always bad' }));

    await expect(runWithValidationRetry(session, 'p', validateOutput, 2)).rejects.toThrow(
      /failed validation after 2 attempts: always bad/,
    );

    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(validateOutput).toHaveBeenCalledTimes(2);
  });

  it('runs exactly one turn when maxAttempts is 1', async () => {
    const session = makeSession();
    const validateOutput = mock(() => ({ error: 'fail' }));

    await expect(runWithValidationRetry(session, 'p', validateOutput, 1)).rejects.toThrow(
      /failed validation after 1 attempts: fail/,
    );

    // Only the first (bare) prompt — no retry prompt is ever built.
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(validateOutput).toHaveBeenCalledTimes(1);
    const sentText = (session.prompt.mock.calls[0] as unknown[])[0] as string;
    expect(sentText).toBe('p');
  });

  it('succeeds within a custom maxAttempts when validation passes in time', async () => {
    const session = makeSession();
    let calls = 0;
    const validateOutput = mock(() => {
      calls++;
      // Fail once, accept on the second — within the 5-attempt budget.
      return calls < 2 ? { error: 'try again' } : undefined;
    });

    const result = await runWithValidationRetry(session, 'p', validateOutput, 5);

    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(result).toBe('output');
  });
});

// ─── Return value ───────────────────────────────────────────────────────────

describe('runWithValidationRetry — return value', () => {
  it('returns the session last assistant text on success', async () => {
    const session = makeSession(() => 'final answer');
    const validateOutput = mock(() => undefined);

    const result = await runWithValidationRetry(session, 'p', validateOutput);

    expect(result).toBe('final answer');
    expect(session.getLastAssistantText).toHaveBeenCalled();
  });

  it('returns the text from the LAST turn after retries', async () => {
    let turn = 0;
    const session = makeSession(() => `attempt-${++turn}`);
    let calls = 0;
    const validateOutput = mock(() => {
      calls++;
      return calls < 3 ? { error: 'no' } : undefined;
    });

    const result = await runWithValidationRetry(session, 'p', validateOutput);

    // 3 turns; last assistant text is from the 3rd.
    expect(session.prompt).toHaveBeenCalledTimes(3);
    expect(result).toBe('attempt-3');
  });

  it('returns a string typed as Promise<string>', async () => {
    const session = makeSession(() => 'text');
    const result: string = await runWithValidationRetry(session, 'p', () => undefined);
    expect(typeof result).toBe('string');
  });
});

// ─── Per-turn ordering ──────────────────────────────────────────────────────

describe('runWithValidationRetry — per-turn ordering', () => {
  it('calls prompt then validateOutput on each turn (validateOutput runs after the prompt)', async () => {
    const session = makeSession();
    const order: string[] = [];
    const realPrompt = session.prompt;
    session.prompt = mock(async (text: string) => {
      order.push('prompt');
      // delegate to the recorded behaviour so lastText is still set
      await realPrompt(text);
    }) as unknown as MockSession['prompt'];
    const validateOutput = mock(() => {
      order.push('validate');
      return undefined;
    });

    await runWithValidationRetry(session, 'p', validateOutput);

    expect(order).toEqual(['prompt', 'validate']);
  });

  it('calls validateOutput exactly once per turn', async () => {
    const session = makeSession();
    let calls = 0;
    const validateOutput = mock(() => {
      calls++;
      return calls < 2 ? { error: 'x' } : undefined;
    });

    await runWithValidationRetry(session, 'p', validateOutput);

    // 2 turns → 2 validateOutput calls.
    expect(validateOutput).toHaveBeenCalledTimes(2);
  });
});
