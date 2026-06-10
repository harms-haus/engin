// ─── Re-exports from @earendil-works/pi-coding-agent ───────────────────────
export { AgentSession, AuthStorage, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent';
export type { ThinkingLevel };

// ─── Peer dependency re-exports (not re-exported by pi-coding-agent) ───────
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export { getModel, parseJsonWithRepair } from '@earendil-works/pi-ai';
export type { Model } from '@earendil-works/pi-ai';

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
export type TaskStatus = 'blocked' | 'ready' | 'claimed' | 'implementing' | 'reviewing' | 'done' | 'failed';

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
  isCode?: boolean;
}

// ─── Workflow Phases ────────────────────────────────────────────────────────
export type WorkflowPhase =
  | 'scouting'
  | 'scouting_review'
  | 'planning'
  | 'plan_review'
  | 'implementing'
  | 'final_review'
  | 'done';

export interface WorkflowState {
  taskPrompt: string;
  currentPhase: WorkflowPhase;
  completedPhases: WorkflowPhase[];
  tasks: Task[];
  /** Scouting reports stored as opaque values; consumers should cast to their specific schema type */
  scoutingReports: unknown[];
  /** Plan stored as opaque value; consumers should cast to their specific schema type */
  plan: unknown;
  research?: string;
  /** Plan review feedback text from the reviewer when a plan is rejected */
  planReviewFeedback?: string;
  /** Specific improvement suggestions from the plan reviewer */
  planReviewSuggestions?: string[];
  stats: {
    totalTokens: number;
    totalCost: number;
    agentCount: number;
  };
}

// ─── Audit Events ───────────────────────────────────────────────────────────
export type AuditEvent =
  | { type: 'agent_start'; agentId: string; profile: AgentProfile; taskId?: string; timestamp: string }
  | { type: 'agent_end'; agentId: string; result: unknown; taskId?: string; timestamp: string }
  | { type: 'decision'; agentId: string; decision: string; reasoning: string; taskId?: string; timestamp: string }
  | { type: 'structured_output'; agentId: string; output: unknown; taskId?: string; timestamp: string }
  | { type: 'error'; agentId: string; error: string; taskId?: string; timestamp: string };

// ─── Structured Output ──────────────────────────────────────────────────────
export interface StructuredOutputOptions {
  maxRetries: number;
  retryPrompt?: string;
}

// ─── Status Callbacks ──────────────────────────────────────────────────────
export interface WorkflowStatusCallbacks {
  onWorkflowStart?: (info: { taskPrompt: string; resumed: boolean; workDir: string }) => void;
  onPhaseStart?: (info: { phase: string; round: number }) => void;
  onPhaseComplete?: (info: { phase: string; durationMs: number }) => void;
  onAgentSpawn?: (info: { agentId: string; profile: string; phase: string; taskId?: string }) => void;
  onAgentComplete?: (info: { agentId: string; profile: string; phase: string; taskId?: string }) => void;
  onTaskStart?: (info: { taskId: string; title: string; agentId: string }) => void;
  onTaskComplete?: (info: { taskId: string; title: string }) => void;
  onTaskRejected?: (info: { taskId: string; title: string; reason: string }) => void;
  onDecision?: (info: { agentId: string; decision: string; reasoning: string; taskId?: string }) => void;
  onError?: (info: { agentId: string; error: string; phase: string; taskId?: string }) => void;
  onWorkflowComplete?: (info: { totalDurationMs: number; agentCount: number }) => void;
  onWorkflowFailed?: (info: { error: Error; phase: string }) => void;
  onSidebarUpdate?: (info: {
    title?: string;
    indicator?: string;
    phases?: { id: string; label: string; icon: string }[];
  }) => void;
}

export type TurnContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; redacted?: boolean }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };

export interface AgentStatusCallbacks {
  onTurnStart?: (info: { agentId: string; turn: number }) => void;
  onTurnEnd?: (info: {
    agentId: string;
    turn: number;
    tokens?: { input: number; output: number };
    contentBlocks?: TurnContentBlock[];
  }) => void;
  onToolCallStart?: (info: {
    agentId: string;
    toolName: string;
    toolCallId: string;
    arguments: Record<string, unknown>;
  }) => void;
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
  /** Abort signal for cooperative cancellation (e.g. SIGINT) */
  signal?: AbortSignal;
}

// ─── Workflow Entry ───────────────────────────────────────────────────────
export interface WorkflowEntry {
  name: string;
  source: 'local' | 'global';
  path: string;
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
  apiKeys?: Record<string, string>;
  onAgentStatus?: AgentStatusCallbacks;
  sessionDir?: string;
  resumeSessionPath?: string;
}
