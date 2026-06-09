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
    scoutingReports: unknown[];
    plan: unknown;
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

// ─── Agent Loop Result ──────────────────────────────────────────────────────
export interface AgentLoopResult<T> {
    result: T;
    attempts: number;
    totalTokens: { input: number; output: number };
}

// ─── Harness Creation ───────────────────────────────────────────────────────
export interface HarnessCreationOptions {
    profile: AgentProfile;
    cwd: string;
    sessionId?: string;
    additionalTools?: AgentTool[];
    apiKeys?: Record<string, string>;
}
