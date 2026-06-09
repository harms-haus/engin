// ─── Development Workflow ────────────────────────────────────────────────────
import { z } from "zod";
import type { AgentProfile, AgentStatusCallbacks, HarnessCreationOptions, StatusCallbacks } from "../core/types";
import { loadProfilesFromDirs } from "../core/profile";
import { resolveProfilesDirs } from "../core/config";
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
    profilesDir?: string;
    /** Working directory for the project being developed */
    cwd: string;
    /** Maximum concurrent implementation tasks */
    maxConcurrentTasks?: number;
    /** Custom API keys by provider */
    apiKeys?: Record<string, string>;
    /** Status callbacks for agent/workflow events */
    onStatus?: StatusCallbacks;
    /** Existing workDir to resume from */
    workDir?: string;
}

// ─── Audit Event Helpers ─────────────────────────────────────────────────

function structuredOutputEvent(
    agentId: string,
    output: unknown,
    taskId?: string,
): Omit<Extract<AuditEvent, { type: "structured_output" }>, "timestamp"> {
    return { type: "structured_output", agentId, output, ...(taskId && { taskId }) };
}

function decisionEvent(
    agentId: string,
    decision: string,
    reasoning: string,
    taskId?: string,
): Omit<Extract<AuditEvent, { type: "decision" }>, "timestamp"> {
    return { type: "decision", agentId, decision, reasoning, ...(taskId && { taskId }) };
}

function errorEvent(
    agentId: string,
    error: string,
    taskId?: string,
): Omit<Extract<AuditEvent, { type: "error" }>, "timestamp"> {
    return { type: "error", agentId, error, ...(taskId && { taskId }) };
}

// ─── Helper: get profile and create harness ─────────────────────────────────

async function getProfile(
    profilesDirs: string[],
    profileId: string,
): Promise<AgentProfile> {
    const profiles = await loadProfilesFromDirs(profilesDirs);
    const profile = profiles.get(profileId);
    if (!profile) {
        throw new Error(`Profile "${profileId}" not found in ${profilesDirs.join(", ")}`);
    }
    return profile;
}

function agentCallbacks(onStatus?: StatusCallbacks): AgentStatusCallbacks | undefined {
    if (!onStatus) return undefined;
    return {
        onTurnStart: onStatus.onTurnStart,
        onTurnEnd: onStatus.onTurnEnd,
        onToolCallStart: onStatus.onToolCallStart,
        onToolCallEnd: onStatus.onToolCallEnd,
    };
}

