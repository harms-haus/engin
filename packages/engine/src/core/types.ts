// ─── Re-exports from @earendil-works/pi-coding-agent ───────────────────────
export { AgentSession, AuthStorage, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent';
export type { ThinkingLevel };

// ─── Peer dependency re-exports (not re-exported by pi-coding-agent) ───────
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { RendererRegistry } from './renderer-registry.js';

export { getModel, parseJsonWithRepair } from '@earendil-works/pi-ai';
export type { Model } from '@earendil-works/pi-ai';
export type { StepDefinition, StepEntity, TaskEntity, TaskStatus } from '@engin/shared/types';

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

// ─── Task Tracking (re-exported from @engin/shared/types) ────────────────────
import type { TaskStatus } from '@engin/shared/types';

/**
 * Executor-side Task (write-model) — the object the TaskTracker and LanePool mutate.
 * Carries phaseId + new TaskStatus + executor fields.
 */
export interface Task {
  id: string;
  title: string;
  prompt: string;
  profile: string;
  files: string[];
  dependencies: string[];
  status: TaskStatus;
  phaseId: string; // REQUIRED
  assignedAgent?: string;
  result?: unknown;
  reviewFeedback?: string[];
  isCode?: boolean;
}

// ─── Workflow Phases ────────────────────────────────────────────────────────
export interface WorkflowState {
  taskPrompt: string;
  currentPhaseId: string;
  completedPhaseIds: string[];
  tasks: Task[];
  /** Generic workflow data bag — consumers store workflow-specific state here */
  workflowData: Record<string, unknown>;
  stats: {
    totalTokens: number;
    totalCost: number;
    agentCount: number;
  };
  spawnedAgents?: PersistedAgentRecord[];
  /** Git worktree information for isolated execution */
  worktree?: WorktreeInfo;
}

// ─── Audit Events ───────────────────────────────────────────────────────────
export type AuditEvent =
  | {
      type: 'agent_start';
      agentId: string;
      profile: AgentProfile;
      taskId?: string;
      timestamp: string;
      phaseId?: string;
    }
  | { type: 'agent_end'; agentId: string; result: unknown; taskId?: string; timestamp: string; phaseId?: string }
  | { type: 'decision'; agentId: string; decision: string; reasoning: string; taskId?: string; timestamp: string }
  | { type: 'structured_output'; agentId: string; output: unknown; taskId?: string; timestamp: string }
  | { type: 'error'; agentId: string; error: string; taskId?: string; timestamp: string };

// ─── Persisted Agent Record ────────────────────────────────────────────────
export interface PersistedAgentRecord {
  agentId: string;
  profile: string;
  phaseId: string;
  taskId?: string;
  stepIndex?: number;
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
  onPhaseRegister?: (info: { id: string; label: string; icon: string }) => void;
  onPhaseStart?: (info: { phase: string; round: number }) => void;
  onPhaseComplete?: (info: { phase: string; durationMs: number }) => void;
  onAgentSpawn?: (info: {
    agentId: string;
    profile: string;
    phaseId: string;
    taskId?: string;
    stepIndex?: number;
    sessionId?: string;
    sessionPath?: string;
  }) => void;
  onAgentComplete?: (info: {
    agentId: string;
    profile: string;
    phaseId: string;
    taskId?: string;
    sessionId?: string;
  }) => void;
  onTaskStart?: (info: {
    taskId: string;
    title: string;
    agentId: string;
    phaseId?: string;
    startedAt?: number;
  }) => void;
  onTaskRegister?: (info: {
    taskId: string;
    phaseId: string;
    title: string;
    dependencies: string[];
    steps: { name: string; profileId: string; isReadOnly: boolean }[];
  }) => void;
  onStepStart?: (info: { taskId: string; stepIndex: number; stepName: string; agentId: string }) => void;
  onTaskComplete?: (info: { taskId: string; title: string }) => void;
  onTaskRejected?: (info: { taskId: string; title: string; reason: string }) => void;
  onDecision?: (info: { agentId: string; decision: string; reasoning: string; taskId?: string }) => void;
  onAgentRender?: (info: { agentId: string; profile: string; taskId?: string; rendered: string }) => void;
  onError?: (info: { agentId: string; error: string; phaseId: string; taskId?: string }) => void;
  onWorkflowComplete?: (info: { totalDurationMs: number; agentCount: number }) => void;
  onWorkflowFailed?: (info: { error: Error; phaseId: string }) => void;
  onSidebarUpdate?: (info: { title?: string; indicator?: string }) => void;
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
  'onPhaseRegister',
  'onAgentSpawn',
  'onAgentComplete',
  'onTaskStart',
  'onTaskRegister',
  'onStepStart',
  'onTaskComplete',
  'onTaskRejected',
  'onDecision',
  'onAgentRender',
  'onError',
  'onWorkflowComplete',
  'onWorkflowFailed',
  'onTurnStart',
  'onTurnEnd',
  'onToolCallStart',
  'onToolCallEnd',
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
  /** When provided, enables output renderers that transform agent JSON output into human-readable markdown. */
  rendererRegistry?: RendererRegistry;
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
  /** Optional hook for workflows to register output renderers for agent profiles. Called by the engine after module load. */
  registerRenderers?: (registry: RendererRegistry) => void;
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
  /**
   * Optional write sandbox: when set, `write`/`edit` tool calls whose target
   * path resolves outside these directories are blocked (the agent receives an
   * error tool result and may retry inside the sandbox). Paths are resolved
   * against `cwd`. Use to confine an agent's file mutations (e.g. a planner
   * that should only write into a run's artifacts directory).
   */
  allowedWriteDirs?: string[];
}
