/**
 * @fileoverview Shared test helpers for LanePool tests.
 *
 * This module captures real modules, sets up module mocks (mock.module),
 * imports LanePool (which resolves through the mocks), and exports
 * everything test files need: mock functions, LanePool, TaskTracker,
 * shared test data, and helper functions.
 *
 * Test files just import from here — no local mock.module or LanePool import.
 */

import { mock } from 'bun:test';

// ─── Capture real modules before mocking ───────────────────────────────────

export const realAgentRegistry = Object.assign({}, await import('../../packages/engine/src/core/agent-registry.js'));
export const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.js'));
export const realStructuredOutput = Object.assign(
  {},
  await import('../../packages/engine/src/core/structured-output.js'),
);

// ─── Mock definitions + mock.module ───────────────────────────────────────

export const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
export const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
export const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

// Agent-registry is NOT mocked via mock.module (process-global pollution).
// Instead, a mock plugin is registered in the real registry at module load
// time (see below after imports). Each test file that imports this module
// resets the registry in its beforeEach via clearPoolMocks().

mock.module('../../packages/engine/src/core/profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

mock.module('../../packages/engine/src/core/structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Imports that resolve through the mocks above ─────────────────────────

import type { AgentRuntime } from '../../packages/engine/src/core/agent-plugin.js';
import type { AgentProfile, Task } from '../../packages/engine/src/core/types.js';
import { LanePool } from '../../packages/engine/src/pool/lane-pool.js';
import type {
  StepDefinition,
  TaskRunner,
  TaskRunnerContext,
  TrackedSession,
} from '../../packages/engine/src/pool/types.js';
import { TaskTracker } from '../../packages/engine/src/tracking/task-status.js';
import { makeMockSession } from '../helpers/make-session.js';
import { makeTask as _makeTask } from '../helpers/make-task.js';

// ─── Real agent-registry for mock plugin registration ────────────────────
//
// Instead of using process-global mock.module (which leaks across files),
// we register a mock plugin in the real registry. The plugin's createSession
// delegates to mockCreateHarness, which each test configures.
//
// clearPoolMocks() resets the registry before each test (see below) so the
// mock plugin is always registered when test code runs, even if another test
// file (e.g. session.test.ts) cleared the registry in its own beforeEach.

import {
  clearAgentPluginRegistry,
  DEFAULT_AGENT_PLUGIN_ID,
  registerAgentPlugin,
} from '../../packages/engine/src/core/agent-registry.js';

// ─── Register mock plugin at module load time ───────────────────────────
//
// Calling clearAgentPluginRegistry() here also clears any plugins that
// sibling test files may have registered in earlier module evaluations.
// The mock plugin is re-registered in clearPoolMocks() (called by every
// test file's beforeEach) to restore the default after a sibling file
// (e.g. session.test.ts) replaces it.

clearAgentPluginRegistry();
registerAgentPlugin({
  id: DEFAULT_AGENT_PLUGIN_ID,
  createSession: async (opts: unknown) => {
    const w = (await mockCreateHarness(opts)) as {
      session: Record<string, unknown>;
      sessionId?: string;
      dispose?: () => void;
      contextWindow?: number;
    };
    // Propagate wrapper-level fields onto the inner session IN-PLACE so the
    // same object reference is tracked in activeSessions AND the session's
    // dispose() / sessionId observe the wrapper's mock.
    if (w.dispose) (w.session as { dispose: () => void }).dispose = w.dispose;
    if (w.sessionId) (w.session as { sessionId: string }).sessionId = w.sessionId;
    if (w.contextWindow !== undefined) (w.session as { contextWindow: number }).contextWindow = w.contextWindow;
    return w.session as unknown as AgentRuntime;
  },
});

export { LanePool, _makeTask as makeTask, TaskTracker };
export type { StepDefinition };

// ═══════════════════════════════════════════════════════════════════════════
// Shared test data
// ═══════════════════════════════════════════════════════════════════════════

export const defaultProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [] as string[],
  includeTools: [] as string[],
};

export const reviewerProfile = {
  ...defaultProfile,
  id: 'reviewer',
  name: 'Reviewer',
};

/**
 * Build a `Map<string, AgentProfile>` pre-populated with the default coder and
 * reviewer profiles. Convenient for constructing a `TaskRunnerContext.profiles`
 * map without re-declaring the profile literals in each test file.
 */
export function createProfiles(): Map<string, AgentProfile> {
  const profiles = new Map<string, AgentProfile>();
  profiles.set('coder', defaultProfile);
  profiles.set('reviewer', reviewerProfile);
  return profiles;
}

// ═══════════════════════════════════════════════════════════════════════════
// Session helpers
// ═══════════════════════════════════════════════════════════════════════════

export function makeSession(textFn?: (promptText: string) => string | undefined) {
  return makeMockSession(textFn ?? (() => 'done')).session;
}

export function makeSessionWithAbort(textFn?: (promptText: string) => string | undefined) {
  const session = makeSession(textFn);
  return { ...session, abort: mock(async () => {}) };
}

/**
 * Build a `TrackedSession`-compatible object for runner tests (mapRunner,
 * councilRunner, …) along with the tracked `dispose` mock.
 *
 * Unifies the `MockTrackedSession` (map-runner) and `makeTrackedSession()`
 * (council-runner) local helpers into one flexible factory. The returned
 * `trackedSession` is a full `TrackedSession` (including `session.abort`), and
 * `dispose` is the same mock attached as `trackedSession.dispose` so tests can
 * assert on disposal without casting.
 *
 * Pass an optional `disposeFn` to inject a pre-created (and thus assertable)
 * dispose mock; otherwise a fresh one is created.
 */
export interface TrackedSessionMock {
  trackedSession: TrackedSession;
  dispose: ReturnType<typeof mock>;
}

export function makeTrackedSession(disposeFn?: ReturnType<typeof mock>): TrackedSessionMock {
  const dispose = disposeFn ?? mock(() => {});
  const mockSession = makeMockSession();
  const trackedSession: TrackedSession = {
    session: {
      abort: mock(async () => {}),
      dispose: mockSession.session.dispose,
      subscribe: mockSession.session.subscribe,
      prompt: mockSession.session.prompt,
      getLastAssistantText: mockSession.session.getLastAssistantText,
      getLastAssistantMessage: mock(() => undefined),
      sessionId: mockSession.session.sessionId,
    },
    dispose,
    sessionPath: '/tmp/sessions/test',
  };
  return { trackedSession, dispose };
}

// ═══════════════════════════════════════════════════════════════════════════
// Mock setup helpers
// ═══════════════════════════════════════════════════════════════════════════

export function setupProfileMocks() {
  const profilesMap = new Map<string, typeof defaultProfile>();
  profilesMap.set('coder', defaultProfile);
  profilesMap.set('reviewer', reviewerProfile);
  mockLoadProfilesFromDirs.mockResolvedValue(profilesMap);
}

export function setupHarnessMocks(session?: ReturnType<typeof makeSession>) {
  const sess = session ?? makeSession(() => 'done');
  mockCreateHarness.mockResolvedValue({
    session: sess,
    sessionId: 'test-session',
    dispose: mock(() => {}),
  });
  return sess;
}

export function setupHarnessMocksWithAbort(session?: ReturnType<typeof makeSessionWithAbort>) {
  const sess = session ?? makeSessionWithAbort();
  mockCreateHarness.mockResolvedValue({
    session: sess,
    sessionId: 'test-session',
    dispose: mock(() => {}),
  });
  return sess;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pool + Tracker factory
// ═══════════════════════════════════════════════════════════════════════════

export interface PoolOptions {
  maxConcurrentLanes?: number;
  maxStepRetries?: number;
  maxTaskRetries?: number;
  getStepsForTask?: (task: Task) => StepDefinition[];
  getRunnerForTask?: (task: Task) => TaskRunner;
  tasks?: Task[];
  signal?: AbortSignal;
  laneWaitTimeoutMs?: number;
  sessionBaseDir?: string;
  onStatus?: Record<string, unknown>;
  auditLog?: unknown;
}

export function createPoolAndTracker(overrides?: PoolOptions) {
  const tracker = new TaskTracker();

  const tasks = overrides?.tasks ?? [_makeTask()];
  for (const task of tasks) {
    tracker.addTask(task);
  }

  const getStepsForTask =
    overrides?.getStepsForTask ??
    ((_task: Task): StepDefinition[] => [{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

  const pool = new LanePool({
    maxConcurrentLanes: overrides?.maxConcurrentLanes ?? 1,
    profilesDirs: ['/mock/profiles'],
    sessionBaseDir: overrides?.sessionBaseDir ?? '/tmp/sessions',
    cwd: '/tmp/project',
    phaseId: 'implementing',
    taskTracker: tracker,
    getStepsForTask,
    getRunnerForTask: overrides?.getRunnerForTask,
    maxStepRetries: overrides?.maxStepRetries,
    maxTaskRetries: overrides?.maxTaskRetries,
    onStatus: overrides?.onStatus as unknown as undefined,
    auditLog: overrides?.auditLog as unknown as undefined,
    signal: overrides?.signal,
    laneWaitTimeoutMs: overrides?.laneWaitTimeoutMs,
  });

  return { pool, tracker };
}

// ═══════════════════════════════════════════════════════════════════════════
// Audit log helper
// ═══════════════════════════════════════════════════════════════════════════

export function createMockAuditLog() {
  const events: unknown[] = [];
  return {
    append: mock(async (event: unknown) => {
      events.push(event);
    }),
    events,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Mock TaskTracker helper
// ═══════════════════════════════════════════════════════════════════════════

export function createMockTaskTracker(overrides: Record<string, unknown> = {}) {
  return {
    claimTasks: mock(() => []),
    completeTask: mock(() => {}),
    failTask: mock(() => {}),
    isPoolDone: mock(() => true),
    getAllTasks: mock(() => []),
    getReadyTasks: mock(() => []),
    addTask: mock(() => {}),
    getTask: mock(() => undefined),
    // kb-7: LanePool.run() registers a TaskSettled observer for deadlock
    // surfacing; the Scheduler registers persistent wake listeners per lane.
    // The mock must be callable (no-op) so these registrations/cleanups
    // don't throw TypeError.
    on: mock(() => {}),
    removeListener: mock(() => {}),
    listenerCount: mock(() => 0),
    ...overrides,
  } as unknown as TaskTracker;
}

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle helpers
// ═══════════════════════════════════════════════════════════════════════════

export function clearPoolMocks() {
  mockCreateHarness.mockClear();
  mockLoadProfilesFromDirs.mockClear();
  mockPromptForStructured.mockClear();
  // Re-register the default mock plugin to restore state after a sibling test
  // file (e.g. session.test.ts) may have cleared/replaced the registry in its
  // own beforeEach. This ensures every test in a helpers.ts-importing file
  // starts with the mock plugin registered under DEFAULT_AGENT_PLUGIN_ID.
  clearAgentPluginRegistry();
  registerAgentPlugin({
    id: DEFAULT_AGENT_PLUGIN_ID,
    createSession: async (opts: unknown) => {
      const w = (await mockCreateHarness(opts)) as {
        session: Record<string, unknown>;
        sessionId?: string;
        dispose?: () => void;
        contextWindow?: number;
      };
      if (w.dispose) (w.session as { dispose: () => void }).dispose = w.dispose;
      if (w.sessionId) (w.session as { sessionId: string }).sessionId = w.sessionId;
      if (w.contextWindow !== undefined) (w.session as { contextWindow: number }).contextWindow = w.contextWindow;
      return w.session as unknown as AgentRuntime;
    },
  });
}

export function restorePoolMocks() {
  // Agent-registry is not mocked via mock.module (uses real registry with
  // registered mock plugin) so no restore is needed for it.
  mock.module('../../packages/engine/src/core/profile.js', () => realProfile);
  mock.module('../../packages/engine/src/core/structured-output.js', () => realStructuredOutput);
}

// ═══════════════════════════════════════════════════════════════════════════
// createRunnerContext — convenience factory for TaskRunnerContext
// ═══════════════════════════════════════════════════════════════════════════

export function createRunnerContext(overrides?: Partial<TaskRunnerContext>): TaskRunnerContext {
  const profiles = createProfiles();

  return {
    task: _makeTask(),
    agentId: 'lane-0',
    profiles,
    onStatus: undefined,
    activeSessions: new Set(),
    phaseId: 'implementing',
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    maxStepRetries: 5,
    completeTask: mock(() => true) as () => boolean,
    failTask: mock(() => {}) as (result?: unknown) => void,
    ...overrides,
  };
}
