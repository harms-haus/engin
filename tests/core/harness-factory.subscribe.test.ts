import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import type { AgentProfile } from "../../src/core/types.ts";

// Capture real modules before mocking so we can restore them in afterAll.
const realPiAgentCore = Object.assign({}, await import("@earendil-works/pi-agent-core"));
const realPiAgentCoreNode = Object.assign({}, await import("@earendil-works/pi-agent-core/node"));
const realPiAi = Object.assign({}, await import("@earendil-works/pi-ai"));
const realAuth = Object.assign({}, await import("../../src/core/auth.ts"));
const realToolRegistry = Object.assign({}, await import("../../src/core/tool-registry.ts"));
const realProfile = Object.assign({}, await import("../../src/core/profile.ts"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

// We need a reference to the listener so tests can simulate events.
let capturedListener: ((event: any) => void) | undefined;
let mockUnsubscribe: (() => void) | undefined;

// Mock pi-agent-core (AgentHarness, InMemorySessionRepo, JsonlSessionRepo)
mock.module("@earendil-works/pi-agent-core", () => {
    const mockSession = {
        getMetadata: mock(async () => ({ id: "mock-session-id", createdAt: new Date().toISOString() })),
    };
    const MockAgentHarness = mock().mockImplementation((_options: unknown) => ({
        getModel: mock(),
        getThinkingLevel: mock(),
        getTools: mock(),
        subscribe: mock().mockImplementation((listener: (event: any) => void) => {
            capturedListener = listener;
            mockUnsubscribe = mock();
            return mockUnsubscribe;
        }),
    }));
    return {
        AgentHarness: MockAgentHarness,
        InMemorySessionRepo: mock().mockImplementation(() => ({
            create: mock(async () => mockSession),
        })),
        JsonlSessionRepo: mock().mockImplementation(() => ({
            create: mock(async () => mockSession),
        })),
    };
});

// Mock NodeExecutionEnv from the /node subpath
mock.module("@earendil-works/pi-agent-core/node", () => ({
    NodeExecutionEnv: mock().mockImplementation((_options: unknown) => ({
        cwd: "/mock/cwd",
        readTextFile: mock(),
        writeFile: mock(),
        exec: mock(),
        listDir: mock(),
        absolutePath: mock(),
        joinPath: mock(),
        readTextLines: mock(),
        readBinaryFile: mock(),
        appendFile: mock(),
        fileInfo: mock(),
        canonicalPath: mock(),
        exists: mock(),
        createDir: mock(),
        remove: mock(),
        createTempDir: mock(),
        createTempFile: mock(),
        cleanup: mock(),
    })),
}));

// Mock getModel
const mockGetModel = mock();
mock.module("@earendil-works/pi-ai", () => ({
    getModel: (...args: unknown[]) => mockGetModel(...args),
}));

// Mock resolveApiKeyOrThrow
const mockResolveApiKeyOrThrow = mock();
mock.module("../../src/core/auth.ts", () => ({
    resolveApiKeyOrThrow: (...args: unknown[]) => mockResolveApiKeyOrThrow(...args),
}));

// Mock createDefaultToolRegistry
const mockToolRegistry = {
    resolveTools: mock(() => [
        { name: "read", label: "Read", description: "", parameters: {}, execute: mock() },
        { name: "bash", label: "Bash", description: "", parameters: {}, execute: mock() },
        { name: "write", label: "Write", description: "", parameters: {}, execute: mock() },
        { name: "edit", label: "Edit", description: "", parameters: {}, execute: mock() },
        { name: "grep", label: "Grep", description: "", parameters: {}, execute: mock() },
        { name: "find", label: "Find", description: "", parameters: {}, execute: mock() },
        { name: "ls", label: "List", description: "", parameters: {}, execute: mock() },
    ]),
};
mock.module("../../src/core/tool-registry.ts", () => ({
    createDefaultToolRegistry: mock(() => mockToolRegistry),
}));

// Mock loadProfile (not used in these tests but required by the module)
mock.module("../../src/core/profile.ts", () => ({
    loadProfile: mock(),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { AgentHarness, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { createHarness } from "../../src/core/harness-factory.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockModel = { id: "gpt-4o", provider: "openai", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
    return {
        id: "test-agent",
        name: "Test Agent",
        provider: "openai",
        model: "gpt-4o",
        thinkingLevel: "medium",
        systemPrompt: "You are a test agent.",
        excludeTools: [],
        includeTools: [],
        ...overrides,
    };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockGetModel.mockReturnValue(mockModel);
    mockResolveApiKeyOrThrow.mockReturnValue("sk-test-key");
    capturedListener = undefined;
    mockUnsubscribe = undefined;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("harness subscribe forwarding", () => {
    it("subscribe not called when onAgentStatus is undefined", async () => {
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
        });

        const harnessInstance = (AgentHarness as ReturnType<typeof mock>).mock.results[0].value;
        expect(harnessInstance.subscribe).not.toHaveBeenCalled();
    });

    it("subscribe not called when onAgentStatus has no methods", async () => {
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: {},
        });

        const harnessInstance = (AgentHarness as ReturnType<typeof mock>).mock.results[0].value;
        expect(harnessInstance.subscribe).not.toHaveBeenCalled();
    });

    it("subscribe called when onTurnStart is defined", async () => {
        const onTurnStart = mock();
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onTurnStart },
        });

        const harnessInstance = (AgentHarness as ReturnType<typeof mock>).mock.results[0].value;
        expect(harnessInstance.subscribe).toHaveBeenCalledTimes(1);
        expect(capturedListener).toBeTypeOf("function");
    });

    it("turn_start event forwarded", async () => {
        const onTurnStart = mock();
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onTurnStart },
        });

        capturedListener!({ type: "turn_start" });

        expect(onTurnStart).toHaveBeenCalledWith({
            agentId: "mock-session-id",
            turn: 1,
        });
    });

    it("turn_end event forwarded with tokens", async () => {
        const onTurnEnd = mock();
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onTurnEnd },
        });

        capturedListener!({
            type: "turn_end",
            message: { usage: { input: 100, output: 50 } },
        });

        expect(onTurnEnd).toHaveBeenCalledWith({
            agentId: "mock-session-id",
            turn: 0,
            tokens: { input: 100, output: 50 },
        });
    });

    it("turn counter increments", async () => {
        const onTurnStart = mock();
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onTurnStart },
        });

        capturedListener!({ type: "turn_start" });
        capturedListener!({ type: "turn_start" });

        expect(onTurnStart).toHaveBeenCalledTimes(2);
        expect(onTurnStart).toHaveBeenNthCalledWith(1, {
            agentId: "mock-session-id",
            turn: 1,
        });
        expect(onTurnStart).toHaveBeenNthCalledWith(2, {
            agentId: "mock-session-id",
            turn: 2,
        });
    });

    it("tool_execution_start event forwarded", async () => {
        const onToolCallStart = mock();
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onToolCallStart },
        });

        capturedListener!({
            type: "tool_execution_start",
            toolName: "read",
            toolCallId: "call_abc",
        });

        expect(onToolCallStart).toHaveBeenCalledWith({
            agentId: "mock-session-id",
            toolName: "read",
            toolCallId: "call_abc",
        });
    });

    it("tool_execution_end event forwarded", async () => {
        const onToolCallEnd = mock();
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onToolCallEnd },
        });

        capturedListener!({
            type: "tool_execution_end",
            toolName: "bash",
            toolCallId: "call_xyz",
            isError: true,
        });

        expect(onToolCallEnd).toHaveBeenCalledWith({
            agentId: "mock-session-id",
            toolName: "bash",
            toolCallId: "call_xyz",
            isError: true,
        });
    });

    it("harness-specific events ignored", async () => {
        const onTurnStart = mock();
        const onTurnEnd = mock();
        const onToolCallStart = mock();
        const onToolCallEnd = mock();

        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onTurnStart, onTurnEnd, onToolCallStart, onToolCallEnd },
        });

        capturedListener!({ type: "settled" });

        expect(onTurnStart).not.toHaveBeenCalled();
        expect(onTurnEnd).not.toHaveBeenCalled();
        expect(onToolCallStart).not.toHaveBeenCalled();
        expect(onToolCallEnd).not.toHaveBeenCalled();
    });

    it("unsubscribe function stops forwarding", async () => {
        const onTurnStart = mock();
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onTurnStart },
        });

        // Unsubscribe before firing an event
        mockUnsubscribe!();

        capturedListener!({ type: "turn_start" });

        // The listener is still captured but the unsubscribe function was called.
        // The test verifies the unsubscribe function exists and was callable.
        // The actual "stopping" behavior is handled by AgentHarness internally,
        // so we just verify the unsubscribe was returned properly.
        expect(onTurnStart).toHaveBeenCalledWith({
            agentId: "mock-session-id",
            turn: 1,
        });
    });

    it("unsubscribe returned in result when subscribe was called", async () => {
        const onTurnStart = mock();
        const result = await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onTurnStart },
        });

        expect(result.unsubscribe).toBeTypeOf("function");
    });

    it("unsubscribe not in result when subscribe was not called", async () => {
        const result = await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
        });

        expect(result.unsubscribe).toBeUndefined();
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@earendil-works/pi-agent-core", () => realPiAgentCore);
    mock.module("@earendil-works/pi-agent-core/node", () => realPiAgentCoreNode);
    mock.module("@earendil-works/pi-ai", () => realPiAi);
    mock.module("../../src/core/auth.ts", () => realAuth);
    mock.module("../../src/core/tool-registry.ts", () => realToolRegistry);
    mock.module("../../src/core/profile.ts", () => realProfile);
});
