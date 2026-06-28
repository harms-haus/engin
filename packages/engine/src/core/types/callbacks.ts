export interface WorkflowStatusCallbacks {
  onWorkflowStart?: (info: { taskPrompt: string; resumed: boolean; workDir: string }) => void;
  onPhaseRegister?: (info: { id: string; label: string; icon: string }) => void;
  onPhaseStart?: (info: { phase: string; round: number }) => void;
  onPhaseComplete?: (info: { phase: string; durationMs: number }) => void;
  onSessionStart?: (info: {
    agentId: string;
    profile: string;
    phaseId: string;
    taskId?: string;
    sessionId?: string;
    sessionPath?: string;
    /** Resolved model's context window (from pi-ai `Model.contextWindow`). */
    contextWindow?: number;
    runnerRole?: string;
    attempt?: number;
  }) => void;
  onSessionComplete?: (info: {
    agentId: string;
    profile: string;
    phaseId: string;
    taskId?: string;
    sessionId?: string;
    runnerRole?: string;
    attempt?: number;
  }) => void;
  onTaskStart?: (info: {
    taskId: string;
    title: string;
    agentId: string;
    phaseId?: string;
    startedAt?: number;
    /** Ordered session plan the task's runner will produce, declared upfront
     *  so consumers (TUI/web) can show all planned sessions + progress. */
    sessionPlan?: { role: string; profile: string }[];
  }) => void;
  onTaskRegister?: (info: { taskId: string; phaseId: string; title: string; dependencies: string[] }) => void;
  onTaskComplete?: (info: { taskId: string; title: string }) => void;
  onTaskRejected?: (info: { taskId: string; title: string; reason: string }) => void;
  onTaskParked?: (info: { taskId: string; title: string; agentId: string; phaseId?: string }) => void;
  onTaskUnparked?: (info: { taskId: string; title: string; agentId: string; phaseId?: string }) => void;
  onDecision?: (info: { agentId: string; decision: string; reasoning: string; taskId?: string }) => void;
  onAgentRender?: (info: { agentId: string; profile: string; taskId?: string; rendered: string }) => void;
  onError?: (info: { agentId: string; error: string; phaseId: string; taskId?: string }) => void;
  onWorkflowComplete?: (info: { totalDurationMs: number; agentCount: number }) => void;
  onWorkflowFailed?: (info: { error: Error; phaseId: string }) => void;
  onWorkflowData?: (info: { data: Record<string, unknown> }) => void;
  onSidebarUpdate?: (info: { title?: string; indicator?: string }) => void;
  onAutoRetryStart?: (info: {
    agentId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage?: string;
  }) => void;
  onAutoRetryCompleted?: (info: { agentId: string; success: boolean; attempt: number; finalError?: string }) => void;
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
  onAutoRetryStart?: (info: {
    agentId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage?: string;
  }) => void;
  onAutoRetryCompleted?: (info: { agentId: string; success: boolean; attempt: number; finalError?: string }) => void;
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
  'onSessionStart',
  'onSessionComplete',
  'onTaskStart',
  'onTaskRegister',
  'onTaskComplete',
  'onTaskRejected',
  'onTaskParked',
  'onTaskUnparked',
  'onDecision',
  'onAgentRender',
  'onError',
  'onWorkflowComplete',
  'onWorkflowFailed',
  'onTurnStart',
  'onTurnEnd',
  'onToolCallStart',
  'onToolCallEnd',
  'onAutoRetryStart',
  'onAutoRetryCompleted',
  'onSidebarUpdate',
  'onWorkflowData',
]);
