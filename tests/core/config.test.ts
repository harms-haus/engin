import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadEnvResult } from '../../src/core/config.js';
import {
  DEFAULT_WORKER_PROFILE,
  ensureDir,
  getDefaultWorkDir,
  getGlobalConfigDir,
  getLocalConfigDir,
  loadEnvFiles,
  resolveProfilesDirs,
  resolveWorkflowsDirs,
  scanPastRuns,
} from '../../src/core/config.js';
import { useEnvSandbox } from '../helpers/env-sandbox.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── DEFAULT_WORKER_PROFILE ─────────────────────────────────────────────────

describe('DEFAULT_WORKER_PROFILE', () => {
  it('is exported as a string constant', () => {
    expect(typeof DEFAULT_WORKER_PROFILE).toBe('string');
  });

  it('has the value "worker"', () => {
    expect(DEFAULT_WORKER_PROFILE).toBe('worker');
  });

  it('is a compile-time constant (not mutable at runtime)', () => {
    // Re-importing from the module should yield the same value;
    // this also verifies the export is a simple string, not computed.
    expect(DEFAULT_WORKER_PROFILE).toStrictEqual('worker');
  });
});

// ─── Temp directory helper ──────────────────────────────────────────────────

const { getDir } = useTempDir();

// ─── getGlobalConfigDir ────────────────────────────────────────────────────

describe('getGlobalConfigDir', () => {
  let savedXdg: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  it('returns $XDG_CONFIG_HOME/engin when XDG_CONFIG_HOME is set', () => {
    process.env.XDG_CONFIG_HOME = '/custom/xdg';
    expect(getGlobalConfigDir()).toBe('/custom/xdg/engin');
  });

  it('falls back to ~/.config/engin when XDG_CONFIG_HOME is not set', () => {
    delete process.env.XDG_CONFIG_HOME;
    const result = getGlobalConfigDir();
    expect(result).toMatch(/\/\.config\/engin$/);
    expect(result).toContain('.config');
  });

  it('falls back to ~/.config/engin when XDG_CONFIG_HOME is empty string', () => {
    process.env.XDG_CONFIG_HOME = '';
    const result = getGlobalConfigDir();
    expect(result).toMatch(/\/\.config\/engin$/);
  });
});

// ─── getLocalConfigDir ─────────────────────────────────────────────────────

describe('getLocalConfigDir', () => {
  it('returns cwd/.engin', () => {
    expect(getLocalConfigDir('/project')).toBe('/project/.engin');
  });

  it('handles nested paths', () => {
    expect(getLocalConfigDir('/home/user/projects/my-app')).toBe('/home/user/projects/my-app/.engin');
  });
});

// ─── resolveProfilesDirs ───────────────────────────────────────────────────

describe('resolveProfilesDirs', () => {
  it('returns workflow-scoped dirs when workflowName is provided', () => {
    const globalDir = getGlobalConfigDir();
    const dirs = resolveProfilesDirs('/project', 'develop');
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toBe('/project/.engin/workflows/develop/profiles');
    expect(dirs[1]).toBe(join(globalDir, 'workflows', 'develop', 'profiles'));
  });

  it('returns local dir first (override priority)', () => {
    const dirs = resolveProfilesDirs('/project', 'develop');
    expect(dirs[0]).toBe('/project/.engin/workflows/develop/profiles');
  });

  it('returns empty array when workflowName is not provided', () => {
    expect(resolveProfilesDirs('/project')).toEqual([]);
  });

  it('returns empty array when workflowName is empty string', () => {
    expect(resolveProfilesDirs('/project', '')).toEqual([]);
  });

  it('handles workflow names with hyphens', () => {
    const globalDir = getGlobalConfigDir();
    const dirs = resolveProfilesDirs('/project', 'my-workflow');
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toContain('my-workflow');
    expect(dirs[0]).toBe('/project/.engin/workflows/my-workflow/profiles');
    expect(dirs[1]).toBe(join(globalDir, 'workflows', 'my-workflow', 'profiles'));
  });

  it('throws on workflow names with path separators', () => {
    expect(() => resolveProfilesDirs('/project', '../etc')).toThrow('Invalid workflow name');
  });

  it('throws on workflow names with backslashes', () => {
    expect(() => resolveProfilesDirs('/project', 'foo\\bar')).toThrow('Invalid workflow name');
  });

  it('throws on workflow name containing double-dot traversal', () => {
    expect(() => resolveProfilesDirs('/project', '..')).toThrow('Invalid workflow name');
  });
});

// ─── resolveWorkflowsDirs ──────────────────────────────────────────────────

