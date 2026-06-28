// ─── Shared Test Fixtures for SessionPlan Runners ────────────────────────
//
// Provides common test fixtures (DEFAULT_TASK, makePlanContext, CANNED_RESULT,
// mockRunScheduledSession) plus setupRunScheduledSessionMock() that wires
// mock.module + beforeEach cleanup.
//
// Usage:
//
//   import { makePlanContext, CANNED_RESULT, mockRunScheduledSession,
//            setupRunScheduledSessionMock } from './test-fixtures.js';
//   import { myRunner } from './my-runner.js';
//
//   setupRunScheduledSessionMock();
//
//   describe('myRunner', () => { ... });

import { beforeEach, mock } from 'bun:test';
import type { AgentProfile, Task } from '../../core/types.js';
import type { SessionResult } from '../session.js';
import type { SessionPlanContext } from './session-plan-types.js';

// ─── Mock runScheduledSession ─────────────────────────────────────────────

/**
 * Shared mock for `runScheduledSession`. Reset between tests via
 * `setupRunScheduledSessionMock()` or a manual `beforeEach`.
 */
export const mockRunScheduledSession = mock() as ReturnType<typeof mock> &
  ((...args: unknown[]) => Promise<SessionResult>);

// mock.module is process-global in bun and hoisted before imports. Placing it
// at the top level of this module ensures the mock is registered when any test
// file imports from this module before importing the module-under-test.
mock.module('../run-scheduled-session.js', () => ({
  runScheduledSession: (...args: unknown[]) => mockRunScheduledSession(...args),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────

export const DEFAULT_TASK: Task = {
  id: 'task-abc',
  title: 'Build feature',
  prompt: 'Implement X',
  profile: 'executor',
  files: [],
  dependencies: [],
  status: 'active',
  phaseId: 'code',
  worktree: 'none',
};

export const CANNED_RESULT: SessionResult = { mode: 'text', text: 'session output' };

/**
 * Build a SessionPlanContext with a default executor AgentProfile fixture.
 *
 * @param overrides - Optional partial overrides for any context field.
 */
export function makePlanContext(overrides?: Partial<SessionPlanContext>): SessionPlanContext {
  const profiles = new Map<string, AgentProfile>();
  profiles.set('executor', {
    id: 'executor',
    name: 'Executor',
    provider: 'openai',
    model: 'gpt-4o',
    thinkingLevel: 'low',
    systemPrompt: 'You are an executor.',
    excludeTools: [],
    includeTools: [],
  });

  return {
    task: DEFAULT_TASK,
    profiles,
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    activeSessions: new Set(),
    phaseId: 'code',
    agentId: 'agent-1',
    ...overrides,
  };
}

/**
 * Convenience spec factory for singleSession tests.
 *
 * Returns fields compatible with the singleSession() parameter type
 * (Omit<SessionSpec, 'id' | 'attempt'> & { role: string; attempt?: number }).
 */
export function makeSSSpec(overrides?: Record<string, unknown>) {
  return {
    profile: 'executor',
    prompt: 'Do the work',
    outputMode: 'text' as const,
    role: 'executor',
    runnerRole: 'executor',
    ...overrides,
  };
}

// ─── Mock Wiring ──────────────────────────────────────────────────────────

/**
 * Register a `beforeEach` that resets `mockRunScheduledSession`.
 *
 * Call this once at the top level of any test file that imports
 * `mockRunScheduledSession`. Without it, mock call counts and return
 * values leak across tests.
 */
export function setupRunScheduledSessionMock(): void {
  beforeEach(() => {
    mockRunScheduledSession.mockReset();
  });
}
