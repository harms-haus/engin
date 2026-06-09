// ─── Development Workflow ────────────────────────────────────────────────────
import { z } from "zod";
import type { AgentProfile, HarnessCreationOptions } from "../core/types";
import { loadProfiles } from "../core/profile";
import { createHarness } from "../core/harness-factory";
import { promptForStructured } from "../core/structured-output";
import { parallelAgents } from "../core/agent-loop";
import type { WorkflowStatusTracker } from "../tracking/workflow-status";
import type { AuditEvent } from "../core/types";

// ─── Zod Schemas ────────────────────────────────────────────────────────────

export const ScoutingTopicSchema = z.object({
    topics: z.array(
        z.object({
            topic: z.string().describe("Short name for the area to scout"),
            rationale: z.string().describe("Why this topic matters for the task"),
            files: z.array(z.string()).describe("Key files or directories to examine"),
        }),
    ),
});

export type ScoutingTopics = z.infer<typeof ScoutingTopicSchema>;

export const ScoutingReviewSchema = z.object({
    ready: z.boolean().describe("Whether enough information has been gathered to proceed"),
    research: z.string().describe("Synthesized research summary from the scouting reports"),
    gaps: z.array(z.string()).describe("Topics that still need investigation"),
});

export type ScoutingReview = z.infer<typeof ScoutingReviewSchema>;

export const PlanSchema = z.object({
    tasks: z.array(
        z.object({
            id: z.string().describe("Unique task identifier"),
            title: z.string().describe("Short description of the task"),
            prompt: z.string().describe("Detailed prompt for the implementing agent"),
            profile: z.string().describe("Agent profile to use, e.g. 'implementer'"),
            files: z.array(z.string()).describe("Files this task will modify"),
            dependencies: z.array(z.string()).describe("Task IDs that must complete first"),
        }),
    ),
    strategy: z.string().describe("High-level implementation strategy"),
});

export type Plan = z.infer<typeof PlanSchema>;

export const PlanReviewSchema = z.object({
    ready: z.boolean().describe("Whether the plan is approved"),
    feedback: z.string().describe("Feedback or approval comments"),
    suggestions: z.array(z.string()).describe("Specific improvements if not ready"),
});

export type PlanReview = z.infer<typeof PlanReviewSchema>;

