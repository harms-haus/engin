// ─── Agent Loop Utilities ──────────────────────────────────────────────────
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ZodType } from "zod";
import type {
    AgentHarness,
    AgentLoopResult,
    HarnessCreationOptions,
} from "./types";
import { createHarness } from "./harness-factory";
import {
    promptForStructured,
    type PromptableHarness,
} from "./structured-output";

// ─── agentLoopUntil ────────────────────────────────────────────────────────

export interface AgentLoopUntilOptions {
    maxAttempts?: number;
}

/**
 * Repeatedly prompt the harness until `conditionFn` returns `true` or
 * `maxAttempts` is exhausted.
 *
 * @param harness    Object with a `prompt(text)` method.
 * @param promptFn   Called with `(attempt, lastResponse?)` to build each prompt.
 * @param conditionFn  Return `true` to stop the loop.
 * @param options    `{ maxAttempts }` — default 10.
 * @returns The final response and the number of attempts made.
 */
export async function agentLoopUntil(
    harness: { prompt: (text: string) => Promise<AssistantMessage> },
    promptFn: (attempt: number, lastResponse?: AssistantMessage) => string,
    conditionFn: (response: AssistantMessage) => boolean,
    options?: AgentLoopUntilOptions,
): Promise<{ response: AssistantMessage; attempts: number }> {
    const maxAttempts = options?.maxAttempts ?? 10;
    let lastResponse: AssistantMessage | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const prompt = promptFn(attempt, lastResponse);
        lastResponse = await harness.prompt(prompt);
        if (conditionFn(lastResponse)) {
            return { response: lastResponse, attempts: attempt };
        }
    }

    throw new Error(
        `agentLoopUntil: condition not met after ${maxAttempts} attempts`,
    );
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
    harness: PromptableHarness,
    prompt: string,
    schema: ZodType<T>,
    options?: { maxRetries?: number },
): Promise<AgentLoopResult<T>> {
    const result = await promptForStructured(
        harness,
        prompt,
        schema,
        options?.maxRetries !== undefined
            ? { maxRetries: options.maxRetries }
            : undefined,
    );

    return {
        result,
        attempts: options?.maxRetries ?? 3,
        totalTokens: { input: 0, output: 0 },
    };
}

// ─── parallelAgents ────────────────────────────────────────────────────────

export interface ParallelAgentOptions {
    schema?: ZodType<any>;
    maxRetries?: number;
}

/**
 * Create harnesses for every config in parallel, then run prompts in parallel
 * via `Promise.allSettled`.
 *
 * When `options.schema` is provided each prompt is parsed through
 * {@link promptForStructured}; otherwise the raw `AssistantMessage` is returned.
 */
export async function parallelAgents<T = AssistantMessage>(
    configs: HarnessCreationOptions[],
    promptFn: (harness: AgentHarness, index: number) => string,
    options?: ParallelAgentOptions,
): Promise<PromiseSettledResult<T>[]> {
    // 1. Create harnesses
    const harnessResults = await Promise.all(
        configs.map((config) => createHarness(config)),
    );

    // 2. Run prompts
    const results = await Promise.allSettled(
        harnessResults.map(async ({ harness }, i) => {
            const prompt = promptFn(harness, i);
            if (options?.schema) {
                return promptForStructured(
                    harness,
                    prompt,
                    options.schema,
                    options.maxRetries !== undefined
                        ? { maxRetries: options.maxRetries }
                        : undefined,
                ) as Promise<T>;
            }
            return harness.prompt(prompt) as unknown as Promise<T>;
        }),
    );

    return results;
}

// ─── sequentialAgents ──────────────────────────────────────────────────────

export interface SequentialAgentOptions {
    schema?: ZodType<any>;
    maxRetries?: number;
}

/**
 * Create harnesses for every config in parallel, then run prompts
 * sequentially. Throws on the first failure.
 */
export async function sequentialAgents<T = AssistantMessage>(
    configs: HarnessCreationOptions[],
    promptFn: (harness: AgentHarness, index: number) => string,
    options?: SequentialAgentOptions,
): Promise<T[]> {
    // 1. Create harnesses
    const harnessResults = await Promise.all(
        configs.map((config) => createHarness(config)),
    );

    // 2. Run prompts sequentially
    const results: T[] = [];
    for (let i = 0; i < harnessResults.length; i++) {
        const { harness } = harnessResults[i];
        const prompt = promptFn(harness, i);
        if (options?.schema) {
            results.push(
                (await promptForStructured(
                    harness,
                    prompt,
                    options.schema,
                    options.maxRetries !== undefined
                        ? { maxRetries: options.maxRetries }
                        : undefined,
                )) as T,
            );
        } else {
            results.push(
                (await harness.prompt(prompt)) as unknown as T,
            );
        }
    }

    return results;
}