async function makeHarnessOptions(
    profilesDirs: string[],
    profileId: string,
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<HarnessCreationOptions> {
    const profile = await getProfile(profilesDirs, profileId);
    return { profile, cwd, apiKeys, onAgentStatus: agentCallbacks(onStatus) };
}

// ─── Phase type (shared by run(), completePhase, executePhase) ────────────

type Phase =
    | "scouting"
    | "scouting_review"
    | "planning"
    | "plan_review"
    | "implementing"
    | "final_review"
    | "done";

const PHASE_ORDER: Phase[] = [
    "scouting", "scouting_review",
    "planning", "plan_review",
    "implementing", "final_review", "done",
];

/**
 * Mutable state shared across phase executions within a single `run()` call.
 * Passed by reference so `executePhase` mutations are visible to the caller.
 */
interface RunState {
    research: string;
    plan: Plan | undefined;
    scoutingReports: unknown[];
    scoutingRounds: number;
    planningRounds: number;
}

// ─── Helper: complete a phase transition ────────────────────────────────────

async function completePhase(
    phase: Phase,
    tracker: WorkflowStatusTracker,
    onStatus: StatusCallbacks | undefined,
    startTime: number,
    nextPhase?: Phase,
): Promise<void> {
    if (nextPhase !== undefined) {
        tracker.setPhase(nextPhase);
    } else {
        tracker.advancePhase();
    }
    await tracker.save();
    onStatus?.onPhaseComplete?.({ phase, durationMs: Date.now() - startTime });
}

// ─── Helper: execute a single pipeline phase ───────────────────────────────

/**
 * Execute a single pipeline phase.
 *
 * Each case does exactly ONE step. The caller (`run`) handles advancing
 * phases and looping back when needed (e.g. scouting retries). May return
 * the name of a phase to jump to instead of advancing linearly.
 */
async function executePhase(
    phase: Phase,
    state: RunState,
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    taskPrompt: string,
    cwd: string,
    maxConcurrentTasks: number | undefined,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<Phase | void> {
    const phaseStartTime = Date.now();
    const round = (phase === "scouting" || phase === "scouting_review")
        ? state.scoutingRounds
        : (phase === "planning" || phase === "plan_review")
            ? state.planningRounds
            : 0;
    onStatus?.onPhaseStart?.({ phase, round });

    switch (phase) {
        // ── Scouting: run scouts, then advance to scouting_review ──
        case "scouting": {
            state.scoutingReports = await scoutingPhase(
                tracker, profilesDirs, taskPrompt, cwd, apiKeys, onStatus,
            );
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Scouting Review: evaluate reports, loop back if needed ──
        case "scouting_review": {
            const reports = state.scoutingReports.length > 0
                ? state.scoutingReports
                : tracker.scoutingReports;
            const review = await scoutingReviewPhase(
                tracker, profilesDirs, reports, cwd, apiKeys, onStatus,
            );
            state.scoutingRounds++;

            state.research = review.research;
            tracker.setResearch(state.research);

            if (review.ready) {
                await completePhase(phase, tracker, onStatus, phaseStartTime);
                break;
            }

            // Not ready — loop back to scouting (max 3 rounds)
            if (state.scoutingRounds < 3) {
                await completePhase(phase, tracker, onStatus, phaseStartTime, "scouting");
                return "scouting";
            }

            // Exhausted rounds — proceed anyway with what we have
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Planning: create a plan, then advance to plan_review ──
        case "planning": {
            // Derive research from saved scouting reports if not yet available
            if (!state.research) {
                if (tracker.research) {
                    state.research = tracker.research;
                } else {
                    const reports = tracker.scoutingReports;
                    const review = await scoutingReviewPhase(
                        tracker, profilesDirs, reports, cwd, apiKeys, onStatus,
                    );
                    state.research = review.research;
                    tracker.setResearch(state.research);
                }
            }

            state.plan = await planningPhase(
                tracker, profilesDirs, state.research, taskPrompt, cwd, apiKeys, onStatus,
            );
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Plan Review: evaluate the plan, loop back if needed ──
        case "plan_review": {
            if (!state.plan) {
                state.plan = tracker.plan as Plan | undefined;
            }

            const planReview = await planReviewPhase(
                tracker, profilesDirs, state.plan!, state.research, taskPrompt, cwd, apiKeys, onStatus,
            );
            state.planningRounds++;

            if (planReview.ready) {
                await completePhase(phase, tracker, onStatus, phaseStartTime);
                break;
            }

            // Not ready — loop back to planning (max 3 rounds)
            state.plan = undefined;
            if (state.planningRounds < 3) {
                await completePhase(phase, tracker, onStatus, phaseStartTime, "planning");
                return "planning";
            }

            // Exhausted rounds — proceed anyway with current plan
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Implementation: run the plan tasks ──
        case "implementing": {
            if (state.plan) {
                await implementationPhase(
                    tracker, profilesDirs, state.plan, cwd, maxConcurrentTasks, apiKeys, onStatus,
                );
            }
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Final Review: quality check the result ──
        case "final_review": {
            await finalReviewPhase(tracker, profilesDirs, cwd, apiKeys, onStatus);
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        case "done":
            break;
    }
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
    profilesDirs: string[],
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<unknown[]> {
    // 1. Get scouting topics
    const scoutOpts = await makeHarnessOptions(profilesDirs, "scout", cwd, apiKeys, onStatus);
    const { harness: scoutHarness, unsubscribe: scoutUnsub } = await createHarness(scoutOpts);
    onStatus?.onAgentSpawn?.({ agentId: "scout-coordinator", profile: "scout", phase: "scouting" });
    tracker.incrementAgentCount();

    let topics: ScoutingTopics;
    try {
        const topicPrompt = [
            "You are a codebase scout. Analyze the task below and identify key areas of the codebase that need investigation.",
            "",
            `Task: ${taskPrompt}`,
            "",
            "Respond with a JSON object listing the topics to investigate.",
        ].join("\n");

        topics = await promptForStructured(scoutHarness, topicPrompt, ScoutingTopicSchema);
    } finally {
        scoutUnsub?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "scout-coordinator", profile: "scout", phase: "scouting" });

    // 2. Spawn parallel scouts for each topic
    const reports: unknown[] = [];

    if (topics.topics.length > 0) {
        for (let i = 0; i < topics.topics.length; i++) {
            onStatus?.onAgentSpawn?.({ agentId: `scout-${i}`, profile: "scout", phase: "scouting" });
            tracker.incrementAgentCount();
        }

        const scoutProfile = await getProfile(profilesDirs, "scout");
        const scoutConfigs: HarnessCreationOptions[] = topics.topics.map(() => ({
            profile: scoutProfile,
            cwd,
            apiKeys,
            onAgentStatus: agentCallbacks(onStatus),
        }));

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

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === "fulfilled") {
                reports.push(result.value);
                onStatus?.onAgentComplete?.({ agentId: `scout-${i}`, profile: "scout", phase: "scouting" });
            }
        }
    }

    // 3. Update tracker
    tracker.setScoutingReports(reports);

    await tracker.auditLog.append(
        structuredOutputEvent("scout-coordinator", topics),
    );

    return reports;
}

// ─── Phase 2: Scouting Review ───────────────────────────────────────────────

/**
 * Review the scouting reports and determine if we have enough information
 * to proceed to planning.
 */
export async function scoutingReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    reports: unknown[],
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<ScoutingReview> {
    const opts = await makeHarnessOptions(profilesDirs, "scouting-reviewer", cwd, apiKeys, onStatus);
    const { harness, unsubscribe } = await createHarness(opts);
    onStatus?.onAgentSpawn?.({ agentId: "scouting-reviewer", profile: "scouting-reviewer", phase: "scouting_review" });
    tracker.incrementAgentCount();

    const prompt = [
        "You are reviewing scouting reports to determine if we have enough information to create an implementation plan.",
        "",
        "Scouting reports:",
        JSON.stringify(reports, null, 2),
        "",
        "Determine if we're ready to plan. If not, identify what gaps remain.",
    ].join("\n");

    let review: ScoutingReview;
    try {
        review = await promptForStructured(harness, prompt, ScoutingReviewSchema);
    } finally {
        unsubscribe?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "scouting-reviewer", profile: "scouting-reviewer", phase: "scouting_review" });

    onStatus?.onDecision?.({
        agentId: "scouting-reviewer",
        decision: review.ready ? "proceed_to_planning" : "more_scouting_needed",
        reasoning: review.research,
    });

    await tracker.auditLog.append(
        decisionEvent(
            "scouting-reviewer",
            review.ready ? "proceed_to_planning" : "more_scouting_needed",
            review.research,
        ),
    );

    return review;
}

// ─── Phase 3: Planning ──────────────────────────────────────────────────────

/**
 * Create an implementation plan based on the scouting research and task prompt.
 */
export async function planningPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    research: string,
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<Plan> {
    const opts = await makeHarnessOptions(profilesDirs, "planner", cwd, apiKeys, onStatus);
    const { harness, unsubscribe } = await createHarness(opts);
    onStatus?.onAgentSpawn?.({ agentId: "planner", profile: "planner", phase: "planning" });
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

    let plan: Plan;
    try {
        plan = await promptForStructured(harness, prompt, PlanSchema);
    } finally {
        unsubscribe?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "planner", profile: "planner", phase: "planning" });

    tracker.setPlan(plan);

    await tracker.auditLog.append(
        structuredOutputEvent("planner", plan),
    );

    return plan;
}

// ─── Phase 4: Plan Review ───────────────────────────────────────────────────

/**
 * Review the plan and determine if it's ready for implementation.
 */
export async function planReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    plan: Plan,
    research: string,
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<PlanReview> {
    const opts = await makeHarnessOptions(profilesDirs, "plan-reviewer", cwd, apiKeys, onStatus);
    const { harness, unsubscribe } = await createHarness(opts);
    onStatus?.onAgentSpawn?.({ agentId: "plan-reviewer", profile: "plan-reviewer", phase: "plan_review" });
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

    let review: PlanReview;
    try {
        review = await promptForStructured(harness, prompt, PlanReviewSchema);
    } finally {
        unsubscribe?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "plan-reviewer", profile: "plan-reviewer", phase: "plan_review" });

    onStatus?.onDecision?.({
        agentId: "plan-reviewer",
        decision: review.ready ? "plan_approved" : "plan_rejected",
        reasoning: review.feedback,
    });

    await tracker.auditLog.append(
        decisionEvent(
            "plan-reviewer",
            review.ready ? "plan_approved" : "plan_rejected",
            review.feedback,
        ),
    );

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
    profilesDirs: string[],
    plan: Plan,
    cwd: string,
    maxConcurrentTasks: number = 3,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
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
                const profile = await getProfile(profilesDirs, task.profile);
                return { profile, cwd, apiKeys, onAgentStatus: agentCallbacks(onStatus) };
            }),
        );

        for (const task of claimed) {
            tracker.taskTracker.startTask(task.id, `implementer-${task.id}`);
            onStatus?.onTaskStart?.({ taskId: task.id, title: task.title, agentId: `implementer-${task.id}` });
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
                const reviewerOpts = await makeHarnessOptions(profilesDirs, "implement-reviewer", cwd, apiKeys, onStatus);
                const { harness, unsubscribe } = await createHarness(reviewerOpts);
                onStatus?.onAgentSpawn?.({ agentId: `reviewer-${task.id}`, profile: "implement-reviewer", phase: "implementing", taskId: task.id });
                tracker.incrementAgentCount();
                return { task, harness, unsubscribe };
            }),
        );

        const reviewPromises = reviewerHarnesses.map(
            async ({ task, harness: reviewerHarness, unsubscribe: reviewerUnsub }) => {
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

                let reviewResult: ReviewResult;
                try {
                    reviewResult = await promptForStructured(reviewerHarness, reviewPrompt, ReviewResultSchema);
                } finally {
                    reviewerUnsub?.();
                }
                onStatus?.onAgentComplete?.({ agentId: `reviewer-${task.id}`, profile: "implement-reviewer", phase: "implementing", taskId: task.id });

                return {
                    task,
                    review: reviewResult,
                };
            },
        );

        const reviewSettled = await Promise.allSettled(reviewPromises);

        const auditPromises: Promise<void>[] = [];
        for (let i = 0; i < reviewSettled.length; i++) {
            const settled = reviewSettled[i];
            const task = reviewingTasks[i];

            if (settled.status === "fulfilled") {
                const { review } = settled.value;

                auditPromises.push(
                    tracker.auditLog.append(
                        decisionEvent(
                            `reviewer-${task.id}`,
                            review.approved ? "approved" : "rejected",
                            review.feedback,
                            task.id,
                        ),
                    ),
                );

                if (review.approved) {
                    tracker.taskTracker.completeTask(task.id);
                    onStatus?.onTaskComplete?.({ taskId: task.id, title: task.title });
                } else {
                    tracker.taskTracker.rejectTask(task.id, review.feedback);
                    onStatus?.onTaskRejected?.({ taskId: task.id, title: task.title, reason: review.feedback });
                }
            } else {
                // Review itself failed — task is known via index
                const errorMessage = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);

                onStatus?.onError?.({ agentId: `reviewer-${task.id}`, error: errorMessage, phase: "implementing", taskId: task.id });

                auditPromises.push(
                    tracker.auditLog.append(
                        errorEvent(
                            `reviewer-${task.id}`,
                            `Review failed: ${errorMessage}`,
                            task.id,
                        ),
                    ),
                );

                tracker.taskTracker.completeTask(task.id);
            }
        }
        await Promise.all(auditPromises);
    }
}

