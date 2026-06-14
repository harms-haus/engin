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
  describe('onAgentSpawn includes phase: implementing', () => {
    it('onAgentSpawn from runStep includes phase: implementing', async () => {
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
          phase: 'implementing',
          taskId: 'task-1',
        }),
      );
    });

    it('onAgentSpawn includes phase for every step in a multi-step flow', async () => {
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
        expect(call[0]).toMatchObject({ phase: 'implementing' });
      });
    });
  });

  describe('onAgentComplete includes phase: implementing', () => {
    it('onAgentComplete from runStep includes phase: implementing', async () => {
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
          phase: 'implementing',
          taskId: 'task-1',
        }),
      );
    });

    it('onAgentComplete includes phase for every step in a multi-step flow', async () => {
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
        expect(call[0]).toMatchObject({ phase: 'implementing' });
      });
    });
  });

  describe('phase is present even on failure paths', () => {
    it('onAgentComplete includes phase: implementing when prompt throws', async () => {
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
      expect(onAgentComplete).toHaveBeenCalledWith(expect.objectContaining({ phase: 'implementing' }));
    });

    it('onAgentComplete includes phase: implementing when dispose throws', async () => {
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
        expect(onAgentComplete).toHaveBeenCalledWith(expect.objectContaining({ phase: 'implementing' }));
      } finally {
        console.error = orig;
      }
    });
  });

  describe('combined callback order and phase consistency', () => {
    it('onAgentSpawn and onAgentComplete pairs both carry phase: implementing', async () => {
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
      const spawnPhases = onAgentSpawn.mock.calls.map((c) => (c[0] as Record<string, unknown>).phase);
      const completePhases = onAgentComplete.mock.calls.map((c) => (c[0] as Record<string, unknown>).phase);
      expect(spawnPhases).toEqual(['implementing', 'implementing']);
      expect(completePhases).toEqual(['implementing', 'implementing']);
    });
  });
});
