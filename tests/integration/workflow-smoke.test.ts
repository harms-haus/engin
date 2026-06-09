// ─── Workflow Smoke Tests ──────────────────────────────────────────────────
//
// Integration tests that exercise the full develop workflow with mocked LLM
// calls. Real implementations are used for internal modules (TaskTracker,
// AuditLog, WorkflowStatusTracker, profile parser, harness-factory,
// structured-output, agent-loop). Only the external API boundary is mocked:
//   - AgentHarness (prompt method → returns mock AssistantMessages)
//   - pi-ai functions (getModel, getEnvApiKey, findEnvKeys, parseJsonWithRepair)
//   - NodeExecutionEnv (filesystem methods)
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// ─── Mocks ──────────────────────────────────────────────────────────────────

/**
 * Central mock for AgentHarness.prompt(). Each test can override this to
 * control what the LLM "returns" for different prompt types.
 */
const mockPromptFn = vi.fn<(text: string) => Promise<unknown>>();

vi.mock("@earendil-works/pi-agent-core", () => ({
    AgentHarness: vi.fn().mockImplementation((_options: unknown) => ({
        prompt: vi.fn(async (text: string) => mockPromptFn(text)),
    })),
    InMemorySessionRepo: vi.fn().mockImplementation(() => ({
        create: vi.fn(async () => ({
            getMetadata: vi.fn(async () => ({ id: "mock-session-id" })),
        })),
    })),
    JsonlSessionRepo: vi.fn().mockImplementation(() => ({
        create: vi.fn(async () => ({
            getMetadata: vi.fn(async () => ({ id: "mock-session-id" })),
        })),
    })),
}));

vi.mock("@earendil-works/pi-agent-core/node", () => ({
    NodeExecutionEnv: vi.fn().mockImplementation((_options: { cwd: string }) => ({
        cwd: _options.cwd,
        readTextFile: vi.fn(async () => ({ ok: true, value: "" })),
        writeFile: vi.fn(async () => ({ ok: true, value: undefined })),
        exec: vi.fn(async () => ({
            ok: true,
            value: { stdout: "", stderr: "", exitCode: 0 },
        })),
        listDir: vi.fn(async () => ({ ok: true, value: [] })),
        readTextLines: vi.fn(async () => ({ ok: true, value: [] })),
        readBinaryFile: vi.fn(async () => ({ ok: true, value: Buffer.alloc(0) })),
        appendFile: vi.fn(async () => ({ ok: true, value: undefined })),
        fileInfo: vi.fn(async () => ({ ok: true, value: { exists: false } })),
        canonicalPath: vi.fn(async (p: string) => ({ ok: true, value: p })),
        exists: vi.fn(async () => ({ ok: true, value: true })),
        createDir: vi.fn(async () => ({ ok: true, value: undefined })),
        remove: vi.fn(async () => ({ ok: true, value: undefined })),
        createTempDir: vi.fn(async () => ({ ok: true, value: "/tmp/mock-temp" })),
        createTempFile: vi.fn(async () => ({
            ok: true,
            value: "/tmp/mock-temp-file",
        })),
        cleanup: vi.fn(async () => ({ ok: true, value: undefined })),
        absolutePath: vi.fn((p: string) => p),
        joinPath: vi.fn((...parts: string[]) => path.join(...parts)),
    })),
}));