// ─── Phase 6: Final Review ──────────────────────────────────────────────────

/**
 * Perform a final quality review of the entire implementation.
 * Spawns fixers for any issues found and loops until clean.
 */
export async function finalReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<boolean> {
    const maxFixRounds = 3;
    let clean = false;

    for (let round = 0; round < maxFixRounds; round++) {
        // 1. Get final review assessment
        const reviewerOpts = await makeHarnessOptions(profilesDirs, "final-reviewer", cwd, apiKeys, onStatus);
        const { harness: reviewerHarness, unsubscribe: reviewerUnsub } = await createHarness(reviewerOpts);
        onStatus?.onAgentSpawn?.({ agentId: "final-reviewer", profile: "final-reviewer", phase: "final_review" });
        tracker.incrementAgentCount();

        const reviewPrompt = [
            "You are performing a final quality review of the codebase.",
            "",
            "Examine the files and identify any remaining issues.",
            "Respond with your assessment of overall quality and specific issues found.",
        ].join("\n");

        let assessment: FinalReviewTopics;
        try {
            assessment = await promptForStructured(reviewerHarness, reviewPrompt, FinalReviewTopicsSchema);
        } finally {
            reviewerUnsub?.();
        }
        onStatus?.onAgentComplete?.({ agentId: "final-reviewer", profile: "final-reviewer", phase: "final_review" });

        await tracker.auditLog.append(
            structuredOutputEvent("final-reviewer", assessment),
        );

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
                const profile = await getProfile(profilesDirs, "fixer");
                return { profile, cwd, apiKeys, onAgentStatus: agentCallbacks(onStatus) };
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
    const { profilesDir, cwd, maxConcurrentTasks, apiKeys, workDir, onStatus } = options;
    const profilesDirs: string[] = options.profilesDir ? [options.profilesDir] : resolveProfilesDirs(options.cwd);
    const workflowStartTime = Date.now();

    // Create or load tracker
    let tracker: WorkflowStatusTracker;
    let resumed: boolean;
    try {
        tracker = await (await import("../tracking/workflow-status")).WorkflowStatusTracker.load(workDir);
        resumed = true;
    } catch (err: unknown) {
        // Only catch "file not found" — any other error (corruption, permissions) must propagate.
        // WorkflowStatusTracker.load wraps ENOENT as a plain Error with this message.
        const isNotFound =
            err instanceof Error && err.message.startsWith("Workflow state file not found");
        if (isNotFound) {
            const { WorkflowStatusTracker: WST } = await import("../tracking/workflow-status");
            tracker = new WST(workDir);
            resumed = false;
        } else {
            throw err;
        }
    }

    tracker.setTaskPrompt(taskPrompt);
    await tracker.save();

    onStatus?.onWorkflowStart?.({ taskPrompt, resumed, workDir });

    // ── Shared mutable state that flows between phases ────────────────
    const state: RunState = {
        research: tracker.research ?? "",
        plan: undefined,
        scoutingReports: [],
        scoutingRounds: 0,
        planningRounds: 0,
    };

    // ── Execute phases from the starting point ──────────────────────
    let currentIndex = PHASE_ORDER.indexOf(tracker.currentPhase as Phase);
    if (currentIndex < 0) currentIndex = 0;

    try {
        while (currentIndex < PHASE_ORDER.length) {
            const phase = PHASE_ORDER[currentIndex];
            if (phase === "done") break;

            const jumpTo = await executePhase(
                phase, state, tracker, profilesDirs, taskPrompt, cwd, maxConcurrentTasks, apiKeys, onStatus,
            );

            if (jumpTo) {
                currentIndex = PHASE_ORDER.indexOf(jumpTo);
            } else {
                currentIndex++;
            }
        }
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        onStatus?.onWorkflowFailed?.({ error: err, phase: tracker.currentPhase });
        throw error;
    }

    onStatus?.onWorkflowComplete?.({ totalDurationMs: Date.now() - workflowStartTime, agentCount: tracker.stats.agentCount });
}
