import { afterEach, beforeEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Registers beforeEach/afterEach hooks to create and clean up a temp directory.
 * Call inside a describe() block to isolate temp dir to that block's tests.
 *
 * The directory is created in beforeEach and recursively removed in afterEach.
 */
export function useTempDir(): { getDir: () => string } {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  return {
    getDir: () => dir,
  };
}
