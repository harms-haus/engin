import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  clearPoolMocks,
  createPoolAndTracker,
  makeSession,
  mockCreateHarness,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.js';

beforeEach(() => {
  clearPoolMocks();
});

describe('LanePool status callback phase field', () => {
  describe('onSessionStart includes phaseId: implementing', () => {
    it('onSessionStart from runStep includes phaseId: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onSessionStart = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onSessionStart } });
      await pool.run();
      expect(onSessionStart).toHaveBeenCalledTimes(1);
      expect(onSessionStart).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'lane-0',
          profile: 'coder',
          phaseId: 'implementing',
          taskId: 'task-1',
        }),
      );
    });

    it('onSessionStart includes phaseId for every step in a multi-step flow', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onSessionStart = mock((_info: Record<string, unknown>) => {});
      const { pool } = createPoolAndTracker({
        onStatus: { onSessionStart },
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      await pool.run();
      expect(onSessionStart).toHaveBeenCalledTimes(2);
      onSessionStart.mock.calls.forEach((call) => {
        expect(call[0]).toMatchObject({ phaseId: 'implementing' });
      });
    });
  });

  describe('onSessionComplete includes phaseId: implementing', () => {
    it('onSessionComplete from runStep includes phaseId: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onSessionComplete = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onSessionComplete } });
      await pool.run();
      expect(onSessionComplete).toHaveBeenCalledTimes(1);
      expect(onSessionComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'lane-0',
          profile: 'coder',
          phaseId: 'implementing',
          taskId: 'task-1',
        }),
      );
    });

    it('onSessionComplete includes phaseId for every step in a multi-step flow', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onSessionComplete = mock((_info: Record<string, unknown>) => {});
      const { pool } = createPoolAndTracker({
        onStatus: { onSessionComplete },
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      await pool.run();
      expect(onSessionComplete).toHaveBeenCalledTimes(2);
      onSessionComplete.mock.calls.forEach((call) => {
        expect(call[0]).toMatchObject({ phaseId: 'implementing' });
      });
    });
  });

  describe('phaseId is present even on failure paths', () => {
    it('onSessionComplete includes phaseId: implementing when prompt throws', async () => {
      setupProfileMocks();
      const onSessionComplete = mock(() => {});
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Prompt failed');
        }),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });
      const { pool } = createPoolAndTracker({ onStatus: { onSessionComplete } });
      await pool.run();
      expect(onSessionComplete).toHaveBeenCalledTimes(1);
      expect(onSessionComplete).toHaveBeenCalledWith(expect.objectContaining({ phaseId: 'implementing' }));
    });

    it('onSessionComplete includes phaseId: implementing when dispose throws', async () => {
      setupProfileMocks();
      const onSessionComplete = mock(() => {});
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
        const { pool } = createPoolAndTracker({ onStatus: { onSessionComplete } });
        await pool.run();
        expect(onSessionComplete).toHaveBeenCalledTimes(1);
        expect(onSessionComplete).toHaveBeenCalledWith(expect.objectContaining({ phaseId: 'implementing' }));
      } finally {
        console.error = orig;
      }
    });
  });

  describe('combined callback order and phaseId consistency', () => {
    it('onSessionStart and onSessionComplete pairs both carry phaseId: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onSessionStart = mock((_info: Record<string, unknown>) => {});
      const onSessionComplete = mock((_info: Record<string, unknown>) => {});
      const { pool } = createPoolAndTracker({
        onStatus: { onSessionStart, onSessionComplete },
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      await pool.run();
      expect(onSessionStart).toHaveBeenCalledTimes(2);
      expect(onSessionComplete).toHaveBeenCalledTimes(2);
      // Interleave: spawn, complete, spawn, complete
      const spawnPhases = onSessionStart.mock.calls.map((c) => c[0].phaseId);
      const completePhases = onSessionComplete.mock.calls.map((c) => c[0].phaseId);
      expect(spawnPhases).toEqual(['implementing', 'implementing']);
      expect(completePhases).toEqual(['implementing', 'implementing']);
    });
  });
});
