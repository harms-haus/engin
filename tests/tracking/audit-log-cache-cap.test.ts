import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AuditLog } from '../../packages/engine/src/tracking/audit-log.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

/**
 * Tests for the in-memory cache event cap (MAX_CACHED_EVENTS = 5000).
 *
 * When the cache is rebuilt from disk in getEvents(), only the most recent
 * 5000 events are retained in memory. The file on disk retains all events.
 * Consumers that need events beyond the 5000-event window should read the
 * file directly.
 */
describe('AuditLog cache event cap (MAX_CACHED_EVENTS = 5000)', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let log: AuditLog;

  beforeEach(() => {
    dir = getDir();
    log = new AuditLog(dir);
  });

  // ── Helper: write N events directly to the audit file ──────────────

  async function writeEvents(count: number, startIdx = 0): Promise<void> {
    const lines: string[] = [];
    for (let i = startIdx; i < startIdx + count; i++) {
      lines.push(
        JSON.stringify({
          type: 'agent_start',
          agentId: `a${i}`,
          profile: {},
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'audit.jsonl'), lines.join('\n') + '\n', 'utf-8');
  }

  // ── Basic cap: >5000 events on disk ─────────────────────────────────

  it('caps cache to 5000 events when more than 5000 exist on disk', async () => {
    await writeEvents(6000);

    const events = await log.getEvents();
    expect(events).toHaveLength(5000);

    // The in-memory cache should be capped
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cache!.length).toBe(5000);
  });

  it('returns the 5000 most recent events (sliding window)', async () => {
    // Write 6000 events with sequential indices
    await writeEvents(6000);

    const events = await log.getEvents();

    // The most recent 5000 events should be indices 1000..5999
    expect(events).toHaveLength(5000);
    expect((events[0] as { agentId?: string }).agentId).toBe('a1000');
    expect((events[events.length - 1] as { agentId?: string }).agentId).toBe('a5999');

    // Verify no old events leaked into cache
    const oldEvents = events.filter((e) => {
      const idx = parseInt((e as any).agentId.slice(1), 10);
      return idx < 1000;
    });
    expect(oldEvents).toHaveLength(0);
  });

  // ── File on disk retains all events ─────────────────────────────────

  it('file on disk retains all events even when cache is capped', async () => {
    await writeEvents(6000);

    // Trigger cache build
    await log.getEvents();

    // Read the file directly – should have all 6000 events
    const raw = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(6000);
  });

  // ── Events below cap are not affected ───────────────────────────────

  it('does not cap events when fewer than 5000 exist', async () => {
    await writeEvents(100);

    const events = await log.getEvents();
    expect(events).toHaveLength(100);
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cache!.length).toBe(100);
  });

  it('works correctly with exactly 5000 events', async () => {
    await writeEvents(5000);

    const events = await log.getEvents();
    expect(events).toHaveLength(5000);
    expect((log as any).cache!.length).toBe(5000);
  });

  it('works correctly with 4999 events (just under cap)', async () => {
    await writeEvents(4999);

    const events = await log.getEvents();
    expect(events).toHaveLength(4999);
    expect((log as any).cache!.length).toBe(4999);
  });

  // ── Filtering with capped cache ─────────────────────────────────────

  it('filtering works correctly on capped cache', async () => {
    // Write 5500 events: 5000 of type agent_start, then 500 of type agent_end
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: 'agent_start',
          agentId: `a${i}`,
          profile: {},
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    for (let i = 0; i < 500; i++) {
      lines.push(
        JSON.stringify({
          type: 'agent_end',
          agentId: `a${i}`,
          result: { cost: 0.5, tokens: 100 },
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 5000 + i)).toISOString(),
        }),
      );
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'audit.jsonl'), lines.join('\n') + '\n', 'utf-8');

    // Cache will be capped to 5000 most recent (all agent_end + 4500 agent_start)
    const allEvents = await log.getEvents();
    expect(allEvents).toHaveLength(5000);

    // Filter by type 'agent_end' – should find all 500 agent_end events
    const ends = await log.getEvents({ type: 'agent_end' });
    expect(ends).toHaveLength(500);
    expect(ends.every((e) => e.type === 'agent_end')).toBe(true);

    // Filter by type 'agent_start' – should find 4500 (since 500 agent_end are most recent)
    const starts = await log.getEvents({ type: 'agent_start' });
    expect(starts).toHaveLength(4500);
  });

  it('taskId filtering works on capped cache', async () => {
    // Write 6000 events with different taskIds
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      const taskId = i < 3000 ? 'task-1' : 'task-2';
      lines.push(
        JSON.stringify({
          type: 'agent_start',
          agentId: `a${i}`,
          profile: {},
          taskId,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'audit.jsonl'), lines.join('\n') + '\n', 'utf-8');

    // Cache capped to 5000 most recent: events 1000..5999
    // task-1: indices 1000..2999 (2000 events)
    // task-2: indices 3000..5999 (3000 events)
    const task1 = await log.getEvents({ taskId: 'task-1' });
    expect(task1).toHaveLength(2000);
    expect(task1.every((e) => (e as { taskId?: string }).taskId === 'task-1')).toBe(true);
    // All task-1 events should be from the capped window (agentId >= a1000)
    expect((task1[0] as { agentId?: string }).agentId).toBe('a1000');
    expect((task1[task1.length - 1] as { agentId?: string }).agentId).toBe('a2999');

    const task2 = await log.getEvents({ taskId: 'task-2' });
    expect(task2).toHaveLength(3000);
    expect(task2.every((e) => (e as any).taskId === 'task-2')).toBe(true);
  });

  // ── getStats with capped cache ──────────────────────────────────────

  it('getStats works correctly with capped cache', async () => {
    // Write 6000 events: 5000 agent_start + 1000 agent_end with costs
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: 'agent_start',
          agentId: `a${i}`,
          profile: {},
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    for (let i = 0; i < 1000; i++) {
      lines.push(
        JSON.stringify({
          type: 'agent_end',
          agentId: `a${i}`,
          result: { cost: 0.5, tokens: 100 },
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 5000 + i)).toISOString(),
        }),
      );
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'audit.jsonl'), lines.join('\n') + '\n', 'utf-8');

    // Cache capped to 5000: events 1000..5999
    // That includes: no agent_start (indices 1000..4999 = 4000) wait...
    // Let me recalculate:
    //   agent_start: indices 0..4999 (5000 events)
    //   agent_end:   indices 5000..5999 (1000 events)
    // Capped to last 5000 = indices 1000..5999
    //   agent_start: 1000..4999 = 4000
    //   agent_end:   5000..5999 = 1000
    const stats = await log.getStats();
    expect(stats.totalEvents).toBe(5000); // capped
    expect(stats.totalCost).toBe(500); // 1000 agent_end * 0.5 cost
    expect(stats.totalTokens).toBe(100_000); // 1000 agent_end * 100 tokens
  });

  // ── Cache invalidation after append still works ─────────────────────

  it('append invalidates cache even when cache is capped', async () => {
    await writeEvents(6000);

    // Populate the capped cache
    await log.getEvents();
    expect((log as any).cache!.length).toBe(5000);

    // Append a new event – cache should be nulled
    await log.append({ type: 'agent_end', agentId: 'new', result: {} });
    expect((log as any).cache).toBeNull();
  });

  it('append followed by getEvents sees all events (file not capped)', async () => {
    await writeEvents(6000);

    // Populate the capped cache
    await log.getEvents();
    expect((log as any).cache!.length).toBe(5000);

    // Append a new event
    await log.append({ type: 'agent_end', agentId: 'new', result: {} });

    // getEvents now reads file again: 6001 events on disk, capped to 5000
    const events = await log.getEvents();
    expect(events).toHaveLength(5000);

    // The most recent event should be the one we just appended
    expect((events[events.length - 1] as { agentId?: string }).agentId).toBe('new');
  });

  // ── Clear resets cache ─────────────────────────────────────────────

  it('clear works correctly after capped cache', async () => {
    await writeEvents(6000);

    // Populate the capped cache
    await log.getEvents();
    expect((log as any).cache!.length).toBe(5000);

    await log.clear();

    expect((log as any).cache).toBeNull();

    const events = await log.getEvents();
    expect(events).toEqual([]);
  });

  // ── Concurrent getEvents with cap ───────────────────────────────────

  it('concurrent getEvents calls all respect the cap', async () => {
    await writeEvents(6000);

    // Invalidate cache
    (log as any).cache = null;

    const [result1, result2, result3] = await Promise.all([log.getEvents(), log.getEvents(), log.getEvents()]);

    expect(result1).toHaveLength(5000);
    expect(result2).toHaveLength(5000);
    expect(result3).toHaveLength(5000);

    // All should have same content (most recent 5000)
    expect((result1[0] as { agentId?: string }).agentId).toBe((result2[0] as { agentId?: string }).agentId);
    expect((result1[0] as { agentId?: string }).agentId).toBe((result3[0] as { agentId?: string }).agentId);
  });

  // ── getEventsByTask with cap ────────────────────────────────────────

  it('getEventsByTask works correctly with capped cache', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      const taskId = i < 2000 ? 'task-a' : 'task-b';
      lines.push(
        JSON.stringify({
          type: 'agent_start',
          agentId: `a${i}`,
          profile: {},
          taskId,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'audit.jsonl'), lines.join('\n') + '\n', 'utf-8');

    // Cache capped to 5000: indices 1000..5999
    // task-a: 1000..1999 = 1000 events
    // task-b: 2000..5999 = 4000 events
    const taskA = await log.getEventsByTask('task-a');
    expect(taskA).toHaveLength(1000);
    expect(taskA.every((e) => (e as any).taskId === 'task-a')).toBe(true);

    const taskB = await log.getEventsByTask('task-b');
    expect(taskB).toHaveLength(4000);
    expect(taskB.every((e) => (e as any).taskId === 'task-b')).toBe(true);
  });

  // ── Cap constant is defined (structural check) ──────────────────────

  it('getEvents source contains MAX_CACHED_EVENTS constant', async () => {
    const source = AuditLog.prototype.getEvents.toString();
    expect(source).toContain('MAX_CACHED_EVENTS');
    expect(source).toContain('5000');
  });

  it('getEvents source calls slice with -MAX_CACHED_EVENTS', async () => {
    const source = AuditLog.prototype.getEvents.toString();
    expect(source).toContain('.slice(-MAX_CACHED_EVENTS)');
  });
});
