// ─── Agent Loop Utilities ──────────────────────────────────────────────────
import type { ZodType } from 'zod';
import type { AgentRuntime, AgentSessionOptions } from './agent-plugin.js';
import { requireAgentPlugin } from './agent-registry.js';
import { promptForStructured, type PromptableHarness } from './structured-output.js';
import type { AgentLoopResult } from './types.js';

// ─── Internal Helpers ─────────────────────────────────────────────────────

/**
 * Inject an `agentId` of the form `{prefix}-{index}` into a config when a
 * prefix is provided; otherwise return the config unchanged.
 */
function resolveConfig(cfg: AgentSessionOptions, prefix: string | undefined, index: number): AgentSessionOptions {
  return prefix ? { ...cfg, agentId: `${prefix}-${index}` } : cfg;
}

/**
 * Create sessions for every config sequentially, rolling back any
 * already-created sessions if one fails.
 */
async function createSessionsWithCleanup(configs: AgentSessionOptions[]): Promise<AgentRuntime[]> {
  const results: AgentRuntime[] = [];
  try {
    for (const config of configs) {
      const plugin = requireAgentPlugin(config.profile.agent);
      results.push(await plugin.createSession(config));
    }
  } catch (err) {
    for (const r of results) {
      r.dispose?.();
    }
    throw err;
  }
  return results;
}

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
  session: PromptableHarness,
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
  const { result, attempts } = await promptForStructured(
    session,
    prompt,
    schema,
    options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : undefined,
  );

  return {
    result,
    attempts,
    // Token tracking not available via PromptableHarness interface
    totalTokens: { input: 0, output: 0 },
  };
}

// ─── parallelAgents / sequentialAgents shared options ─────────────────────

export interface MultiAgentOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema?: ZodType<any>;
  maxRetries?: number;
  agentIdPrefix?: string;
}

// ─── parallelAgents ────────────────────────────────────────────────────────

/**
 * Create sessions for every config in parallel, then run prompts in parallel
 * via `Promise.allSettled`.
 *
 * When `options.schema` is provided each prompt is parsed through
 * {@link promptForStructured}; otherwise the last assistant text is returned.
 */
export async function parallelAgents<T = string | undefined>(
  configs: AgentSessionOptions[],
  promptFn: (session: AgentRuntime, index: number) => string,
  options?: MultiAgentOptions,
): Promise<PromiseSettledResult<T>[]> {
  // 0. Inject agentId prefix into configs if provided
  const resolvedConfigs = configs.map((cfg, i) => resolveConfig(cfg, options?.agentIdPrefix, i));

  // 1. Create sessions sequentially so partial failures dispose already-created sessions
  const sessions = await createSessionsWithCleanup(resolvedConfigs);

  // 2. Run prompts
  try {
    const results = await Promise.allSettled(
      sessions.map(async (session, i) => {
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
    for (const session of sessions) {
      session.dispose?.();
    }
  }
}

// ─── sequentialAgents ──────────────────────────────────────────────────────

/**
 * Create sessions one at a time, run prompts sequentially, and dispose
 * each session after use. Throws on the first failure.
 */
export async function sequentialAgents<T = string | undefined>(
  configs: AgentSessionOptions[],
  promptFn: (session: AgentRuntime, index: number) => string,
  options?: MultiAgentOptions,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < configs.length; i++) {
    const config = resolveConfig(configs[i], options?.agentIdPrefix, i);
    const plugin = requireAgentPlugin(config.profile.agent);
    const session = await plugin.createSession(config);
    try {
      const promptText = promptFn(session, i);
      if (options?.schema) {
        results.push(
          (await promptForStructured(
            session,
            promptText,
            options.schema,
            options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : undefined,
          )) as T,
        );
      } else {
        await session.prompt(promptText);
        results.push(session.getLastAssistantText() as unknown as T);
      }
    } finally {
      session.dispose?.();
    }
  }
  return results;
}