vi.mock("@earendil-works/pi-ai", () => {
    // Minimal TypeBox-like stub so createDefaultToolRegistry can build schemas
    const Type = {
        Object: (properties: Record<string, unknown>, _opts?: unknown) => ({
            type: "object",
            properties,
        }),
        String: (_opts?: unknown) => ({ type: "string" }),
        Number: (_opts?: unknown) => ({ type: "number" }),
        Boolean: (_opts?: unknown) => ({ type: "boolean" }),
        Optional: (schema: Record<string, unknown>) => ({
            ...schema,
            optional: true,
        }),
        Array: (
            items: Record<string, unknown>,
            _opts?: unknown,
        ) => ({
            type: "array",
            items,
        }),
    };

    return {
        Type,
        getModel: vi.fn().mockReturnValue({
            id: "mock-model",
            provider: "mock-provider",
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        }),
        getEnvApiKey: vi.fn().mockReturnValue("mock-api-key"),
        findEnvKeys: vi.fn().mockReturnValue([]),
        parseJsonWithRepair: vi
            .fn()
            .mockImplementation((text: string) => JSON.parse(text)),
    };
});

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { run } from "../../src/workflows/develop";
import { WorkflowStatusTracker } from "../../src/tracking/workflow-status";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAssistantMessage(text: string) {
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

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `workflow-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

/**
 * All profile IDs required by the develop workflow. Each gets a minimal
 * .md file with the required frontmatter fields.
 */
const ALL_PROFILES = [
    "scout",
    "scouting-reviewer",
    "planner",
    "plan-reviewer",
    "implement-reviewer",
    "implementer",
    "final-reviewer",
];

// ─── Smart prompt handler ──────────────────────────────────────────────────

/**
 * Inspects the prompt text and returns an appropriate mock AssistantMessage
 * containing JSON that matches the Zod schema expected by each workflow phase.
 */
function defaultPromptHandler(text: string) {
    // ── More-specific checks FIRST ──────────────────────────────────
    // Plan review — check before the broader "implementation plan"
    // substring so the review prompt isn't mis-routed to the planner.
    if (text.includes("reviewing an implementation plan")) {
        return makeAssistantMessage(
            JSON.stringify({
                ready: true,
                feedback: "Plan is well-structured and feasible",
                suggestions: [],
            }),
        );
    }

    // Scouting coordinator: identify topics
    if (
        text.includes("codebase scout") ||
        text.includes("Identify key areas")
    ) {
        return makeAssistantMessage(
            JSON.stringify({
                topics: [
                    {
                        topic: "core-module",
                        rationale: "Core logic needs investigation",
                        files: ["src/core.ts"],
                    },
                ],
            }),
        );
    }

    // Scouting review
    if (text.includes("reviewing scouting reports")) {
        return makeAssistantMessage(
            JSON.stringify({
                ready: true,
                research:
                    "All areas have been investigated thoroughly. No gaps remain.",
                gaps: [],
            }),
        );
    }

    // Planning
    if (text.includes("planning agent")) {
        return makeAssistantMessage(
            JSON.stringify({
                tasks: [
                    {
                        id: "t1",
                        title: "Implement core feature",
                        prompt: "Implement the core feature as described",
                        profile: "implementer",
                        files: ["src/core.ts"],
                        dependencies: [],
                    },
                ],
                strategy: "Implement directly in the core module",
            }),
        );
    }

    // Implementation agent
    if (text.includes("implementation agent")) {
        return makeAssistantMessage(
            JSON.stringify({ result: "Implementation complete" }),
        );
    }

    // Code reviewer (per-task review)
    if (text.includes("code reviewer")) {
        return makeAssistantMessage(
            JSON.stringify({
                approved: true,
                feedback: "Implementation looks correct and complete",
                issues: [],
            }),
        );
    }

    // Final quality review
    if (text.includes("final quality review")) {
        return makeAssistantMessage(
            JSON.stringify({
                topics: [
                    { topic: "overall quality", files: ["src/core.ts"] },
                ],
                overallAssessment: "Code quality is good",
                issues: [],
            }),
        );
    }

    // Default: plain text response
    return makeAssistantMessage("ok");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Workflow Smoke Tests", () => {
    let profilesDir: string;
    let workDir: string;
    let projectDir: string;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockPromptFn.mockImplementation(defaultPromptHandler);

        const base = tmpDir();
        profilesDir = path.join(base, "profiles");
        workDir = path.join(base, "work");
        projectDir = path.join(base, "project");

        await fs.mkdir(profilesDir, { recursive: true });
        await fs.mkdir(workDir, { recursive: true });
        await fs.mkdir(projectDir, { recursive: true });

        // Create minimal .md profile files for every role the workflow uses
        for (const name of ALL_PROFILES) {
            await fs.writeFile(
                path.join(profilesDir, `${name}.md`),
                [
                    "---",
                    `name: ${name}`,
                    "provider: mock-provider",
                    "model: mock-model",
                    "thinkingLevel: medium",
                    "---",
                    `You are a ${name} agent.`,
                ].join("\n"),
                "utf-8",
            );
        }
    });

    // ── 1. Full workflow run ──────────────────────────────────────────

    describe("Full workflow run", () => {
        it("runs all phases and produces expected artifacts", async () => {
            await run("Build a simple feature", {
                profilesDir,
                cwd: projectDir,
                workDir,
            });

            // ── Verify workflow-state.json ────────────────────────────
            const statePath = path.join(workDir, "workflow-state.json");
            const stateRaw = await fs.readFile(statePath, "utf-8");
            const state = JSON.parse(stateRaw);

            expect(state.currentPhase).toBe("done");
            expect(state.taskPrompt).toBe("Build a simple feature");
            expect(state.completedPhases).toContain("scouting");
            expect(state.completedPhases).toContain("scouting_review");
            expect(state.completedPhases).toContain("planning");
            expect(state.completedPhases).toContain("plan_review");
            expect(state.completedPhases).toContain("implementing");
            expect(state.completedPhases).toContain("final_review");

            // ── Verify audit.jsonl ────────────────────────────────────
            const auditPath = path.join(workDir, "audit", "audit.jsonl");
            const auditRaw = await fs.readFile(auditPath, "utf-8");
            const events = auditRaw
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));

            expect(events.length).toBeGreaterThan(0);

            // structured_output events from scouting coordinator,
            // planner, and final reviewer
            const structuredEvents = events.filter(
                (e: { type: string }) => e.type === "structured_output",
            );
            expect(structuredEvents.length).toBeGreaterThanOrEqual(2);

            // decision events from scouting review, plan review,
            // and implementation review
            const decisionEvents = events.filter(
                (e: { type: string }) => e.type === "decision",
            );
            expect(decisionEvents.length).toBeGreaterThanOrEqual(2);
        }, 30_000);
    });

    // ── 2. Resume scenario ───────────────────────────────────────────

    describe("Resume scenario", () => {
        it("restores state from saved workflow-state.json", async () => {
            // Create a tracker, set some state, save it
            const tracker = new WorkflowStatusTracker(workDir);
            tracker.setTaskPrompt("Resumed task");
            tracker.setScoutingReports([{ summary: "existing report" }]);
            tracker.setPlan({
                tasks: [{ id: "t1" }],
                strategy: "test",
            });
            tracker.setPhase("planning");
            await tracker.save();

            // Create a new tracker loading from saved state
            const restored = await WorkflowStatusTracker.load(workDir);

            expect(restored.taskPrompt).toBe("Resumed task");
            expect(restored.currentPhase).toBe("planning");
            expect(restored.scoutingReports).toEqual([
                { summary: "existing report" },
            ]);
            expect(restored.plan).toEqual({
                tasks: [{ id: "t1" }],
                strategy: "test",
            });
        });

        it("restores task tracker state through save/load round-trip", async () => {
            const tracker = new WorkflowStatusTracker(workDir);
            tracker.setTaskPrompt("Task with work");

            // Add tasks and advance one through the lifecycle
            tracker.taskTracker.addTask({
                id: "t1",
                title: "Base task",
                prompt: "Do base",
                profile: "implementer",
                files: ["src/base.ts"],
                dependencies: [],
            });
            tracker.taskTracker.addTask({
                id: "t2",
                title: "Dependent task",
                prompt: "Do dep",
                profile: "implementer",
                files: ["src/dep.ts"],
                dependencies: ["t1"],
            });

            // Complete t1
            const claimed = tracker.taskTracker.claimTasks(1);
            expect(claimed).toHaveLength(1);
            tracker.taskTracker.startTask("t1", "agent-1");
            tracker.taskTracker.submitForReview("t1", { done: true });
            tracker.taskTracker.completeTask("t1");

            await tracker.save();

            // Restore and verify
            const restored = await WorkflowStatusTracker.load(workDir);
            expect(restored.taskTracker.getTask("t1")!.status).toBe("done");
            expect(restored.taskTracker.getTask("t2")!.status).toBe("ready");
        });
    });

    // ── 3. Error handling ────────────────────────────────────────────

    describe("Error handling", () => {
        it("handles harness errors during implementation", async () => {
            // Override prompt handler to throw during implementation
            mockPromptFn.mockImplementation(async (text: string) => {
                if (text.includes("implementation agent")) {
                    throw new Error("Implementation harness crashed");
                }
                return defaultPromptHandler(text);
            });

            // The workflow should still complete without throwing
            await run("Build with errors", {
                profilesDir,
                cwd: projectDir,
                workDir,
            });

            // ── Verify workflow completed ─────────────────────────────
            const statePath = path.join(workDir, "workflow-state.json");
            const stateRaw = await fs.readFile(statePath, "utf-8");
            const state = JSON.parse(stateRaw);

            expect(state.currentPhase).toBe("done");

            // ── Verify audit.jsonl has events ─────────────────────────
            const auditPath = path.join(workDir, "audit", "audit.jsonl");
            const auditRaw = await fs.readFile(auditPath, "utf-8");
            const events = auditRaw
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));

            expect(events.length).toBeGreaterThan(0);

            // The reviewer should have logged a decision event about
            // the implementation error
            const decisionEvents = events.filter(
                (e: { type: string }) => e.type === "decision",
            );
            expect(decisionEvents.length).toBeGreaterThan(0);

            // The task reviewer (reviewer-t1) should have logged a
            // decision approving the error result
            const implReview = decisionEvents.find(
                (e: { agentId?: string }) =>
                    e.agentId === "reviewer-t1",
            );
            expect(implReview).toBeDefined();
            expect(implReview!.decision).toBe("approved");
        }, 30_000);

        it("handles reviewer rejection by marking task as claimed", async () => {
            let implementationCallCount = 0;

            mockPromptFn.mockImplementation(async (text: string) => {
                // Implementation always succeeds
                if (text.includes("implementation agent")) {
                    implementationCallCount++;
                    return makeAssistantMessage(
                        JSON.stringify({ result: `attempt ${implementationCallCount}` }),
                    );
                }

                // Reviewer rejects on the first call
                if (text.includes("code reviewer")) {
                    if (implementationCallCount <= 1) {
                        return makeAssistantMessage(
                            JSON.stringify({
                                approved: false,
                                feedback: "Missing error handling",
                                issues: [
                                    {
                                        file: "src/core.ts",
                                        description: "No try-catch",
                                        severity: "critical",
                                    },
                                ],
                            }),
                        );
                    }
                    return makeAssistantMessage(
                        JSON.stringify({
                            approved: true,
                            feedback: "Looks good now",
                            issues: [],
                        }),
                    );
                }

                return defaultPromptHandler(text);
            });

            await run("Build with rejection", {
                profilesDir,
                cwd: projectDir,
                workDir,
            });

            // Workflow should still complete
            const statePath = path.join(workDir, "workflow-state.json");
            const stateRaw = await fs.readFile(statePath, "utf-8");
            const state = JSON.parse(stateRaw);
            expect(state.currentPhase).toBe("done");

            // The reviewer rejected the implementation.  rejectTask puts the
            // task back into "claimed" status (not "ready"), so the loop
            // exits when claimTasks returns nothing.  Verify the task was
            // implemented once and rejected.
            expect(implementationCallCount).toBe(1);

            // Verify a decision event was logged for the rejection
            const auditPath = path.join(workDir, "audit", "audit.jsonl");
            const auditRaw = await fs.readFile(auditPath, "utf-8");
            const events = auditRaw
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            const rejectedDecision = events.find(
                (e: { type: string; decision?: string }) =>
                    e.type === "decision" && e.decision === "rejected",
            );
            expect(rejectedDecision).toBeDefined();
            expect(rejectedDecision.agentId).toBe("reviewer-t1");
        }, 30_000);
    });
});