export const ReviewResultSchema = z.object({
    approved: z.boolean().describe("Whether the implementation is accepted"),
    feedback: z.string().describe("Detailed review feedback"),
    issues: z.array(
        z.object({
            file: z.string().describe("File with the issue"),
            description: z.string().describe("What needs to be fixed"),
            severity: z.enum(["critical", "minor"]).describe("How important the fix is"),
        }),
    ),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const FinalReviewTopicsSchema = z.object({
    topics: z.array(
        z.object({
            topic: z.string().describe("Area to review"),
            files: z.array(z.string()).describe("Files to examine"),
        }),
    ),
    overallAssessment: z.string().describe("General quality assessment"),
    issues: z.array(
        z.object({
            file: z.string(),
            description: z.string(),
            severity: z.enum(["critical", "minor"]),
        }),
    ),
});

export type FinalReviewTopics = z.infer<typeof FinalReviewTopicsSchema>;

// ─── Shared Options ─────────────────────────────────────────────────────────

export interface DevelopWorkflowOptions {
    /** Directory containing agent profile .md files */
    profilesDir: string;
    /** Working directory for the project being developed */
    cwd: string;
    /** Maximum concurrent implementation tasks */
    maxConcurrentTasks?: number;
    /** Custom API keys by provider */
    apiKeys?: Record<string, string>;
    /** Existing workDir to resume from */
    workDir?: string;
}

// ─── Helper: get profile and create harness ─────────────────────────────────

async function getProfile(
    profilesDir: string,
    profileId: string,
): Promise<AgentProfile> {
    const profiles = await loadProfiles(profilesDir);
    const profile = profiles.get(profileId);
    if (!profile) {
        throw new Error(`Profile "${profileId}" not found in ${profilesDir}`);
    }
    return profile;
}

async function makeHarnessOptions(
    profilesDir: string,
    profileId: string,
    cwd: string,
    apiKeys?: Record<string, string>,
): Promise<HarnessCreationOptions> {
    const profile = await getProfile(profilesDir, profileId);
    return { profile, cwd, apiKeys };
}

// ─── Phase 1: Scouting ──────────────────────────────────────────────────────

/**
 * Scout the codebase to identify key areas of investigation.
 *
 * 1. Uses the `scout` profile to identify topics.
 * 2. For each topic, spawns a scout agent in parallel to investigate.
 * 3. Returns the collected reports.
 */
export async function scoutingPhase(
    tracker: WorkflowStatusTracker,
    profilesDir: string,
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
): Promise<unknown[]> {
    // 1. Get scouting topics
    const scoutOpts = await makeHarnessOptions(profilesDir, "scout", cwd, apiKeys);
    const { harness: scoutHarness } = await createHarness(scoutOpts);
    tracker.incrementAgentCount();

    const topicPrompt = [
        "You are a codebase scout. Analyze the task below and identify key areas of the codebase that need investigation.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Respond with a JSON object listing the topics to investigate.",
    ].join("\n");

    const topics = await promptForStructured(scoutHarness, topicPrompt, ScoutingTopicSchema);

    // 2. Spawn parallel scouts for each topic
    const reports: unknown[] = [];

    if (topics.topics.length > 0) {
        const scoutConfigs: HarnessCreationOptions[] = await Promise.all(
            topics.topics.map(async (topic) => {
                const profile = await getProfile(profilesDir, "scout");
                return { profile, cwd, apiKeys };
            }),
        );

        const results = await parallelAgents(
            scoutConfigs,
            (_harness, i) => {
                const topic = topics.topics[i];
                return [
                    `Investigate the following area of the codebase:`,
                    "",
                    `Topic: ${topic.topic}`,
                    `Rationale: ${topic.rationale}`,
                    `Key files: ${topic.files.join(", ")}`,
                    "",
                    "Provide a detailed report of your findings as a JSON object with a 'report' field.",
                ].join("\n");
            },
        );

        for (const result of results) {
            if (result.status === "fulfilled") {
                reports.push(result.value);
            }
        }
    }

    // 3. Update tracker
    tracker.setScoutingReports(reports);
    for (let i = 0; i < reports.length + 1; i++) {
        // +1 for the topic scout harness
        tracker.incrementAgentCount();
    }

    await tracker.auditLog.append({
        type: "structured_output",
        agentId: "scout-coordinator",
        output: topics,
    } as Omit<Extract<AuditEvent, { type: "structured_output" }>, "timestamp">);

    return reports;
}

// ─── Phase 2: Scouting Review ───────────────────────────────────────────────

/**
 * Review the scouting reports and determine if we have enough information
 * to proceed to planning.
 */
export async function scoutingReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDir: string,
    reports: unknown[],
    cwd: string,
    apiKeys?: Record<string, string>,
): Promise<ScoutingReview> {
    const opts = await makeHarnessOptions(profilesDir, "scouting-reviewer", cwd, apiKeys);
    const { harness } = await createHarness(opts);
    tracker.incrementAgentCount();

    const prompt = [
        "You are reviewing scouting reports to determine if we have enough information to create an implementation plan.",
        "",
        "Scouting reports:",
        JSON.stringify(reports, null, 2),
        "",
        "Determine if we're ready to plan. If not, identify what gaps remain.",
    ].join("\n");

    const review = await promptForStructured(harness, prompt, ScoutingReviewSchema);

    await tracker.auditLog.append({
        type: "decision",
        agentId: "scouting-reviewer",
        decision: review.ready ? "proceed_to_planning" : "more_scouting_needed",
        reasoning: review.research,
    } as Omit<Extract<AuditEvent, { type: "decision" }>, "timestamp">);

    return review;
}

// ─── Phase 3: Planning ──────────────────────────────────────────────────────

/**
 * Create an implementation plan based on the scouting research and task prompt.
 */
export async function planningPhase(
    tracker: WorkflowStatusTracker,
    profilesDir: string,
    research: string,
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
): Promise<Plan> {
    const opts = await makeHarnessOptions(profilesDir, "planner", cwd, apiKeys);
    const { harness } = await createHarness(opts);
    tracker.incrementAgentCount();

    const prompt = [
        "You are a planning agent. Based on the research below, create a detailed implementation plan.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Research findings:",
        research,
        "",
        "Create a plan with specific tasks. Each task should be independently implementable.",
    ].join("\n");

    const plan = await promptForStructured(harness, prompt, PlanSchema);

    tracker.setPlan(plan);

    await tracker.auditLog.append({
        type: "structured_output",
        agentId: "planner",
        output: plan,
    } as Omit<Extract<AuditEvent, { type: "structured_output" }>, "timestamp">);

    return plan;
}

// ─── Phase 4: Plan Review ───────────────────────────────────────────────────

/**
 * Review the plan and determine if it's ready for implementation.
 */
export async function planReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDir: string,
    plan: Plan,
    research: string,
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
): Promise<PlanReview> {
    const opts = await makeHarnessOptions(profilesDir, "plan-reviewer", cwd, apiKeys);
    const { harness } = await createHarness(opts);
    tracker.incrementAgentCount();

    const prompt = [
        "You are reviewing an implementation plan. Evaluate it for completeness, correctness, and feasibility.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Research context:",
        research,
        "",
        "Proposed plan:",
        JSON.stringify(plan, null, 2),
        "",
        "Approve the plan if it's sound, or provide specific feedback for improvement.",
    ].join("\n");

    const review = await promptForStructured(harness, prompt, PlanReviewSchema);

    await tracker.auditLog.append({
        type: "decision",
        agentId: "plan-reviewer",
        decision: review.ready ? "plan_approved" : "plan_rejected",
        reasoning: review.feedback,
    } as Omit<Extract<AuditEvent, { type: "decision" }>, "timestamp">);

    return review;
}

