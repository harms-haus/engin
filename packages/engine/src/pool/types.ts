import type { RendererRegistry } from '../core/renderer-registry.js';
import type { AgentProfile, StatusCallbacks, StepDefinition, Task } from '../core/types.js';
import type { AuditLog } from '../tracking/audit-log.js';
import type { TaskTracker } from '../tracking/task-status.js';

export type { StepDefinition } from '../core/types.js';

/** Result from executing a single step. */
export type StepResult =
  | { type: 'approved'; output: unknown }
  | { type: 'rejected'; feedback: string; output?: unknown };

/** Configuration for creating a LanePool. */
export interface LanePoolOptions {
  /** Maximum number of concurrent lanes (workers) */
  maxConcurrentLanes: number;
  /** Directories containing .md agent profile files. Searched in order, local overrides global. */
  profilesDirs: string[];
  /** Base directory for persisted session storage. Sessions stored at {base}/{taskId}/{attempt}-{stepIndex}-{stepName}/ */
  sessionBaseDir: string;
  /** Working directory for agent operations */
  cwd: string;
  /** Optional API key overrides by provider */
  apiKeys?: Record<string, string>;
  /** Status callback handlers */
  onStatus?: StatusCallbacks;
  /** Audit log for recording events */
  auditLog?: AuditLog;
  /** Shared task tracker — lanes claim tasks from here */
  taskTracker: TaskTracker;
  /** Given a task, return the ordered list of steps to execute */
  getStepsForTask?: (task: Task) => StepDefinition[];
  /** Given a task, return a TaskRunner that handles all step execution. When provided, takes precedence over getStepsForTask. */
  getRunnerForTask?: (task: Task) => TaskRunner;
  /** Maximum retries per step on agent crash. Default: 5 */
  maxStepRetries?: number;
  /**
   * Maximum number of times a failed task is reset and re-run within a single
   * pool run, after its initial attempt. Total attempts = `1 + maxTaskRetries`.
   *
   * When a task fails and retries remain, its persisted sessions are cleared
   * ({@link clearTaskSessions}) and it is reset to `ready` so a lane re-claims
   * it and restarts from step 1. Default `0` (a failed task stays failed — the
   * historical behavior).
   */
  maxTaskRetries?: number;
  /** Maximum time (ms) a lane waits for new work before polling again. Default: 60000 */
  laneWaitTimeoutMs?: number;
  /** Abort signal for cooperative cancellation */
  signal?: AbortSignal;
  /** Optional registry of custom output renderers keyed by profile name */
  rendererRegistry?: RendererRegistry;
  /** Phase identifier set by the workflow orchestrator — required */
  phaseId: string;
}

/** Distributive Omit that preserves discriminated union structure. */
export type WithoutTimestamp<T> = T extends infer U ? (U extends T ? Omit<U, 'timestamp'> : never) : never;

/** A tracked session wrapper returned by runStep. */
export interface TrackedSession {
  session: {
    abort(): Promise<void>;
    dispose(): void;
    subscribe(cb: (event: unknown) => void): () => void;
    prompt(text: string): Promise<void>;
    getLastAssistantText(): string | undefined;
    sessionId: string;
  };
  dispose: () => void;
  sessionPath: string;
}

/** Discriminated union representing the outcome of a task execution. */
export type TaskOutcome =
  | { status: 'completed'; output?: unknown }
  | { status: 'failed'; error?: string; feedback?: string };

/** Context passed to every TaskRunner function. */
export interface TaskRunnerContext {
  task: Task;
  agentId: string;
  profiles: Map<string, AgentProfile>;
  onStatus: StatusCallbacks | undefined;
  activeSessions: Set<{ abort(): Promise<void> }>;
  phaseId: string;
  sessionBaseDir: string;
  cwd: string;
  apiKeys?: Record<string, string>;
  maxStepRetries: number;
  /** Optional registry of custom output renderers keyed by profile name */
  rendererRegistry?: RendererRegistry;
  /** Abort signal for cooperative cancellation (e.g. SIGINT). Forwarded into the
   *  {@link StepExecutionContext} so runStep can re-check the abort state before
   *  starting a prompt, closing the TOCTOU window between session creation and
   *  `session.prompt()`. */
  signal?: AbortSignal;
  /** Safely settle the task as complete. The optional `result` is stored on
   *  the task (e.g. the agent's final output) so downstream phases can read it
   *  via `task.result`. Returns true on success. */
  completeTask: (result?: unknown) => boolean;
  /** Safely settle the task as failed. */
  failTask: (result?: unknown) => void;
}

/** Function signature for executing a task within a lane. */
export type TaskRunner = (ctx: TaskRunnerContext) => Promise<TaskOutcome>;

/** Aggregate result from running the pool. */
export interface LanePoolResult {
  completedTasks: number;
  failedTasks: number;
}
