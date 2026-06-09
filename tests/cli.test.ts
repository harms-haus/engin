import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    parseArgs,
    formatTime,
    createStatusCallbacks,
} from "../src/cli.ts";

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe("parseArgs", () => {
    it("parses valid minimal args", () => {
        const result = parseArgs([
            "build a feature",
            "--profiles-dir",
            "/p",
            "--cwd",
            "/c",
            "--work-dir",
            "/w",
        ]);
        expect(result).toEqual({
            taskPrompt: "build a feature",
            profilesDir: "/p",
            cwd: "/c",
            workDir: "/w",
            maxConcurrent: 3,
            verbose: false,
            apiKeys: {},
        });
    });

    it("parses --verbose flag", () => {
        const result = parseArgs([
            "task",
            "--profiles-dir",
            "/p",
            "--cwd",
            "/c",
            "--work-dir",
            "/w",
            "--verbose",
        ]);
        expect(result.verbose).toBe(true);
    });

    it("parses --max-concurrent 5", () => {
        const result = parseArgs([
            "task",
            "--profiles-dir",
            "/p",
            "--cwd",
            "/c",
            "--work-dir",
            "/w",
            "--max-concurrent",
            "5",
        ]);
        expect(result.maxConcurrent).toBe(5);
    });

    it("parses --api-key repeatable", () => {
        const result = parseArgs([
            "task",
            "--profiles-dir",
            "/p",
            "--cwd",
            "/c",
            "--work-dir",
            "/w",
            "--api-key",
            "anthropic=sk-xxx",
            "--api-key",
            "openai=pk-yyy",
        ]);
        expect(result.apiKeys).toEqual({
            anthropic: "sk-xxx",
            openai: "pk-yyy",
        });
    });

    it("throws on missing task prompt", () => {
        expect(() =>
            parseArgs(["--profiles-dir", "/p", "--cwd", "/c", "--work-dir", "/w"]),
        ).toThrow(/Missing required <task-prompt>/);
    });

    it("throws on missing --profiles-dir", () => {
        expect(() =>
            parseArgs(["task", "--cwd", "/c", "--work-dir", "/w"]),
        ).toThrow(/Missing required --profiles-dir/);
    });

    it("throws on missing --cwd", () => {
        expect(() =>
            parseArgs(["task", "--profiles-dir", "/p", "--work-dir", "/w"]),
        ).toThrow(/Missing required --cwd/);
    });

    it("throws on missing --work-dir", () => {
        expect(() =>
            parseArgs(["task", "--profiles-dir", "/p", "--cwd", "/c"]),
        ).toThrow(/Missing required --work-dir/);
    });
});

// ─── formatTime ─────────────────────────────────────────────────────────────

describe("formatTime", () => {
    it("returns bracketed time format", () => {
        const result = formatTime();
        expect(result).toMatch(/^\[\d{2}:\d{2}:\d{2}\]$/);
    });
});

// ─── createStatusCallbacks ─────────────────────────────────────────────────

describe("createStatusCallbacks", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it("non-verbose has no agent-level callbacks", () => {
        const callbacks = createStatusCallbacks(false);
        expect(callbacks.onTurnStart).toBeUndefined();
        expect(callbacks.onTurnEnd).toBeUndefined();
        expect(callbacks.onToolCallStart).toBeUndefined();
        expect(callbacks.onToolCallEnd).toBeUndefined();
    });

    it("verbose has agent-level callbacks", () => {
        const callbacks = createStatusCallbacks(true);
        expect(typeof callbacks.onTurnStart).toBe("function");
        expect(typeof callbacks.onTurnEnd).toBe("function");
        expect(typeof callbacks.onToolCallStart).toBe("function");
        expect(typeof callbacks.onToolCallEnd).toBe("function");
    });

    it("onWorkflowStart logs formatted output", () => {
        const callbacks = createStatusCallbacks(false);
        callbacks.onWorkflowStart!({
            taskPrompt: "build it",
            resumed: false,
            workDir: "/tmp",
        });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toMatch(/Workflow started/);
    });

    it("onPhaseStart logs formatted output", () => {
        const callbacks = createStatusCallbacks(false);
        callbacks.onPhaseStart!({ phase: "planning" as never, round: 1 });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toMatch(/Phase started/);
    });

    it("onWorkflowComplete logs duration", () => {
        const callbacks = createStatusCallbacks(false);
        callbacks.onWorkflowComplete!({
            totalDurationMs: 5000,
            agentCount: 3,
        });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toMatch(/Workflow complete/);
    });

    it("onWorkflowFailed logs error", () => {
        const callbacks = createStatusCallbacks(false);
        callbacks.onWorkflowFailed!({
            error: new Error("boom"),
            phase: "execution",
        });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toMatch(/Workflow failed/);
    });

    it("onTurnStart logs in verbose mode", () => {
        const callbacks = createStatusCallbacks(true);
        callbacks.onTurnStart!({ agentId: "agent-1", turn: 2 });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toMatch(/Turn/);
    });

    it("onToolCallStart logs tool name", () => {
        const callbacks = createStatusCallbacks(true);
        callbacks.onToolCallStart!({
            agentId: "agent-1",
            toolName: "read_file",
            toolCallId: "tc-1",
        });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toMatch(/Tool call/);
    });
});