// ─── Phase 5: Implementation ────────────────────────────────────────────────

/**
 * Execute the implementation plan by:
 * 1. Loading tasks into the tracker
 * 2. Claiming and dispatching tasks to implementers
 * 3. Reviewing completed tasks
 * 4. Accepting or rejecting based on review
 */
export async function implementationPhase(
    tracker: WorkflowStatusTracker,
    profilesDir: string,
    plan: Plan,
    cwd: string,
    maxConcurrentTasks: number = 3,
    apiKeys?: Record<string, string>,
): Promise<void> {
    // 1. Load plan tasks into the tracker
    for (const task of plan.tasks) {
        tracker.taskTracker.addTask({
            id: task.id,
            title: task.title,
            prompt: task.prompt,
            profile: task.profile,
            files: task.files,
            dependencies: task.dependencies,
        });
    }

    // 2. Main implementation loop
    const maxIterations = plan.tasks.length * 3; // Safety bound
    let iteration = 0;

    while (!tracker.taskTracker.areAllDone() && iteration < maxIterations) {
        iteration++;

        // 2a. Claim available tasks
        const claimed = tracker.taskTracker.claimTasks(maxConcurrentTasks);
        if (claimed.length === 0) {
            // No tasks ready — break to avoid infinite loop
            break;
        }

        // 2b. Create implementer configs and run in parallel
        const implConfigs: HarnessCreationOptions[] = await Promise.all(
            claimed.map(async (task) => {
                const profile = await getProfile(profilesDir, task.profile);
                return { profile, cwd, apiKeys };
            }),
        );

        for (const task of claimed) {
            tracker.taskTracker.startTask(task.id, `implementer-${task.id}`);
            tracker.incrementAgentCount();
        }

        const implResults = await parallelAgents(
            implConfigs,
            (_harness, i) => {
                const task = claimed[i];
                return [
                    `You are an implementation agent. Complete the following task:`,
                    "",
                    `Title: ${task.title}`,
                    `Files to modify: ${task.files.join(", ")}`,
                    "",
                    task.prompt,
                ].join("\n");
            },
        );

        // 2c. Submit each result for review
        for (let i = 0; i < implResults.length; i++) {
            const task = claimed[i];
            const result = implResults[i];

            if (result.status === "fulfilled") {
                tracker.taskTracker.submitForReview(task.id, result.value);
            } else {
                // Implementation failed — submit with error
                tracker.taskTracker.submitForReview(task.id, {
                    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                });
            }
        }

        // 2d. Review completed tasks in parallel
        const reviewingTasks = claimed.filter((task) => {
            const taskObj = tracker.taskTracker.getTask(task.id);
            return taskObj && taskObj.status === "reviewing";
        });

        const reviewerHarnesses = await Promise.all(
            reviewingTasks.map(async (task) => {
                const reviewerOpts = await makeHarnessOptions(profilesDir, "implement-reviewer", cwd, apiKeys);
                const result = await createHarness(reviewerOpts);
                tracker.incrementAgentCount();
                return { task, harness: result.harness };
            }),
        );

        const reviewPromises = reviewerHarnesses.map(
            async ({ task, harness: reviewerHarness }) => {
                const taskObj = tracker.taskTracker.getTask(task.id)!;
                const reviewPrompt = [
                    "You are a code reviewer. Evaluate the following implementation result.",
                    "",
                    `Task: ${task.title}`,
                    `Files modified: ${task.files.join(", ")}`,
                    "",
                    "Implementation result:",
                    JSON.stringify(taskObj.result, null, 2),
                    "",
                    "Determine if the implementation is correct and complete.",
                ].join("\n");

                return {
                    task,
                    review: await promptForStructured(reviewerHarness, reviewPrompt, ReviewResultSchema),
                };
            },
        );

        const reviewSettled = await Promise.allSettled(reviewPromises);

        for (const settled of reviewSettled) {
            if (settled.status === "fulfilled") {
                const { task, review } = settled.value;

                await tracker.auditLog.append({
                    type: "decision",
                    agentId: `reviewer-${task.id}`,
                    decision: review.approved ? "approved" : "rejected",
                    reasoning: review.feedback,
                    taskId: task.id,
                } as Omit<Extract<AuditEvent, { type: "decision" }>, "timestamp">);

                if (review.approved) {
                    tracker.taskTracker.completeTask(task.id);
                } else {
                    tracker.taskTracker.rejectTask(task.id, review.feedback);
                }
            } else {
                // Review itself failed — find which task this was
                const failedTask = reviewingTasks.find((task) =>
                    !reviewSettled.some(
                        (r) =>
                            r.status === "fulfilled" &&
                            (r.value as { task: { id: string } }).task.id === task.id,
                    ),
                );
                const taskId = failedTask?.id ?? "unknown";
                const errorMessage = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);

                await tracker.auditLog.append({
                    type: "error",
                    agentId: `reviewer-${taskId}`,
                    error: `Review failed: ${errorMessage}`,
                    taskId,
                } as Omit<Extract<AuditEvent, { type: "error" }>, "timestamp">);

                if (failedTask) {
                    tracker.taskTracker.completeTask(failedTask.id);
                }
            }
        }
    }
}

