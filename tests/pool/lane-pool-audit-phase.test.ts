import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Task } from '../../src/core/types.js';
import { TaskTracker } from '../../src/tracking/task-status.js';
import { makeMockSession } from '../helpers/make-session.js';
import { makeTask } from '../helpers/make-task.js';

// Capture real modules before mocking so we can restore them in afterAll.
const realHarnessFactory = Object.assign({}, await import('../../src/core/harness-factory.ts'));
const realProfile = Object.assign({}, await import('../../src/core/profile.ts'));
const realStructuredOutput = Object.assign({}, await import('../../src/core/structured-output.ts'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/harness-factory.ts', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/profile.ts', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/structured-output.ts', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { LanePool } from '../../src/pool/lane-pool.ts';
import type { StepDefinition } from '../../src/pool/types.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

const defaultProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [] as string[],
  includeTools: [] as string[],
};

const reviewerProfile = {
  ...defaultProfile,
  id: 'reviewer',
  name: 'Reviewer',
};

function makeSession(textFn: (promptText: string) => string | undefined) {
  return makeMockSession(textFn).session;
}

function setupProfileMocks() {
  const profilesMap = new Map<string, typeof defaultProfile>();
  profilesMap.set('coder', defaultProfile);
  profilesMap.set('reviewer', reviewerProfile);
  mockLoadProfilesFromDirs.mockResolvedValue(profilesMap);
}

function setupHarnessMocks(session?: ReturnType<typeof makeSession>) {
  const sess = session ?? makeSession(() => 'done');
  mockCreateHarness.mockResolvedValue({
    session: sess,
    sessionId: 'test-session',
    dispose: mock(() => {}),
  });
  return sess;
}

function createMockAuditLog() {
  const events: unknown[] = [];
  return {
    append: mock(async (event: unknown) => {
      events.push(event);
    }),
    events,
  };
}

function createPoolAndTracker(overrides?: {
  tasks?: Task[];
  getStepsForTask?: (task: Task) => StepDefinition[];
  auditLog?: unknown;
}) {
  const tracker = new TaskTracker();
  const tasks = overrides?.tasks ?? [makeTask()];
  for (const task of tasks) {
    tracker.addTask(task);
  }

  const getStepsForTask =
    overrides?.getStepsForTask ??
    ((_task: Task): StepDefinition[] => [{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

  const pool = new LanePool({
    maxConcurrentLanes: 1,
    profilesDirs: ['/mock/profiles'],
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    taskTracker: tracker,
    getStepsForTask,
    onStatus: undefined,
    auditLog: overrides?.auditLog as unknown as undefined,
  });

  return { pool, tracker };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreateHarness.mockClear();
  mockLoadProfilesFromDirs.mockClear();
  mockPromptForStructured.mockClear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('LanePool audit event phase field', () => {
  describe('agent_start includes phase: implementing', () => {
    it('agent_start audit event from runStep includes phase: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const auditLog = createMockAuditLog();

      const { pool } = createPoolAndTracker({
        auditLog: auditLog as unknown as undefined,
      });

      await pool.run();

      const startEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_start');
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0]).toMatchObject({
        type: 'agent_start',
        agentId: 'coder',
        phase: 'implementing',
        taskId: 'task-1',
      });
    });

    it('agent_start audit event includes phase for every step in a multi-step flow', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const auditLog = createMockAuditLog();

      const { pool } = createPoolAndTracker({
        auditLog: auditLog as unknown as undefined,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });

      await pool.run();

      const startEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_start');
      expect(startEvents).toHaveLength(2);
      for (const event of startEvents) {
        expect(event).toMatchObject({ phase: 'implementing' });
      }
      expect(startEvents[0]).toMatchObject({ agentId: 'coder' });
      expect(startEvents[1]).toMatchObject({ agentId: 'reviewer' });
    });
  });

  describe('agent_end includes phase: implementing', () => {
    it('agent_end audit event from runStep includes phase: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const auditLog = createMockAuditLog();

      const { pool } = createPoolAndTracker({
        auditLog: auditLog as unknown as undefined,
      });

      await pool.run();

      const endEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_end');
      expect(endEvents).toHaveLength(1);
      expect(endEvents[0]).toMatchObject({
        type: 'agent_end',
        agentId: 'coder',
        phase: 'implementing',
        taskId: 'task-1',
      });
    });

    it('agent_end audit event includes phase for every step in a multi-step flow', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const auditLog = createMockAuditLog();

      const { pool } = createPoolAndTracker({
        auditLog: auditLog as unknown as undefined,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });

      await pool.run();

      const endEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_end');
      expect(endEvents).toHaveLength(2);
      for (const event of endEvents) {
        expect(event).toMatchObject({ phase: 'implementing' });
      }
      expect(endEvents[0]).toMatchObject({ agentId: 'coder' });
      expect(endEvents[1]).toMatchObject({ agentId: 'reviewer' });
    });
  });

  describe('phase is present even on failure paths', () => {
    it('agent_end still includes phase: implementing when prompt throws', async () => {
      setupProfileMocks();

      const auditLog = createMockAuditLog();

      const session = makeSession(() => {
        throw new Error('Prompt failed');
      });
      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const { pool } = createPoolAndTracker({
        auditLog: auditLog as unknown as undefined,
      });

      await pool.run();

      // agent_start and agent_end are both appended (finally block runs even on error)
      const startEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_start');
      const endEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_end');
      expect(startEvents).toHaveLength(1);
      expect(endEvents).toHaveLength(1);
      expect(startEvents[0]).toMatchObject({ phase: 'implementing' });
      expect(endEvents[0]).toMatchObject({ phase: 'implementing' });
    });

    it('agent_end includes phase: implementing when dispose throws', async () => {
      setupProfileMocks();

      const auditLog = createMockAuditLog();
      const consoleSpy = (() => {
        // Silence console.error from the dispose catch block
        const _spies: ReturnType<typeof mock>[] = [];
        const orig = console.error;
        console.error = (..._args: unknown[]) => {
          // Swallow for testing
        };
        return {
          restore: () => {
            console.error = orig;
          },
        };
      })();

      try {
        mockCreateHarness.mockResolvedValue({
          session: makeSession(() => 'ok'),
          sessionId: 'test-session',
          dispose: mock(() => {
            throw new Error('dispose exploded');
          }),
        });

        const { pool } = createPoolAndTracker({
          auditLog: auditLog as unknown as undefined,
        });

        await pool.run();

        const endEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_end');
        expect(endEvents).toHaveLength(1);
        expect(endEvents[0]).toMatchObject({ phase: 'implementing' });
      } finally {
        consoleSpy.restore();
      }
    });
  });

  describe('combined audit event order and phase consistency', () => {
    it('agent_start and agent_end pairs both carry phase: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const auditLog = createMockAuditLog();

      const { pool } = createPoolAndTracker({
        auditLog: auditLog as unknown as undefined,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });

      await pool.run();

      // Expect exactly 4 events: start/end for step 1, start/end for step 2
      expect(auditLog.events).toHaveLength(4);

      // Verify every event in the pair has phase: implementing
      for (const event of auditLog.events) {
        expect(event).toMatchObject({ phase: 'implementing' });
      }

      // Verify the ordering is start, end, start, end
      expect(auditLog.events.map((e: Record<string, unknown>) => e.type)).toEqual([
        'agent_start',
        'agent_end',
        'agent_start',
        'agent_end',
      ]);
    });
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../src/core/profile.ts', () => realProfile);
  mock.module('../../src/core/structured-output.ts', () => realStructuredOutput);
});
