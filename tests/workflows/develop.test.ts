// ─── Develop Workflow Tests ──────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentProfile, HarnessCreationOptions } from "../../src/core/types";
import type { Plan, ScoutingReview, PlanReview, ReviewResult, FinalReviewTopics } from "../../src/workflows/develop";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = vi.fn();
vi.mock("../../src/core/harness-factory.ts", () => ({
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockPromptForStructured = vi.fn();
vi.mock("../../src/core/structured-output.ts", () => ({
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    getAssistantText: vi.fn(),
}));

const mockParallelAgents = vi.fn();
vi.mock("../../src/core/agent-loop.ts", () => ({
    parallelAgents: (...args: unknown[]) => mockParallelAgents(...args),
}));

const mockLoadProfilesFromDirs = vi.fn();
vi.mock("../../src/core/profile.ts", () => ({
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { createHarness } from "../../src/core/harness-factory.ts";
import { promptForStructured } from "../../src/core/structured-output.ts";
import { parallelAgents } from "../../src/core/agent-loop.ts";
import { loadProfilesFromDirs } from "../../src/core/profile.ts";
import {
    scoutingPhase,
    scoutingReviewPhase,
    planningPhase,
    planReviewPhase,
    implementationPhase,
    finalReviewPhase,
    run,
    ScoutingTopicSchema,
    ScoutingReviewSchema,
    PlanSchema,
    PlanReviewSchema,
    ReviewResultSchema,
    FinalReviewTopicsSchema,
} from "../../src/workflows/develop";
import { WorkflowStatusTracker } from "../../src/tracking/workflow-status";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const SCOUT_PROFILE: AgentProfile = {
    id: "scout",
    name: "Scout",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a scout agent.",
    excludeTools: [],
    includeTools: [],
};

const REVIEWER_PROFILE: AgentProfile = {
    id: "implement-reviewer",
    name: "Reviewer",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a reviewer agent.",
    excludeTools: [],
    includeTools: [],
};

const IMPLEMENTER_PROFILE: AgentProfile = {
    id: "implementer",
    name: "Implementer",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are an implementer agent.",
    excludeTools: [],
    includeTools: [],
};

const FIXER_PROFILE: AgentProfile = {
    id: "fixer",
    name: "Fixer",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a fix agent.",
    excludeTools: [],
    includeTools: [],
};

function makeHarness() {
    return {
        prompt: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    };
}

function makeHarnessResult() {
    return { harness: makeHarness(), sessionId: "test-session" };
}

function makeAllProfiles(): Map<string, AgentProfile> {
    const map = new Map<string, AgentProfile>();
    map.set("scout", SCOUT_PROFILE);
    map.set("scouting-reviewer", {
        ...SCOUT_PROFILE,
        id: "scouting-reviewer",
        name: "Scouting Reviewer",
    });
    map.set("planner", {
        ...SCOUT_PROFILE,
        id: "planner",
        name: "Planner",
    });
    map.set("plan-reviewer", {
        ...SCOUT_PROFILE,
        id: "plan-reviewer",
        name: "Plan Reviewer",
    });
    map.set("implement-reviewer", REVIEWER_PROFILE);
    map.set("implementer", IMPLEMENTER_PROFILE);
    map.set("fixer", FIXER_PROFILE);
    map.set("final-reviewer", {
        ...SCOUT_PROFILE,
        id: "final-reviewer",
        name: "Final Reviewer",
    });
    return map;
}

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `develop-workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
});

// ─── Schemas ────────────────────────────────────────────────────────────────

describe("Zod Schemas", () => {
    it("ScoutingTopicSchema validates correct structure", () => {
        const data = {
            topics: [
                {
                    topic: "auth module",
                    rationale: "Need to understand login flow",
                    files: ["src/auth.ts"],
                },
            ],
        };
        expect(ScoutingTopicSchema.safeParse(data).success).toBe(true);
    });

    it("ScoutingReviewSchema validates correct structure", () => {
        const data = {
            ready: true,
            research: "Found everything we need",
            gaps: [],
        };
        expect(ScoutingReviewSchema.safeParse(data).success).toBe(true);
    });

    it("PlanSchema validates correct structure", () => {
        const data = {
            tasks: [
                {
                    id: "t1",
                    title: "Add login",
                    prompt: "Implement login",
                    profile: "implementer",
                    files: ["src/auth.ts"],
                    dependencies: [],
                },
            ],
            strategy: "Bottom-up approach",
        };
        expect(PlanSchema.safeParse(data).success).toBe(true);
    });

    it("PlanReviewSchema validates correct structure", () => {
        const data = {
            ready: true,
            feedback: "Plan looks good",
            suggestions: [],
        };
        expect(PlanReviewSchema.safeParse(data).success).toBe(true);
    });

    it("ReviewResultSchema validates correct structure", () => {
        const data = {
            approved: true,
            feedback: "Looks correct",
            issues: [],
        };
        expect(ReviewResultSchema.safeParse(data).success).toBe(true);
    });

    it("FinalReviewTopicsSchema validates correct structure", () => {
        const data = {
            topics: [{ topic: "error handling", files: ["src/errors.ts"] }],
            overallAssessment: "Good quality",
            issues: [
                {
                    file: "src/errors.ts",
                    description: "Missing null check",
                    severity: "critical" as const,
                },
            ],
        };
        expect(FinalReviewTopicsSchema.safeParse(data).success).toBe(true);
    });
});

// ─── scoutingPhase ──────────────────────────────────────────────────────────

describe("scoutingPhase", () => {
    it("creates a scout harness, gets topics, and spawns parallel scouts", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const topics = {
            topics: [
                {
                    topic: "module-a",
                    rationale: "Core module",
                    files: ["src/a.ts"],
                },
                {
                    topic: "module-b",
                    rationale: "Supporting module",
                    files: ["src/b.ts"],
                },
            ],
        };

        // First call for topics, then parallel agents for reports
        mockPromptForStructured.mockResolvedValueOnce(topics);
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { report: "scout report A" } },
            { status: "fulfilled", value: { report: "scout report B" } },
        ]);

        const reports = await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd");

        expect(reports).toHaveLength(2);
        expect(reports[0]).toEqual({ report: "scout report A" });
        expect(reports[1]).toEqual({ report: "scout report B" });
        expect(mockCreateHarness).toHaveBeenCalledTimes(1); // coordinator harness
        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
        expect(mockParallelAgents).toHaveBeenCalledTimes(1);
        expect(mockParallelAgents).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    profile: expect.objectContaining({ id: "scout" }),
                    cwd: "/cwd",
                }),
                expect.objectContaining({
                    profile: expect.objectContaining({ id: "scout" }),
                    cwd: "/cwd",
                }),
            ]),
            expect.any(Function),
        );
        expect(tracker.scoutingReports).toEqual(reports);
    });

    it("returns empty reports when no topics found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockPromptForStructured.mockResolvedValueOnce({ topics: [] });

        const reports = await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd");

        expect(reports).toEqual([]);
        expect(mockParallelAgents).not.toHaveBeenCalled();
    });

    it("handles partial failures in parallel scouts", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const topics = {
            topics: [
                { topic: "a", rationale: "A", files: ["a.ts"] },
                { topic: "b", rationale: "B", files: ["b.ts"] },
            ],
        };

        mockPromptForStructured.mockResolvedValueOnce(topics);
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { report: "success" } },
            { status: "rejected", reason: new Error("scout failed") },
        ]);

        const reports = await scoutingPhase(tracker, ["/profiles"], "task", "/cwd");

        expect(reports).toHaveLength(1);
        expect(reports[0]).toEqual({ report: "success" });
    });

    it("throws if scout profile not found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockLoadProfilesFromDirs.mockResolvedValueOnce(new Map()); // empty profiles

        await expect(
            scoutingPhase(tracker, ["/profiles"], "task", "/cwd"),
        ).rejects.toThrow('Profile "scout" not found');
    });
});

// ─── scoutingReviewPhase ────────────────────────────────────────────────────

describe("scoutingReviewPhase", () => {
    it("returns ready=true with research summary", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const reviewResult: ScoutingReview = {
            ready: true,
            research: "All areas investigated thoroughly",
            gaps: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(reviewResult);

        const result = await scoutingReviewPhase(
            tracker,
            ["/profiles"],
            [{ summary: "report 1" }],
            "/cwd",
        );

        expect(result).toEqual(reviewResult);
        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    });

    it("returns ready=false with gaps when more scouting needed", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const reviewResult: ScoutingReview = {
            ready: false,
            research: "Partial findings",
            gaps: ["Need to investigate test coverage"],
        };
        mockPromptForStructured.mockResolvedValueOnce(reviewResult);

        const result = await scoutingReviewPhase(
            tracker,
            ["/profiles"],
            [],
            "/cwd",
        );

        expect(result.ready).toBe(false);
        expect(result.gaps).toHaveLength(1);
    });

    it("throws if scouting-reviewer profile not found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockLoadProfilesFromDirs.mockResolvedValueOnce(new Map());

        await expect(
            scoutingReviewPhase(tracker, ["/profiles"], [], "/cwd"),
        ).rejects.toThrow('Profile "scouting-reviewer" not found');
    });
});

// ─── planningPhase ──────────────────────────────────────────────────────────

describe("planningPhase", () => {
    it("creates a plan with tasks", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Implement feature X",
                    prompt: "Create the X module",
                    profile: "implementer",
                    files: ["src/x.ts"],
                    dependencies: [],
                },
                {
                    id: "t2",
                    title: "Add tests for X",
                    prompt: "Write tests",
                    profile: "implementer",
                    files: ["tests/x.test.ts"],
                    dependencies: ["t1"],
                },
            ],
            strategy: "Implement core first, then tests",
        };

        mockPromptForStructured.mockResolvedValueOnce(plan);

        const result = await planningPhase(
            tracker,
            ["/profiles"],
            "Research summary",
            "Build feature X",
            "/cwd",
        );

        expect(result).toEqual(plan);
        expect(result.tasks).toHaveLength(2);
        expect(tracker.plan).toEqual(plan);
    });

    it("throws if planner profile not found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockLoadProfilesFromDirs.mockResolvedValueOnce(new Map());

        await expect(
            planningPhase(tracker, ["/profiles"], "research", "task", "/cwd"),
        ).rejects.toThrow('Profile "planner" not found');
    });
});

// ─── planReviewPhase ────────────────────────────────────────────────────────

describe("planReviewPhase", () => {
    it("approves a good plan", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Do something",
                    prompt: "Do it",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                },
            ],
            strategy: "Simple approach",
        };

        const review: PlanReview = {
            ready: true,
            feedback: "Plan is solid and well-structured",
            suggestions: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(review);

        const result = await planReviewPhase(
            tracker,
            ["/profiles"],
            plan,
            "research",
            "task prompt",
            "/cwd",
        );

        expect(result.ready).toBe(true);
        expect(result.feedback).toContain("solid");
    });

    it("rejects a flawed plan with suggestions", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [],
            strategy: "No tasks defined",
        };

        const review: PlanReview = {
            ready: false,
            feedback: "Plan has no tasks",
            suggestions: ["Add concrete implementation tasks"],
        };
        mockPromptForStructured.mockResolvedValueOnce(review);

        const result = await planReviewPhase(
            tracker,
            ["/profiles"],
            plan,
            "research",
            "task",
            "/cwd",
        );

        expect(result.ready).toBe(false);
        expect(result.suggestions).toHaveLength(1);
    });
});

// ─── implementationPhase ────────────────────────────────────────────────────

describe("implementationPhase", () => {
    it("processes tasks through full lifecycle: claim → implement → review → complete", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Task 1",
                    prompt: "Do task 1",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                },
            ],
            strategy: "Sequential",
        };

        // parallelAgents for implementation returns fulfilled
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { result: "implemented" } },
        ]);

        // Reviewer approves
        const reviewResult: ReviewResult = {
            approved: true,
            feedback: "Looks good",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(reviewResult);

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3);

        // Task should be done
        expect(tracker.taskTracker.getTask("t1")!.status).toBe("done");

        // parallelAgents called for implementation
        expect(mockParallelAgents).toHaveBeenCalledTimes(1);

        // Reviewer called with promptForStructured
        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    });

    it("rejects task when reviewer disapproves, then re-implements and approves", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Task 1",
                    prompt: "Do task 1",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                },
            ],
            strategy: "Test strategy",
        };

        // First implementation
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { result: "bad implementation" } },
        ]);

        // Reviewer rejects first attempt
        const rejectResult: ReviewResult = {
            approved: false,
            feedback: "Missing error handling",
            issues: [
                {
                    file: "src/a.ts",
                    description: "No try-catch",
                    severity: "critical",
                },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce(rejectResult);

        // Second implementation (after reclaim)
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { result: "fixed implementation" } },
        ]);

        // Reviewer approves second attempt
        const approveResult: ReviewResult = {
            approved: true,
            feedback: "Looks good now",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(approveResult);

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3);

        // Task should be done after re-implementation and approval
        expect(tracker.taskTracker.getTask("t1")!.status).toBe("done");
        // Feedback from rejection is preserved
        expect(tracker.taskTracker.getTask("t1")!.reviewFeedback).toBe("Missing error handling");
    });

    it("completes task when reviewer throws", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Task 1",
                    prompt: "Do task 1",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                },
            ],
            strategy: "Test",
        };

        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { result: "ok" } },
        ]);

        // Reviewer throws
        mockPromptForStructured.mockRejectedValueOnce(new Error("review failed"));

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3);

        // Task should be completed despite review failure
        expect(tracker.taskTracker.getTask("t1")!.status).toBe("done");
    });

    it("handles dependent tasks in correct order", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Base task",
                    prompt: "Do base",
                    profile: "implementer",
                    files: ["src/base.ts"],
                    dependencies: [],
                },
                {
                    id: "t2",
                    title: "Dependent task",
                    prompt: "Do dependent",
                    profile: "implementer",
                    files: ["src/dep.ts"],
                    dependencies: ["t1"],
                },
            ],
            strategy: "Sequential due to dependency",
        };

        // First iteration: only t1 is ready
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { result: "base done" } },
        ]);

        // Reviewer approves t1
        mockPromptForStructured.mockResolvedValueOnce({
            approved: true,
            feedback: "OK",
            issues: [],
        });

        // Second iteration: t2 is now ready (dependency resolved)
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { result: "dep done" } },
        ]);

        // Reviewer approves t2
        mockPromptForStructured.mockResolvedValueOnce({
            approved: true,
            feedback: "OK",
            issues: [],
        });

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3);

        expect(tracker.taskTracker.getTask("t1")!.status).toBe("done");
        expect(tracker.taskTracker.getTask("t2")!.status).toBe("done");
        expect(mockParallelAgents).toHaveBeenCalledTimes(2);
    });

    it("handles implementation failure", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Failing task",
                    prompt: "Do it",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                },
            ],
            strategy: "Test",
        };

        mockParallelAgents.mockResolvedValueOnce([
            { status: "rejected", reason: new Error("impl crashed") },
        ]);

        // Reviewer called on the error result
        mockPromptForStructured.mockResolvedValueOnce({
            approved: true,
            feedback: "Accept despite crash",
            issues: [],
        });

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3);

        const task = tracker.taskTracker.getTask("t1")!;
        expect(task.status).toBe("done");
        expect(task.result).toEqual({ error: "impl crashed" });
    });

    it("respects maxConcurrentTasks", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                { id: "t1", title: "A", prompt: "a", profile: "implementer", files: [], dependencies: [] },
                { id: "t2", title: "B", prompt: "b", profile: "implementer", files: [], dependencies: [] },
                { id: "t3", title: "C", prompt: "c", profile: "implementer", files: [], dependencies: [] },
                { id: "t4", title: "D", prompt: "d", profile: "implementer", files: [], dependencies: [] },
            ],
            strategy: "Parallel",
        };

        // First batch: only 2 tasks (maxConcurrentTasks=2)
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: "r1" },
            { status: "fulfilled", value: "r2" },
        ]);
        mockPromptForStructured
            .mockResolvedValueOnce({ approved: true, feedback: "ok", issues: [] })
            .mockResolvedValueOnce({ approved: true, feedback: "ok", issues: [] });

        // Second batch: remaining 2 tasks
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: "r3" },
            { status: "fulfilled", value: "r4" },
        ]);
        mockPromptForStructured
            .mockResolvedValueOnce({ approved: true, feedback: "ok", issues: [] })
            .mockResolvedValueOnce({ approved: true, feedback: "ok", issues: [] });

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 2);

        expect(tracker.taskTracker.areAllDone()).toBe(true);
        // parallelAgents should have been called with at most 2 configs per batch
        expect(mockParallelAgents).toHaveBeenCalledTimes(2);
    });
});

// ─── finalReviewPhase ───────────────────────────────────────────────────────

describe("finalReviewPhase", () => {
    it("returns true when no issues found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const assessment: FinalReviewTopics = {
            topics: [{ topic: "Code quality", files: ["src/main.ts"] }],
            overallAssessment: "Code looks good",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(assessment);

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd");

        expect(clean).toBe(true);
        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    });

    it("spawns fixers for critical issues and returns true when fixed", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // First review: finds critical issue
        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce(firstAssessment);

        // Fixers run in parallel
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: "fixed" },
        ]);

        // Second review: clean
        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "All fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(secondAssessment);

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd");

        expect(clean).toBe(true);
        expect(mockPromptForStructured).toHaveBeenCalledTimes(2); // two review rounds
        expect(mockParallelAgents).toHaveBeenCalledTimes(1); // one fix round
    });

    it("returns true when only minor issues found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const assessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Mostly good",
            issues: [
                { file: "src/a.ts", description: "Formatting", severity: "minor" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce(assessment);

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd");

        expect(clean).toBe(true);
        // No fixers spawned since only minor issues
        expect(mockParallelAgents).not.toHaveBeenCalled();
    });

    it("gives up after max fix rounds and returns false", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // Every review finds critical issues
        const assessmentWithCritical: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Still broken",
            issues: [
                { file: "src/a.ts", description: "Persistent bug", severity: "critical" },
            ],
        };

        mockPromptForStructured.mockResolvedValue(assessmentWithCritical);
        mockParallelAgents.mockResolvedValue([
            { status: "fulfilled", value: "attempted fix" },
        ]);

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd");

        expect(clean).toBe(false);
        // Should have run 3 rounds of review (all rounds exhausted)
        expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
        // Should have run 3 rounds of fixing (one per round with critical issues)
        expect(mockParallelAgents).toHaveBeenCalledTimes(3);
    });
});

// ─── run ─────────────────────────────────────────────────────────────────────

describe("run", () => {
    it("orchestrates all phases in order", async () => {
        const workDir = tmpDir();

        // scoutingPhase: topics then parallel agents
        mockPromptForStructured
            // scouting: topics
            .mockResolvedValueOnce({
                topics: [{ topic: "core", rationale: "Core module", files: ["src/core.ts"] }],
            })
            // scoutingReview: ready
            .mockResolvedValueOnce({
                ready: true,
                research: "Found everything",
                gaps: [],
            })
            // planning
            .mockResolvedValueOnce({
                tasks: [
                    {
                        id: "t1",
                        title: "Implement",
                        prompt: "Do it",
                        profile: "implementer",
                        files: ["src/core.ts"],
                        dependencies: [],
                    },
                ],
                strategy: "Direct approach",
            })
            // planReview: approved
            .mockResolvedValueOnce({
                ready: true,
                feedback: "Plan approved",
                suggestions: [],
            })
            // implementation review
            .mockResolvedValueOnce({
                approved: true,
                feedback: "Implementation looks good",
                issues: [],
            })
            // finalReview: clean
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Everything looks great",
                issues: [],
            });

        // parallelAgents for scouting
        mockParallelAgents
            .mockResolvedValueOnce([
                { status: "fulfilled", value: { report: "scouted" } },
            ])
            // parallelAgents for implementation
            .mockResolvedValueOnce([
                { status: "fulfilled", value: { result: "implemented" } },
            ]);

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Verify the workflow advanced through all phases
        const statePath = path.join(workDir, "workflow-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.currentPhase).toBe("done");
        expect(state.completedPhases).toContain("scouting");
        expect(state.completedPhases).toContain("scouting_review");
        expect(state.completedPhases).toContain("planning");
        expect(state.completedPhases).toContain("plan_review");
        expect(state.completedPhases).toContain("implementing");
        expect(state.completedPhases).toContain("final_review");
    }, 30000);

    it("retries scouting when not ready", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // scouting round 1: topics
            .mockResolvedValueOnce({ topics: [{ topic: "a", rationale: "A", files: [] }] })
            // scouting review round 1: NOT ready
            .mockResolvedValueOnce({ ready: false, research: "Partial", gaps: ["need more"] })
            // scouting round 2: topics
            .mockResolvedValueOnce({ topics: [{ topic: "b", rationale: "B", files: [] }] })
            // scouting review round 2: ready
            .mockResolvedValueOnce({ ready: true, research: "Complete", gaps: [] })
            // planning
            .mockResolvedValueOnce({
                tasks: [],
                strategy: "No tasks needed",
            })
            // plan review
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // final review
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Good",
                issues: [],
            });

        mockParallelAgents
            .mockResolvedValue([{ status: "fulfilled", value: {} }]);

        await run("Build something", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Scouting phase called twice (2 rounds)
        expect(mockParallelAgents).toHaveBeenCalled();

        const raw = await fs.readFile(path.join(workDir, "workflow-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");
    }, 30000);

    it("retries planning when plan is rejected", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // scouting
            .mockResolvedValueOnce({ topics: [] })
            // scouting review: ready
            .mockResolvedValueOnce({ ready: true, research: "Done", gaps: [] })
            // planning round 1
            .mockResolvedValueOnce({
                tasks: [],
                strategy: "Bad plan",
            })
            // plan review round 1: rejected
            .mockResolvedValueOnce({
                ready: false,
                feedback: "Plan is too vague",
                suggestions: ["Add tasks"],
            })
            // planning round 2
            .mockResolvedValueOnce({
                tasks: [
                    {
                        id: "t1",
                        title: "Real task",
                        prompt: "Do it",
                        profile: "implementer",
                        files: [],
                        dependencies: [],
                    },
                ],
                strategy: "Better plan",
            })
            // plan review round 2: approved
            .mockResolvedValueOnce({ ready: true, feedback: "Better", suggestions: [] })
            // implementation review
            .mockResolvedValueOnce({ approved: true, feedback: "ok", issues: [] })
            // final review
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Good",
                issues: [],
            });

        mockParallelAgents.mockResolvedValue([
            { status: "fulfilled", value: "done" },
        ]);

        await run("Fix the bug", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const raw = await fs.readFile(path.join(workDir, "workflow-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");
    }, 30000);

    it("creates a new tracker when no saved state exists", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            .mockResolvedValueOnce({ topics: [] })
            .mockResolvedValueOnce({ ready: true, research: "ok", gaps: [] })
            .mockResolvedValueOnce({ tasks: [], strategy: "none" })
            .mockResolvedValueOnce({ ready: true, feedback: "ok", suggestions: [] })
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "ok",
                issues: [],
            });

        mockParallelAgents.mockResolvedValue([]);

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Verify state file was created
        const exists = await fs.stat(path.join(workDir, "workflow-state.json"));
        expect(exists.isFile()).toBe(true);
    }, 30000);

    it("resumes from saved state", async () => {
        const workDir = tmpDir();

        // Create initial saved state at "planning" phase
        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("Resumed task");
        tracker.setScoutingReports([{ summary: "existing report" }]);
        tracker.setPhase("planning");
        await tracker.save();

        // Setup mocks for planning and beyond
        mockPromptForStructured
            // scouting review (to get research)
            .mockResolvedValueOnce({ ready: true, research: "From saved reports", gaps: [] })
            // planning
            .mockResolvedValueOnce({
                tasks: [
                    {
                        id: "t1",
                        title: "Task",
                        prompt: "Do it",
                        profile: "implementer",
                        files: [],
                        dependencies: [],
                    },
                ],
                strategy: "Strategy",
            })
            // plan review
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // implementation review
            .mockResolvedValueOnce({ approved: true, feedback: "OK", issues: [] })
            // final review
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Done",
                issues: [],
            });

        mockParallelAgents.mockResolvedValue([
            { status: "fulfilled", value: "done" },
        ]);

        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const raw = await fs.readFile(path.join(workDir, "workflow-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");
        expect(state.taskPrompt).toBe("Resumed task");
    }, 30000);

    it("saves state after each phase", async () => {
        const workDir = tmpDir();

        let promptForStructuredCallCount = 0;
        const originalMock = mockPromptForStructured.bind(vi);

        mockPromptForStructured.mockImplementation(async (...args: unknown[]) => {
            promptForStructuredCallCount++;

            // Check state file exists at various points
            try {
                await fs.stat(path.join(workDir, "workflow-state.json"));
            } catch {
                // State may not exist yet on first call
            }

            // scouting topics
            if (promptForStructuredCallCount === 1) return { topics: [] };
            // scouting review
            if (promptForStructuredCallCount === 2) return { ready: true, research: "ok", gaps: [] };
            // planning
            if (promptForStructuredCallCount === 3) return { tasks: [], strategy: "none" };
            // plan review
            if (promptForStructuredCallCount === 4) return { ready: true, feedback: "ok", suggestions: [] };
            // final review
            if (promptForStructuredCallCount === 5) return { topics: [], overallAssessment: "ok", issues: [] };

            return {};
        });

        mockParallelAgents.mockResolvedValue([]);

        await run("Test", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Final state file should exist
        const raw = await fs.readFile(path.join(workDir, "workflow-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");
    }, 30000);
});
