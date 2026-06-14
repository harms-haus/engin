import { beforeEach, describe, expect, it } from 'bun:test';
import type { AuditEvent } from '../../src/core/types.js';
import { AuditLog } from '../../src/tracking/audit-log.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('AuditEvent phaseId field', () => {
  // ── Type-level checks ──────────────────────────────────────────────

  describe('agent_start accepts phaseId', () => {
    it('phaseId is assignable on agent_start event', () => {
      const event: AuditEvent = {
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
        phaseId: 'implementing',
        timestamp: new Date().toISOString(),
      };
      expect(event.type).toBe('agent_start');
      if (event.type === 'agent_start') {
        expect(event.phaseId).toBe('implementing');
      }
    });

    it('phaseId is optional — agent_start works without it', () => {
      const event: AuditEvent = {
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
        timestamp: new Date().toISOString(),
      };
      expect(event.type).toBe('agent_start');
      if (event.type === 'agent_start') {
        expect(event.phaseId).toBeUndefined();
      }
    });

    it('phaseId accepts any string value', () => {
      const customPhase = 'custom_phase_42';
      const event: AuditEvent = {
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
        phaseId: customPhase,
        timestamp: new Date().toISOString(),
      };
      if (event.type === 'agent_start') {
        expect(event.phaseId).toBe(customPhase);
      }
    });
  });

  describe('agent_end accepts phaseId', () => {
    it('phaseId is assignable on agent_end event', () => {
      const event: AuditEvent = {
        type: 'agent_end',
        agentId: 'a1',
        result: {},
        phaseId: 'planning',
        timestamp: new Date().toISOString(),
      };
      expect(event.type).toBe('agent_end');
      if (event.type === 'agent_end') {
        expect(event.phaseId).toBe('planning');
      }
    });

    it('phaseId is optional — agent_end works without it', () => {
      const event: AuditEvent = {
        type: 'agent_end',
        agentId: 'a1',
        result: {},
        timestamp: new Date().toISOString(),
      };
      expect(event.type).toBe('agent_end');
      if (event.type === 'agent_end') {
        expect(event.phaseId).toBeUndefined();
      }
    });

    it('phaseId accepts any string value', () => {
      const event: AuditEvent = {
        type: 'agent_end',
        agentId: 'a1',
        result: { cost: 0.5 },
        phaseId: 'final_review',
        timestamp: new Date().toISOString(),
      };
      if (event.type === 'agent_end') {
        expect(event.phaseId).toBe('final_review');
      }
    });
  });

  describe('decision does NOT have phaseId', () => {
    it('decision event does not accept phaseId', () => {
      // @ts-expect-error — 'phaseId' is not a valid field on decision variant
      const _event: AuditEvent = {
        type: 'decision',
        agentId: 'a1',
        decision: 'approve',
        reasoning: 'looks good',
        phaseId: 'implementing',
        timestamp: new Date().toISOString(),
      };
      expect(_event.type).toBe('decision');
    });
  });

  describe('structured_output does NOT have phaseId', () => {
    it('structured_output event does not accept phaseId', () => {
      // @ts-expect-error — 'phaseId' is not a valid field on structured_output variant
      const _event: AuditEvent = {
        type: 'structured_output',
        agentId: 'a1',
        output: {},
        phaseId: 'implementing',
        timestamp: new Date().toISOString(),
      };
      expect(_event.type).toBe('structured_output');
    });
  });

  describe('error does NOT have phaseId', () => {
    it('error event does not accept phaseId', () => {
      // @ts-expect-error — 'phaseId' is not a valid field on error variant
      const _event: AuditEvent = {
        type: 'error',
        agentId: 'a1',
        error: 'something broke',
        phaseId: 'implementing',
        timestamp: new Date().toISOString(),
      };
      expect(_event.type).toBe('error');
    });
  });

  // ── AuditLog persistence ───────────────────────────────────────────

  describe('AuditLog round-trips phaseId field', () => {
    const { getDir } = useTempDir();
    let dir: string;

    beforeEach(() => {
      dir = getDir();
    });

    it('persists and reads back phaseId on agent_start', async () => {
      const log = new AuditLog(dir);

      await log.append({
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
        phaseId: 'scouting',
      });

      const events = await log.getEvents({ type: 'agent_start' });
      expect(events).toHaveLength(1);
      const e = events[0] as Extract<AuditEvent, { type: 'agent_start' }>;
      expect(e.phaseId).toBe('scouting');
    });

    it('persists and reads back phaseId on agent_end', async () => {
      const log = new AuditLog(dir);

      await log.append({
        type: 'agent_end',
        agentId: 'a1',
        result: { cost: 0.3 },
        phaseId: 'implementing',
      });

      const events = await log.getEvents({ type: 'agent_end' });
      expect(events).toHaveLength(1);
      const e = events[0] as Extract<AuditEvent, { type: 'agent_end' }>;
      expect(e.phaseId).toBe('implementing');
    });

    it('agent_start without phaseId reads back as undefined', async () => {
      const log = new AuditLog(dir);

      await log.append({
        type: 'agent_start',
        agentId: 'a1',
        profile: {} as never,
      });

      const events = await log.getEvents({ type: 'agent_start' });
      expect(events).toHaveLength(1);
      const e = events[0] as Extract<AuditEvent, { type: 'agent_start' }>;
      expect(e.phaseId).toBeUndefined();
    });

    it('agent_end without phaseId reads back as undefined', async () => {
      const log = new AuditLog(dir);

      await log.append({
        type: 'agent_end',
        agentId: 'a1',
        result: {},
      });

      const events = await log.getEvents({ type: 'agent_end' });
      expect(events).toHaveLength(1);
      const e = events[0] as Extract<AuditEvent, { type: 'agent_end' }>;
      expect(e.phaseId).toBeUndefined();
    });

    it('mixed events with and without phaseId are all returned', async () => {
      const log = new AuditLog(dir);

      await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never, phaseId: 'scouting' });
      await log.append({ type: 'agent_end', agentId: 'a1', result: {}, phaseId: 'scouting' });
      await log.append({ type: 'agent_start', agentId: 'a2', profile: {} as never });
      await log.append({ type: 'error', agentId: 'a2', error: 'fail' });

      const events = await log.getEvents();
      expect(events).toHaveLength(4);

      const starts = events.filter((e) => e.type === 'agent_start') as Extract<AuditEvent, { type: 'agent_start' }>[];
      expect(starts[0].phaseId).toBe('scouting');
      expect(starts[1].phaseId).toBeUndefined();
    });
  });

  // ── Backward compatibility ─────────────────────────────────────────

  describe('backward compatibility', () => {
    it('existing agent_start events without phaseId still type-check', () => {
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
        expect(event.phaseId).toBeUndefined();
      }
    });

    it('existing agent_end events without phaseId still type-check', () => {
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
        expect(event.phaseId).toBeUndefined();
      }
    });
  });
});
