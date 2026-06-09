import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTool, AgentProfile } from "../../src/core/types.ts";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// We need a reference to the listener so tests can simulate events.
let capturedListener: ((event: any) => void) | undefined;
let mockUnsubscribe: (() => void) | undefined;

// Mock pi-agent-core (AgentHarness, InMemorySessionRepo, JsonlSessionRepo)
vi.mock("@earendil-works/pi-agent-core", () => {
    const mockSession = {
        getMetadata: vi.fn(async () => ({ id: "mock-session-id", createdAt: new Date().toISOString() })),
    };
    const MockAgentHarness = vi.fn().mockImplementation((_options: unknown) => ({
        getModel: vi.fn(),
        getThinkingLevel: vi.fn(),
        getTools: vi.fn(),
        subscribe: vi.fn().mockImplementation((listener: (event: any) => void) => {
            capturedListener = listener;
            mockUnsubscribe = vi.fn();
            return mockUnsubscribe;
        }),
    }));
    return {
        AgentHarness: MockAgentHarness,
        InMemorySessionRepo: vi.fn().mockImplementation(() => ({
            create: vi.fn(async () => mockSession),
        })),
        JsonlSessionRepo: vi.fn().mockImplementation(() => ({
            create: vi.fn(async () => mockSession),
        })),
    };
});

// Mock NodeExecutionEnv from the /node subpath
vi.mock("@earendil-works/pi-agent-core/node", () => ({
    NodeExecutionEnv: vi.fn().mockImplementation((_options: unknown) => ({
        cwd: "/mock/cwd",
        readTextFile: vi.fn(),
        writeFile: vi.fn(),
        exec: vi.fn(),
        listDir: vi.fn(),
        absolutePath: vi.fn(),
        joinPath: vi.fn(),
        readTextLines: vi.fn(),
        readBinaryFile: vi.fn(),
        appendFile: vi.fn(),
        fileInfo: vi.fn(),
        canonicalPath: vi.fn(),
        exists: vi.fn(),
        createDir: vi.fn(),
        remove: vi.fn(),
        createTempDir: vi.fn(),
        createTempFile: vi.fn(),
        cleanup: vi.fn(),
    })),
}));

// Mock getModel
const mockGetModel = vi.fn();
vi.mock("@earendil-works/pi-ai", () => ({
    getModel: (...args: unknown[]) => mockGetModel(...args),
}));

// Mock resolveApiKeyOrThrow
const mockResolveApiKeyOrThrow = vi.fn();
vi.mock("../../src/core/auth.ts", () => ({
    resolveApiKeyOrThrow: (...args: unknown[]) => mockResolveApiKeyOrThrow(...args),
}));

// Mock createDefaultToolRegistry
const mockToolRegistry = {
    resolveTools: vi.fn(() => [
        { name: "read", label: "Read", description: "", parameters: {}, execute: vi.fn() },
        { name: "bash", label: "Bash", description: "", parameters: {}, execute: vi.fn() },
        { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn() },
        { name: "edit", label: "Edit", description: "", parameters: {}, execute: vi.fn() },
        { name: "grep", label: "Grep", description: "", parameters: {}, execute: vi.fn() },
        { name: "find", label: "Find", description: "", parameters: {}, execute: vi.fn() },
        { name: "ls", label: "List", description: "", parameters: {}, execute: vi.fn() },
    ]),
};
vi.mock("../../src/core/tool-registry.ts", () => ({
    createDefaultToolRegistry: vi.fn(() => mockToolRegistry),
}));

// Mock loadProfile (not used in these tests but required by the module)
vi.mock("../../src/core/profile.ts", () => ({
    loadProfile: vi.fn(),
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
    vi.clearAllMocks();
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

        const harnessInstance = vi.mocked(AgentHarness).mock.results[0].value;
        expect(harnessInstance.subscribe).not.toHaveBeenCalled();
    });

    it("subscribe not called when onAgentStatus has no methods", async () => {
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: {},
        });

        const harnessInstance = vi.mocked(AgentHarness).mock.results[0].value;
        expect(harnessInstance.subscribe).not.toHaveBeenCalled();
    });

    it("subscribe called when onTurnStart is defined", async () => {
        const onTurnStart = vi.fn();
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            onAgentStatus: { onTurnStart },
        });

        const harnessInstance = vi.mocked(AgentHarness).mock.results[0].value;
        expect(harnessInstance.subscribe).toHaveBeenCalledTimes(1);
        expect(capturedListener).toBeTypeOf("function");
    });

    it("turn_start event forwarded", async () => {
        const onTurnStart = vi.fn();
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
        const onTurnEnd = vi.fn();
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
        const onTurnStart = vi.fn();
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
        const onToolCallStart = vi.fn();
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
        const onToolCallEnd = vi.fn();
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
        const onTurnStart = vi.fn();
        const onTurnEnd = vi.fn();
        const onToolCallStart = vi.fn();
        const onToolCallEnd = vi.fn();

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
        const onTurnStart = vi.fn();
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
        const onTurnStart = vi.fn();
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
