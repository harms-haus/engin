import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    SessionHistory,
    resumeSession,
    createResumableSession,
} from "../../src/core/session-history.ts";
import type { Session, AgentHarness, AgentMessage } from "../../src/core/types.ts";
import type { MessageEntry, SessionTreeEntry } from "@earendil-works/pi-agent-core";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMessageEntry(message: AgentMessage): MessageEntry {
    return {
        type: "message",
        id: `entry-${Math.random().toString(36).slice(2, 8)}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message,
    };
}

function makeNonMessageEntry(type: string): SessionTreeEntry {
    return {
        type,
        id: `entry-${Math.random().toString(36).slice(2, 8)}`,
        parentId: null,
        timestamp: new Date().toISOString(),
    } as SessionTreeEntry;
}

function makeAssistantMessage(
    overrides: Partial<{ input: number; output: number; costTotal: number }> = {},
): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
        api: "openai-completions",
        provider: { id: "openai", name: "OpenAI" },
        model: "gpt-4",
        usage: {
            input: overrides.input ?? 100,
            output: overrides.output ?? 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: overrides.costTotal ?? 0.001,
            },
        },
        stopReason: "stop",
        timestamp: Date.now(),
    } as unknown as AgentMessage;
}

function makeUserMessage(content: string): AgentMessage {
    return {
        role: "user",
        content,
        timestamp: Date.now(),
    } as unknown as AgentMessage;
}

function mockSession(entries: SessionTreeEntry[]): Session {
    return {
        getEntries: vi.fn(async () => entries),
    } as unknown as Session;
}

function mockHarness(): AgentHarness & { appended: AgentMessage[] } {
    const appended: AgentMessage[] = [];
    return {
        appended,
        appendMessage: vi.fn(async (msg: AgentMessage) => {
            appended.push(msg);
        }),
    } as unknown as AgentHarness & { appended: AgentMessage[] };
}

// ─── SessionHistory ─────────────────────────────────────────────────────────

describe("SessionHistory", () => {
    describe("getMessageCount", () => {
        it("returns 0 for an empty session", async () => {
            const session = mockSession([]);
            const history = new SessionHistory(session);
            expect(await history.getMessageCount()).toBe(0);
        });

        it("counts only message entries", async () => {
            const entries: SessionTreeEntry[] = [
                makeMessageEntry(makeUserMessage("hello")),
                makeNonMessageEntry("compaction"),
                makeMessageEntry(makeAssistantMessage()),
                makeNonMessageEntry("model_change"),
                makeMessageEntry(makeUserMessage("world")),
            ];
            const session = mockSession(entries);
            const history = new SessionHistory(session);
            expect(await history.getMessageCount()).toBe(3);
        });

        it("returns 0 when there are only non-message entries", async () => {
            const entries: SessionTreeEntry[] = [
                makeNonMessageEntry("compaction"),
                makeNonMessageEntry("thinking_level_change"),
            ];
            const session = mockSession(entries);
            const history = new SessionHistory(session);
            expect(await history.getMessageCount()).toBe(0);
        });
    });

    describe("getStats", () => {
        it("returns zeros for an empty session", async () => {
            const session = mockSession([]);
            const history = new SessionHistory(session);
            const stats = await history.getStats();
            expect(stats).toEqual({
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCost: 0,
                messageCount: 0,
            });
        });

        it("sums usage from assistant messages only", async () => {
            const entries: SessionTreeEntry[] = [
                makeMessageEntry(makeUserMessage("q1")),
                makeMessageEntry(makeAssistantMessage({ input: 100, output: 50, costTotal: 0.01 })),
                makeMessageEntry(makeUserMessage("q2")),
                makeMessageEntry(makeAssistantMessage({ input: 200, output: 80, costTotal: 0.02 })),
            ];
            const session = mockSession(entries);
            const history = new SessionHistory(session);
            const stats = await history.getStats();

            expect(stats.totalInputTokens).toBe(300);
            expect(stats.totalOutputTokens).toBe(130);
            expect(stats.totalCost).toBeCloseTo(0.03);
            expect(stats.messageCount).toBe(4);
        });

        it("ignores non-message entries in usage calculation", async () => {
            const entries: SessionTreeEntry[] = [
                makeMessageEntry(makeAssistantMessage({ input: 100, output: 50, costTotal: 0.01 })),
                makeNonMessageEntry("compaction"),
                makeNonMessageEntry("model_change"),
            ];
            const session = mockSession(entries);
            const history = new SessionHistory(session);
            const stats = await history.getStats();

            expect(stats.totalInputTokens).toBe(100);
            expect(stats.totalOutputTokens).toBe(50);
            expect(stats.totalCost).toBeCloseTo(0.01);
            expect(stats.messageCount).toBe(1);
        });

        it("handles user and toolResult messages without usage", async () => {
            const toolResultMsg = {
                role: "toolResult",
                toolCallId: "tc-1",
                toolName: "bash",
                content: [{ type: "text", text: "output" }],
                isError: false,
                timestamp: Date.now(),
            } as unknown as AgentMessage;

            const entries: SessionTreeEntry[] = [
                makeMessageEntry(makeUserMessage("question")),
                makeMessageEntry(toolResultMsg),
                makeMessageEntry(makeAssistantMessage({ input: 50, output: 25, costTotal: 0.005 })),
            ];
            const session = mockSession(entries);
            const history = new SessionHistory(session);
            const stats = await history.getStats();

            expect(stats.totalInputTokens).toBe(50);
            expect(stats.totalOutputTokens).toBe(25);
            expect(stats.totalCost).toBeCloseTo(0.005);
            expect(stats.messageCount).toBe(3);
        });

        it("handles assistant messages with zero usage", async () => {
            const entries: SessionTreeEntry[] = [
                makeMessageEntry(makeAssistantMessage({ input: 0, output: 0, costTotal: 0 })),
            ];
            const session = mockSession(entries);
            const history = new SessionHistory(session);
            const stats = await history.getStats();

            expect(stats.totalInputTokens).toBe(0);
            expect(stats.totalOutputTokens).toBe(0);
            expect(stats.totalCost).toBe(0);
            expect(stats.messageCount).toBe(1);
        });
    });

});

// ─── resumeSession ──────────────────────────────────────────────────────────

describe("resumeSession", () => {
    it("copies all message entries from source to target harness", async () => {
        const msg1 = makeUserMessage("hello");
        const msg2 = makeAssistantMessage({ input: 10, output: 5, costTotal: 0.001 });
        const entries: SessionTreeEntry[] = [
            makeMessageEntry(msg1),
            makeNonMessageEntry("compaction"),
            makeMessageEntry(msg2),
        ];
        const source = mockSession(entries);
        const target = mockHarness();

        await resumeSession(source, target);

        expect(target.appendMessage).toHaveBeenCalledTimes(2);
        expect(target.appended[0]).toBe(msg1);
        expect(target.appended[1]).toBe(msg2);
    });

    it("does nothing when source has no message entries", async () => {
        const entries: SessionTreeEntry[] = [
            makeNonMessageEntry("compaction"),
            makeNonMessageEntry("model_change"),
        ];
        const source = mockSession(entries);
        const target = mockHarness();

        await resumeSession(source, target);

        expect(target.appendMessage).not.toHaveBeenCalled();
        expect(target.appended).toHaveLength(0);
    });

    it("does nothing when source session is empty", async () => {
        const source = mockSession([]);
        const target = mockHarness();

        await resumeSession(source, target);

        expect(target.appendMessage).not.toHaveBeenCalled();
    });

    it("preserves message ordering from source", async () => {
        const msgs = Array.from({ length: 5 }, (_, i) =>
            i % 2 === 0
                ? makeUserMessage(`q-${i}`)
                : makeAssistantMessage({ input: i * 10, output: i * 5, costTotal: i * 0.001 }),
        );
        const entries = msgs.map((m) => makeMessageEntry(m));
        const source = mockSession(entries);
        const target = mockHarness();

        await resumeSession(source, target);

        expect(target.appended).toHaveLength(5);
        for (let i = 0; i < msgs.length; i++) {
            expect(target.appended[i]).toBe(msgs[i]);
        }
    });
});

// ─── createResumableSession ─────────────────────────────────────────────────

describe("createResumableSession", () => {
    it("creates an in-memory session when no sessionId is provided", async () => {
        const { session, sessionId } = await createResumableSession("/tmp/test");

        expect(sessionId).toBeTruthy();
        expect(typeof sessionId).toBe("string");
        expect(sessionId.length).toBeGreaterThan(0);

        // In-memory session should start empty
        const entries = await session.getEntries();
        expect(entries).toEqual([]);
    });

    it("returns a usable Session object", async () => {
        const { session } = await createResumableSession("/tmp/test");

        // Should be able to append a message
        const msg = makeUserMessage("test message");
        const entryId = await session.appendMessage(msg);
        expect(entryId).toBeTruthy();

        // And retrieve it
        const entries = await session.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].type).toBe("message");
    });

    it("creates unique sessionIds for successive in-memory calls", async () => {
        const result1 = await createResumableSession("/tmp/test");
        const result2 = await createResumableSession("/tmp/test");

        expect(result1.sessionId).not.toBe(result2.sessionId);
    });

    it("preserves a provided sessionId for jsonl sessions", async () => {
        // Use a temp directory for the jsonl session
        const fs = await import("node:fs/promises");
        const os = await import("node:os");
        const path = await import("node:path");
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-test-"));

        try {
            const customId = "my-custom-session-id";
            const { session, sessionId } = await createResumableSession(tmpDir, customId);

            expect(sessionId).toBe(customId);

            // Should be able to append and read back
            const msg = makeUserMessage("resumable message");
            await session.appendMessage(msg);
            const entries = await session.getEntries();
            expect(entries).toHaveLength(1);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it("creates unique ids when no sessionId is provided for jsonl", async () => {
        const fs = await import("node:fs/promises");
        const os = await import("node:os");
        const path = await import("node:path");
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-test-"));

        try {
            const result1 = await createResumableSession(tmpDir);
            const result2 = await createResumableSession(tmpDir);

            expect(result1.sessionId).not.toBe(result2.sessionId);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });
});
