import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuditEvent } from "../core/types.js";

function isEnoentError(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "ENOENT"
    );
}

export class AuditLog {
    private readonly logPath: string;
    private cache: AuditEvent[] | null = null;

    constructor(private readonly logDir: string) {
        this.logPath = path.join(logDir, "audit.jsonl");
    }

    async append(event: Omit<AuditEvent, "timestamp">): Promise<void> {
        await fs.mkdir(this.logDir, { recursive: true });

        const record = {
            ...event,
            timestamp: new Date().toISOString(),
        } as AuditEvent;

        await fs.appendFile(this.logPath, JSON.stringify(record) + "\n", "utf-8");
        this.cache = null;
    }

    async getEvents(filter?: { taskId?: string; type?: string }): Promise<AuditEvent[]> {
        if (this.cache === null) {
            let content: string;
            try {
                content = await fs.readFile(this.logPath, "utf-8");
            } catch (err: unknown) {
                if (isEnoentError(err)) {
                    this.cache = [];
                } else {
                    throw err;
                }
            }

            if (this.cache === null) {
                const events: AuditEvent[] = [];
                for (const line of content!.split("\n")) {
                    if (line.trim() === "") continue;
                    try {
                        events.push(JSON.parse(line) as AuditEvent);
                    } catch {
                        console.warn(`Skipping malformed JSONL line: ${line.slice(0, 100)}`);
                    }
                }
                this.cache = events;
            }
        }

        let filtered = this.cache;

        if (filter?.type) {
            filtered = filtered.filter((e) => e.type === filter.type);
        }

        if (filter?.taskId) {
            filtered = filtered.filter((e) => e.taskId === filter.taskId);
        }

        return filtered;
    }

    async getEventsByTask(taskId: string): Promise<AuditEvent[]> {
        return this.getEvents({ taskId });
    }

    async getStats(): Promise<{ totalEvents: number; totalCost: number; totalTokens: number }> {
        const allEvents = await this.getEvents();
        const agentEndEvents = (await this.getEvents({ type: "agent_end" })).filter(
            (e): e is Extract<AuditEvent, { type: "agent_end" }> => e.type === "agent_end",
        );
        const events = allEvents;

        let totalCost = 0;
        let totalTokens = 0;

        for (const event of agentEndEvents) {
            const result = event.result as Record<string, unknown> | undefined;
            if (result && typeof result === "object") {
                if (typeof result.cost === "number") {
                    totalCost += result.cost;
                }
                if (typeof result.tokens === "number") {
                    totalTokens += result.tokens;
                }
            }
        }

        return {
            totalEvents: events.length,
            totalCost,
            totalTokens,
        };
    }

    async clear(): Promise<void> {
        try {
            await fs.unlink(this.logPath);
        } catch (err: unknown) {
            if (!isEnoentError(err)) throw err;
        }
        this.cache = null;
    }
}
