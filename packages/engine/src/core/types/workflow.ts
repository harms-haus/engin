import type { HookProvider, HookRegistry } from '../../hooks/types.js';
import type { RendererRegistry } from '../renderer-registry.js';
import type { WorktreeManager } from '../worktree-manager.js';

import type { StatusCallbacks } from './callbacks.js';
import type { Task } from './tasks.js';

export interface PersistedAgentRecord {
  agentId: string;
  profile: string;
  phaseId: string;
  taskId?: string;
  stepIndex?: number;
  completedAt?: string;
}

/** Describes a git worktree used for isolated workflow execution. */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory on disk */
  worktreePath: string;
  /** Name of the branch checked out in the worktree */
  branchName: string;
  /** The original working directory before switching to the worktree */
  originalCwd: string;
}

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
  /** WorktreeManager for isolated git worktree execution */
  worktreeManager?: WorktreeManager;
  /** The engine-assembled hook registry. Forwarded to LanePool / runStepTask / runMultiStepTask so engine primitives can invoke hooks. */
  hookRegistry?: HookRegistry;
  /** Optional per-prompt timeout in milliseconds. Forwarded to LanePool so
   *  each `session.prompt()` call is raced against a timeout. Unset/0/NaN → no
   *  timeout (zero behavior change). */
  stepTimeoutMs?: number;
}

export interface WorkflowEntry {
  name: string;
  source: 'local' | 'global';
  path: string;
}

export interface WorkflowModule {
  run(taskPrompt: string, options: WorkflowRunOptions): Promise<void>;
  /** Optional hook for workflows to register output renderers for agent profiles. Called by the engine after module load. */
  registerRenderers?: (registry: RendererRegistry) => void;
  /** Optional workflow-provided hooks. The engine composes these with the store callbacks via composeHooks. */
  hooks?: HookProvider;
  name?: string;
  description?: string;
}
