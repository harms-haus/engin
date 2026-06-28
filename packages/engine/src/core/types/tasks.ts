import type { TaskStatus } from '@engin/shared/types';

/**
 * Executor-side Task (write-model) — the object the SessionScheduler and TaskGraph
 * mutate. Carries phaseId + new TaskStatus + executor fields.
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
  worktree: 'none' | 'code';
}
