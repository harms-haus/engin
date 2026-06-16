import type { ZodType } from 'zod';

// ─── Task Tracking ──────────────────────────────────────────────────────────
export type TaskStatus = 'ready' | 'blocked' | 'active' | 'complete' | 'failed' | 'cancelled';

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
 * Projection shape for a step within a task.
 * Steps have NO status — their rendered state (done / active / pending) is
 * DERIVED from their index vs the owning task's activeStepIndex:
 *   index <  activeStepIndex  → done
 *   index === activeStepIndex → active
 *   index >  activeStepIndex  → pending
 */
export interface StepEntity {
  name: string;
  index: number; // 0-based position within the task
  profile?: string; // profileId this step runs as
  agentKey?: string; // key into projection.agents once an agent is spawned (undefined until spawned)
  isReadOnly?: boolean;
}

/**
 * Projection shape for a task (read-model). Does NOT carry executor-only fields
 * (prompt, files, result, reviewFeedback, isCode, assignedAgent, profile).
 */
export interface TaskEntity {
  id: string;
  title: string;
  phaseId: string; // REQUIRED
  status: TaskStatus;
  steps: StepEntity[]; // ordered; state derived from activeStepIndex
  activeStepIndex?: number; // the single active step; undefined when none
  dependencies: string[]; // task ids
  startedAt?: number;
  completedAt?: string;
}