describe('resolveWorkflowsDirs', () => {
  it('returns local-before-global order', () => {
    const dirs = resolveWorkflowsDirs('/project');
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toBe('/project/.engin/workflows');
    expect(dirs[1]).toMatch(/\/engin\/workflows$/);
  });

  it('local dir is first (override priority)', () => {
    const dirs = resolveWorkflowsDirs('/project');
    expect(dirs[0]).toContain('/project/.engin');
  });
});

// ─── getDefaultWorkDir ─────────────────────────────────────────────────────

describe('getDefaultWorkDir', () => {
  const FAKE_TIMESTAMP = 1718012345678;
  const originalDateNow = Date.now;

  beforeEach(() => {
    Date.now = () => FAKE_TIMESTAMP;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it('returns timestamp-prefixed path under local config dir', () => {
    expect(getDefaultWorkDir('/project', 'my-workflow')).toBe(`/project/.engin/work/${FAKE_TIMESTAMP}-my-workflow`);
  });

  it('handles workflow names with hyphens', () => {
    expect(getDefaultWorkDir('/app', 'deploy-prod')).toBe(`/app/.engin/work/${FAKE_TIMESTAMP}-deploy-prod`);
  });

  it('returns unique paths when Date.now changes between calls', () => {
    const first = getDefaultWorkDir('/project', 'my-workflow');

    Date.now = () => FAKE_TIMESTAMP + 5000;
    const second = getDefaultWorkDir('/project', 'my-workflow');

    expect(first).not.toBe(second);
    expect(first).toContain(`${FAKE_TIMESTAMP}-my-workflow`);
    expect(second).toContain(`${FAKE_TIMESTAMP + 5000}-my-workflow`);
  });

  it('reflects a changed timestamp on second call', () => {
    const first = getDefaultWorkDir('/project', 'my-workflow');

    // Simulate time advancing by 1000ms
    Date.now = () => FAKE_TIMESTAMP + 1000;
    const second = getDefaultWorkDir('/project', 'my-workflow');

    expect(first).toBe(`/project/.engin/work/${FAKE_TIMESTAMP}-my-workflow`);
    expect(second).toBe(`/project/.engin/work/${FAKE_TIMESTAMP + 1000}-my-workflow`);
  });
});

// ─── ensureDir ─────────────────────────────────────────────────────────────

describe('ensureDir', () => {
  it('creates a directory that does not exist', async () => {
    const newDir = join(getDir(), 'nested', 'sub', 'dir');
    await ensureDir(newDir);

    const s = await stat(newDir);
    expect(s.isDirectory()).toBe(true);
  });

  it('succeeds when directory already exists', async () => {
    const existingDir = join(getDir(), 'already-here');
    await mkdir(existingDir, { recursive: true });

    // Should not throw
    await ensureDir(existingDir);

    const s = await stat(existingDir);
    expect(s.isDirectory()).toBe(true);
  });
});

// ─── loadEnvFiles ──────────────────────────────────────────────────────────

describe('loadEnvFiles', () => {
  useEnvSandbox();

  // Helper: create a temp-based "global config dir" using XDG_CONFIG_HOME
  async function makeGlobalEnvDir(content: string): Promise<string> {
    const xdgDir = join(getDir(), 'xdg-config');
    await mkdir(join(xdgDir, 'engin'), { recursive: true });
    await writeFile(join(xdgDir, 'engin', '.env'), content);
    return xdgDir;
  }

  // Helper: create a local .env in .engin under a project dir
  async function makeLocalEnvFile(projectDir: string, content: string): Promise<void> {
    const localDir = join(projectDir, '.engin');
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, '.env'), content);
  }

  it('returns empty results when no .env files exist', () => {
    const projectDir = join(getDir(), 'project');
    // Don't create any directories or files
    delete process.env.XDG_CONFIG_HOME;

    const result: LoadEnvResult = loadEnvFiles(projectDir);

    expect(result.loadedFiles).toEqual([]);
    expect(result.skippedFiles).toHaveLength(2);
    expect(result.keysSet).toEqual([]);
  });

  it('loads global .env when only global exists', async () => {
    const xdgDir = await makeGlobalEnvDir('GLOBAL_KEY=global_value\n');
    process.env.XDG_CONFIG_HOME = xdgDir;
    const projectDir = join(getDir(), 'project');

    const result = loadEnvFiles(projectDir);

    expect(result.loadedFiles).toHaveLength(1);
    expect(result.loadedFiles[0]).toBe(join(xdgDir, 'engin', '.env'));
    expect(result.skippedFiles).toHaveLength(1);
    expect(result.keysSet).toEqual(['GLOBAL_KEY']);
    expect(process.env.GLOBAL_KEY).toBe('global_value');
  });

  it('loads local .env when only local exists', async () => {
    const projectDir = join(getDir(), 'project');
    delete process.env.XDG_CONFIG_HOME;
    await makeLocalEnvFile(projectDir, 'LOCAL_KEY=local_value\n');

    const result = loadEnvFiles(projectDir);

    expect(result.loadedFiles).toHaveLength(1);
    expect(result.loadedFiles[0]).toBe(join(projectDir, '.engin', '.env'));
    expect(result.skippedFiles).toHaveLength(1);
    expect(result.keysSet).toEqual(['LOCAL_KEY']);
    expect(process.env.LOCAL_KEY).toBe('local_value');
  });

  it('loads keys from both global and local when both exist', async () => {
    const xdgDir = await makeGlobalEnvDir('GLOB_ONLY=glob\nSHARED=from_global\n');
    process.env.XDG_CONFIG_HOME = xdgDir;
    const projectDir = join(getDir(), 'project');
    await makeLocalEnvFile(projectDir, 'LOC_ONLY=loc\n');

    const result = loadEnvFiles(projectDir);

    expect(result.loadedFiles).toHaveLength(2);
    expect(result.keysSet).toContain('GLOB_ONLY');
    expect(result.keysSet).toContain('SHARED');
    expect(result.keysSet).toContain('LOC_ONLY');
    expect(process.env.GLOB_ONLY).toBe('glob');
    expect(process.env.LOC_ONLY).toBe('loc');
    expect(process.env.SHARED).toBe('from_global');
  });

  it('local value overrides global when same key exists in both', async () => {
    const xdgDir = await makeGlobalEnvDir('SHARED=from_global\n');
    process.env.XDG_CONFIG_HOME = xdgDir;
    const projectDir = join(getDir(), 'project');
    await makeLocalEnvFile(projectDir, 'SHARED=from_local\n');

    const result = loadEnvFiles(projectDir);

    expect(result.loadedFiles).toHaveLength(2);
    expect(result.keysSet).toContain('SHARED');
    expect(process.env.SHARED).toBe('from_local');
  });

  it('process.env wins over both global and local files', async () => {
    process.env.PREEXISTING = 'already_here';
    const xdgDir = await makeGlobalEnvDir('PREEXISTING=from_global\n');
    process.env.XDG_CONFIG_HOME = xdgDir;
    const projectDir = join(getDir(), 'project');
    await makeLocalEnvFile(projectDir, 'PREEXISTING=from_local\n');

    const result = loadEnvFiles(projectDir);

    expect(process.env.PREEXISTING).toBe('already_here');
    expect(result.keysSet).not.toContain('PREEXISTING');
  });

  it('does not throw on malformed .env file (dotenv is lenient)', async () => {
    const projectDir = join(getDir(), 'project');
    delete process.env.XDG_CONFIG_HOME;
    await makeLocalEnvFile(projectDir, 'this is just random text without equals\n');

    // Should not throw
    const result = loadEnvFiles(projectDir);

    expect(result.loadedFiles).toHaveLength(1);
    // dotenv.parse silently ignores lines without =
    expect(result.keysSet).toEqual([]);
  });

  it('ignores comments and blank lines', async () => {
    const projectDir = join(getDir(), 'project');
    delete process.env.XDG_CONFIG_HOME;
    await makeLocalEnvFile(projectDir, '# this is a comment\n\nKEY=val\n\n# another comment\n');

    const result = loadEnvFiles(projectDir);

    expect(result.keysSet).toEqual(['KEY']);
    expect(process.env.KEY).toBe('val');
  });

  it('handles empty .env file (zero bytes)', async () => {
    const projectDir = join(getDir(), 'project');
    delete process.env.XDG_CONFIG_HOME;
    await makeLocalEnvFile(projectDir, '');

    const result = loadEnvFiles(projectDir);

    expect(result.loadedFiles).toHaveLength(1);
    expect(result.loadedFiles[0]).toBe(join(projectDir, '.engin', '.env'));
    expect(result.keysSet).toEqual([]);
  });

  it('sets env var to empty string for KEY=', async () => {
    const projectDir = join(getDir(), 'project');
    delete process.env.XDG_CONFIG_HOME;
    await makeLocalEnvFile(projectDir, 'KEY=\n');

    const result = loadEnvFiles(projectDir);

    expect(result.keysSet).toContain('KEY');
    expect(process.env.KEY).toBe('');
  });

  it('skips blocked dangerous env vars', async () => {
    const localDir = join(getDir(), '.engin');
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, '.env'), 'NODE_TLS_REJECT_UNAUTHORIZED=0\nMY_SAFE_KEY=safe_val\n');
    const result = loadEnvFiles(getDir());
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(process.env.MY_SAFE_KEY).toBe('safe_val');
    expect(result.keysSet).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(result.keysSet).toContain('MY_SAFE_KEY');
  });

  it('ignores KEY without equals sign', async () => {
    const projectDir = join(getDir(), 'project');
    delete process.env.XDG_CONFIG_HOME;
    await makeLocalEnvFile(projectDir, 'LONELY_KEY\nVALID=val\n');

    const result = loadEnvFiles(projectDir);

    expect(result.keysSet).not.toContain('LONELY_KEY');
    expect(result.keysSet).toContain('VALID');
    expect(process.env.VALID).toBe('val');
  });

  it('skips additional blocked keys like NODE_OPTIONS and PATH', async () => {
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const originalPath = process.env.PATH;
    const localDir = join(getDir(), '.engin');
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, '.env'), 'NODE_OPTIONS=--require=/malicious\nPATH=/evil\nSAFE_KEY=safe\n');

    const result = loadEnvFiles(getDir());

    // NODE_OPTIONS and PATH should NOT be overwritten by .env values
    expect(process.env.NODE_OPTIONS).toBe(originalNodeOptions);
    expect(process.env.PATH).toBe(originalPath);
    expect(process.env.SAFE_KEY).toBe('safe');
    expect(result.keysSet).not.toContain('NODE_OPTIONS');
    expect(result.keysSet).not.toContain('PATH');
    expect(result.keysSet).toContain('SAFE_KEY');
  });
});

