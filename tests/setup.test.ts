import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { useTempDir } from './helpers/use-temp-dir.js';

// Resolve real module objects before mocking so they can be restored in afterAll
const actualConfig = Object.assign({}, await import('../packages/engine/src/core/config.js'));

// Mock ../src/core/config.js so getGlobalConfigDir returns our temp dir
let mockGlobalDir: string;

mock.module('../packages/engine/src/core/config.js', () => ({
  getGlobalConfigDir: () => mockGlobalDir,
  ensureDir: async (dirPath: string) => {
    const { mkdir: mkdirFn } = await import('node:fs/promises');
    await mkdirFn(dirPath, { recursive: true });
  },
}));

import { initDefaultConfig } from '../packages/engine/src/core/setup.js';

// Restore original modules so mocks don't leak to other test files in the same process
afterAll(() => {
  mock.module('../packages/engine/src/core/config.js', () => actualConfig);
});

describe('initDefaultConfig', () => {
  const { getDir } = useTempDir();

  beforeEach(async () => {
    mockGlobalDir = join(getDir(), 'global-config');
    await mkdir(mockGlobalDir, { recursive: true });
  });

  it('creates workflows/ directory in global config dir', async () => {
    await initDefaultConfig();

    const workflowsStat = await stat(join(mockGlobalDir, 'workflows'));
    expect(workflowsStat.isDirectory()).toBe(true);
  });

  it('returns createdDirs with workflows', async () => {
    const result = await initDefaultConfig();

    expect(result).toEqual({ createdDirs: ['workflows'] });
  });

  it('is idempotent when directories already exist', async () => {
    await initDefaultConfig();

    // Second call should not throw
    const result = await initDefaultConfig();
    expect(result).toEqual({ createdDirs: ['workflows'] });

    // Directory still exists
    const workflowsStat = await stat(join(mockGlobalDir, 'workflows'));
    expect(workflowsStat.isDirectory()).toBe(true);
  });

  it('works when global config dir does not exist yet', async () => {
    // Point mockGlobalDir to a path whose parent exists but it does not
    mockGlobalDir = join(getDir(), 'brand-new-config');

    const result = await initDefaultConfig();
    expect(result).toEqual({ createdDirs: ['workflows'] });

    // The subdirectory was created recursively
    const workflowsStat = await stat(join(mockGlobalDir, 'workflows'));
    expect(workflowsStat.isDirectory()).toBe(true);
  });
});
