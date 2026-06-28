import type { Task } from '../../packages/engine/src/core/types.js';

/**
 * Creates a Task with sensible defaults.
 * Canonical version based on legacy pool tests (provides id default).
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

/**
 * Creates a Task whose status is `'parked'` — useful for scheduler / UI
 * tests that need a parked (capacity-waiting) task fixture. Delegates to
 * {@link makeTask} so all other defaults stay in sync.
 */
export function makeParkedTask(overrides?: Partial<Task>): Task {
  return makeTask({ status: 'parked', ...overrides });
}
