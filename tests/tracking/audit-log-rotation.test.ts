import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AuditLog } from '../../packages/engine/src/tracking/audit-log.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

/**
 * Tests for AuditLog file rotation (prevents unbounded growth of audit.jsonl).
 *
 * When the current `audit.jsonl` exceeds `maxFileSize` (default 10 MB), append()
 * rotates it: renames it to `audit.<timestamp>.jsonl` (archived), starts a fresh
 * `audit.jsonl`, and trims the archive directory to the `maxArchivedFiles` most
 * recent files (default 5). The size check is performed periodically (not on
 * every append) to avoid a stat() syscall per event.
 *
 * Archived files are NOT queryable via getEvents()/getStats() — those only read
 * the current `audit.jsonl` plus the in-memory cache.
 */
describe('AuditLog file rotation', () => {
  const { getDir } = useTempDir();
  let dir: string;

  beforeEach(() => {
    dir = getDir();
  });

  // ── Helpers ───────────────────────────────────────────────────────────

  const ARCHIVE_RE = /^audit\.\d+\.jsonl$/;

  /** Lists archived files (`audit.<digits>.jsonl`), sorted by name. */
  async function listArchives(d: string): Promise<string[]> {
    const entries = await fs.readdir(d);
    return entries.filter((n) => ARCHIVE_RE.test(n)).sort();
  }

  /**
   * Appends events until a rotation creates a *new* archived file not present in
   * `known`. Robust to either periodic-check strategy:
   *  - counter-based ("every 100 appends"): the loop runs up to 250 appends so a
   *    100-append check window always fires.
   *  - cache-rebuild-based: getEvents() is interleaved every 5 appends so that
   *    a check triggered by a rebuilt cache also fires.
   * Throws if no rotation occurs within the cap.
   */
  async function appendUntilNewArchive(
    log: AuditLog,
    d: string,
    known = new Set<string>(),
    maxIters = 250,
  ): Promise<void> {
    for (let i = 0; i < maxIters; i++) {
      await log.append({ type: 'agent_start', agentId: `r${i}`, profile: {} as never });
      const archives = await listArchives(d);
      if (archives.some((n) => !known.has(n))) return;
      if (i % 5 === 0) await log.getEvents();
    }
    throw new Error(`rotation did not create a new archive within ${maxIters} appends`);
  }

  // ── Constructor options & defaults ───────────────────────────────────

  it('defaults maxFileSize to 10 MB', () => {
    const log = new AuditLog(dir);
    expect((log as any).maxFileSize).toBe(10 * 1024 * 1024);
  });

  it('defaults maxArchivedFiles to 5', () => {
    const log = new AuditLog(dir);
    expect((log as any).maxArchivedFiles).toBe(5);
  });

  it('accepts custom maxFileSize and maxArchivedFiles', () => {
    const log = new AuditLog(dir, { maxFileSize: 12345, maxArchivedFiles: 7 });
    expect((log as any).maxFileSize).toBe(12345);
    expect((log as any).maxArchivedFiles).toBe(7);
  });

  it('constructor options do not break basic append/getEvents', async () => {
    const log = new AuditLog(dir, { maxFileSize: 1000, maxArchivedFiles: 3 });
    await log.append({ type: 'agent_start', agentId: 'a1', profile: {} as never });
    await log.append({ type: 'agent_end', agentId: 'a1', result: { cost: 1 } });

    const events = await log.getEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(['agent_start', 'agent_end']);
  });

  // ── Periodic size checking ───────────────────────────────────────────

  it('does not create archive files during normal (sub-threshold) operation', async () => {
    const log = new AuditLog(dir); // 10 MB threshold
    for (let i = 0; i < 150; i++) {
      await log.append({ type: 'agent_start', agentId: `a${i}`, profile: {} as never });
    }
    expect(await listArchives(dir)).toEqual([]);
  });

  it('checks file size periodically rather than on every append', async () => {
    const log = new AuditLog(dir, { maxFileSize: 10 * 1024 * 1024, maxArchivedFiles: 5 });
    const statSpy = spyOn(fs, 'stat');

    // A handful of appends must NOT each trigger a stat() call.
    for (let i = 0; i < 5; i++) {
      await log.append({ type: 'agent_start', agentId: `e${i}`, profile: {} as never });
    }
    expect(statSpy.mock.calls.length).toBeLessThan(5);

    // After enough appends (and cache rebuilds) a periodic size check fires.
    for (let i = 5; i < 105; i++) {
      await log.append({ type: 'agent_start', agentId: `e${i}`, profile: {} as never });
      if (i % 10 === 0) await log.getEvents();
    }
    expect(statSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    statSpy.mockRestore();
  });

  // ── Rotation triggers and produces archives ──────────────────────────

  it('rotates the file once it exceeds maxFileSize', async () => {
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles: 5 });
    expect(await listArchives(dir)).toEqual([]);

    await appendUntilNewArchive(log, dir);

    const archives = await listArchives(dir);
    expect(archives.length).toBeGreaterThanOrEqual(1);

    // A current audit.jsonl must still exist after rotation.
    const stat = await fs.stat(path.join(dir, 'audit.jsonl'));
    expect(stat.isFile()).toBe(true);
  });

  it('names archived files audit.<timestamp>.jsonl', async () => {
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles: 5 });
    await appendUntilNewArchive(log, dir);

    const archives = await listArchives(dir);
    expect(archives.length).toBeGreaterThanOrEqual(1);
    for (const name of archives) {
      expect(name).toMatch(ARCHIVE_RE);
      // The embedded timestamp must be a positive integer (millis since epoch).
      const ts = Number(name.slice('audit.'.length, -'.jsonl'.length));
      expect(Number.isInteger(ts)).toBe(true);
      expect(ts).toBeGreaterThan(0);
    }
  });

  it('moves pre-rotation content into the archived file', async () => {
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles: 5 });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'audit.jsonl'),
      JSON.stringify({
        type: 'agent_start',
        agentId: 'PRE_ROTATION',
        profile: {},
        timestamp: new Date().toISOString(),
      }) + '\n',
      'utf-8',
    );

    await appendUntilNewArchive(log, dir);

    const archives = await listArchives(dir);
    expect(archives).toHaveLength(1);
    const archivedContent = await fs.readFile(path.join(dir, archives[0]), 'utf-8');
    expect(archivedContent).toContain('PRE_ROTATION');
  });

  it('starts a fresh audit.jsonl after rotation', async () => {
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles: 5 });
    await fs.mkdir(dir, { recursive: true });
    // A marker that should end up ARCHIVED, not in the fresh current file.
    await fs.writeFile(
      path.join(dir, 'audit.jsonl'),
      JSON.stringify({
        type: 'agent_start',
        agentId: 'BEFORE',
        profile: {},
        timestamp: new Date().toISOString(),
      }) + '\n',
      'utf-8',
    );

    await appendUntilNewArchive(log, dir);

    // The current file is fresh: it must NOT carry the pre-rotation marker.
    const current = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf-8');
    expect(current).not.toContain('BEFORE');

    // And it still accepts new appends.
    await log.append({ type: 'error', agentId: 'AFTER', error: 'boom' });
    const after = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf-8');
    expect(after).toContain('AFTER');
  });

  // ── API only reads the current file (archived events not queryable) ───

  it('getEvents does not return events from archived files', async () => {
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles: 5 });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'audit.jsonl'),
      JSON.stringify({
        type: 'agent_start',
        agentId: 'ARCHIVED',
        profile: {},
        timestamp: new Date().toISOString(),
      }) + '\n',
      'utf-8',
    );

    await appendUntilNewArchive(log, dir);
    await log.append({ type: 'agent_start', agentId: 'CURRENT', profile: {} as never });

    const events = await log.getEvents();
    expect(events.some((e) => 'agentId' in e && e.agentId === 'ARCHIVED')).toBe(false);
    expect(events.some((e) => 'agentId' in e && e.agentId === 'CURRENT')).toBe(true);
  });

  it('getStats only reflects the current file (ignores archived cost/tokens)', async () => {
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles: 5 });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'audit.jsonl'),
      JSON.stringify({
        type: 'agent_end',
        agentId: 'old',
        result: { cost: 5, tokens: 1000 },
        timestamp: new Date().toISOString(),
      }) + '\n',
      'utf-8',
    );

    await appendUntilNewArchive(log, dir);
    await log.append({ type: 'agent_end', agentId: 'new', result: { cost: 2, tokens: 200 } });

    const stats = await log.getStats();
    expect(stats.totalCost).toBe(2);
    expect(stats.totalTokens).toBe(200);
  });

  // ── Cache invalidation after rotation ────────────────────────────────

  it('invalidates the in-memory cache after rotation', async () => {
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles: 5 });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'audit.jsonl'),
      JSON.stringify({
        type: 'agent_start',
        agentId: 'STALE',
        profile: {},
        timestamp: new Date().toISOString(),
      }) + '\n',
      'utf-8',
    );

    // Populate the cache with the pre-rotation event.
    await log.getEvents();
    expect((log as any).cache).not.toBeNull();

    await appendUntilNewArchive(log, dir);

    // Rotation (inside append) must have invalidated the cache.
    expect((log as any).cache).toBeNull();

    // The rebuilt cache must NOT serve the archived event.
    const events = await log.getEvents();
    expect(events.some((e) => 'agentId' in e && e.agentId === 'STALE')).toBe(false);
  });

  // ── maxArchivedFiles cleanup ─────────────────────────────────────────

  it('keeps only the N most recent archived files', async () => {
    const maxArchivedFiles = 3;
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles });

    // Pre-create 5 archives with increasing realistic timestamps and matching
    // mtimes so that both name-based and mtime-based sorting agree on order.
    const base = 1_700_000_000_000; // 2023 — strictly less than any real Date.now()
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ts = base + i * 1000;
      const name = `audit.${ts}.jsonl`;
      names.push(name);
      const file = path.join(dir, name);
      await fs.writeFile(file, `old${i}\n`, 'utf-8');
      await fs.utimes(file, ts / 1000, ts / 1000);
    }
    // Oversized current file — the first periodic check will rotate it, producing
    // a real archive whose timestamp (Date.now()) is the newest of them all.
    await fs.writeFile(path.join(dir, 'audit.jsonl'), 'x'.repeat(200), 'utf-8');

    const known = new Set(await listArchives(dir));
    await appendUntilNewArchive(log, dir, known);

    const archives = await listArchives(dir);
    // Real archive (newest) + 5 fakes = 6 total, capped to maxArchivedFiles.
    expect(archives.length).toBe(maxArchivedFiles);

    // The three OLDEST fakes must have been deleted…
    expect(archives).not.toContain(names[0]);
    expect(archives).not.toContain(names[1]);
    expect(archives).not.toContain(names[2]);
    // …while the two NEWEST fakes (plus the real archive) are retained.
    expect(archives).toContain(names[3]);
    expect(archives).toContain(names[4]);
  });

  it('caps the archive count across many rotations', async () => {
    const maxArchivedFiles = 2;
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles });

    for (let i = 0; i < 400; i++) {
      await log.append({ type: 'agent_start', agentId: `a${i}`, profile: {} as never });
      if (i % 5 === 0) await log.getEvents();
    }

    const archives = await listArchives(dir);
    expect(archives.length).toBeLessThanOrEqual(maxArchivedFiles);
    expect(archives.length).toBeGreaterThanOrEqual(1);
  });

  it('does not delete the current audit.jsonl during cleanup', async () => {
    const log = new AuditLog(dir, { maxFileSize: 50, maxArchivedFiles: 1 });
    await appendUntilNewArchive(log, dir);

    // The current file must survive cleanup and remain writable.
    await log.append({ type: 'agent_start', agentId: 'after', profile: {} as never });
    const raw = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf-8');
    expect(raw).toContain('after');
  });
});
