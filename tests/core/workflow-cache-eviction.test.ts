import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearWorkflowCache, loadWorkflow } from '../../src/core/workflow-loader.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function makeCwd(): string {
  process.env.XDG_CONFIG_HOME = join(getDir(), 'global');
  return join(getDir(), 'local');
}

async function createWorkflow(name: string, returnValue: number): Promise<void> {
  const dir = join(globalWorkflowDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'main.ts'), `export async function run() { return ${returnValue}; }`);
}

function wfName(i: number): string {
  return `wf-${String(i).padStart(3, '0')}`;
}

// ─── Oldest-entry eviction tests ────────────────────────────────────────────

describe('workflowCache oldest-entry eviction', () => {
  it('evicts only the oldest entry when threshold is exceeded, preserving newer entries', async () => {
    const cwd = makeCwd();

    // Create and load 52 unique workflows to trigger one eviction
    for (let i = 0; i < 52; i++) {
      await createWorkflow(wfName(i), i);
    }
    for (let i = 0; i < 52; i++) {
      await loadWorkflow(wfName(i), cwd);
    }

    // Trace:
    //   Loads 0–49: cache grows 0 → 50 (no eviction at check time since ≤ 50)
    //   Load 50:    cache was 50, not > 50 → grows to 51
    //   Load 51:    cache is 51 > 50 → evict wf-000 → cache = 50 → add wf-051 → cache = 51
    // Final cache: {wf-001, …, wf-051} (51 entries; wf-000 evicted)

    // Verify wf-000 was evicted: delete from disk, load → should throw "not found"
    await rm(join(globalWorkflowDir, wfName(0), 'main.ts'));
    // Loading wf-000: cache 51 > 50 → evict wf-001 → lookup wf-000: not found → try disk → gone → throw
    await expect(loadWorkflow(wfName(0), cwd)).rejects.toThrow("Workflow 'wf-000' not found.");

    // Verify a mid-range workflow (wf-025) is still cached.
    // Delete it from disk — if cached, it should still load successfully.
    await rm(join(globalWorkflowDir, wfName(25), 'main.ts'));
    // Current cache after wf-000 load attempt: {wf-002, …, wf-051} (50 entries, wf-001 evicted, wf-000 not found so not added)
    // Load wf-025: cache 50 > 50? No → lookup wf-025 → found (still cached!)
    const mod25 = await loadWorkflow(wfName(25), cwd);
    expect(typeof mod25.run).toBe('function');
    const result = await mod25.run('', { cwd: '', workDir: '' });
    expect(result).toBe(25);
  });

  it('each new unique workflow evicts exactly one oldest entry (not all)', async () => {
    const cwd = makeCwd();

    // Create and load 55 workflows → 5 evictions past threshold
    for (let i = 0; i < 55; i++) {
      await createWorkflow(wfName(i), i);
    }
    for (let i = 0; i < 55; i++) {
      await loadWorkflow(wfName(i), cwd);
    }

    // Trace:
    //   Loads 0–49:  cache = 50
    //   Load 50:     cache = 51
    //   Load 51:     evict wf-000
    //   Load 52:     evict wf-001
    //   Load 53:     evict wf-002
    //   Load 54:     evict wf-003
    // Final cache: {wf-004, …, wf-054} (51 entries)
    // Evicted: wf-000, wf-001, wf-002, wf-003

    // wf-004 is the current oldest. A mid-range entry (wf-030) should be cached.
    // Delete wf-030 from disk — if cached, it should still work.
    await rm(join(globalWorkflowDir, wfName(30), 'main.ts'));
    // Load wf-030: cache 51 > 50 → evict wf-004 → lookup wf-030: found → cached
    const mod30 = await loadWorkflow(wfName(30), cwd);
    const result = await mod30.run('', { cwd: '', workDir: '' });
    expect(result).toBe(30);

    // Verify wf-003 (evicted) is truly gone: delete from disk → load → throw
    await rm(join(globalWorkflowDir, wfName(3), 'main.ts'));
    await expect(loadWorkflow(wfName(3), cwd)).rejects.toThrow("Workflow 'wf-003' not found.");
  });

  it('evicted workflow is re-loaded from disk and re-cached on next access', async () => {
    const cwd = makeCwd();

    // Create and load 52 workflows → wf-000 evicted
    for (let i = 0; i < 52; i++) {
      await createWorkflow(wfName(i), i);
    }
    for (let i = 0; i < 52; i++) {
      await loadWorkflow(wfName(i), cwd);
    }

    // wf-000 was evicted. Recreate it with a different return value.
    await rm(join(globalWorkflowDir, wfName(0)), { recursive: true, force: true });
    await createWorkflow(wfName(0), 999);

    // Load wf-000 → eviction of wf-001, then re-read from disk → new module
    const mod = await loadWorkflow(wfName(0), cwd);
    const result = await mod.run('', { cwd: '', workDir: '' });
    expect(result).toBe(999);

    // Now delete wf-000 from disk — it was just re-cached, should still work
    await rm(join(globalWorkflowDir, wfName(0), 'main.ts'));
    const modAgain = await loadWorkflow(wfName(0), cwd);
    const resultAgain = await modAgain.run('', { cwd: '', workDir: '' });
    expect(resultAgain).toBe(999);
  });

  it('cache does not grow unbounded across many unique loads', async () => {
    const cwd = makeCwd();

    // Load 80 unique workflows — well past threshold of 50
    for (let i = 0; i < 80; i++) {
      await createWorkflow(wfName(i), i);
    }
    for (let i = 0; i < 80; i++) {
      await loadWorkflow(wfName(i), cwd);
    }

    // 30 evictions total (loads 51–80 each evict one).
    // Evicted: wf-000 through wf-028 (29 entries)
    // Final cache: {wf-029, …, wf-079} (51 entries)

    // Early entry wf-010 should be evicted: delete from disk → load → throw
    await rm(join(globalWorkflowDir, wfName(10), 'main.ts'));
    await expect(loadWorkflow(wfName(10), cwd)).rejects.toThrow("Workflow 'wf-010' not found.");

    // Late entry wf-060 should be cached: delete from disk → still works
    await rm(join(globalWorkflowDir, wfName(60), 'main.ts'));
    const mod60 = await loadWorkflow(wfName(60), cwd);
    const result = await mod60.run('', { cwd: '', workDir: '' });
    expect(result).toBe(60);
  });

  it('does not evict when cache size equals threshold', async () => {
    const cwd = makeCwd();

    // Create and load exactly 50 workflows
    for (let i = 0; i < 50; i++) {
      await createWorkflow(wfName(i), i);
    }
    for (let i = 0; i < 50; i++) {
      await loadWorkflow(wfName(i), cwd);
    }

    // Cache size is exactly 50 — no eviction.
    // Delete wf-000 from disk: it should still be cached.
    await rm(join(globalWorkflowDir, wfName(0), 'main.ts'));
    const mod = await loadWorkflow(wfName(0), cwd);
    const result = await mod.run('', { cwd: '', workDir: '' });
    expect(result).toBe(0);
  });

  it('does not evict when cache size is below threshold', async () => {
    const cwd = makeCwd();

    // Create and load 49 workflows
    for (let i = 0; i < 49; i++) {
      await createWorkflow(wfName(i), i);
    }
    for (let i = 0; i < 49; i++) {
      await loadWorkflow(wfName(i), cwd);
    }

    // Cache size is 49 — no eviction.
    await rm(join(globalWorkflowDir, wfName(0), 'main.ts'));
    const mod = await loadWorkflow(wfName(0), cwd);
    const result = await mod.run('', { cwd: '', workDir: '' });
    expect(result).toBe(0);
  });

  it('evicts in FIFO order — first loaded is first evicted', async () => {
    const cwd = makeCwd();

    // Load 53 workflows → wf-000 and wf-001 evicted
    for (let i = 0; i < 53; i++) {
      await createWorkflow(wfName(i), i);
    }
    for (let i = 0; i < 53; i++) {
      await loadWorkflow(wfName(i), cwd);
    }

    // Trace:
    //   Loads 0–49: cache = 50
    //   Load 50:    cache = 51
    //   Load 51:    evict wf-000
    //   Load 52:    evict wf-001
    // Final cache: {wf-002, …, wf-052} (51 entries)

    // Verify wf-000 and wf-001 are evicted (deleted from disk → throw)
    await rm(join(globalWorkflowDir, wfName(0), 'main.ts'));
    await rm(join(globalWorkflowDir, wfName(1), 'main.ts'));

    // Load wf-000: cache 51 > 50 → evict wf-002 (now oldest) → lookup wf-000: not found → disk → throw
    await expect(loadWorkflow(wfName(0), cwd)).rejects.toThrow("Workflow 'wf-000' not found.");
    // Cache after wf-000 attempt: {wf-003, …, wf-052} (50 entries, wf-002 evicted, wf-000 not added)

    // Load wf-001: cache 50, not > 50 → lookup wf-001: not found → disk → throw
    await expect(loadWorkflow(wfName(1), cwd)).rejects.toThrow("Workflow 'wf-001' not found.");
    // Cache after wf-001 attempt: {wf-003, …, wf-052} (50 entries, unchanged)

    // Verify a mid-range entry (wf-010) is still cached (delete from disk → still works)
    await rm(join(globalWorkflowDir, wfName(10), 'main.ts'));
    const mod10 = await loadWorkflow(wfName(10), cwd);
    const result10 = await mod10.run('', { cwd: '', workDir: '' });
    expect(result10).toBe(10);

    // Verify another mid-range entry (wf-030) is also still cached
    await rm(join(globalWorkflowDir, wfName(30), 'main.ts'));
    const mod30 = await loadWorkflow(wfName(30), cwd);
    const result30 = await mod30.run('', { cwd: '', workDir: '' });
    expect(result30).toBe(30);
  });

  it('clearWorkflowCache still works independently of size-based eviction', async () => {
    const cwd = makeCwd();

    for (let i = 0; i < 5; i++) {
      await createWorkflow(wfName(i), i);
    }
    for (let i = 0; i < 5; i++) {
      await loadWorkflow(wfName(i), cwd);
    }

    // Delete wf-000 from disk
    await rm(join(globalWorkflowDir, wfName(0), 'main.ts'));

    // Explicitly clear cache
    clearWorkflowCache();

    // Load wf-000: cache is empty, tries disk, file gone → throw
    await expect(loadWorkflow(wfName(0), cwd)).rejects.toThrow("Workflow 'wf-000' not found.");
  });
});
