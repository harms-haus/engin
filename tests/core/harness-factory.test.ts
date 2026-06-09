import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import type { AgentTool, AgentProfile } from "../../src/core/types.ts";

// Capture real modules before mocking so we can restore them in afterAll.
const realPiAgentCore = Object.assign({}, await import("@earendil-works/pi-agent-core"));
const realPiAgentCoreNode = Object.assign({}, await import("@earendil-works/pi-agent-core/node"));
const realPiAi = Object.assign({}, await import("@earendil-works/pi-ai"));
const realAuth = Object.assign({}, await import("../../src/core/auth.ts"));
const realToolRegistry = Object.assign({}, await import("../../src/core/tool-registry.ts"));
const realProfile = Object.assign({}, await import("../../src/core/profile.ts"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock pi-agent-core (AgentHarness, InMemorySessionRepo, JsonlSessionRepo)
mock.module("@earendil-works/pi-agent-core", () => {
    const mockSession = {
        getMetadata: mock(async () => ({ id: "mock-session-id", createdAt: new Date().toISOString() })),
    };
    const MockAgentHarness = mock().mockImplementation((_options: unknown) => ({
        getModel: mock(),
        getThinkingLevel: mock(),
        getTools: mock(),
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

// Mock loadProfile
const mockLoadProfile = mock();
mock.module("../../src/core/profile.ts", () => ({
    loadProfile: (...args: unknown[]) => mockLoadProfile(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { AgentHarness, InMemorySessionRepo, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createDefaultToolRegistry } from "../../src/core/tool-registry.ts";
import { createHarness, createHarnessFromProfile } from "../../src/core/harness-factory.ts";

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
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createHarness", () => {
    it("creates a NodeExecutionEnv with the given cwd", async () => {
        await createHarness({
            profile: makeProfile(),
            cwd: "/my/project",
        });

        expect(NodeExecutionEnv).toHaveBeenCalledWith({ cwd: "/my/project" });
    });

    it("creates an InMemorySessionRepo when sessionId is omitted", async () => {
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
        });

        expect(InMemorySessionRepo).toHaveBeenCalled();
        expect(JsonlSessionRepo).not.toHaveBeenCalled();
    });

    it("creates a JsonlSessionRepo when sessionId is provided", async () => {
        const result = await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            sessionId: "my-session",
        });

        expect(JsonlSessionRepo).toHaveBeenCalled();
        expect(InMemorySessionRepo).not.toHaveBeenCalled();
        expect(result.sessionId).toBe("my-session");
    });

    it("resolves model via getModel and throws on unknown model", async () => {
        mockGetModel.mockReturnValue(undefined);

        await expect(
            createHarness({
                profile: makeProfile({ provider: "unknown", model: "nonexistent" }),
                cwd: "/tmp",
            }),
        ).rejects.toThrow(/Unknown model "nonexistent" for provider "unknown"/);

        expect(mockGetModel).toHaveBeenCalledWith("unknown", "nonexistent");
    });

    it("passes the resolved model to AgentHarness", async () => {
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
        });

        expect(mockGetModel).toHaveBeenCalledWith("openai", "gpt-4o");
        expect(AgentHarness).toHaveBeenCalledWith(
            expect.objectContaining({ model: mockModel }),
        );
    });

    it("resolves API key via resolveApiKeyOrThrow", async () => {
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            apiKeys: { openai: "sk-custom" },
        });

        expect(mockResolveApiKeyOrThrow).toHaveBeenCalledWith("openai", { openai: "sk-custom" });
    });

    it("passes apiKey via getApiKeyAndHeaders callback", async () => {
        mockResolveApiKeyOrThrow.mockReturnValue("sk-resolved");

        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
        });

        const harnessOptions = (AgentHarness as ReturnType<typeof mock>).mock.calls[0][0];
        const getApiKeyAndHeaders = harnessOptions.getApiKeyAndHeaders!;
        const result = await getApiKeyAndHeaders(mockModel as never);

        expect(result).toEqual({ apiKey: "sk-resolved" });
    });

    it("passes thinkingLevel from profile to AgentHarness", async () => {
        await createHarness({
            profile: makeProfile({ thinkingLevel: "high" }),
            cwd: "/tmp",
        });

        expect(AgentHarness).toHaveBeenCalledWith(
            expect.objectContaining({ thinkingLevel: "high" }),
        );
    });

    it("passes systemPrompt from profile to AgentHarness", async () => {
        await createHarness({
            profile: makeProfile({ systemPrompt: "Custom system prompt." }),
            cwd: "/tmp",
        });

        expect(AgentHarness).toHaveBeenCalledWith(
            expect.objectContaining({ systemPrompt: "Custom system prompt." }),
        );
    });

    it("passes env to AgentHarness", async () => {
        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
        });

        expect(AgentHarness).toHaveBeenCalledWith(
            expect.objectContaining({ env: expect.anything() }),
        );
    });

    it("creates default tool registry and resolves tools from profile", async () => {
        await createHarness({
            profile: makeProfile({
                includeTools: ["read", "bash"],
                excludeTools: ["ls"],
            }),
            cwd: "/tmp",
        });

        expect(createDefaultToolRegistry).toHaveBeenCalled();
        expect(mockToolRegistry.resolveTools).toHaveBeenCalledWith(
            ["read", "bash"],
            ["ls"],
        );
    });

    it("appends additionalTools to resolved tools", async () => {
        const extraTool: AgentTool = {
            name: "custom_tool",
            label: "Custom",
            description: "A custom tool",
            parameters: { type: "object", properties: {} },
            execute: mock(),
        };

        await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
            additionalTools: [extraTool],
        });

        const harnessOptions = (AgentHarness as ReturnType<typeof mock>).mock.calls[0][0];
        const tools = harnessOptions.tools!;
        const toolNames = tools.map((t: AgentTool) => t.name);

        expect(toolNames).toContain("custom_tool");
        // The 7 defaults + 1 extra
        expect(tools.length).toBe(8);
    });

    it("returns harness and sessionId", async () => {
        const result = await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
        });

        expect(result).toHaveProperty("harness");
        expect(result).toHaveProperty("sessionId");
        expect(typeof result.sessionId).toBe("string");
    });

    it("returns mock-session-id as sessionId for in-memory sessions", async () => {
        const result = await createHarness({
            profile: makeProfile(),
            cwd: "/tmp",
        });

        expect(result.sessionId).toBe("mock-session-id");
    });
});

