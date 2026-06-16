import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearWorkflowCache, listWorkflows, loadWorkflow } from '../../packages/engine/src/core/workflow-loader.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Temp directory helper ──────────────────────────────────────────────────

const { getDir } = useTempDir();

let localWorkflowDir: string;
let globalWorkflowDir: string;
let savedXdg: string | undefined;

beforeEach(async () => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  localWorkflowDir = join(getDir(), 'local', '.engin', 'workflows');
  globalWorkflowDir = join(getDir(), 'global', 'engin', 'workflows');
  await mkdir(localWorkflowDir, { recursive: true });
  await mkdir(globalWorkflowDir, { recursive: true });
  clearWorkflowCache();
});

afterEach(() => {
  if (savedXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedXdg;
  }
});

/**
 * Helper: build a cwd whose resolveWorkflowsDirs returns our temp local + global dirs.
 * We set XDG_CONFIG_HOME so that the global dir maps to globalWorkflowDir.
 */
function makeCwd(): string {
  // cwd must be <getDir()>/local so that .engin/workflows = localWorkflowDir
  // XDG_CONFIG_HOME must be <getDir()>/global so that engin = globalWorkflowDir
  process.env.XDG_CONFIG_HOME = join(getDir(), 'global');
  return join(getDir(), 'local');
}

/**
 * Helper: create a directory-based workflow in the given workflows directory.
 * Structure: <workflowsDir>/<name>/main.ts
 */
async function createDirWorkflow(
  workflowsDir: string,
  name: string,
  content = "export async function run() { return 'ok'; }",
): Promise<void> {
  await mkdir(join(workflowsDir, name), { recursive: true });
  await writeFile(join(workflowsDir, name, 'main.ts'), content);
}

// ─── listWorkflows ──────────────────────────────────────────────────────────

describe('listWorkflows', () => {
  it('returns empty array when no dirs exist', async () => {
    const emptyCwd = join(getDir(), 'nowhere');
    await mkdir(emptyCwd, { recursive: true });
    process.env.XDG_CONFIG_HOME = join(getDir(), 'nowhere-global');
    const result = await listWorkflows(emptyCwd);
    expect(result).toEqual([]);
  });

  it('finds directories with main.ts in global dir with correct source label', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(globalWorkflowDir, 'alpha');
    await createDirWorkflow(globalWorkflowDir, 'bravo');
    await createDirWorkflow(globalWorkflowDir, 'charlie');

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name)).toEqual(['alpha', 'bravo', 'charlie']);
    for (const entry of result) {
      expect(entry.source).toBe('global');
      expect(entry.path).toBe(join(globalWorkflowDir, entry.name, 'main.ts'));
    }
  });

  it('finds directories in local dir with source label local', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(localWorkflowDir, 'local-only');

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('local-only');
    expect(result[0].source).toBe('local');
    expect(result[0].path).toBe(join(localWorkflowDir, 'local-only', 'main.ts'));
  });

  it('returns both local and global entries for same name, local first', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(localWorkflowDir, 'shared', "export async function run() { return 'local'; }");
    await createDirWorkflow(globalWorkflowDir, 'shared', "export async function run() { return 'global'; }");

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(2);

    // local first due to sort
    expect(result[0].name).toBe('shared');
    expect(result[0].source).toBe('local');
    expect(result[1].name).toBe('shared');
    expect(result[1].source).toBe('global');
  });

  it('ignores directories without main.ts', async () => {
    const cwd = makeCwd();
    // Create a directory with other.ts but NOT main.ts
    await mkdir(join(globalWorkflowDir, 'no-main'), { recursive: true });
    await writeFile(join(globalWorkflowDir, 'no-main', 'other.ts'), 'export function run() {}');
    // Create a valid workflow
    await createDirWorkflow(globalWorkflowDir, 'valid');

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid');
  });

  it('ignores plain files in workflows dir', async () => {
    const cwd = makeCwd();
    // Create a flat file (not a directory)
    await writeFile(join(globalWorkflowDir, 'flat-file.ts'), 'export function run() {}');
    // Create a valid directory workflow
    await createDirWorkflow(globalWorkflowDir, 'valid');

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid');
  });

  it('ignores hidden directories starting with .', async () => {
    const cwd = makeCwd();
    // Create a hidden directory with main.ts inside
    const hiddenDir = join(globalWorkflowDir, '.hidden');
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(join(hiddenDir, 'main.ts'), 'export function run() {}');
    // Create a valid workflow
    await createDirWorkflow(globalWorkflowDir, 'visible');

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('visible');
  });

  it('results are sorted by name then source (local before global for same name)', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(localWorkflowDir, 'beta');
    await createDirWorkflow(globalWorkflowDir, 'alpha');
    await createDirWorkflow(localWorkflowDir, 'alpha');

    const result = await listWorkflows(cwd);
    expect(result.map((r) => `${r.name}:${r.source}`)).toEqual(['alpha:local', 'alpha:global', 'beta:local']);
  });
});

