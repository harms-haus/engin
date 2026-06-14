import type { StatusCallbacks, StepDefinition, Task } from '../core/types.js';
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
  getStepsForTask: (task: Task) => StepDefinition[];
  /** Maximum retries per step on agent crash. Default: 5 */
  maxStepRetries?: number;
  /** Maximum time (ms) a lane waits for new work before polling again. Default: 60000 */
  laneWaitTimeoutMs?: number;
  /** Abort signal for cooperative cancellation */
  signal?: AbortSignal;
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

/** Aggregate result from running the pool. */
export interface LanePoolResult {
  completedTasks: number;
  failedTasks: number;
}
