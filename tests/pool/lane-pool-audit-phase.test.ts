import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  clearPoolMocks,
  createMockAuditLog,
  createPoolAndTracker,
  makeSession,
  mockCreateHarness,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.ts';

beforeEach(() => {
  clearPoolMocks();
});

describe('LanePool audit event phase field', () => {
  describe('agent_start includes phase: implementing', () => {
    it('agent_start audit event from runStep includes phase: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const auditLog = createMockAuditLog();
      const { pool } = createPoolAndTracker({ auditLog: auditLog as unknown as undefined });
      await pool.run();
      const starts = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_start');
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        type: 'agent_start',
        agentId: 'coder',
        phase: 'implementing',
        taskId: 'task-1',
      });
    });

    it('agent_start includes phase for every step in a multi-step flow', async () => {
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
      const starts = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_start');
      expect(starts).toHaveLength(2);
      starts.forEach((e) => expect(e).toMatchObject({ phase: 'implementing' }));
    });
  });

  describe('agent_end includes phase: implementing', () => {
    it('agent_end audit event from runStep includes phase: implementing', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const auditLog = createMockAuditLog();
      const { pool } = createPoolAndTracker({ auditLog: auditLog as unknown as undefined });
      await pool.run();
      const ends = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_end');
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ type: 'agent_end', agentId: 'coder', phase: 'implementing', taskId: 'task-1' });
    });

    it('agent_end includes phase for every step in a multi-step flow', async () => {
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
      const ends = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_end');
      expect(ends).toHaveLength(2);
      ends.forEach((e) => expect(e).toMatchObject({ phase: 'implementing' }));
    });
  });

  describe('phase is present even on failure paths', () => {
    it('agent_end includes phase: implementing when prompt throws', async () => {
      setupProfileMocks();
      const auditLog = createMockAuditLog();
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Prompt failed');
        }),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });
      const { pool } = createPoolAndTracker({ auditLog: auditLog as unknown as undefined });
      await pool.run();
      const ends = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_end');
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ phase: 'implementing' });
    });

    it('agent_end includes phase: implementing when dispose throws', async () => {
      setupProfileMocks();
      const auditLog = createMockAuditLog();
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
        const { pool } = createPoolAndTracker({ auditLog: auditLog as unknown as undefined });
        await pool.run();
        const ends = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_end');
        expect(ends).toHaveLength(1);
        expect(ends[0]).toMatchObject({ phase: 'implementing' });
      } finally {
        console.error = orig;
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
      expect(auditLog.events).toHaveLength(4);
      auditLog.events.forEach((e: Record<string, unknown>) => expect(e).toMatchObject({ phase: 'implementing' }));
      expect(auditLog.events.map((e: Record<string, unknown>) => e.type)).toEqual([
        'agent_start',
        'agent_end',
        'agent_start',
        'agent_end',
      ]);
    });
  });
});
