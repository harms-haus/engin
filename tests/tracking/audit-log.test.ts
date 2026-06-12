import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AuditLog } from '../../src/tracking/audit-log.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('AuditLog', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let log: AuditLog;

  beforeEach(() => {
    dir = getDir();
    log = new AuditLog(dir);
  });

  // ── append ──────────────────────────────────────────────────────────

  it('append writes a JSONL line with timestamp', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });

    const raw = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf-8');
    const record = JSON.parse(raw.trim());

    expect(record.type).toBe('agent_start');
    expect(record.agentId).toBe('a1');
    expect(record.timestamp).toBeDefined();
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
  });

  it('append creates directory if missing', async () => {
    const nested = path.join(dir, 'deep', 'nested');
    const nestedLog = new AuditLog(nested);

    await nestedLog.append({ type: 'error', agentId: 'e1', error: 'boom' });

    const raw = await fs.readFile(path.join(nested, 'audit.jsonl'), 'utf-8');
    const record = JSON.parse(raw.trim());

    expect(record.type).toBe('error');
  });

  // ── getEvents ───────────────────────────────────────────────────────

  it('getEvents reads back all events', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.append({ type: 'agent_end', agentId: 'a1', result: { cost: 0.5 } });
    await log.append({ type: 'error', agentId: 'a2', error: 'fail' });

    const events = await log.getEvents();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(['agent_start', 'agent_end', 'error']);
  });

  it('getEvents with type filter', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.append({ type: 'agent_end', agentId: 'a1', result: {} });
    await log.append({ type: 'agent_end', agentId: 'a2', result: {} });

    const ends = await log.getEvents({ type: 'agent_end' });
    expect(ends).toHaveLength(2);
    expect(ends.every((e) => e.type === 'agent_end')).toBe(true);
  });

  it('getEvents with taskId filter', async () => {
    await log.append({
      type: 'agent_start',
      agentId: 'a1',
      profile: {} as never,
      taskId: 'task-1',
    });
    await log.append({
      type: 'agent_start',
      agentId: 'a2',
      profile: {} as never,
      taskId: 'task-2',
    });
    await log.append({
      type: 'agent_end',
      agentId: 'a1',
      result: {},
      taskId: 'task-1',
    });

    const task1 = await log.getEvents({ taskId: 'task-1' });
    expect(task1).toHaveLength(2);
    expect(task1.every((e) => (e as never).taskId === 'task-1')).toBe(true);
  });

  it("getEvents returns [] when file doesn't exist", async () => {
    const events = await log.getEvents();
    expect(events).toEqual([]);
  });

  // ── getEventsByTask ──────────────────────────────────────────────

  it('getEventsByTask returns only events for the given task', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never, taskId: 't1' });
    await log.append({ type: 'agent_end', agentId: 'a1', result: {}, taskId: 't1' });
    await log.append({ type: 'agent_start', agentId: 'a2', profile: {} as never, taskId: 't2' });
    await log.append({ type: 'error', agentId: 'a1', error: 'fail', taskId: 't1' });

    const t1 = await log.getEventsByTask('t1');
    expect(t1).toHaveLength(3);
    expect(t1.map((e) => e.type)).toEqual(['agent_start', 'agent_end', 'error']);

    const t2 = await log.getEventsByTask('t2');
    expect(t2).toHaveLength(1);
    expect(t2[0].type).toBe('agent_start');

    const missing = await log.getEventsByTask('nope');
    expect(missing).toHaveLength(0);
  });

  // ── clear ───────────────────────────────────────────────────────────

  it('clear deletes the file', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });

    const before = await log.getEvents();
    expect(before).toHaveLength(1);

    await log.clear();

    const after = await log.getEvents();
    expect(after).toEqual([]);
  });

  it('clear is safe when file does not exist', async () => {
    await expect(log.clear()).resolves.toBeUndefined();
  });

  // ── cache eviction ──────────────────────────────────────────────────

  it('getEvents evicts cache when it exceeds 1000 entries', async () => {
    // Append some real events and call getEvents to populate the cache
    for (let i = 0; i < 5; i++) {
      await log.append({ type: 'agent_start', agentId: `a${i}`, profile: {} as never });
    }
    const firstCall = await log.getEvents();
    expect(firstCall).toHaveLength(5);

    // Cache should now be populated
    expect((log as any).cache).not.toBeNull();

    // Manually inflate cache to 1001 entries to exceed the threshold
    const base = { type: 'agent_start', agentId: 'x', profile: {}, timestamp: new Date().toISOString() };
    (log as any).cache = Array.from({ length: 1001 }, () => ({ ...base }));
    expect((log as any).cache.length).toBe(1001);

    // Calling getEvents again should return data and then evict the cache
    const result = await log.getEvents();
    expect(result).toHaveLength(1001);
    expect((log as any).cache).toBeNull();
  });

  it('getEvents does not evict cache with 1000 or fewer entries', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.getEvents();

    // Cache should be populated and small
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cache.length).toBeLessThanOrEqual(1000);

    // Manually set cache to exactly 1000 entries (boundary)
    const base = { type: 'agent_start', agentId: 'x', profile: {}, timestamp: new Date().toISOString() };
    (log as any).cache = Array.from({ length: 1000 }, () => ({ ...base }));

    await log.getEvents();

    // At exactly 1000, cache should NOT be evicted
    expect((log as any).cache).not.toBeNull();
  });

  // ── malformed JSON ──────────────────────────────────────────────────

  it('getEvents skips malformed JSON lines', async () => {
    await fs.mkdir(dir, { recursive: true });

    const valid = { type: 'agent_start', agentId: 'a1', profile: {}, timestamp: new Date().toISOString() };
    const content = JSON.stringify(valid) + '\nNOT VALID JSON{\n' + JSON.stringify(valid) + '\n';
    await fs.writeFile(path.join(dir, 'audit.jsonl'), content, 'utf-8');

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const events = await log.getEvents();
    expect(events).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('Skipping malformed');

    warnSpy.mockRestore();
  });
});
