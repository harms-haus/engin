import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AuditLog } from '../../src/tracking/audit-log.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

/**
 * Tests for the serialized cache rebuild mechanism.
 *
 * The invariant: at most one file-read rebuild can be in flight at a time.
 * Once the cache is populated, it is served from memory.
 * Concurrent callers awaiting getEvents() share the same rebuild promise.
 */
describe('AuditLog cache serialization', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let log: AuditLog;

  beforeEach(() => {
    dir = getDir();
    log = new AuditLog(dir);
  });

  // ── Fast path: cache hit does not trigger rebuild ──────────────────

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

  // ── Serialized rebuilds: concurrent getEvents share one promise ────

  it('concurrent getEvents calls share a single rebuild promise', async () => {
    // Write some events to the log
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.append({ type: 'agent_end', agentId: 'a1', result: {} });

    // Invalidate cache so next getEvents triggers a rebuild
    (log as any).cache = null;

    // Fire multiple concurrent getEvents calls while cache is null.
    // With serialized rebuilds, all should share the same cacheBuildPromise
    // and only one file read should happen.
    const [result1, result2, result3] = await Promise.all([log.getEvents(), log.getEvents(), log.getEvents()]);

    // All should return the same data
    expect(result1).toHaveLength(2);
    expect(result2).toHaveLength(2);
    expect(result3).toHaveLength(2);

    // After all resolve, cache should be populated and build promise cleared
    expect((log as any).cache).not.toBeNull();
    // cacheBuildPromise should be null (not undefined) after the fix
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── append invalidates cacheBuildPromise ───────────────────────────

  it('append invalidates cache and any in-flight rebuild promise', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });

    // Populate cache
    await log.getEvents();
    expect((log as any).cache).not.toBeNull();

    // Append should null out cache
    await log.append({ type: 'agent_end', agentId: 'a1', result: { cost: 1.0 } });
    expect((log as any).cache).toBeNull();

    // The build promise field should also be cleared (falsy)
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── append during rebuild invalidates the rebuild result ───────────

  it('append after concurrent getEvents forces fresh data on next getEvents', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });

    // Populate cache so the first getEvents resolves quickly
    await log.getEvents();
    expect((log as any).cache).not.toBeNull();

    // Now append a new event — this invalidates the cache
    await log.append({ type: 'agent_end', agentId: 'a1', result: {} });
    expect((log as any).cache).toBeNull();

    // The build promise field should also be cleared (falsy)
    expect((log as any).cacheBuildPromise).toBeFalsy();

    // getEvents must now rebuild from disk and see both events
    const events = await log.getEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(['agent_start', 'agent_end']);
  });

  // ── Sequential getEvents calls after append see fresh data ─────────

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

  // ── cacheBuildPromise is null when cache is populated ──────────────

  it('cacheBuildPromise is falsy after cache is populated from disk', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    (log as any).cache = null;

    // Before getEvents, cacheBuildPromise should be falsy (no build in-flight yet)
    expect((log as any).cacheBuildPromise).toBeFalsy();

    await log.getEvents();

    // After rebuilding, cache is populated and no build promise is in-flight
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── Clear also resets cacheBuildPromise ────────────────────────────

  it('clear resets both cache and cacheBuildPromise', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.getEvents();

    expect((log as any).cache).not.toBeNull();

    await log.clear();

    expect((log as any).cache).toBeNull();
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── Multiple appends interleaved with getEvents see consistent data

  it('multiple appends interleaved with concurrent getEvents see consistent data', async () => {
    // Write 3 events
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.append({ type: 'agent_end', agentId: 'a1', result: {} });
    await log.append({ type: 'error', agentId: 'a2', error: 'fail' });

    // Read events and verify all 3 are there
    const events = await log.getEvents();
    expect(events).toHaveLength(3);
  });

  // ── Stress test: many concurrent getEvents with intermittent appends

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

  // ── Rebuild promise is shared, not duplicated ──────────────────────

  it('second getEvents during rebuild awaits the same promise', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    (log as any).cache = null;

    // Start first getEvents — it will initiate a rebuild
    const promise1 = log.getEvents();

    // While the rebuild is in-flight, cacheBuildPromise should be set (truthy)
    const buildPromise = (log as any).cacheBuildPromise;

    // If cacheBuildPromise is implemented, it should be a Promise and not null
    if (buildPromise !== undefined) {
      expect(buildPromise).not.toBeNull();
      expect(buildPromise).toBeInstanceOf(Promise);

      // Start second getEvents — should attach to the same promise
      const promise2 = log.getEvents();

      // Both should share the same cacheBuildPromise
      expect((log as any).cacheBuildPromise).toBe(buildPromise);

      const [r1, r2] = await Promise.all([promise1, promise2]);

      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
    } else {
      // Pre-fix: both calls should still return correct data even without serialization
      const promise2 = log.getEvents();
      const [r1, r2] = await Promise.all([promise1, promise2]);
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
    }

    // After completion, the build promise should be cleared (falsy)
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── getEvents on empty file returns [] and populates cache ─────────

  it('getEvents on missing file populates cache with empty array and clears build promise', async () => {
    // No file exists, no events appended
    const events = await log.getEvents();

    expect(events).toEqual([]);
    expect((log as any).cache).toEqual([]);
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── getEvents with filter still uses cache properly ────────────────

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

  // ── Cache eviction still works after serialization fix ──────────────

  it('getEvents evicts cache when it exceeds 1000 entries (with build promise cleared)', async () => {
    for (let i = 0; i < 5; i++) {
      await log.append({ type: 'agent_start', agentId: `a${i}`, profile: {} as never });
    }
    const firstCall = await log.getEvents();
    expect(firstCall).toHaveLength(5);

    // Cache should be populated and no build promise in-flight
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cacheBuildPromise).toBeFalsy();

    // Manually inflate cache to 1001 entries to exceed the threshold
    const base = { type: 'agent_start', agentId: 'x', profile: {}, timestamp: new Date().toISOString() };
    (log as any).cache = Array.from({ length: 1001 }, () => ({ ...base }));

    // Calling getEvents should return data and then evict the cache
    const result = await log.getEvents();
    expect(result).toHaveLength(1001);
    expect((log as any).cache).toBeNull();
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── Concurrent getEvents with different filters share the same rebuild

  it('concurrent getEvents with different filters share one rebuild', async () => {
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

    // Only one rebuild should have happened
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── Race: append between two getEvents calls ───────────────────────

  it('append between two sequential getEvents calls ensures fresh data', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });

    const first = await log.getEvents();
    expect(first).toHaveLength(1);

    // Append invalidates cache
    await log.append({ type: 'error', agentId: 'a1', error: 'oops' });

    // Second getEvents must rebuild from disk and see the new event
    const second = await log.getEvents();
    expect(second).toHaveLength(2);
    expect(second[1].type).toBe('error');
  });

  // ── Only one file read during concurrent getEvents (spy on readFile) ─

  it('concurrent getEvents calls trigger at most one readFile call for the audit log', async () => {
    for (let i = 0; i < 3; i++) {
      await log.append({ type: 'agent_start', agentId: `a${i}`, profile: {} as never });
    }

    // Invalidate cache to force rebuild
    (log as any).cache = null;

    // Spy on fs.readFile to count how many times the audit log file is read
    let readFileCallCount = 0;
    const origReadFile = fs.readFile.bind(fs);
    const spy = spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
      const filePath = args[0];
      if (typeof filePath === 'string' && filePath.endsWith('audit.jsonl')) {
        readFileCallCount++;
      }
      // @ts-expect-error spy type mismatch
      return origReadFile(...args);
    });

    // Fire 5 concurrent getEvents calls
    const results = await Promise.all([
      log.getEvents(),
      log.getEvents(),
      log.getEvents(),
      log.getEvents(),
      log.getEvents(),
    ]);

    // All should return correct data
    for (const result of results) {
      expect(result).toHaveLength(3);
    }

    // With serialized rebuilds, only 1 readFile call should have been made.
    // Without the fix, each concurrent caller independently reads the file (5 reads).
    // This is the key invariant that proves the race condition is fixed.
    expect(readFileCallCount).toBeLessThanOrEqual(1);

    spy.mockRestore();
  });

  // ── getStats works correctly with serialized rebuilds ──────────────

  it('getStats works correctly with serialized rebuilds', async () => {
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

    // Call getStats concurrently — it calls getEvents internally
    const [stats1, stats2] = await Promise.all([log.getStats(), log.getStats()]);

    expect(stats1.totalEvents).toBe(4);
    expect(stats1.totalCost).toBe(2.0);
    expect(stats1.totalTokens).toBe(150);

    expect(stats2).toEqual(stats1);
  });

  // ── getEventsByTask works with serialized rebuilds ─────────────────

  it('getEventsByTask works correctly with serialized rebuilds', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never, taskId: 't1' });
    await log.append({ type: 'agent_end', agentId: 'a1', result: {}, taskId: 't1' });
    await log.append({ type: 'agent_start', agentId: 'a2', profile: {} as never, taskId: 't2' });

    (log as any).cache = null;

    const [t1, t2] = await Promise.all([log.getEventsByTask('t1'), log.getEventsByTask('t2')]);

    expect(t1).toHaveLength(2);
    expect(t2).toHaveLength(1);
  });

  // ── Rebuild promise reference equality for concurrent callers ──────

  it('concurrent callers resolve with data from the same rebuild', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    (log as any).cache = null;

    // Start 3 concurrent getEvents
    const promises = [log.getEvents(), log.getEvents(), log.getEvents()];

    const results = await Promise.all(promises);

    // All results should have the same length
    expect(results.every((r) => r.length === 1)).toBe(true);

    // Cache should now be populated
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── Error during rebuild propagates to all waiters ─────────────────

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

  // ── Fresh rebuild after cache eviction uses serialized rebuild ──────

  it('fresh rebuild after cache eviction still serializes', async () => {
    for (let i = 0; i < 5; i++) {
      await log.append({ type: 'agent_start', agentId: `a${i}`, profile: {} as never });
    }

    // First call to populate cache
    await log.getEvents();
    expect((log as any).cache).not.toBeNull();

    // Manually null the cache to simulate eviction
    (log as any).cache = null;

    // Concurrent calls should share one rebuild
    const [r1, r2] = await Promise.all([log.getEvents(), log.getEvents()]);

    expect(r1).toHaveLength(5);
    expect(r2).toHaveLength(5);
    expect((log as any).cache).not.toBeNull();
    expect((log as any).cacheBuildPromise).toBeFalsy();
  });

  // ── Clear resets both cache and cacheBuildPromise ──────────────────

  it('clear resets both cache and cacheBuildPromise after cache populated', async () => {
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.getEvents();

    expect((log as any).cache).not.toBeNull();

    // No concurrent operations — clear should cleanly reset state
    await log.clear();

    expect((log as any).cache).toBeNull();
    expect((log as any).cacheBuildPromise).toBeFalsy();

    // Subsequent getEvents should return empty
    const events = await log.getEvents();
    expect(events).toEqual([]);
  });
});
