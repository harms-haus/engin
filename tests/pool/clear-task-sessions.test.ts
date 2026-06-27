import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearTaskSessions } from '../../packages/engine/src/pool/session.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('clearTaskSessions', () => {
  const { getDir } = useTempDir();

  it('recursively deletes the task session directory', async () => {
    const base = getDir();
    const taskDir = join(base, 'task-1');
    // Create nested session subdirs matching the {exec}-{idx}-{stepName} layout
    await mkdir(join(taskDir, '0-0-write-tests'), { recursive: true });
    await mkdir(join(taskDir, '0-1-review'), { recursive: true });
    await writeFile(join(taskDir, '0-0-write-tests', 'session.jsonl'), '...');

    clearTaskSessions(base, 'task-1');

    expect(existsSync(taskDir)).toBe(false);
    expect(existsSync(join(taskDir, '0-0-write-tests', 'session.jsonl'))).toBe(false);
  });

  it('is a no-op when the task directory does not exist', () => {
    const base = getDir();
    expect(() => clearTaskSessions(base, 'never-existed')).not.toThrow();
    expect(existsSync(join(base, 'never-existed'))).toBe(false);
  });

  it('leaves other tasks’ sessions untouched', async () => {
    const base = getDir();
    await mkdir(join(base, 'task-1', '0-0-write-tests'), { recursive: true });
    await mkdir(join(base, 'task-2', '0-0-write-tests'), { recursive: true });
    await writeFile(join(base, 'task-2', '0-0-write-tests', 'session.jsonl'), '...');

    clearTaskSessions(base, 'task-1');

    expect(existsSync(join(base, 'task-1'))).toBe(false);
    expect(existsSync(join(base, 'task-2', '0-0-write-tests', 'session.jsonl'))).toBe(true);
  });

  it('rejects task ids with path-traversal characters', () => {
    const base = getDir();
    // safeName regex is ^[a-zA-Z0-9_-]+$, so dots / slashes must be rejected.
    expect(() => clearTaskSessions(base, '../escape')).toThrow('unsafe characters');
    expect(() => clearTaskSessions(base, 'a/b')).toThrow('unsafe characters');
  });
});