// ─── createHarnessFromProfile ───────────────────────────────────────────────

describe("createHarnessFromProfile", () => {
    it("loads profile and delegates to createHarness", async () => {
        const profile = makeProfile({ id: "loaded-agent", provider: "anthropic", model: "claude-sonnet-4-20250514" });
        mockLoadProfile.mockResolvedValue(profile);
        mockGetModel.mockReturnValue({ ...mockModel, provider: "anthropic" });

        await createHarnessFromProfile("/profiles", "loaded-agent", {
            cwd: "/tmp",
        });

        expect(mockLoadProfile).toHaveBeenCalledWith("/profiles", "loaded-agent");
        expect(mockGetModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-20250514");
    });

    it("propagates loadProfile errors", async () => {
        mockLoadProfile.mockRejectedValue(new Error('Profile "missing" not found'));

        await expect(
            createHarnessFromProfile("/profiles", "missing", { cwd: "/tmp" }),
        ).rejects.toThrow('Profile "missing" not found');
    });

    it("passes all options through to createHarness", async () => {
        const profile = makeProfile();
        mockLoadProfile.mockResolvedValue(profile);

        const extraTool: AgentTool = {
            name: "extra",
            label: "Extra",
            description: "",
            parameters: {},
            execute: mock(),
        };

        await createHarnessFromProfile("/profiles", "test-agent", {
            cwd: "/my/project",
            apiKeys: { openai: "sk-from-profile" },
            additionalTools: [extraTool],
        });

        expect(mockResolveApiKeyOrThrow).toHaveBeenCalledWith("openai", { openai: "sk-from-profile" });

        const harnessOptions = (AgentHarness as ReturnType<typeof mock>).mock.calls[0][0];
        const toolNames = harnessOptions.tools!.map((t: AgentTool) => t.name);
        expect(toolNames).toContain("extra");
    });

    it("returns harness and sessionId", async () => {
        mockLoadProfile.mockResolvedValue(makeProfile());

        const result = await createHarnessFromProfile("/profiles", "test-agent", {
            cwd: "/tmp",
        });

        expect(result).toHaveProperty("harness");
        expect(result).toHaveProperty("sessionId");
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
