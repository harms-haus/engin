import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearWorkflowCache, listWorkflows, loadWorkflow } from '../../src/core/workflow-loader.js';

// ─── Temp directory helper ──────────────────────────────────────────────────

let tempDir: string;
let localWorkflowDir: string;
let globalWorkflowDir: string;
let savedXdg: string | undefined;

beforeEach(async () => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  tempDir = join(tmpdir(), `wf-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  localWorkflowDir = join(tempDir, 'local', '.engin', 'workflows');
  globalWorkflowDir = join(tempDir, 'global', 'engin', 'workflows');
  await mkdir(localWorkflowDir, { recursive: true });
  await mkdir(globalWorkflowDir, { recursive: true });
  clearWorkflowCache();
});

afterEach(async () => {
  if (savedXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedXdg;
  }
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Helper: build a cwd whose resolveWorkflowsDirs returns our temp local + global dirs.
 * We set XDG_CONFIG_HOME so that the global dir maps to globalWorkflowDir.
 */
function makeCwd(): string {
  // cwd must be <tempDir>/local so that .engin/workflows = localWorkflowDir
  // XDG_CONFIG_HOME must be <tempDir>/global so that engin = globalWorkflowDir
  process.env.XDG_CONFIG_HOME = join(tempDir, 'global');
  return join(tempDir, 'local');
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
    const emptyCwd = join(tempDir, 'nowhere');
    await mkdir(emptyCwd, { recursive: true });
    process.env.XDG_CONFIG_HOME = join(tempDir, 'nowhere-global');
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
  it('clears the cache map', async () => {
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

    // Note: Node.js caches ESM modules internally, so mod1 and mod2
    // are the same underlying module namespace. clearWorkflowCache
    // only clears our Map; it does not bust Node's ESM cache.
    expect(mod1).toBe(mod2);
  });
});
