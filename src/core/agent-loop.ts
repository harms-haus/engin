// ─── Agent Loop Utilities ──────────────────────────────────────────────────
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ZodType } from 'zod';
import { createHarness } from './harness-factory';
import { promptForStructured, type PromptableHarness } from './structured-output';
import type { AgentLoopResult, HarnessCreationOptions } from './types.js';

// ─── agentLoopUntil ────────────────────────────────────────────────────────

export interface AgentLoopUntilOptions {
  maxAttempts?: number;
}

/**
 * Repeatedly prompt the session until `conditionFn` returns `true` or
 * `maxAttempts` is exhausted.
 *
 * @param session    Object with `prompt(text)` and `getLastAssistantText()` methods.
 * @param promptFn   Called with `(attempt, lastText?)` to build each prompt.
 * @param conditionFn  Return `true` to stop the loop. Receives the last assistant text.
 * @param options    `{ maxAttempts }` — default 10.
 * @returns The final text and the number of attempts made.
 */
export async function agentLoopUntil(
  session: { prompt: (text: string) => Promise<void>; getLastAssistantText: () => string | undefined },
  promptFn: (attempt: number, lastText?: string) => string,
  conditionFn: (lastText: string | undefined) => boolean,
  options?: AgentLoopUntilOptions,
): Promise<{ lastText: string | undefined; attempts: number }> {
  const maxAttempts = options?.maxAttempts ?? 10;
  let lastText: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = promptFn(attempt, lastText);
    await session.prompt(prompt);
    lastText = session.getLastAssistantText();
    if (conditionFn(lastText)) {
      return { lastText, attempts: attempt };
    }
  }

  throw new Error(`agentLoopUntil: condition not met after ${maxAttempts} attempts`);
}

// ─── retryAgentUntil ───────────────────────────────────────────────────────

/**
 * Convenience wrapper around {@link promptForStructured} that returns an
 * {@link AgentLoopResult} envelope.
 *
 * Token tracking is not available through this wrapper; `totalTokens` is
 * set to zero.
 */
export async function retryAgentUntil<T>(
  session: PromptableHarness,
  prompt: string,
  schema: ZodType<T>,
  options?: { maxRetries?: number },
): Promise<AgentLoopResult<T>> {
  const result = await promptForStructured(
    session,
    prompt,
    schema,
    options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : undefined,
  );

  return {
    result,
    attempts: options?.maxRetries ?? 3,
    totalTokens: { input: 0, output: 0 },
  };
}

// ─── parallelAgents ────────────────────────────────────────────────────────

export interface ParallelAgentOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema?: ZodType<any>;
  maxRetries?: number;
}

/**
 * Create sessions for every config in parallel, then run prompts in parallel
 * via `Promise.allSettled`.
 *
 * When `options.schema` is provided each prompt is parsed through
 * {@link promptForStructured}; otherwise the last assistant text is returned.
 */
export async function parallelAgents<T = string | undefined>(
  configs: HarnessCreationOptions[],
  promptFn: (session: AgentSession, index: number) => string,
  options?: ParallelAgentOptions,
): Promise<PromiseSettledResult<T>[]> {
  // 1. Create sessions
  const sessionResults = await Promise.all(configs.map((config) => createHarness(config)));

  // 2. Run prompts
  try {
    const results = await Promise.allSettled(
      sessionResults.map(async ({ session }, i) => {
        const prompt = promptFn(session, i);
        if (options?.schema) {
          return promptForStructured(
            session,
            prompt,
            options.schema,
            options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : undefined,
          ) as Promise<T>;
        }
        await session.prompt(prompt);
        return session.getLastAssistantText() as unknown as T;
      }),
    );

    return results;
  } finally {
    for (const result of sessionResults) {
      result.dispose?.();
    }
  }
}

// ─── sequentialAgents ──────────────────────────────────────────────────────

export interface SequentialAgentOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema?: ZodType<any>;
  maxRetries?: number;
}

/**
 * Create sessions for every config in parallel, then run prompts
 * sequentially. Throws on the first failure.
 */
export async function sequentialAgents<T = string | undefined>(
  configs: HarnessCreationOptions[],
  promptFn: (session: AgentSession, index: number) => string,
  options?: SequentialAgentOptions,
): Promise<T[]> {
  // 1. Create sessions
  const sessionResults = await Promise.all(configs.map((config) => createHarness(config)));

  // 2. Run prompts sequentially
  try {
    const results: T[] = [];
    for (let i = 0; i < sessionResults.length; i++) {
      const { session } = sessionResults[i];
      const prompt = promptFn(session, i);
      if (options?.schema) {
        results.push(
          (await promptForStructured(
            session,
            prompt,
            options.schema,
            options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : undefined,
          )) as T,
        );
      } else {
        await session.prompt(prompt);
        results.push(session.getLastAssistantText() as unknown as T);
      }
    }

    return results;
  } finally {
    for (const result of sessionResults) {
      result.dispose?.();
    }
  }
}
