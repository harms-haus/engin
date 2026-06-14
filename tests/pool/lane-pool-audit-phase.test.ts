import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  clearPoolMocks,
  createPoolAndTracker,
  makeSession,
  mockCreateHarness,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.ts';

beforeEach(() => {
  clearPoolMocks();
});

describe('LanePool status callback phase field', () => {
  describe('onAgentSpawn includes phaseId: implementing', () => {
    it('onAgentSpawn from runStep includes phaseId: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onAgentSpawn = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onAgentSpawn } });
      await pool.run();
      expect(onAgentSpawn).toHaveBeenCalledTimes(1);
      expect(onAgentSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'lane-0',
          profile: 'coder',
          phaseId: 'implementing',
          taskId: 'task-1',
        }),
      );
    });

    it('onAgentSpawn includes phaseId for every step in a multi-step flow', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onAgentSpawn = mock(() => {});
      const { pool } = createPoolAndTracker({
        onStatus: { onAgentSpawn },
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      await pool.run();
      expect(onAgentSpawn).toHaveBeenCalledTimes(2);
      onAgentSpawn.mock.calls.forEach((call) => {
        expect(call[0]).toMatchObject({ phaseId: 'implementing' });
      });
    });
  });

  describe('onAgentComplete includes phaseId: implementing', () => {
    it('onAgentComplete from runStep includes phaseId: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onAgentComplete = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onAgentComplete } });
      await pool.run();
      expect(onAgentComplete).toHaveBeenCalledTimes(1);
      expect(onAgentComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'lane-0',
          profile: 'coder',
          phaseId: 'implementing',
          taskId: 'task-1',
        }),
      );
    });

    it('onAgentComplete includes phaseId for every step in a multi-step flow', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onAgentComplete = mock(() => {});
      const { pool } = createPoolAndTracker({
        onStatus: { onAgentComplete },
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      await pool.run();
      expect(onAgentComplete).toHaveBeenCalledTimes(2);
      onAgentComplete.mock.calls.forEach((call) => {
        expect(call[0]).toMatchObject({ phaseId: 'implementing' });
      });
    });
  });

  describe('phaseId is present even on failure paths', () => {
    it('onAgentComplete includes phaseId: implementing when prompt throws', async () => {
      setupProfileMocks();
      const onAgentComplete = mock(() => {});
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Prompt failed');
        }),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });
      const { pool } = createPoolAndTracker({ onStatus: { onAgentComplete } });
      await pool.run();
      expect(onAgentComplete).toHaveBeenCalledTimes(1);
      expect(onAgentComplete).toHaveBeenCalledWith(expect.objectContaining({ phaseId: 'implementing' }));
    });

    it('onAgentComplete includes phaseId: implementing when dispose throws', async () => {
      setupProfileMocks();
      const onAgentComplete = mock(() => {});
      const orig = console.error;
      console.error = () => {};
      try {
        mockCreateHarness.mockResolvedValue({
          session: makeSession(() => 'ok'),
          sessionId: 'test-session',
          dispose: mock(() => {
            throw new Error('dispose exploded');
          }),
        });
        const { pool } = createPoolAndTracker({ onStatus: { onAgentComplete } });
        await pool.run();
        expect(onAgentComplete).toHaveBeenCalledTimes(1);
        expect(onAgentComplete).toHaveBeenCalledWith(expect.objectContaining({ phaseId: 'implementing' }));
      } finally {
        console.error = orig;
      }
    });
  });

  describe('combined callback order and phaseId consistency', () => {
    it('onAgentSpawn and onAgentComplete pairs both carry phaseId: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onAgentSpawn = mock(() => {});
      const onAgentComplete = mock(() => {});
      const { pool } = createPoolAndTracker({
        onStatus: { onAgentSpawn, onAgentComplete },
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      await pool.run();
      expect(onAgentSpawn).toHaveBeenCalledTimes(2);
      expect(onAgentComplete).toHaveBeenCalledTimes(2);
      // Interleave: spawn, complete, spawn, complete
      const spawnPhases = onAgentSpawn.mock.calls.map((c) => (c[0] as Record<string, unknown>).phaseId);
      const completePhases = onAgentComplete.mock.calls.map((c) => (c[0] as Record<string, unknown>).phaseId);
      expect(spawnPhases).toEqual(['implementing', 'implementing']);
      expect(completePhases).toEqual(['implementing', 'implementing']);
    });
  });
});