// ─── loadWorkflow ───────────────────────────────────────────────────────────

describe('loadWorkflow', () => {
  it('throws with descriptive error when name not found', async () => {
    const cwd = makeCwd();
    await expect(loadWorkflow('nonexistent', cwd)).rejects.toThrow("Workflow 'nonexistent' not found.");
  });

  it('throws when module has no run export', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(globalWorkflowDir, 'bad-module', 'export const something = 42;');

    await expect(loadWorkflow('bad-module', cwd)).rejects.toThrow(
      "Workflow 'bad-module' does not export a 'run' function.",
    );
  });

  it('loads main.ts and returns its run function', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(
      globalWorkflowDir,
      'hello',
      "export async function run(taskPrompt, options) { return 'hello-result'; }",
    );

    const mod = await loadWorkflow('hello', cwd);
    expect(typeof mod.run).toBe('function');
    const result = await mod.run('test', { cwd: '/tmp', workDir: '/tmp/work' });
    expect(result).toBe('hello-result');
  });

  it('loads a module with default export', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(
      globalWorkflowDir,
      'default-export',
      "export default { async run(taskPrompt, options) { return 'default-result'; } };",
    );

    const mod = await loadWorkflow('default-export', cwd);
    expect(typeof mod.run).toBe('function');
    const result = await mod.run('test', { cwd: '/tmp', workDir: '/tmp/work' });
    expect(result).toBe('default-result');
  });

  it('prefers local workflow over global with same name', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(localWorkflowDir, 'override', "export async function run() { return 'local'; }");
    await createDirWorkflow(globalWorkflowDir, 'override', "export async function run() { return 'global'; }");

    const mod = await loadWorkflow('override', cwd);
    const result = await mod.run('', { cwd: '', workDir: '' });
    expect(result).toBe('local');
  });

  it('caches modules (call twice, same reference returned)', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(
      globalWorkflowDir,
      'cached',
      'let callCount = 0; export async function run() { return ++callCount; }',
    );

    const mod1 = await loadWorkflow('cached', cwd);
    const result1 = await mod1.run('', { cwd: '', workDir: '' });
    expect(result1).toBe(1);

    // Second load should return the same cached module — counter keeps incrementing
    const mod2 = await loadWorkflow('cached', cwd);
    const result2 = await mod2.run('', { cwd: '', workDir: '' });
    expect(result2).toBe(2);

    // Same object reference (cached)
    expect(mod1).toBe(mod2);
  });

  it('throws for path traversal with forward slash', async () => {
    const cwd = makeCwd();
    await expect(loadWorkflow('../etc/passwd', cwd)).rejects.toThrow(
      'Invalid workflow name: "../etc/passwd". Names must not contain path separators or "..".',
    );
  });

  it('throws for path traversal with backslash', async () => {
    const cwd = makeCwd();
    await expect(loadWorkflow('foo\\bar', cwd)).rejects.toThrow(
      'Invalid workflow name: "foo\\bar". Names must not contain path separators or "..".',
    );
  });

  it('throws for path traversal with double dot', async () => {
    const cwd = makeCwd();
    await expect(loadWorkflow('..', cwd)).rejects.toThrow(
      'Invalid workflow name: "..". Names must not contain path separators or "..".',
    );
  });
});

// ─── clearWorkflowCache ─────────────────────────────────────────────────────

describe('clearWorkflowCache', () => {
  it('cache clear does not break subsequent loads', async () => {
    const cwd = makeCwd();
    await createDirWorkflow(globalWorkflowDir, 'cache-clear', 'export async function run() { return 42; }');

    // First load populates the cache
    const mod1 = await loadWorkflow('cache-clear', cwd);
    expect(typeof mod1.run).toBe('function');

    // Clear the cache
    clearWorkflowCache();

    // Next load still works (re-resolves via the same path)
    const mod2 = await loadWorkflow('cache-clear', cwd);
    expect(typeof mod2.run).toBe('function');
    const result = await mod2.run('', { cwd: '', workDir: '' });
    expect(result).toBe(42);
  });
});

