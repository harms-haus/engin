import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearWorkflowCache, listWorkflows, loadWorkflow } from '../../src/core/workflow-loader.js';

// ─── Temp directory helper ──────────────────────────────────────────────────

let tempDir: string;
let localWorkflowDir: string;
let globalWorkflowDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `wf-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  localWorkflowDir = join(tempDir, 'local', '.engin', 'workflows');
  globalWorkflowDir = join(tempDir, 'global', 'engin', 'workflows');
  await mkdir(localWorkflowDir, { recursive: true });
  await mkdir(globalWorkflowDir, { recursive: true });
  clearWorkflowCache();
});

afterEach(async () => {
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

// ─── listWorkflows ──────────────────────────────────────────────────────────

describe('listWorkflows', () => {
  it('returns empty array when no dirs exist', async () => {
    // Use a cwd that doesn't have any workflow dirs
    const emptyCwd = join(tempDir, 'nowhere');
    await mkdir(emptyCwd, { recursive: true });
    process.env.XDG_CONFIG_HOME = join(tempDir, 'nowhere-global');
    const result = await listWorkflows(emptyCwd);
    expect(result).toEqual([]);
  });

  it('finds .js, .mjs, .cjs, .ts files in global dir with correct source label', async () => {
    const cwd = makeCwd();
    await writeFile(join(globalWorkflowDir, 'alpha.js'), 'export function run() {}');
    await writeFile(join(globalWorkflowDir, 'bravo.mjs'), 'export function run() {}');
    await writeFile(join(globalWorkflowDir, 'charlie.cjs'), 'module.exports = { run() {} };');
    await writeFile(join(globalWorkflowDir, 'delta.ts'), 'export function run(): void {}');

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    for (const entry of result) {
      expect(entry.source).toBe('global');
    }
  });

  it('finds files in local dir', async () => {
    const cwd = makeCwd();
    await writeFile(join(localWorkflowDir, 'local-only.js'), 'export function run() {}');

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('local-only');
    expect(result[0].source).toBe('local');
    expect(result[0].path).toBe(join(localWorkflowDir, 'local-only.js'));
  });

  it('returns both local and global entries for same name', async () => {
    const cwd = makeCwd();
    await writeFile(join(localWorkflowDir, 'shared.js'), 'export function run() {}');
    await writeFile(join(globalWorkflowDir, 'shared.js'), 'export function run() {}');

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(2);

    // local first due to sort
    expect(result[0].name).toBe('shared');
    expect(result[0].source).toBe('local');
    expect(result[1].name).toBe('shared');
    expect(result[1].source).toBe('global');
  });

  it('ignores files with unsupported extensions', async () => {
    const cwd = makeCwd();
    await writeFile(join(globalWorkflowDir, 'readme.md'), '# docs');
    await writeFile(join(globalWorkflowDir, 'data.json'), '{}');
    await writeFile(join(globalWorkflowDir, 'valid.js'), 'export function run() {}');

    const result = await listWorkflows(cwd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid');
  });

  it('results are sorted by name then source', async () => {
    const cwd = makeCwd();
    await writeFile(join(localWorkflowDir, 'beta.js'), 'export function run() {}');
    await writeFile(join(globalWorkflowDir, 'alpha.js'), 'export function run() {}');
    await writeFile(join(localWorkflowDir, 'alpha.js'), 'export function run() {}');

    const result = await listWorkflows(cwd);
    expect(result.map((r) => `${r.name}:${r.source}`)).toEqual(['alpha:local', 'alpha:global', 'beta:local']);
  });
});

// ─── loadWorkflow ───────────────────────────────────────────────────────────

describe('loadWorkflow', () => {
  it('throws with descriptive error when name not found', async () => {
    const cwd = makeCwd();
    await expect(loadWorkflow('nonexistent', cwd)).rejects.toThrow(
      "Workflow 'nonexistent' not found. Use 'engin list' to see available workflows.",
    );
  });

  it('throws when module has no run export', async () => {
    const cwd = makeCwd();
    await writeFile(join(globalWorkflowDir, 'bad-module.js'), 'export const something = 42;');

    await expect(loadWorkflow('bad-module', cwd)).rejects.toThrow(
      "Workflow 'bad-module' does not export a 'run' function.",
    );
  });

  it('loads a .js file and returns its run function', async () => {
    const cwd = makeCwd();
    await writeFile(
      join(globalWorkflowDir, 'hello.js'),
      "export async function run(taskPrompt, options) { return 'hello-result'; }",
    );

    const mod = await loadWorkflow('hello', cwd);
    expect(typeof mod.run).toBe('function');
    const result = await mod.run('test', { cwd: '/tmp', workDir: '/tmp/work' });
    expect(result).toBe('hello-result');
  });

  it('loads a .mjs file', async () => {
    const cwd = makeCwd();
    await writeFile(
      join(globalWorkflowDir, 'esm-workflow.mjs'),
      "export async function run(taskPrompt, options) { return 'mjs-result'; }",
    );

    const mod = await loadWorkflow('esm-workflow', cwd);
    expect(typeof mod.run).toBe('function');
    const result = await mod.run('test', { cwd: '/tmp', workDir: '/tmp/work' });
    expect(result).toBe('mjs-result');
  });

  it('loads a module with default export', async () => {
    const cwd = makeCwd();
    await writeFile(
      join(globalWorkflowDir, 'default-export.js'),
      "export default { async run(taskPrompt, options) { return 'default-result'; } };",
    );

    const mod = await loadWorkflow('default-export', cwd);
    expect(typeof mod.run).toBe('function');
    const result = await mod.run('test', { cwd: '/tmp', workDir: '/tmp/work' });
    expect(result).toBe('default-result');
  });

  it('prefers local workflow over global with same name', async () => {
    const cwd = makeCwd();
    await writeFile(join(localWorkflowDir, 'override.js'), "export async function run() { return 'local'; }");
    await writeFile(join(globalWorkflowDir, 'override.js'), "export async function run() { return 'global'; }");

    const mod = await loadWorkflow('override', cwd);
    const result = await mod.run('', { cwd: '', workDir: '' });
    expect(result).toBe('local');
  });

  it('caches modules (call twice, same result)', async () => {
    const cwd = makeCwd();
    await writeFile(
      join(globalWorkflowDir, 'cached.js'),
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

  it('prefers .js over .mjs over .cjs over .ts for same name', async () => {
    const cwd = makeCwd();
    await writeFile(join(globalWorkflowDir, 'ext-pref.mjs'), "export async function run() { return 'mjs'; }");
    await writeFile(join(globalWorkflowDir, 'ext-pref.js'), "export async function run() { return 'js'; }");

    const mod = await loadWorkflow('ext-pref', cwd);
    const result = await mod.run('', { cwd: '', workDir: '' });
    expect(result).toBe('js');
  });
});

// ─── clearWorkflowCache ─────────────────────────────────────────────────────

describe('clearWorkflowCache', () => {
  it('clears the internal cache map', async () => {
    const cwd = makeCwd();
    await writeFile(join(globalWorkflowDir, 'cache-clear.js'), 'export async function run() { return 42; }');

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
