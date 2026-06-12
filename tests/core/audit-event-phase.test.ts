import { beforeEach, describe, expect, it } from 'bun:test';
import type { AuditEvent } from '../../src/core/types.js';
import { AuditLog } from '../../src/tracking/audit-log.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('AuditEvent phase field', () => {
  // ── Type-level checks ──────────────────────────────────────────────

  describe('agent_start accepts phase', () => {
    it('phase is assignable on agent_start event', () => {
      const event: AuditEvent = {
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
        phase: 'implementing',
        timestamp: new Date().toISOString(),
      };
      expect(event.type).toBe('agent_start');
      if (event.type === 'agent_start') {
        expect(event.phase).toBe('implementing');
      }
    });

    it('phase is optional — agent_start works without it', () => {
      const event: AuditEvent = {
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
        timestamp: new Date().toISOString(),
      };
      expect(event.type).toBe('agent_start');
      if (event.type === 'agent_start') {
        expect(event.phase).toBeUndefined();
      }
    });

    it('phase accepts any string value', () => {
      const customPhase = 'custom_phase_42';
      const event: AuditEvent = {
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
        phase: customPhase,
        timestamp: new Date().toISOString(),
      };
      if (event.type === 'agent_start') {
        expect(event.phase).toBe(customPhase);
      }
    });
  });

  describe('agent_end accepts phase', () => {
    it('phase is assignable on agent_end event', () => {
      const event: AuditEvent = {
        type: 'agent_end',
        agentId: 'a1',
        result: {},
        phase: 'planning',
        timestamp: new Date().toISOString(),
      };
      expect(event.type).toBe('agent_end');
      if (event.type === 'agent_end') {
        expect(event.phase).toBe('planning');
      }
    });

    it('phase is optional — agent_end works without it', () => {
      const event: AuditEvent = {
        type: 'agent_end',
        agentId: 'a1',
        result: {},
        timestamp: new Date().toISOString(),
      };
      expect(event.type).toBe('agent_end');
      if (event.type === 'agent_end') {
        expect(event.phase).toBeUndefined();
      }
    });

    it('phase accepts any string value', () => {
      const event: AuditEvent = {
        type: 'agent_end',
        agentId: 'a1',
        result: { cost: 0.5 },
        phase: 'final_review',
        timestamp: new Date().toISOString(),
      };
      if (event.type === 'agent_end') {
        expect(event.phase).toBe('final_review');
      }
    });
  });

  describe('decision does NOT have phase', () => {
    it('decision event does not accept phase', () => {
      // @ts-expect-error — 'phase' is not a valid field on decision variant
      const _event: AuditEvent = {
        type: 'decision',
        agentId: 'a1',
        decision: 'approve',
        reasoning: 'looks good',
        phase: 'implementing',
        timestamp: new Date().toISOString(),
      };
      expect(_event.type).toBe('decision');
    });
  });

  describe('structured_output does NOT have phase', () => {
    it('structured_output event does not accept phase', () => {
      // @ts-expect-error — 'phase' is not a valid field on structured_output variant
      const _event: AuditEvent = {
        type: 'structured_output',
        agentId: 'a1',
        output: {},
        phase: 'implementing',
        timestamp: new Date().toISOString(),
      };
      expect(_event.type).toBe('structured_output');
    });
  });

  describe('error does NOT have phase', () => {
    it('error event does not accept phase', () => {
      // @ts-expect-error — 'phase' is not a valid field on error variant
      const _event: AuditEvent = {
        type: 'error',
        agentId: 'a1',
        error: 'something broke',
        phase: 'implementing',
        timestamp: new Date().toISOString(),
      };
      expect(_event.type).toBe('error');
    });
  });

  // ── AuditLog persistence ───────────────────────────────────────────

  describe('AuditLog round-trips phase field', () => {
    const { getDir } = useTempDir();
    let dir: string;

    beforeEach(() => {
      dir = getDir();
    });

    it('persists and reads back phase on agent_start', async () => {
      const log = new AuditLog(dir);

      await log.append({
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
        phase: 'scouting',
      });

      const events = await log.getEvents({ type: 'agent_start' });
      expect(events).toHaveLength(1);
      const e = events[0] as Extract<AuditEvent, { type: 'agent_start' }>;
      expect(e.phase).toBe('scouting');
    });

    it('persists and reads back phase on agent_end', async () => {
      const log = new AuditLog(dir);

      await log.append({
        type: 'agent_end',
        agentId: 'a1',
        result: { cost: 0.3 },
        phase: 'implementing',
      });

      const events = await log.getEvents({ type: 'agent_end' });
      expect(events).toHaveLength(1);
      const e = events[0] as Extract<AuditEvent, { type: 'agent_end' }>;
      expect(e.phase).toBe('implementing');
    });

    it('agent_start without phase reads back as undefined', async () => {
      const log = new AuditLog(dir);

      await log.append({
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
      });

      const events = await log.getEvents({ type: 'agent_start' });
      expect(events).toHaveLength(1);
      const e = events[0] as Extract<AuditEvent, { type: 'agent_start' }>;
      expect(e.phase).toBeUndefined();
    });

    it('agent_end without phase reads back as undefined', async () => {
      const log = new AuditLog(dir);

      await log.append({
        type: 'agent_end',
        agentId: 'a1',
        result: {},
      });

      const events = await log.getEvents({ type: 'agent_end' });
      expect(events).toHaveLength(1);
      const e = events[0] as Extract<AuditEvent, { type: 'agent_end' }>;
      expect(e.phase).toBeUndefined();
    });

    it('mixed events with and without phase are all returned', async () => {
      const log = new AuditLog(dir);

      await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never, phase: 'scouting' });
      await log.append({ type: 'agent_end', agentId: 'a1', result: {}, phase: 'scouting' });
      await log.append({ type: 'agent_start', agentId: 'a2', profile: {} as never });
      await log.append({ type: 'error', agentId: 'a2', error: 'fail' });

      const events = await log.getEvents();
      expect(events).toHaveLength(4);

      const starts = events.filter((e) => e.type === 'agent_start') as Extract<AuditEvent, { type: 'agent_start' }>[];
      expect(starts[0].phase).toBe('scouting');
      expect(starts[1].phase).toBeUndefined();
    });
  });

  // ── Backward compatibility ─────────────────────────────────────────

  describe('backward compatibility', () => {
    it('existing agent_start events without phase still type-check', () => {
      const event: AuditEvent = {
        type: 'agent_start',
        agentId: 'legacy-agent',
        profile: {} as never,
        taskId: 'task-1',
        timestamp: '2025-01-01T00:00:00.000Z',
      };
      if (event.type === 'agent_start') {
        expect(event.agentId).toBe('legacy-agent');
        expect(event.taskId).toBe('task-1');
        expect(event.phase).toBeUndefined();
      }
    });

    it('existing agent_end events without phase still type-check', () => {
      const event: AuditEvent = {
        type: 'agent_end',
        agentId: 'legacy-agent',
        result: { cost: 1.0, tokens: 500 },
        taskId: 'task-1',
        timestamp: '2025-01-01T00:00:00.000Z',
      };
      if (event.type === 'agent_end') {
        expect(event.agentId).toBe('legacy-agent');
        expect(event.result).toEqual({ cost: 1.0, tokens: 500 });
        expect(event.phase).toBeUndefined();
      }
    });
  });
});