// ─── Size-based cache eviction ──────────────────────────────────────────────

describe('size-based cache eviction', () => {
  /**
   * Creates N unique workflow directories under the global workflows dir.
   * Each exports a unique tag so we can verify identity.
   */
  async function createNWorkflows(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await createDirWorkflow(
        globalWorkflowDir,
        `wf-${String(i).padStart(3, '0')}`,
        `export async function run() { return ${i}; }`,
      );
    }
  }

  it('does not evict when cache has exactly 50 entries', async () => {
    const cwd = makeCwd();
    // Create exactly 50 workflows
    await createNWorkflows(50);

    // Load all 50 unique workflows (cache size = 50)
    for (let i = 0; i < 50; i++) {
      await loadWorkflow(`wf-${String(i).padStart(3, '0')}`, cwd);
    }

    // Delete wf-000 from disk
    await rm(join(globalWorkflowDir, 'wf-000', 'main.ts'));

    // Load wf-000 again: cache size is 50 (not > 50), so no eviction.
    // wf-000 is still in the cache, so it returns the cached version
    // without needing the file on disk.
    const mod = await loadWorkflow('wf-000', cwd);
    expect(typeof mod.run).toBe('function');
    const result = await mod.run('', { cwd: '', workDir: '' });
    expect(result).toBe(0);
  });

  it('evicts cache when size exceeds 50, proving re-resolution from disk', async () => {
    const cwd = makeCwd();
    // Create 52 workflows
    await createNWorkflows(52);

    // Load all 52 unique workflows.
    // The 52nd load (wf-051) triggers eviction of wf-000 (oldest) since cache
    // was 51 (> 50) before adding the new entry.
    for (let i = 0; i < 52; i++) {
      await loadWorkflow(`wf-${String(i).padStart(3, '0')}`, cwd);
    }

    // Delete wf-000 from disk
    await rm(join(globalWorkflowDir, 'wf-000', 'main.ts'));

    // Load wf-000 again: it was evicted by the 52nd load, so it must be
    // re-resolved from disk. Since the file is gone, it should throw "not found".
    await expect(loadWorkflow('wf-000', cwd)).rejects.toThrow("Workflow 'wf-000' not found.");
  });

  it('after eviction, previously cached entries are cleared and must be re-resolved from disk', async () => {
    const cwd = makeCwd();
    // Create 53 workflows
    await createNWorkflows(53);

    // Load 52 unique workflows.
    // Loading wf-051 (the 52nd) triggers eviction of wf-000 (oldest) before adding wf-051.
    for (let i = 0; i < 52; i++) {
      await loadWorkflow(`wf-${String(i).padStart(3, '0')}`, cwd);
    }

    // Load wf-052 (53rd unique, cache miss). This triggers eviction of wf-001.
    const mod52 = await loadWorkflow('wf-052', cwd);
    expect(typeof mod52.run).toBe('function');

    // wf-052 was just cached. Delete it from disk to prove it is cached —
    // loading again should still work (cache hit).
    await rm(join(globalWorkflowDir, 'wf-052', 'main.ts'));
    const mod52Again = await loadWorkflow('wf-052', cwd);
    expect(typeof mod52Again.run).toBe('function');

    // wf-000 was evicted from the cache when wf-051 was loaded.
    // Delete it from disk and verify that loading it re-resolves from disk
    // (file is gone → throws).
    await rm(join(globalWorkflowDir, 'wf-000', 'main.ts'));
    await expect(loadWorkflow('wf-000', cwd)).rejects.toThrow("Workflow 'wf-000' not found.");
  });

  it('clearWorkflowCache still works independently of size-based eviction', async () => {
    const cwd = makeCwd();
    await createNWorkflows(3);

    // Load just 3 workflows — well below the eviction threshold
    for (let i = 0; i < 3; i++) {
      await loadWorkflow(`wf-${String(i).padStart(3, '0')}`, cwd);
    }

    // Delete wf-000 from disk
    await rm(join(globalWorkflowDir, 'wf-000', 'main.ts'));

    // Explicitly clear via the exported function
    clearWorkflowCache();

    // Load wf-000: cache is empty (size 0, no auto-eviction), tries disk, file gone
    await expect(loadWorkflow('wf-000', cwd)).rejects.toThrow("Workflow 'wf-000' not found.");
  });
});