// ─── scanPastRuns ──────────────────────────────────────────────────────────

describe('scanPastRuns', () => {
  it('returns entries sorted newest-first', async () => {
    const workDir = join(getDir(), '.engin', 'work');
    await mkdir(join(workDir, '1000-alpha'), { recursive: true });
    await mkdir(join(workDir, '2000-beta'), { recursive: true });
    await mkdir(join(workDir, '1500-gamma'), { recursive: true });

    const entries = await scanPastRuns(getDir());

    expect(entries).toHaveLength(3);
    expect(entries[0].dirName).toBe('2000-beta');
    expect(entries[1].dirName).toBe('1500-gamma');
    expect(entries[2].dirName).toBe('1000-alpha');
  });

  it('correctly parses workflow names and timestamps', async () => {
    const workDir = join(getDir(), '.engin', 'work');
    await mkdir(join(workDir, '1718012345678-my-workflow'), { recursive: true });

    const entries = await scanPastRuns(getDir());

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.dirName).toBe('1718012345678-my-workflow');
    expect(entry.workflowName).toBe('my-workflow');
    expect(entry.timestamp).toBe(1718012345678);
    expect(entry.fullPath).toBe(join(workDir, '1718012345678-my-workflow'));
  });

  it('hasStateFile is true when state file exists', async () => {
    const runDir = join(getDir(), '.engin', 'work', '3000-delta');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, '.engin-state.json'), '{}');

    const entries = await scanPastRuns(getDir());

    expect(entries).toHaveLength(1);
    expect(entries[0].hasStateFile).toBe(true);
  });

  it('hasStateFile is false when state file does not exist', async () => {
    const runDir = join(getDir(), '.engin', 'work', '4000-epsilon');
    await mkdir(runDir, { recursive: true });

    const entries = await scanPastRuns(getDir());

    expect(entries).toHaveLength(1);
    expect(entries[0].hasStateFile).toBe(false);
  });

  it('returns empty array when .engin/work/ does not exist', async () => {
    const entries = await scanPastRuns(getDir());

    expect(entries).toEqual([]);
  });

  it('ignores non-matching directory names', async () => {
    const workDir = join(getDir(), '.engin', 'work');
    await mkdir(join(workDir, '1000-alpha'), { recursive: true });
    await mkdir(join(workDir, 'not-a-run'), { recursive: true });

    const entries = await scanPastRuns(getDir());

    expect(entries).toHaveLength(1);
    expect(entries[0].dirName).toBe('1000-alpha');
  });

  it('ignores files in the work dir', async () => {
    const workDir = join(getDir(), '.engin', 'work');
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, '5000-file.txt'), 'not a directory');

    const entries = await scanPastRuns(getDir());

    expect(entries).toEqual([]);
  });

  it('handles mixed valid/invalid entries', async () => {
    const workDir = join(getDir(), '.engin', 'work');
    await mkdir(join(workDir, '2000-beta'), { recursive: true });
    await mkdir(join(workDir, '1000-alpha'), { recursive: true });
    await mkdir(join(workDir, 'not-a-run'), { recursive: true });
    await writeFile(join(workDir, '5000-file.txt'), 'not a directory');

    const entries = await scanPastRuns(getDir());

    expect(entries).toHaveLength(2);
    expect(entries[0].dirName).toBe('2000-beta');
    expect(entries[1].dirName).toBe('1000-alpha');
  });
});
