import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { z } from "zod";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    AgentHarness,
    HarnessCreationOptions,
} from "../../src/core/types.ts";

// Capture real modules before mocking so we can restore them in afterAll.
const realHarnessFactory = Object.assign({}, await import("../../src/core/harness-factory.ts"));
const realStructuredOutput = Object.assign({}, await import("../../src/core/structured-output.ts"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module("../../src/core/harness-factory.ts", () => ({
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module("../../src/core/structured-output.ts", () => ({
    promptForStructured: (...args: unknown[]) =>
        mockPromptForStructured(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { createHarness } from "../../src/core/harness-factory.ts";
import { promptForStructured } from "../../src/core/structured-output.ts";
import {
    agentLoopUntil,
    retryAgentUntil,
    parallelAgents,
    sequentialAgents,
} from "../../src/core/agent-loop.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAssistantMessage(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: { id: "openai", name: "OpenAI" },
        model: "gpt-4",
        usage: {
            input: 10,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            total: 30,
        },
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

function makeHarness(promptFn: (text: string) => Promise<AssistantMessage>): {
    harness: AgentHarness;
    sessionId: string;
} {
    return {
        harness: { prompt: promptFn } as unknown as AgentHarness,
        sessionId: "test-session",
    };
}

function makeConfig(overrides?: Partial<HarnessCreationOptions>): HarnessCreationOptions {
    return {
        profile: {
            id: "test-agent",
            name: "Test Agent",
            provider: "openai",
            model: "gpt-4",
            thinkingLevel: "medium",
            systemPrompt: "You are a test agent.",
            excludeTools: [],
            includeTools: [],
        },
        cwd: "/tmp",
        ...overrides,
    };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mockCreateHarness.mockClear();
    mockPromptForStructured.mockClear();
});

// ─── agentLoopUntil ────────────────────────────────────────────────────────

describe("agentLoopUntil", () => {
    it("returns on the first attempt when condition is immediately met", async () => {
        const response = makeAssistantMessage("done");
        const harness = {
            prompt: mock(async () => response),
        };

        const result = await agentLoopUntil(
            harness,
            () => "hello",
            () => true,
        );

        expect(result).toEqual({ response, attempts: 1 });
        expect(harness.prompt).toHaveBeenCalledTimes(1);
        expect(harness.prompt).toHaveBeenCalledWith("hello");
    });

    it("loops until condition is met on a later attempt", async () => {
        const early = makeAssistantMessage("not yet");
        const final = makeAssistantMessage("done now");
        let callCount = 0;

        const harness = {
            prompt: mock(async () => {
                callCount++;
                return callCount < 3 ? early : final;
            }),
        };

        const result = await agentLoopUntil(
            harness,
            (attempt) => `attempt-${attempt}`,
            (_msg) => callCount >= 3,
        );

        expect(result).toEqual({ response: final, attempts: 3 });
        expect(harness.prompt).toHaveBeenCalledTimes(3);
        expect(harness.prompt).toHaveBeenCalledWith("attempt-1");
        expect(harness.prompt).toHaveBeenCalledWith("attempt-2");
        expect(harness.prompt).toHaveBeenCalledWith("attempt-3");
    });

    it("passes lastResponse to promptFn on subsequent attempts", async () => {
        const first = makeAssistantMessage("first");
        const second = makeAssistantMessage("second");
        let callCount = 0;

        const harness = {
            prompt: mock(async () => {
                callCount++;
                return callCount === 1 ? first : second;
            }),
        };

        const prompts: Array<{ attempt: number; lastResponse?: AssistantMessage }> = [];
        await agentLoopUntil(
            harness,
            (attempt, lastResponse) => {
                prompts.push({ attempt, lastResponse });
                return "go";
            },
            (_msg) => callCount >= 2,
        );

        expect(prompts[0]).toEqual({ attempt: 1, lastResponse: undefined });
        expect(prompts[1]).toEqual({ attempt: 2, lastResponse: first });
    });

    it("uses default maxAttempts of 10", async () => {
        const response = makeAssistantMessage("nope");
        const harness = {
            prompt: mock(async () => response),
        };

        await expect(
            agentLoopUntil(harness, () => "test", () => false),
        ).rejects.toThrow(/condition not met after 10 attempts/);
        expect(harness.prompt).toHaveBeenCalledTimes(10);
    });

    it("throws when maxAttempts is exceeded", async () => {
        const response = makeAssistantMessage("nope");
        const harness = {
            prompt: mock(async () => response),
        };

        await expect(
            agentLoopUntil(
                harness,
                () => "test",
                () => false,
                { maxAttempts: 5 },
            ),
        ).rejects.toThrow(/condition not met after 5 attempts/);
        expect(harness.prompt).toHaveBeenCalledTimes(5);
    });

    it("respects custom maxAttempts", async () => {
        const harness = {
            prompt: mock(async () => makeAssistantMessage("ok")),
        };

        const result = await agentLoopUntil(
            harness,
            () => "test",
            () => true,
            { maxAttempts: 3 },
        );

        expect(result.attempts).toBe(1);
        expect(harness.prompt).toHaveBeenCalledTimes(1);
    });
});

// ─── retryAgentUntil ───────────────────────────────────────────────────────

describe("retryAgentUntil", () => {
    const schema = z.object({ name: z.string(), score: z.number() });

    it("delegates to promptForStructured and wraps result in AgentLoopResult", async () => {
        const harness = { prompt: mock() };
        const expectedResult = { name: "Alice", score: 95 };
        mockPromptForStructured.mockResolvedValue(expectedResult);

        const result = await retryAgentUntil(harness, "get a result", schema);

        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
        expect(mockPromptForStructured).toHaveBeenCalledWith(
            harness,
            "get a result",
            schema,
            undefined,
        );
        expect(result).toEqual({
            result: expectedResult,
            attempts: 3,
            totalTokens: { input: 0, output: 0 },
        });
    });

    it("passes maxRetries to promptForStructured", async () => {
        const harness = { prompt: mock() };
        mockPromptForStructured.mockResolvedValue({ name: "Bob", score: 80 });

        await retryAgentUntil(harness, "prompt", schema, { maxRetries: 5 });

        expect(mockPromptForStructured).toHaveBeenCalledWith(
            harness,
            "prompt",
            schema,
            { maxRetries: 5 },
        );
    });

    it("reports correct attempts when maxRetries is custom", async () => {
        const harness = { prompt: mock() };
        mockPromptForStructured.mockResolvedValue({ name: "C", score: 1 });

        const result = await retryAgentUntil(harness, "p", schema, {
            maxRetries: 7,
        });

        expect(result.attempts).toBe(7);
    });

    it("propagates errors from promptForStructured", async () => {
        const harness = { prompt: mock() };
        mockPromptForStructured.mockRejectedValue(
            new Error("Failed to produce structured output after 3 attempts"),
        );

        await expect(
            retryAgentUntil(harness, "bad prompt", schema),
        ).rejects.toThrow("Failed to produce structured output");
    });
});

// ─── parallelAgents ────────────────────────────────────────────────────────

describe("parallelAgents", () => {
    beforeEach(() => {
        // Default: createHarness returns a mock harness for each config
        mockCreateHarness.mockImplementation(
            async (_config: HarnessCreationOptions) =>
                makeHarness(async () => makeAssistantMessage("default")),
        );
    });

    it("creates harnesses and runs prompts in parallel", async () => {
        const config1 = makeConfig();
        const config2 = makeConfig();

        let promptIndex = 0;
        mockCreateHarness.mockImplementation(async () => {
            const idx = promptIndex++;
            return makeHarness(async (text: string) =>
                makeAssistantMessage(`response-${idx}: ${text}`),
            );
        });

        const results = await parallelAgents(
            [config1, config2],
            (_harness, i) => `prompt-${i}`,
        );

        expect(results).toHaveLength(2);
        expect(results[0].status).toBe("fulfilled");
        expect(results[1].status).toBe("fulfilled");

        if (results[0].status === "fulfilled") {
            expect(results[0].value).toMatchObject({
                role: "assistant",
                content: [{ type: "text", text: expect.stringContaining("response-0") }],
            });
        }
        if (results[1].status === "fulfilled") {
            expect(results[1].value).toMatchObject({
                role: "assistant",
                content: [{ type: "text", text: expect.stringContaining("response-1") }],
            });
        }

        expect(mockCreateHarness).toHaveBeenCalledTimes(2);
        expect(mockCreateHarness).toHaveBeenCalledWith(config1);
        expect(mockCreateHarness).toHaveBeenCalledWith(config2);
    });

    it("uses promptForStructured when schema is provided", async () => {
        const schema = z.object({ value: z.number() });
        mockPromptForStructured.mockResolvedValue({ value: 42 });

        const results = await parallelAgents(
            [makeConfig()],
            () => "get value",
            { schema },
        );

        expect(results).toHaveLength(1);
        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
        expect(results[0].status).toBe("fulfilled");
        if (results[0].status === "fulfilled") {
            expect(results[0].value).toEqual({ value: 42 });
        }
    });

    it("handles mixed fulfilled and rejected results", async () => {
        mockCreateHarness.mockImplementation(async () => {
            return makeHarness(async () => {
                throw new Error("harness prompt failed");
            });
        });

        // Override first harness to succeed
        let callCount = 0;
        mockCreateHarness.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return makeHarness(async () => makeAssistantMessage("ok"));
            }
            return makeHarness(async () => {
                throw new Error("failed");
            });
        });

        const results = await parallelAgents(
            [makeConfig(), makeConfig()],
            () => "test",
        );

        expect(results).toHaveLength(2);
        expect(results[0].status).toBe("fulfilled");
        expect(results[1].status).toBe("rejected");
    });

    it("passes promptFn result as the prompt text", async () => {
        const harness = {
            prompt: mock(async () => makeAssistantMessage("ok")),
        };
        mockCreateHarness.mockResolvedValue(
            makeHarness(async () => makeAssistantMessage("ok")),
        );

        // Replace with the spy harness
        mockCreateHarness.mockResolvedValue({
            harness: harness as unknown as AgentHarness,
            sessionId: "s1",
        });

        await parallelAgents([makeConfig()], (_h, i) => `custom-prompt-${i}`);

        expect(harness.prompt).toHaveBeenCalledWith("custom-prompt-0");
    });
});

// ─── sequentialAgents ──────────────────────────────────────────────────────

describe("sequentialAgents", () => {
    it("preserves order of results", async () => {
        const configs = [makeConfig(), makeConfig(), makeConfig()];
        const callOrder: number[] = [];

        mockCreateHarness.mockImplementation(async () => {
            return makeHarness(async (text: string) => {
                const idx = parseInt(text.split("-")[1], 10);
                // Artificial delay ordering
                callOrder.push(idx);
                return makeAssistantMessage(`result-${idx}`);
            });
        });

        const results = await sequentialAgents(
            configs,
            (_harness, i) => `prompt-${i}`,
        );

        expect(results).toHaveLength(3);
        // Each result should be an AssistantMessage in order
        expect(results[0]).toMatchObject({
            content: [{ type: "text", text: expect.stringContaining("result-0") }],
        });
        expect(results[1]).toMatchObject({
            content: [{ type: "text", text: expect.stringContaining("result-1") }],
        });
        expect(results[2]).toMatchObject({
            content: [{ type: "text", text: expect.stringContaining("result-2") }],
        });

        // Execution was sequential
        expect(callOrder).toEqual([0, 1, 2]);
    });

    it("throws on the first failure and stops", async () => {
        const configs = [makeConfig(), makeConfig(), makeConfig()];
        let callCount = 0;

        mockCreateHarness.mockImplementation(async () => {
            return makeHarness(async () => {
                callCount++;
                if (callCount === 2) {
                    throw new Error("second agent failed");
                }
                return makeAssistantMessage("ok");
            });
        });

        await expect(
            sequentialAgents(configs, (_h, i) => `prompt-${i}`),
        ).rejects.toThrow("second agent failed");

        // Should only have attempted 2 (first succeeded, second failed)
        expect(callCount).toBe(2);
    });

    it("uses promptForStructured when schema is provided", async () => {
        const schema = z.object({ answer: z.string() });
        mockPromptForStructured
            .mockResolvedValueOnce({ answer: "first" })
            .mockResolvedValueOnce({ answer: "second" });

        mockCreateHarness.mockImplementation(async () => {
            return makeHarness(async () => makeAssistantMessage("ignored"));
        });

        const results = await sequentialAgents(
            [makeConfig(), makeConfig()],
            (_h, i) => `question-${i}`,
            { schema },
        );

        expect(results).toEqual([
            { answer: "first" },
            { answer: "second" },
        ]);
        expect(mockPromptForStructured).toHaveBeenCalledTimes(2);
    });

    it("creates all harnesses upfront via Promise.all", async () => {
        const configs = [makeConfig(), makeConfig()];
        mockCreateHarness.mockImplementation(async () =>
            makeHarness(async () => makeAssistantMessage("ok")),
        );

        await sequentialAgents(configs, () => "test");

        expect(mockCreateHarness).toHaveBeenCalledTimes(2);
    });

    it("throws on first failure without processing remaining agents", async () => {
        const configs = [makeConfig(), makeConfig(), makeConfig()];
        let promptCount = 0;

        mockCreateHarness.mockImplementation(async () => {
            return makeHarness(async () => {
                promptCount++;
                if (promptCount === 1) {
                    throw new Error("first agent crashed");
                }
                return makeAssistantMessage("ok");
            });
        });

        await expect(
            sequentialAgents(configs, () => "test"),
        ).rejects.toThrow("first agent crashed");

        expect(promptCount).toBe(1);
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("../../src/core/harness-factory.ts", () => realHarnessFactory);
    mock.module("../../src/core/structured-output.ts", () => realStructuredOutput);
});