// ─── Phase 6: Final Review ──────────────────────────────────────────────────

/**
 * Perform a final quality review of the entire implementation.
 * Spawns fixers for any issues found and loops until clean.
 */
export async function finalReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDir: string,
    cwd: string,
    apiKeys?: Record<string, string>,
): Promise<boolean> {
    const maxFixRounds = 3;
    let clean = false;

    for (let round = 0; round < maxFixRounds; round++) {
        // 1. Get final review assessment
        const reviewerOpts = await makeHarnessOptions(profilesDir, "final-reviewer", cwd, apiKeys);
        const { harness: reviewerHarness } = await createHarness(reviewerOpts);
        tracker.incrementAgentCount();

        const reviewPrompt = [
            "You are performing a final quality review of the codebase.",
            "",
            "Examine the files and identify any remaining issues.",
            "Respond with your assessment of overall quality and specific issues found.",
        ].join("\n");

        const assessment = await promptForStructured(reviewerHarness, reviewPrompt, FinalReviewTopicsSchema);

        await tracker.auditLog.append({
            type: "structured_output",
            agentId: "final-reviewer",
            output: assessment,
        } as Omit<Extract<AuditEvent, { type: "structured_output" }>, "timestamp">);

        if (assessment.issues.length === 0) {
            clean = true;
            break;
        }

        // 2. Spawn fixers for critical issues
        const criticalIssues = assessment.issues.filter((issue) => issue.severity === "critical");
        if (criticalIssues.length === 0) {
            clean = true;
            break;
        }

        const fixerConfigs: HarnessCreationOptions[] = await Promise.all(
            criticalIssues.map(async () => {
                const profile = await getProfile(profilesDir, "fixer");
                return { profile, cwd, apiKeys };
            }),
        );

        await parallelAgents(
            fixerConfigs,
            (_harness, i) => {
                const issue = criticalIssues[i];
                return [
                    "You are a fix agent. Resolve the following issue:",
                    "",
                    `File: ${issue.file}`,
                    `Issue: ${issue.description}`,
                    "",
                    "Apply the necessary fix.",
                ].join("\n");
            },
        );

        for (let i = 0; i < criticalIssues.length; i++) {
            tracker.incrementAgentCount();
        }
    }

    return clean;
}

// ─── Orchestrator: run ───────────────────────────────────────────────────────

export interface RunOptions extends DevelopWorkflowOptions {
    /** Directory to store workflow state */
    workDir: string;
}

/**
 * Run the full development workflow:
 * 1. Scouting (up to 3 rounds)
 * 2. Planning (up to 3 rounds)
 * 3. Implementation
 * 4. Final review
 */
