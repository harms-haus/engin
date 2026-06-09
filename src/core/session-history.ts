// ─── Session History ────────────────────────────────────────────────────────
import {
    InMemorySessionRepo,
    JsonlSessionRepo,
    type Session,
    type SessionTreeEntry,
    type MessageEntry,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentHarness, AgentMessage } from "./types.ts";

// ─── SessionStats ───────────────────────────────────────────────────────────

export interface SessionStats {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    messageCount: number;
}

// ─── SessionHistory ─────────────────────────────────────────────────────────

export class SessionHistory {
    constructor(private session: Session) {}

    /**
     * Count the number of message entries in the session.
     */
    async getMessageCount(): Promise<number> {
        const entries = await this.session.getEntries();
        return entries.filter((e): e is MessageEntry => e.type === "message").length;
    }

    /**
     * Sum usage from assistant messages in session entries.
     */
    async getStats(): Promise<SessionStats> {
        const entries = await this.session.getEntries();
        const messageEntries = entries.filter(
            (e): e is MessageEntry => e.type === "message",
        );

        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCost = 0;

        for (const entry of messageEntries) {
            const msg = entry.message;
            if (msg && typeof msg === "object" && "role" in msg && msg.role === "assistant") {
                const usage = (msg as { usage?: { input: number; output: number; cost?: { total: number } } }).usage;
                if (usage) {
                    totalInputTokens += usage.input ?? 0;
                    totalOutputTokens += usage.output ?? 0;
                    totalCost += usage.cost?.total ?? 0;
                }
            }
        }

        return {
            totalInputTokens,
            totalOutputTokens,
            totalCost,
            messageCount: messageEntries.length,
        };
    }


}

/**
 * Resume a session by copying all message entries from `source` into `target`.
 */
export async function resumeSession(
    source: Session,
    target: AgentHarness,
): Promise<void> {
    const entries = await source.getEntries();
    const messageEntries = entries.filter(
        (e): e is MessageEntry => e.type === "message",
    );

    for (const entry of messageEntries) {
        await target.appendMessage(entry.message);
    }
}

/**
 * Create a resumable session backed by in-memory storage (no sessionId) or
 * JSONL file storage (with sessionId).
 */
export async function createResumableSession(
    cwd: string,
    sessionId?: string,
): Promise<{ session: Session; sessionId: string }> {
    if (sessionId) {
        const env = new NodeExecutionEnv({ cwd });
        const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: cwd });
        const session = await repo.create({ cwd, id: sessionId });
        const meta = await session.getMetadata();
        return { session, sessionId: meta.id };
    }

    const repo = new InMemorySessionRepo();
    const session = await repo.create();
    const meta = await session.getMetadata();
    return { session, sessionId: meta.id };
}

