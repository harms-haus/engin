import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AuditLog } from '../../src/tracking/audit-log.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

/**
 * Tests for the simplified cache mechanism (invalidate-on-write).
 *
 * The cache is nulled on every append/clear. getEvents rebuilds it from
 * disk on first call. No while loop, no cacheBuildPromise, no _cacheStale.
 */
describe('AuditLog cache (invalidate-on-write)', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let log: AuditLog;

  beforeEach(() => {
    dir = getDir();
    log = new AuditLog(dir);
  });

  // ── Cache hit: second call does NOT re-read the file ──────────────────

  it('getEvents uses cached data on second call without reading the file again', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });

    // First call populates cache
    const first = await log.getEvents();
    expect(first).toHaveLength(1);

    // Delete the file; if cache works, second call won't try to read it
    await fs.unlink(path.join(dir, 'audit.jsonl'));

    // Second call should use cache — fast path, no file read needed
    const second = await log.getEvents();
    expect(second).toHaveLength(1);
  });

  // ── Cache invalidated on append ──────────────────────────────────────

  it('append invalidates cache (sets it to null)', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });

    // Populate cache
    await log.getEvents();
    expect((log as any).cache).not.toBeNull();

    // Append should null out cache
    await log.append({ type: 'agent_end', agentId: 'a1', result: { cost: 1.0 } });
    expect((log as any).cache).toBeNull();
  });

  it('append forces fresh data on next getEvents', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.getEvents();

    // Append invalidates cache
    await log.append({ type: 'agent_end', agentId: 'a1', result: {} });
    expect((log as any).cache).toBeNull();

    // getEvents must now rebuild from disk and see both events
    const events = await log.getEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(['agent_start', 'agent_end']);
  });

  // ── Sequential getEvents see latest data ─────────────────────────────

  it('sequential getEvents calls after append see the latest data', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });

    const first = await log.getEvents();
    expect(first).toHaveLength(1);

    await log.append({ type: 'agent_end', agentId: 'a1', result: {} });

    const second = await log.getEvents();
    expect(second).toHaveLength(2);

    await log.append({ type: 'error', agentId: 'a2', error: 'fail' });

    const third = await log.getEvents();
    expect(third).toHaveLength(3);
  });

  // ── Concurrent getEvents calls work correctly ────────────────────────

  it('concurrent getEvents calls all return correct data', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.append({ type: 'agent_end', agentId: 'a1', result: {} });

    // Invalidate cache so next getEvents triggers a rebuild
    (log as any).cache = null;

    // Fire multiple concurrent getEvents calls.
    // With simple invalidate-on-write, each caller that finds cache===null
    // will rebuild independently. This is safe because appendFile is atomic
    // per line and readFile always sees a consistent snapshot.
    const [result1, result2, result3] = await Promise.all([log.getEvents(), log.getEvents(), log.getEvents()]);

    // All should return the same data
    expect(result1).toHaveLength(2);
    expect(result2).toHaveLength(2);
    expect(result3).toHaveLength(2);

    // After all resolve, cache should be populated
    expect((log as any).cache).not.toBeNull();
  });

  it('handles many concurrent getEvents calls correctly', async () => {
    // Pre-populate with events
    for (let i = 0; i < 10; i++) {
      await log.append({ type: 'agent_start', agentId: `a${i}`, profile: {} as never });
    }

    // Invalidate cache to force rebuilds
    (log as any).cache = null;

    // Fire many concurrent getEvents
    const results = await Promise.all(Array.from({ length: 20 }, () => log.getEvents()));

    // All results should be consistent
    for (const result of results) {
      expect(result).toHaveLength(10);
    }
  });

  // ── Cache persists across sequential calls without append ────────────

  it('cache persists across sequential calls without append', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.getEvents();

    // Populate a large cache
    const base = {
      type: 'agent_start' as const,
      agentId: 'x',
      profile: {} as never,
      timestamp: new Date().toISOString(),
    };
    (log as any).cache = Array.from({ length: 2000 }, () => ({ ...base }));

    // First getEvents should return data and keep cache
    const r1 = await log.getEvents();
    expect(r1).toHaveLength(2000);
    expect((log as any).cache).not.toBeNull();

    // Second getEvents should use cached data (no re-read)
    const r2 = await log.getEvents();
    expect(r2).toHaveLength(2000);
    expect((log as any).cache).not.toBeNull();
  });

  // ── Cache is NOT auto-evicted regardless of size ─────────────────────

  it('getEvents does not auto-evict cache even with many entries', async () => {
    for (let i = 0; i < 5; i++) {
      await log.append({ type: 'agent_start', agentId: `a${i}`, profile: {} as never });
    }
    const firstCall = await log.getEvents();
    expect(firstCall).toHaveLength(5);

    // Cache should now be populated
    expect((log as any).cache).not.toBeNull();

    // Manually inflate cache to >1000 entries
    const base = {
      type: 'agent_start' as const,
      agentId: 'x',
      profile: {} as never,
      timestamp: new Date().toISOString(),
    };
    (log as any).cache = Array.from({ length: 1001 }, () => ({ ...base }));
    expect((log as any).cache!.length).toBe(1001);

    // getEvents must NOT evict the cache. The cache should persist.
    const result = await log.getEvents();
    expect(result).toHaveLength(1001);
    // Cache is still present after getEvents (no auto-invalidation)
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cache!.length).toBe(1001);
  });

  it('getEvents keeps cache populated after read regardless of size', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.getEvents();

    // Cache should be populated
    expect((log as any).cache).not.toBeNull();

    // Manually set cache to exactly 1000 entries
    const base = {
      type: 'agent_start' as const,
      agentId: 'x',
      profile: {} as never,
      timestamp: new Date().toISOString(),
    };
    (log as any).cache = Array.from({ length: 1000 }, () => ({ ...base }));

    await log.getEvents();

    // Cache should NOT be evicted (no auto-invalidation at any size)
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cache!.length).toBe(1000);
  });

  // ── Clear resets cache ───────────────────────────────────────────────

  it('clear resets cache to null', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.getEvents();

    expect((log as any).cache).not.toBeNull();

    await log.clear();

    expect((log as any).cache).toBeNull();

    // Subsequent getEvents should return empty
    const events = await log.getEvents();
    expect(events).toEqual([]);
  });

  // ── Filtered getEvents uses cache properly ───────────────────────────

  it('getEvents with filter uses cached data on subsequent calls', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.append({ type: 'agent_end', agentId: 'a1', result: {} });

    // First call populates cache
    const starts = await log.getEvents({ type: 'agent_start' });
    expect(starts).toHaveLength(1);

    // Delete the file; if cache works, second call won't fail
    await fs.unlink(path.join(dir, 'audit.jsonl'));

    // Second call with different filter — should still use cache
    const ends = await log.getEvents({ type: 'agent_end' });
    expect(ends).toHaveLength(1);
  });

  // ── Concurrent getEvents with different filters ──────────────────────

  it('concurrent getEvents with different filters all work', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never, taskId: 't1' });
    await log.append({ type: 'agent_end', agentId: 'a1', result: {}, taskId: 't1' });
    await log.append({ type: 'agent_start', agentId: 'a2', profile: {} as never, taskId: 't2' });

    (log as any).cache = null;

    // Fire concurrent getEvents with different filters
    const [all, byType, byTask] = await Promise.all([
      log.getEvents(),
      log.getEvents({ type: 'agent_start' }),
      log.getEvents({ taskId: 't1' }),
    ]);

    expect(all).toHaveLength(3);
    expect(byType).toHaveLength(2);
    expect(byType.every((e) => e.type === 'agent_start')).toBe(true);
    expect(byTask).toHaveLength(2);
    expect(byTask.every((e) => (e as any).taskId === 't1')).toBe(true);

    // Cache should be populated
    expect((log as any).cache).not.toBeNull();
  });

  // ── getStats works correctly ─────────────────────────────────────────

  it('getStats works correctly', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.append({
      type: 'agent_end',
      agentId: 'a1',
      result: { cost: 1.5, tokens: 100 },
    });
    await log.append({ type: 'agent_start', agentId: 'a2', profile: {} as never });
    await log.append({
      type: 'agent_end',
      agentId: 'a2',
      result: { cost: 0.5, tokens: 50 },
    });

    // Invalidate cache
    (log as any).cache = null;

    const stats = await log.getStats();

    expect(stats.totalEvents).toBe(4);
    expect(stats.totalCost).toBe(2.0);
    expect(stats.totalTokens).toBe(150);
  });

  // ── getEventsByTask works correctly ──────────────────────────────────

  it('getEventsByTask works correctly', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never, taskId: 't1' });
    await log.append({ type: 'agent_end', agentId: 'a1', result: {}, taskId: 't1' });
    await log.append({ type: 'agent_start', agentId: 'a2', profile: {} as never, taskId: 't2' });

    (log as any).cache = null;

    const [t1, t2] = await Promise.all([log.getEventsByTask('t1'), log.getEventsByTask('t2')]);

    expect(t1).toHaveLength(2);
    expect(t2).toHaveLength(1);
  });

  // ── Missing file returns empty array ─────────────────────────────────

  it('getEvents on missing file populates cache with empty array', async () => {
    // No file exists, no events appended
    const events = await log.getEvents();

    expect(events).toEqual([]);
    expect((log as any).cache).toEqual([]);
  });

  // ── Error during file read propagates ────────────────────────────────

  it('error during file read propagates correctly', async () => {
    // Create a scenario where readFile will throw a non-ENOENT error
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    (log as any).cache = null;

    // Spy on readFile to throw a permission error
    const spy = spyOn(fs, 'readFile').mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );

    // All concurrent getEvents should reject with the same error
    const results = await Promise.allSettled([log.getEvents(), log.getEvents()]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');

    if (results[0].status === 'rejected') {
      expect(results[0].reason.message).toBe('permission denied');
    }
    if (results[1].status === 'rejected') {
      expect(results[1].reason.message).toBe('permission denied');
    }

    spy.mockRestore();
  });

  // ── Append during concurrent getEvents ───────────────────────────────

  it('append during concurrent getEvents returns fresh data', async () => {
    // Write one event and populate the cache
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.getEvents();

    // Invalidate cache
    (log as any).cache = null;

    // Start getEvents – it will read the file
    const getEventsPromise = log.getEvents();

    // While the read is "in flight", append a new event.
    // With invalidate-on-write, append() sets cache=null, but the first
    // getEvents already started reading. It will see the state of the
    // file at the time it reads. If the append completes before the read,
    // the read will include the new event. If not, the first getEvents
    // misses it but the second getEvents will re-read and find it.
    // Either way, data is eventually consistent.
    await log.append({ type: 'agent_end', agentId: 'a1', result: {} });

    // Wait for the first getEvents to complete
    const events = await getEventsPromise;

    // The result must include at least the first event.
    // Due to timing, it may or may not include the appended event,
    // but the cache should be valid and subsequent calls see everything.
    expect(events.length).toBeGreaterThanOrEqual(1);

    // A subsequent getEvents must see both events
    const allEvents = await log.getEvents();
    expect(allEvents).toHaveLength(2);
    expect(allEvents.map((e) => e.type).sort()).toEqual(['agent_end', 'agent_start']);
  });

  // ── Structural: no while loop, no cacheBuildPromise, no _cacheStale ──

  it('does not have the old _cacheStale field', async () => {
    expect((log as any)._cacheStale).toBeUndefined();
  });

  it('does not have the old cacheBuildPromise field', async () => {
    expect((log as any).cacheBuildPromise).toBeUndefined();
  });

  it('has the cache field (private)', async () => {
    // cache is a private field, so we access it via any
    expect((log as any).cache).toBeNull();
  });

  it('does not contain a while loop in getEvents source', async () => {
    // Verify by checking the class definition has no while keyword
    const source = AuditLog.prototype.getEvents.toString();
    expect(source).not.toContain('while');
  });

  it('getEvents method does not contain cacheBuildPromise logic', async () => {
    const source = AuditLog.prototype.getEvents.toString();
    expect(source).not.toContain('cacheBuildPromise');
  });
});