export async function run(
    taskPrompt: string,
    options: RunOptions,
): Promise<void> {
    const { profilesDir, cwd, maxConcurrentTasks, apiKeys, workDir } = options;

    // Create or load tracker
    let tracker: WorkflowStatusTracker;
    try {
        tracker = await (await import("../tracking/workflow-status")).WorkflowStatusTracker.load(workDir);
    } catch {
        const { WorkflowStatusTracker: WST } = await import("../tracking/workflow-status");
        tracker = new WST(workDir);
    }

    tracker.setTaskPrompt(taskPrompt);
    await tracker.save();

    // ── Ordered pipeline phases ─────────────────────────────────────
    // Each handler does exactly ONE step. The outer loop handles
    // advancing phases and looping back when needed (e.g. scouting
    // retries). A handler may return the name of a phase to jump to
    // instead of advancing linearly.

    type Phase =
        | "scouting"
        | "scouting_review"
        | "planning"
        | "plan_review"
        | "implementing"
        | "final_review"
        | "done";

    const phaseOrder: Phase[] = [
        "scouting", "scouting_review",
        "planning", "plan_review",
        "implementing", "final_review", "done",
    ];

    // Shared mutable state that flows between phases
    let research = "";
    let plan: Plan | undefined;
    let scoutingReports: unknown[] = [];
    let scoutingRounds = 0;
    let planningRounds = 0;

    const handlePhase = async (phase: Phase): Promise<Phase | void> => {
        switch (phase) {
            // ── Scouting: run scouts, then advance to scouting_review ──
            case "scouting": {
                scoutingReports = await scoutingPhase(
                    tracker, profilesDir, taskPrompt, cwd, apiKeys,
                );
                tracker.advancePhase(); // → scouting_review
                await tracker.save();
                break;
            }

            // ── Scouting Review: evaluate reports, loop back if needed ──
            case "scouting_review": {
                const reports = scoutingReports.length > 0
                    ? scoutingReports
                    : tracker.scoutingReports;
                const review = await scoutingReviewPhase(
                    tracker, profilesDir, reports, cwd, apiKeys,
                );
                scoutingRounds++;

                if (review.ready) {
                    research = review.research;
                    tracker.advancePhase(); // → planning
                    await tracker.save();
                    break;
                }

                // Not ready — loop back to scouting (max 3 rounds)
                if (scoutingRounds < 3) {
                    tracker.setPhase("scouting");
                    await tracker.save();
                    return "scouting";
                }

                // Exhausted rounds — proceed anyway with what we have
                research = review.research;
                tracker.advancePhase(); // → planning
                await tracker.save();
                break;
            }

            // ── Planning: create a plan, then advance to plan_review ──
            case "planning": {
                // Derive research from saved scouting reports if not yet available
                if (!research) {
                    const reports = tracker.scoutingReports;
                    const review = await scoutingReviewPhase(
                        tracker, profilesDir, reports, cwd, apiKeys,
                    );
                    research = review.research;
                }

                plan = await planningPhase(
                    tracker, profilesDir, research, taskPrompt, cwd, apiKeys,
                );
                tracker.advancePhase(); // → plan_review
                await tracker.save();
                break;
            }

            // ── Plan Review: evaluate the plan, loop back if needed ──
            case "plan_review": {
                if (!plan) {
                    plan = tracker.plan as Plan | undefined;
                }

                const planReview = await planReviewPhase(
                    tracker, profilesDir, plan!, research, taskPrompt, cwd, apiKeys,
                );
                planningRounds++;

                if (planReview.ready) {
                    tracker.advancePhase(); // → implementing
                    await tracker.save();
                    break;
                }

                // Not ready — loop back to planning (max 3 rounds)
                plan = undefined;
                if (planningRounds < 3) {
                    tracker.setPhase("planning");
                    await tracker.save();
                    return "planning";
                }

                // Exhausted rounds — proceed anyway with current plan
                tracker.advancePhase(); // → implementing
                await tracker.save();
                break;
            }

            // ── Implementation: run the plan tasks ──
            case "implementing": {
                if (plan) {
                    await implementationPhase(
                        tracker, profilesDir, plan, cwd, maxConcurrentTasks, apiKeys,
                    );
                }
                tracker.advancePhase(); // → final_review
                await tracker.save();
                break;
            }

            // ── Final Review: quality check the result ──
            case "final_review": {
                await finalReviewPhase(tracker, profilesDir, cwd, apiKeys);
                tracker.advancePhase(); // → done
                await tracker.save();
                break;
            }

            case "done":
                break;
        }
    };

    // ── Execute phases from the starting point ──────────────────────
    let currentIndex = phaseOrder.indexOf(tracker.currentPhase as Phase);
    if (currentIndex < 0) currentIndex = 0;

    while (currentIndex < phaseOrder.length) {
        const phase = phaseOrder[currentIndex];
        if (phase === "done") break;

        const jumpTo = await handlePhase(phase);

        if (jumpTo) {
            currentIndex = phaseOrder.indexOf(jumpTo);
        } else {
            currentIndex++;
        }
    }
}
