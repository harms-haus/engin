import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEvent } from '../core/types.js';
import { isEnoentError } from '../core/utils.js';

export class AuditLog {
  private readonly logPath: string;
  private cache: AuditEvent[] | null = null;
  private cacheBuildPromise: Promise<AuditEvent[]> | null = null;
  private dirEnsured = false;

  constructor(private readonly logDir: string) {
    this.logPath = join(logDir, 'audit.jsonl');
  }

  async append(event: Omit<AuditEvent, 'timestamp'>): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(this.logDir, { recursive: true });
      this.dirEnsured = true;
    }

    const record = {
      ...event,
      timestamp: new Date().toISOString(),
    } as AuditEvent;

    await appendFile(this.logPath, JSON.stringify(record) + '\n', 'utf-8');
    this.cache = null;
    this.cacheBuildPromise = null;
  }

  async getEvents(filter?: { taskId?: string; type?: string }): Promise<AuditEvent[]> {
    if (this.cache === null) {
      if (this.cacheBuildPromise === null) {
        this.cacheBuildPromise = (async () => {
          let content: string;
          try {
            content = await readFile(this.logPath, 'utf-8');
          } catch (err: unknown) {
            if (isEnoentError(err)) {
              this.cache = [];
              this.cacheBuildPromise = null;
              return this.cache;
            } else {
              throw err;
            }
          }

          const events: AuditEvent[] = [];
          for (const line of content.split('\n')) {
            if (line.trim() === '') continue;
            try {
              events.push(JSON.parse(line) as AuditEvent);
            } catch {
              console.warn(`Skipping malformed JSONL line: ${line.slice(0, 100)}`);
            }
          }
          this.cache = events;
          this.cacheBuildPromise = null;
          return this.cache;
        })();
      }
      await this.cacheBuildPromise;
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
    this.cacheBuildPromise = null;
    this.dirEnsured = false;
  }
}
