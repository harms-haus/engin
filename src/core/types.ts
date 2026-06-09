// ─── Re-exports from @earendil-works/pi-agent-core ─────────────────────────
import type {
    AgentHarness,
    AgentHarnessOptions,
    AgentMessage,
    AgentTool,
    ExecutionEnv,
    InMemorySessionRepo,
    JsonlSessionRepo,
    PromptTemplate,
    QueueMode,
    Session,
    SessionTreeEntry,
    Skill,
    ThinkingLevel,
} from "@earendil-works/pi-agent-core";

export type {
    AgentHarness,
    AgentHarnessOptions,
    AgentMessage,
    AgentTool,
    ExecutionEnv,
    InMemorySessionRepo,
    JsonlSessionRepo,
    PromptTemplate,
    QueueMode,
    Session,
    SessionTreeEntry,
    Skill,
    ThinkingLevel,
};

// ─── Re-exports from @earendil-works/pi-ai ─────────────────────────────────
export type { Model } from "@earendil-works/pi-ai";
export { getModel, getEnvApiKey, parseJsonWithRepair } from "@earendil-works/pi-ai";

// ─── Agent Profile ──────────────────────────────────────────────────────────
export interface AgentProfile {
    id: string;
    name: string;
    provider: string;
    model: string;
    thinkingLevel: ThinkingLevel;
    systemPrompt: string;
    excludeTools: string[];
    includeTools: string[];
}

// ─── Task Tracking ──────────────────────────────────────────────────────────
export type TaskStatus =
    | "blocked"
    | "ready"
    | "claimed"
    | "implementing"
    | "reviewing"
    | "done";

export interface Task {
    id: string;
    title: string;
    prompt: string;
    profile: string;
    files: string[];
    dependencies: string[];
    status: TaskStatus;
    assignedAgent?: string;
    result?: unknown;
    reviewFeedback?: string;
}

// ─── Workflow Phases ────────────────────────────────────────────────────────
export type WorkflowPhase =
    | "scouting"
    | "scouting_review"
    | "planning"
    | "plan_review"
    | "implementing"
    | "final_review"
    | "done";

export interface WorkflowState {
    taskPrompt: string;
    currentPhase: WorkflowPhase;
    completedPhases: WorkflowPhase[];
    tasks: Task[];
    /** Scouting reports stored as opaque values; typed as ScoutingTopics in develop.ts */
    scoutingReports: unknown[];
    /** Plan stored as opaque value; typed as Plan in develop.ts */
    plan: unknown;
    research?: string;
    stats: {
        totalTokens: number;
        totalCost: number;
        agentCount: number;
    };
}

// ─── Audit Events ───────────────────────────────────────────────────────────
export type AuditEvent =
    | { type: "agent_start"; agentId: string; profile: AgentProfile; taskId?: string; timestamp: string }
    | { type: "agent_end"; agentId: string; result: unknown; taskId?: string; timestamp: string }
    | { type: "decision"; agentId: string; decision: string; reasoning: string; taskId?: string; timestamp: string }
    | { type: "structured_output"; agentId: string; output: unknown; taskId?: string; timestamp: string }
    | { type: "error"; agentId: string; error: string; taskId?: string; timestamp: string };

// ─── Structured Output ──────────────────────────────────────────────────────
export interface StructuredOutputOptions {
    maxRetries: number;
    retryPrompt?: string;
}

// ─── Status Callbacks ──────────────────────────────────────────────────────
export interface WorkflowStatusCallbacks {
    onWorkflowStart?: (info: { taskPrompt: string; resumed: boolean; workDir: string }) => void;
    onPhaseStart?: (info: { phase: WorkflowPhase; round: number }) => void;
    onPhaseComplete?: (info: { phase: WorkflowPhase; durationMs: number }) => void;
    onAgentSpawn?: (info: { agentId: string; profile: string; phase: string; taskId?: string }) => void;
    onAgentComplete?: (info: { agentId: string; profile: string; phase: string; taskId?: string }) => void;
    onTaskStart?: (info: { taskId: string; title: string; agentId: string }) => void;
    onTaskComplete?: (info: { taskId: string; title: string }) => void;
    onTaskRejected?: (info: { taskId: string; title: string; reason: string }) => void;
    onDecision?: (info: { agentId: string; decision: string; reasoning: string; taskId?: string }) => void;
    onError?: (info: { agentId: string; error: string; phase: string; taskId?: string }) => void;
    onWorkflowComplete?: (info: { totalDurationMs: number; agentCount: number }) => void;
    onWorkflowFailed?: (info: { error: Error; phase: string }) => void;
}

export interface AgentStatusCallbacks {
    onTurnStart?: (info: { agentId: string; turn: number }) => void;
    onTurnEnd?: (info: { agentId: string; turn: number; tokens?: { input: number; output: number } }) => void;
    onToolCallStart?: (info: { agentId: string; toolName: string; toolCallId: string }) => void;
    onToolCallEnd?: (info: { agentId: string; toolName: string; toolCallId: string; isError: boolean }) => void;
}

export type StatusCallbacks = WorkflowStatusCallbacks & AgentStatusCallbacks;

// ─── Agent Loop Result ──────────────────────────────────────────────────────
export interface AgentLoopResult<T> {
    result: T;
    attempts: number;
    totalTokens: { input: number; output: number };
}

// ─── Workflow Run Options ──────────────────────────────────────────────────
export interface WorkflowRunOptions {
    cwd: string;
    workDir: string;
    maxConcurrentTasks?: number;
    apiKeys?: Record<string, string>;
    onStatus?: StatusCallbacks;
}

// ─── Workflow Module ────────────────────────────────────────────────────────
export interface WorkflowModule {
    run(taskPrompt: string, options: WorkflowRunOptions): Promise<void>;
    name?: string;
    description?: string;
}

// ─── Harness Creation ───────────────────────────────────────────────────────
export interface HarnessCreationOptions {
    profile: AgentProfile;
    cwd: string;
    sessionId?: string;
    additionalTools?: AgentTool[];
    apiKeys?: Record<string, string>;
    onAgentStatus?: AgentStatusCallbacks;
}
