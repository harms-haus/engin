import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { AuditLog } from "../../src/tracking/audit-log.js";

function tmpDir(): string {
    return path.join(os.tmpdir(), `audit-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("AuditLog", () => {
    let dir: string;
    let log: AuditLog;

    beforeEach(() => {
        dir = tmpDir();
        log = new AuditLog(dir);
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    // ── append ──────────────────────────────────────────────────────────

    it("append writes a JSONL line with timestamp", async () => {
        await log.append({ type: "agent_start", agentId: "a1", profile: {} as never });

        const raw = await fs.readFile(path.join(dir, "audit.jsonl"), "utf-8");
        const record = JSON.parse(raw.trim());

        expect(record.type).toBe("agent_start");
        expect(record.agentId).toBe("a1");
        expect(record.timestamp).toBeDefined();
        expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
    });

    it("append creates directory if missing", async () => {
        const nested = path.join(dir, "deep", "nested");
        const nestedLog = new AuditLog(nested);

        await nestedLog.append({ type: "error", agentId: "e1", error: "boom" });

        const raw = await fs.readFile(path.join(nested, "audit.jsonl"), "utf-8");
        const record = JSON.parse(raw.trim());

        expect(record.type).toBe("error");
    });

    // ── getEvents ───────────────────────────────────────────────────────

    it("getEvents reads back all events", async () => {
        await log.append({ type: "agent_start", agentId: "a1", profile: {} as never });
        await log.append({ type: "agent_end", agentId: "a1", result: { cost: 0.5 } });
        await log.append({ type: "error", agentId: "a2", error: "fail" });

        const events = await log.getEvents();
        expect(events).toHaveLength(3);
        expect(events.map((e) => e.type)).toEqual(["agent_start", "agent_end", "error"]);
    });

    it("getEvents with type filter", async () => {
        await log.append({ type: "agent_start", agentId: "a1", profile: {} as never });
        await log.append({ type: "agent_end", agentId: "a1", result: {} });
        await log.append({ type: "agent_end", agentId: "a2", result: {} });

        const ends = await log.getEvents({ type: "agent_end" });
        expect(ends).toHaveLength(2);
        expect(ends.every((e) => e.type === "agent_end")).toBe(true);
    });

    it("getEvents with taskId filter", async () => {
        await log.append({
            type: "agent_start",
            agentId: "a1",
            profile: {} as never,
            taskId: "task-1",
        });
        await log.append({
            type: "agent_start",
            agentId: "a2",
            profile: {} as never,
            taskId: "task-2",
        });
        await log.append({
            type: "agent_end",
            agentId: "a1",
            result: {},
            taskId: "task-1",
        });

        const task1 = await log.getEvents({ taskId: "task-1" });
        expect(task1).toHaveLength(2);
        expect(task1.every((e) => (e as never).taskId === "task-1")).toBe(true);
    });

    it("getEvents returns [] when file doesn't exist", async () => {
        const events = await log.getEvents();
        expect(events).toEqual([]);
    });

    // ── getStats ────────────────────────────────────────────────────────

    it("getStats aggregates cost and tokens from agent_end events", async () => {
        await log.append({
            type: "agent_end",
            agentId: "a1",
            result: { cost: 0.1, tokens: 100 },
        });
        await log.append({
            type: "agent_end",
            agentId: "a2",
            result: { cost: 0.25, tokens: 250 },
        });
        await log.append({
            type: "agent_start",
            agentId: "a3",
            profile: {} as never,
        });

        const stats = await log.getStats();
        expect(stats.totalEvents).toBe(3);
        expect(stats.totalCost).toBeCloseTo(0.35);
        expect(stats.totalTokens).toBe(350);
    });

    it("getStats returns zeros when no events", async () => {
        const stats = await log.getStats();
        expect(stats).toEqual({ totalEvents: 0, totalCost: 0, totalTokens: 0 });
    });

    // ── getEventsByTask ──────────────────────────────────────────────

    it("getEventsByTask returns only events for the given task", async () => {
        await log.append({ type: "agent_start", agentId: "a1", profile: {} as never, taskId: "t1" });
        await log.append({ type: "agent_end", agentId: "a1", result: {}, taskId: "t1" });
        await log.append({ type: "agent_start", agentId: "a2", profile: {} as never, taskId: "t2" });
        await log.append({ type: "error", agentId: "a1", error: "fail", taskId: "t1" });

        const t1 = await log.getEventsByTask("t1");
        expect(t1).toHaveLength(3);
        expect(t1.map((e) => e.type)).toEqual(["agent_start", "agent_end", "error"]);

        const t2 = await log.getEventsByTask("t2");
        expect(t2).toHaveLength(1);
        expect(t2[0].type).toBe("agent_start");

        const missing = await log.getEventsByTask("nope");
        expect(missing).toHaveLength(0);
    });

    // ── clear ───────────────────────────────────────────────────────────

    it("clear deletes the file", async () => {
        await log.append({ type: "agent_start", agentId: "a1", profile: {} as never });

        const before = await log.getEvents();
        expect(before).toHaveLength(1);

        await log.clear();

        const after = await log.getEvents();
        expect(after).toEqual([]);
    });

    it("clear is safe when file does not exist", async () => {
        await expect(log.clear()).resolves.toBeUndefined();
    });

    // ── malformed JSON ──────────────────────────────────────────────────

    it("getEvents skips malformed JSON lines", async () => {
        await fs.mkdir(dir, { recursive: true });

        const valid = { type: "agent_start", agentId: "a1", profile: {}, timestamp: new Date().toISOString() };
        const content = JSON.stringify(valid) + "\nNOT VALID JSON{\n" + JSON.stringify(valid) + "\n";
        await fs.writeFile(path.join(dir, "audit.jsonl"), content, "utf-8");

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const events = await log.getEvents();
        expect(events).toHaveLength(2);
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0][0]).toContain("Skipping malformed");

        warnSpy.mockRestore();
    });
});
