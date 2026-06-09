// ─── Develop Workflow Callback Tests ────────────────────────────────────────
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentProfile, StatusCallbacks } from "../../src/core/types";

// Capture real modules before mocking so we can restore them in afterAll.
const realHarnessFactory = Object.assign({}, await import("../../src/core/harness-factory.ts"));
const realStructuredOutput = Object.assign({}, await import("../../src/core/structured-output.ts"));
const realAgentLoop = Object.assign({}, await import("../../src/core/agent-loop.ts"));
const realProfile = Object.assign({}, await import("../../src/core/profile.ts"));
const realConfig = Object.assign({}, await import("../../src/core/config.ts"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module("../../src/core/harness-factory.ts", () => ({
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module("../../src/core/structured-output.ts", () => ({
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

const mockParallelAgents = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module("../../src/core/agent-loop.ts", () => ({
    parallelAgents: (...args: unknown[]) => mockParallelAgents(...args),
}));

const mockLoadProfiles = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module("../../src/core/profile.ts", () => ({
    loadProfiles: (...args: unknown[]) => mockLoadProfiles(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

mock.module("../../src/core/config.ts", () => ({
    resolveProfilesDirs: mock(),
    getGlobalConfigDir: mock(),
    getLocalConfigDir: mock(),
    resolveWorkflowsDirs: mock(),
    getDefaultWorkDir: mock(),
    ensureDir: mock(),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { run } from "../../src/workflows/develop";
import { WorkflowStatusTracker } from "../../src/tracking/workflow-status";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const BASE_PROFILE: AgentProfile = {
    id: "base",
    name: "Base",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a helpful agent.",
    excludeTools: [],
    includeTools: [],
};

function makeAllProfiles(): Map<string, AgentProfile> {
    const map = new Map<string, AgentProfile>();
    const ids = [
        "scout",
        "scouting-reviewer",
        "planner",
        "plan-reviewer",
        "implement-reviewer",
        "implementer",
        "fixer",
        "final-reviewer",
    ];
    for (const id of ids) {
        map.set(id, { ...BASE_PROFILE, id, name: id });
    }
    return map;
}

function makeHarness() {
    return {
        prompt: mock(async () => {}),
        getLastAssistantText: mock(() => "ok"),
        messages: [],
        subscribe: mock(() => mock()),
        sessionId: "test-session",
    };
}

function makeHarnessResult() {
    return { session: makeHarness(), sessionId: "test-session", dispose: mock() };
}

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `develop-callbacks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

/** Set up default mocks for a minimal successful run (no tasks). */
function setupHappyPathMocks() {
    mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());

    mockPromptForStructured
        // scouting: topics (empty)
        .mockResolvedValueOnce({ topics: [] })
        // scouting review: ready
        .mockResolvedValueOnce({ ready: true, research: "All scouted", gaps: [] })
        // planning
        .mockResolvedValueOnce({ tasks: [], strategy: "none" })
        // plan review: approved
        .mockResolvedValueOnce({ ready: true, feedback: "Plan approved", suggestions: [] })
        // final review: clean
        .mockResolvedValueOnce({ topics: [], overallAssessment: "Good", issues: [] });

    mockParallelAgents.mockResolvedValue([]);
}

/** Set up mocks for a run with one implementation task (approved). */
function setupRunWithTaskMocks() {
    mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());

    mockPromptForStructured
        // scouting: topics (empty)
        .mockResolvedValueOnce({ topics: [] })
        // scouting review: ready
        .mockResolvedValueOnce({ ready: true, research: "All scouted", gaps: [] })
        // planning
        .mockResolvedValueOnce({
            tasks: [
                {
                    id: "t1",
                    title: "Implement feature",
                    prompt: "Do it",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                },
            ],
            strategy: "Direct",
        })
        // plan review: approved
        .mockResolvedValueOnce({ ready: true, feedback: "Plan approved", suggestions: [] })
        // implementation review: approved
        .mockResolvedValueOnce({ approved: true, feedback: "Looks good", issues: [] })
        // final review: clean
        .mockResolvedValueOnce({ topics: [], overallAssessment: "Good", issues: [] });

    // implementation parallelAgents
    mockParallelAgents.mockResolvedValue([
        { status: "fulfilled", value: { result: "done" } },
    ]);
}

/** Set up mocks for a run with one task that gets rejected by reviewer. */
function setupRunWithRejectedTaskMocks() {
    mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());

    mockPromptForStructured
        // scouting: topics (empty)
        .mockResolvedValueOnce({ topics: [] })
        // scouting review: ready
        .mockResolvedValueOnce({ ready: true, research: "All scouted", gaps: [] })
        // planning
        .mockResolvedValueOnce({
            tasks: [
                {
                    id: "t1",
                    title: "Bad task",
                    prompt: "Do it badly",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                },
            ],
            strategy: "Direct",
        })
        // plan review: approved
        .mockResolvedValueOnce({ ready: true, feedback: "Plan approved", suggestions: [] })
        // implementation review: REJECTED
        .mockResolvedValueOnce({
            approved: false,
            feedback: "Missing error handling",
            issues: [
                { file: "src/a.ts", description: "No try-catch", severity: "critical" as const },
            ],
        })
        // implementation review (re-implementation after reclaim): APPROVED
        .mockResolvedValueOnce({
            approved: true,
            feedback: "Looks good now",
            issues: [],
        })
        // final review: clean
        .mockResolvedValueOnce({ topics: [], overallAssessment: "Good", issues: [] });

    // implementation parallelAgents
    mockParallelAgents.mockResolvedValue([
        { status: "fulfilled", value: { result: "bad" } },
    ]);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Workflow-level callbacks", () => {
    // 1. onWorkflowStart called on fresh start
    it("onWorkflowStart called on fresh start", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onWorkflowStart = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onWorkflowStart },
        });

        expect(onWorkflowStart).toHaveBeenCalledOnce();
        expect(onWorkflowStart).toHaveBeenCalledWith({
            taskPrompt: "Build a feature",
            resumed: false,
            workDir,
        });
    });

    // 2. onWorkflowStart called with resumed: true
    it("onWorkflowStart called with resumed: true", async () => {
        const workDir = tmpDir();

        // Pre-create a saved state at "planning" phase
        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("Resumed task");
        tracker.setPhase("planning");
        await tracker.save();

        // When resuming at "planning", the code first derives research via scoutingReviewPhase,
        // then continues through planning → plan_review → implementing → final_review
        mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
        mockCreateHarness.mockResolvedValue(makeHarnessResult());

        mockPromptForStructured
            // scoutingReviewPhase (deriving research from empty reports)
            .mockResolvedValueOnce({ ready: true, research: "Resumed research", gaps: [] })
            // planning
            .mockResolvedValueOnce({ tasks: [], strategy: "none" })
            // plan review: approved
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // final review: clean
            .mockResolvedValueOnce({ topics: [], overallAssessment: "OK", issues: [] });

        mockParallelAgents.mockResolvedValue([]);

        const onWorkflowStart = mock();
        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onWorkflowStart },
        });

        expect(onWorkflowStart).toHaveBeenCalledOnce();
        expect(onWorkflowStart).toHaveBeenCalledWith({
            taskPrompt: "Resumed task",
            resumed: true,
            workDir,
        });
    });

    // 3. onPhaseStart called for each phase
    it("onPhaseStart called for each phase", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onPhaseStart = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onPhaseStart },
        });

        expect(onPhaseStart.mock.calls.length).toBeGreaterThanOrEqual(6);

        const phases = onPhaseStart.mock.calls.map((call: unknown[]) => (call[0] as { phase: string }).phase);
        expect(phases).toContain("scouting");
        expect(phases).toContain("scouting_review");
        expect(phases).toContain("planning");
        expect(phases).toContain("plan_review");
        expect(phases).toContain("final_review");
    });

    // 4. onPhaseComplete called for each phase
    it("onPhaseComplete called for each phase", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onPhaseComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onPhaseComplete },
        });

        expect(onPhaseComplete.mock.calls.length).toBeGreaterThanOrEqual(6);

        // Each call should have a phase and durationMs
        for (const call of onPhaseComplete.mock.calls) {
            const info = call[0] as { phase: string; durationMs: number };
            expect(typeof info.phase).toBe("string");
            expect(typeof info.durationMs).toBe("number");
            expect(info.durationMs).toBeGreaterThanOrEqual(0);
        }
    });

    // 5. onWorkflowComplete called at end
    it("onWorkflowComplete called at end", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onWorkflowComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onWorkflowComplete },
        });

        expect(onWorkflowComplete).toHaveBeenCalledOnce();
        const info = onWorkflowComplete.mock.calls[0][0] as { totalDurationMs: number; agentCount: number };
        expect(typeof info.totalDurationMs).toBe("number");
        expect(info.totalDurationMs).toBeGreaterThanOrEqual(0);
        expect(typeof info.agentCount).toBe("number");
    });

    // 6. onWorkflowFailed called on error
    it("onWorkflowFailed called on error", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        // Override: scouting throws
        mockPromptForStructured.mockReset();
        mockPromptForStructured.mockRejectedValue(new Error("LLM unreachable"));

        const onWorkflowFailed = mock();

        await expect(
            run("Build a feature", {
                profilesDir: "/profiles",
                cwd: "/project",
                workDir,
                onStatus: { onWorkflowFailed },
            }),
        ).rejects.toThrow("LLM unreachable");

        expect(onWorkflowFailed).toHaveBeenCalledOnce();
        const info = onWorkflowFailed.mock.calls[0][0] as { error: Error; phase: string };
        expect(info.error).toBeInstanceOf(Error);
        expect(info.error.message).toBe("LLM unreachable");
        expect(typeof info.phase).toBe("string");
    });

    // 7. onAgentSpawn/Complete for scout
    it("onAgentSpawn/Complete for scout", async () => {
        const workDir = tmpDir();
        mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
        mockCreateHarness.mockResolvedValue(makeHarnessResult());

        mockPromptForStructured
            // scouting: topics (with one topic)
            .mockResolvedValueOnce({
                topics: [{ topic: "core", rationale: "Core module", files: ["src/core.ts"] }],
            })
            // scouting review: ready
            .mockResolvedValueOnce({ ready: true, research: "Scouted", gaps: [] })
            // planning
            .mockResolvedValueOnce({ tasks: [], strategy: "none" })
            // plan review: approved
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // final review: clean
            .mockResolvedValueOnce({ topics: [], overallAssessment: "OK", issues: [] });

        // parallelAgents for the scout
        mockParallelAgents.mockResolvedValue([
            { status: "fulfilled", value: { report: "scout report" } },
        ]);

        const onAgentSpawn = mock();
        const onAgentComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn, onAgentComplete },
        });

        // Scout coordinator spawns and completes
        const spawnCalls = onAgentSpawn.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });
        const completeCalls = onAgentComplete.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });

        // Match scout agents by profile='scout' (not agentId, since 'scouting-reviewer' also contains 'scout')
        const scoutSpawns = spawnCalls.filter((c) => c.profile === "scout");
        const scoutCompletes = completeCalls.filter((c) => c.profile === "scout");

        expect(scoutSpawns.length).toBeGreaterThanOrEqual(1);
        expect(scoutCompletes.length).toBeGreaterThanOrEqual(1);

        // Verify agentId contains 'scout' for all matched entries
        for (const spawn of scoutSpawns) {
            expect(spawn.agentId).toContain("scout");
        }
    });

    // 8. onAgentSpawn/Complete for planner
    it("onAgentSpawn/Complete for planner", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onAgentSpawn = mock();
        const onAgentComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn, onAgentComplete },
        });

        const spawnCalls = onAgentSpawn.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });
        const completeCalls = onAgentComplete.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });

        const plannerSpawns = spawnCalls.filter((c) => c.agentId.includes("planner"));
        const plannerCompletes = completeCalls.filter((c) => c.agentId.includes("planner"));

        expect(plannerSpawns.length).toBeGreaterThanOrEqual(1);
        expect(plannerCompletes.length).toBeGreaterThanOrEqual(1);

        for (const spawn of plannerSpawns) {
            expect(spawn.profile).toBe("planner");
        }
    });

    // 9. onDecision called for reviews
    it("onDecision called for reviews", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onDecision = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onDecision },
        });

        // At least 2 decisions: scouting review + plan review
        expect(onDecision.mock.calls.length).toBeGreaterThanOrEqual(2);

        const decisions = onDecision.mock.calls.map((c: unknown[]) => c[0] as { decision: string; reasoning: string });
        const decisionTypes = decisions.map((d) => d.decision);
        expect(decisionTypes).toContain("proceed_to_planning");
        expect(decisionTypes).toContain("plan_approved");

        // All decisions should have reasoning
        for (const d of decisions) {
            expect(typeof d.reasoning).toBe("string");
            expect(d.reasoning.length).toBeGreaterThan(0);
        }
    });

    // 10. onTaskStart/Complete for tasks
    it("onTaskStart/Complete for tasks", async () => {
        const workDir = tmpDir();
        setupRunWithTaskMocks();

        const onTaskStart = mock();
        const onTaskComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onTaskStart, onTaskComplete },
        });

        // Task should have started and completed
        expect(onTaskStart).toHaveBeenCalledOnce();
        const startInfo = onTaskStart.mock.calls[0][0] as { taskId: string; title: string; agentId: string };
        expect(startInfo.taskId).toBe("t1");
        expect(startInfo.title).toBe("Implement feature");
        expect(startInfo.agentId).toContain("implementer");

        expect(onTaskComplete).toHaveBeenCalledOnce();
        const completeInfo = onTaskComplete.mock.calls[0][0] as { taskId: string; title: string };
        expect(completeInfo.taskId).toBe("t1");
        expect(completeInfo.title).toBe("Implement feature");
    });

    // 11. onTaskRejected for rejected tasks
    it("onTaskRejected for rejected tasks", async () => {
        const workDir = tmpDir();
        setupRunWithRejectedTaskMocks();

        const onTaskStart = mock();
        const onTaskRejected = mock();
        const onTaskComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onTaskStart, onTaskRejected, onTaskComplete },
        });

        // Task was started (twice: initial + re-implementation after rejection)
        expect(onTaskStart).toHaveBeenCalledTimes(2);
        expect(onTaskStart.mock.calls[0][0]).toEqual(
            expect.objectContaining({ taskId: "t1" }),
        );

        // Task was rejected on the first attempt
        expect(onTaskRejected).toHaveBeenCalledOnce();
        const rejectedInfo = onTaskRejected.mock.calls[0][0] as {
            taskId: string;
            title: string;
            reason: string;
        };
        expect(rejectedInfo.taskId).toBe("t1");
        expect(rejectedInfo.title).toBe("Bad task");
        expect(rejectedInfo.reason).toBe("Missing error handling");

        // Task was eventually completed after re-implementation and approval
        expect(onTaskComplete).toHaveBeenCalledOnce();
    });

    // 12. onError for failures
    it("onError for review failures", async () => {
        const workDir = tmpDir();
        mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
        mockCreateHarness.mockResolvedValue(makeHarnessResult());

        mockPromptForStructured
            // scouting: topics (empty)
            .mockResolvedValueOnce({ topics: [] })
            // scouting review: ready
            .mockResolvedValueOnce({ ready: true, research: "Scouted", gaps: [] })
            // planning
            .mockResolvedValueOnce({
                tasks: [
                    {
                        id: "t1",
                        title: "Task 1",
                        prompt: "Do it",
                        profile: "implementer",
                        files: ["src/a.ts"],
                        dependencies: [],
                    },
                ],
                strategy: "Direct",
            })
            // plan review: approved
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // implementation review: THROWS (first attempt)
            .mockRejectedValueOnce(new Error("review crashed"))
            // implementation review retry: approved
            .mockResolvedValueOnce({
                approved: true,
                feedback: "Retry succeeded",
                issues: [],
            })
            // final review: clean
            .mockResolvedValueOnce({ topics: [], overallAssessment: "OK", issues: [] });

        mockParallelAgents.mockResolvedValue([
            { status: "fulfilled", value: { result: "ok" } },
        ]);

        const onError = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onError },
        });

        expect(onError).toHaveBeenCalledOnce();
        const errorInfo = onError.mock.calls[0][0] as {
            agentId: string;
            error: string;
            phase: string;
            taskId?: string;
        };
        expect(errorInfo.agentId).toContain("reviewer");
        expect(errorInfo.error).toContain("review crashed");
        expect(errorInfo.phase).toBe("implementing");
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("../../src/core/harness-factory.ts", () => realHarnessFactory);
    mock.module("../../src/core/structured-output.ts", () => realStructuredOutput);
    mock.module("../../src/core/agent-loop.ts", () => realAgentLoop);
    mock.module("../../src/core/profile.ts", () => realProfile);
    mock.module("../../src/core/config.ts", () => realConfig);
});
