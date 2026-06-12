import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isEnoentError } from '../core/utils.js';
import type { LogEntry } from './types.js';

/**
 * Load session logs for a given task from the work directory.
 *
 * Reads all JSONL files under `sessions/{taskId}/`, sorted by step directory
 * name then file name (oldest first). Only `message` events with
 * `role === 'assistant'` are converted to `LogEntry` objects.
 *
 * Returns an empty array if the sessions directory doesn't exist or on any
 * read/parse error.
 */
export async function loadSessionLogs(workDir: string, taskId: string): Promise<LogEntry[]> {
  const logs: LogEntry[] = [];
  const sessionsDir = join(workDir, 'sessions', taskId);

  let stepDirs: string[];
  try {
    stepDirs = (await readdir(sessionsDir)).sort();
  } catch (err) {
    if (!isEnoentError(err)) throw err;
    return logs;
  }

  for (const stepDir of stepDirs) {
    const stepPath = join(sessionsDir, stepDir);
    let files: string[];
    try {
      files = (await readdir(stepPath)).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(stepPath, file);
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (event.type !== 'message') continue;
        const message = event.message as Record<string, unknown> | undefined;
        if (!message || message.role !== 'assistant') continue;

        const msgId = (event.id as string) ?? '';
        const timestamp = (event.timestamp as string) ?? '';
        const contentBlocks = (message.content as Record<string, unknown>[]) ?? [];

        for (let i = 0; i < contentBlocks.length; i++) {
          const block = contentBlocks[i] as Record<string, unknown>;
          if (block.type === 'text') {
            logs.push({
              id: `${msgId}-text-${i}`,
              timestamp,
              type: 'text',
              content: (block.text as string) ?? '',
            });
          } else if (block.type === 'thinking') {
            logs.push({
              id: `${msgId}-think-${i}`,
              timestamp,
              type: 'thinking',
              content: block.redacted ? '[redacted]' : ((block.thinking as string) ?? ''),
            });
          } else if (block.type === 'toolCall') {
            logs.push({
              id: `${msgId}-tool-${i}`,
              timestamp,
              type: 'tool_call',
              content: (block.name as string) ?? '',
              metadata: { arguments: block.arguments },
            });
          }
        }
      }
    }
  }

  return logs;
}
