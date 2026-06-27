import type { Task } from '../../packages/engine/src/core/types.js';

/**
 * Creates a Task with sensible defaults.
 * Canonical version based on lane-pool.test.ts (provides id default).
 */
export function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    prompt: 'Implement feature X',
    profile: 'coder',
    files: ['src/index.ts'],
    dependencies: [],
    status: 'ready',
    phaseId: 'phase-1',
    worktree: 'none',
    ...overrides,
  };
}
