import type { ZodType } from 'zod';
import type { StatusCallbacks, Task } from '../core/types.js';
import type { AuditLog } from '../tracking/audit-log.js';
import type { TaskTracker } from '../tracking/task-status.js';

/** A single step in the task processing pipeline. Each step maps to an agent profile. */
export interface StepDefinition<T = unknown> {
  /** Human-readable step name (e.g. "write-tests", "execute", "review") */
  name: string;
  /** Profile ID to load from the profiles directories */
  profileId: string;
  /** When true, write/edit tools are stripped from the agent's toolset */
  isReadOnly: boolean;
  /** Zod schema for structured output steps (reviews). When absent, raw assistant text is used. */
  schema?: ZodType<T>;
  /** Determines approval from structured output. Defaults to checking result.approved === true. */
  isApproved?: (result: T) => boolean;
  /** Extracts rejection feedback from structured output. Defaults to result.feedback ?? 'No feedback provided'. */
  getFeedback?: (result: T) => string;
}

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
  /** Abort signal for cooperative cancellation */
  signal?: AbortSignal;
}

/** Aggregate result from running the pool. */
export interface LanePoolResult {
  completedTasks: number;
  failedTasks: number;
}
