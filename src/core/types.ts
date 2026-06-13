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
  reviewFeedback?: string[];
  isCode?: boolean;
}

// ─── Workflow Phases ────────────────────────────────────────────────────────
export interface WorkflowState {
  taskPrompt: string;
  currentPhase: string;
  completedPhases: string[];
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
  spawnedAgents?: PersistedAgentRecord[];
  /** Persisted sidebar info for restoring UI state on past runs */
  sidebar?: {
    title?: string;
    indicator?: string;
    phases?: { id: string; label: string; icon: string }[];
  };
  /** Git worktree information for isolated execution */
  worktree?: WorktreeInfo;
}

// ─── Audit Events ───────────────────────────────────────────────────────────
export type AuditEvent =
  | { type: 'agent_start'; agentId: string; profile: AgentProfile; taskId?: string; timestamp: string; phase?: string }
  | { type: 'agent_end'; agentId: string; result: unknown; taskId?: string; timestamp: string; phase?: string }
  | { type: 'decision'; agentId: string; decision: string; reasoning: string; taskId?: string; timestamp: string }
  | { type: 'structured_output'; agentId: string; output: unknown; taskId?: string; timestamp: string }
  | { type: 'error'; agentId: string; error: string; taskId?: string; timestamp: string };

// ─── Persisted Agent Record ────────────────────────────────────────────────
export interface PersistedAgentRecord {
  agentId: string;
  profile: string;
  phase: string;
  taskId?: string;
  completedAt?: string;
}

// ─── Worktree Info ──────────────────────────────────────────────────────
/** Describes a git worktree used for isolated workflow execution. */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory on disk */
  worktreePath: string;
  /** Name of the branch checked out in the worktree */
  branchName: string;
  /** The original working directory before switching to the worktree */
  originalCwd: string;
}

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
  onAgentSpawn?: (info: {
    agentId: string;
    profile: string;
    phase: string;
    taskId?: string;
    sessionId?: string;
    sessionPath?: string;
  }) => void;
  onAgentComplete?: (info: {
    agentId: string;
    profile: string;
    phase: string;
    taskId?: string;
    sessionId?: string;
  }) => void;
  onTaskStart?: (info: { taskId: string; title: string; agentId: string; phase?: string; startedAt?: number }) => void;
  onTaskComplete?: (info: { taskId: string; title: string }) => void;
  onTaskRejected?: (info: { taskId: string; title: string; reason: string }) => void;
  onDecision?: (info: { agentId: string; decision: string; reasoning: string; taskId?: string }) => void;
  onError?: (info: { agentId: string; error: string; phase: string; taskId?: string }) => void;
  onWorkflowComplete?: (info: { totalDurationMs: number; agentCount: number }) => void;
  onWorkflowFailed?: (info: { error: Error; phase: string }) => void;
  onTasksAdded?: (info: {
    tasks: { id: string; title: string; status: TaskStatus; dependencies: string[]; phase?: string }[];
  }) => void;
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

/**
 * Array of all method names in the `StatusCallbacks` interface.
 * Must be kept in sync with `StatusCallbacks`.
 */
export const STATUS_CALLBACK_METHODS: readonly string[] = Object.freeze([
  'onWorkflowStart',
  'onPhaseStart',
  'onPhaseComplete',
  'onAgentSpawn',
  'onAgentComplete',
  'onTaskStart',
  'onTaskComplete',
  'onTaskRejected',
  'onDecision',
  'onError',
  'onWorkflowComplete',
  'onWorkflowFailed',
  'onTurnStart',
  'onTurnEnd',
  'onToolCallStart',
  'onToolCallEnd',
  'onTasksAdded',
  'onSidebarUpdate',
]);

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
  /** Abort signal for cooperative cancellation (e.g. SIGINT). When provided to a
   * WorkflowStatusTracker, it triggers automatic listener cleanup on abort. */
  signal?: AbortSignal;
  /** Pre-created WorkflowStatusTracker; workflows should reuse instead of creating their own. Typed as `unknown` to avoid circular imports. */
  tracker?: unknown;
  /** When true, use verbose console output instead of TUI dashboard */
  verbose?: boolean;
  /** Git worktree information for isolated execution */
  worktree?: WorktreeInfo;
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
  /** Override agent ID used in status callbacks. Defaults to sessionId if not provided. */
  agentId?: string;
}
