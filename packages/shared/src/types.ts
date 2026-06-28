import type { ZodType } from 'zod';

// ─── Task Tracking ──────────────────────────────────────────────────────────
export type TaskStatus = 'ready' | 'blocked' | 'active' | 'complete' | 'failed' | 'cancelled' | 'parked';

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

/**
 * Projection shape for a task (read-model). Does NOT carry executor-only fields
 * (prompt, files, result, reviewFeedback, worktree, assignedAgent, profile).
 */
export interface TaskEntity {
  id: string;
  title: string;
  phaseId: string; // REQUIRED
  status: TaskStatus;
  dependencies: string[]; // task ids
  startedAt?: number;
  completedAt?: string;
  /** Ordered session plan declared when the task started (roles/profiles),
   *  so consumers can render all planned sessions + a ●N/M progress counter.
   *  Absent for tasks that don't declare a plan. */
  sessionPlan?: { role: string; profile: string }[];
}
