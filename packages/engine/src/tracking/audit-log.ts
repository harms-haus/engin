import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEvent } from '../core/types.js';
import { isEnoentError } from '../core/utils.js';

// `Omit` does NOT distribute over a union, so `Omit<AuditEvent, 'timestamp'>`
// would keep only the keys shared by every variant and silently drop
// variant-specific fields (profile / result / error / ...). This distributive
// form omits 'timestamp' from each union member independently. (Uses
// `PropertyKey` + `infer O` instead of the usual `keyof any` / `T extends any`
// so it stays clear of the no-explicit-any lint rule.)
type DistributiveOmit<T, K extends PropertyKey> = T extends infer O ? Omit<O, K> : never;

/** Constructor options for {@link AuditLog}. */
export interface AuditLogOptions {
  /**
   * Maximum size (in bytes) of the current `audit.jsonl` before it is rotated
   * into an archived file (`audit.<timestamp>.jsonl`). Defaults to 10 MB.
   */
  maxFileSize?: number;
  /**
   * Maximum number of archived files to retain after rotation. When more
   * archives than this exist, the oldest (by embedded timestamp) are deleted.
   * Defaults to 5.
   */
  maxArchivedFiles?: number;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_ARCHIVED_FILES = 5;
/** A size check is performed at most once every this many appends. */
const ROTATION_CHECK_INTERVAL = 100;
/** Matches archived files of the form `audit.<digits>.jsonl` (never `audit.jsonl`). */
const ARCHIVE_FILE_PATTERN = /^audit\.(\d+)\.jsonl$/;

export class AuditLog {
  private readonly logPath: string;
  private cache: AuditEvent[] | null = null;
  private dirEnsured = false;
  private readonly maxFileSize: number;
  private readonly maxArchivedFiles: number;
  /** Appends since the last periodic size check. */
  private appendSinceRotationCheck = 0;

  constructor(
    private readonly logDir: string,
    options?: AuditLogOptions,
  ) {
    this.logPath = join(logDir, 'audit.jsonl');
    this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.maxArchivedFiles = options?.maxArchivedFiles ?? DEFAULT_MAX_ARCHIVED_FILES;
  }

  async append(event: DistributiveOmit<AuditEvent, 'timestamp'>): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(this.logDir, { recursive: true });
      this.dirEnsured = true;
    }

    // Rotate before writing if the current file has grown too large. The size
    // check is performed periodically (every ROTATION_CHECK_INTERVAL appends)
    // rather than on every append, to avoid a stat() syscall per event.
    this.appendSinceRotationCheck++;
    if (this.appendSinceRotationCheck >= ROTATION_CHECK_INTERVAL) {
      this.appendSinceRotationCheck = 0;
      await this.maybeRotate();
    }

    const record = {
      ...event,
      timestamp: new Date().toISOString(),
    } as AuditEvent;

    await appendFile(this.logPath, JSON.stringify(record) + '\n', 'utf-8');
    this.cache = null;
  }

  /**
   * Stats the current file and, if it exceeds {@link maxFileSize}, rotates it:
   * renames `audit.jsonl` to `audit.<timestamp>.jsonl` (archived), then trims
   * the archive directory to the {@link maxArchivedFiles} most recent files.
   * A no-op when the file is missing or still under the threshold. After a
   * rotation the in-memory cache is invalidated because its contents now live
   * in the archive.
   *
   * Note: events written to archived files are NOT queryable via getEvents() /
   * getStats() — those only read the current (post-rotation) `audit.jsonl`.
   */
  private async maybeRotate(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.logPath)).size;
    } catch (err: unknown) {
      // No current file exists yet — nothing to rotate.
      if (isEnoentError(err)) return;
      throw err;
    }

    if (size <= this.maxFileSize) {
      return;
    }

    // Archive the oversized current file under a timestamped name.
    const archivePath = join(this.logDir, `audit.${Date.now()}.jsonl`);
    await rename(this.logPath, archivePath);

    // Keep only the N most recent archived files.
    await this.pruneArchives();

    // The just-rotated contents are no longer reflected by the current file.
    this.cache = null;
  }

  /**
   * Lists archived files matching `audit.<digits>.jsonl` and deletes all but
   * the {@link maxArchivedFiles} newest (by embedded timestamp). The current
   * `audit.jsonl` is never matched and therefore never deleted.
   */
  private async pruneArchives(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.logDir);
    } catch (err: unknown) {
      if (isEnoentError(err)) return;
      throw err;
    }

    const archives: { name: string; ts: number }[] = [];
    for (const name of entries) {
      const match = ARCHIVE_FILE_PATTERN.exec(name);
      if (match) {
        archives.push({ name, ts: Number(match[1]) });
      }
    }

    if (archives.length <= this.maxArchivedFiles) {
      return;
    }

    // Newest (largest timestamp) first; delete everything beyond the keep count.
    archives.sort((a, b) => b.ts - a.ts);
    const toDelete = archives.slice(this.maxArchivedFiles);
    await Promise.all(
      toDelete.map((a) =>
        unlink(join(this.logDir, a.name)).catch((err: unknown) => {
          if (!isEnoentError(err)) throw err;
        }),
      ),
    );
  }

  async getEvents(filter?: { taskId?: string; type?: string }): Promise<AuditEvent[]> {
    if (this.cache === null) {
      let content: string;
      try {
        content = await readFile(this.logPath, 'utf-8');
      } catch (err: unknown) {
        if (isEnoentError(err)) {
          this.cache = [];
          return this.cache;
        } else {
          throw err;
        }
      }

      let events: AuditEvent[] = [];
      for (const line of content.split('\n')) {
        if (line.trim() === '') continue;
        try {
          events.push(JSON.parse(line) as AuditEvent);
        } catch {
          console.warn(`Skipping malformed JSONL line: ${line.slice(0, 100)}`);
        }
      }
      const MAX_CACHED_EVENTS = 5000;
      if (events.length > MAX_CACHED_EVENTS) {
        events = events.slice(-MAX_CACHED_EVENTS);
      }
      this.cache = events;
    }

    let filtered = this.cache as AuditEvent[];

    if (filter?.type) {
      filtered = filtered.filter((e) => e.type === filter.type);
    }

    if (filter?.taskId) {
      filtered = filtered.filter((e) => e.taskId === filter.taskId);
    }

    return filtered;
  }

  async getEventsByTask(taskId: string): Promise<AuditEvent[]> {
    return this.getEvents({ taskId });
  }

  async getStats(): Promise<{ totalEvents: number; totalCost: number; totalTokens: number }> {
    const allEvents = await this.getEvents();
    const agentEndEvents = (await this.getEvents({ type: 'agent_end' })) as Extract<
      AuditEvent,
      { type: 'agent_end' }
    >[];

    let totalCost = 0;
    let totalTokens = 0;

    for (const event of agentEndEvents) {
      const result = event.result as Record<string, unknown> | undefined;
      if (result && typeof result === 'object') {
        if (typeof result.cost === 'number') {
          totalCost += result.cost;
        }
        if (typeof result.tokens === 'number') {
          totalTokens += result.tokens;
        }
      }
    }

    return {
      totalEvents: allEvents.length,
      totalCost,
      totalTokens,
    };
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.logPath);
    } catch (err: unknown) {
      if (!isEnoentError(err)) throw err;
    }
    this.cache = null;
    this.dirEnsured = false;
  }
}
