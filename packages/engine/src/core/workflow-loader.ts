import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { resolveWorkflowsDirs } from './config.js';
import type { WorkflowEntry, WorkflowModule } from './types.js';
import { isEnoentError, validateWorkflowName } from './utils.js';

// ─── Cache ──────────────────────────────────────────────────────────────────

const workflowCache = new Map<string, WorkflowModule>();

/** Clears the module-level workflow cache. */
export function clearWorkflowCache(): void {
  workflowCache.clear();
}

// ─── loadWorkflow ───────────────────────────────────────────────────────────

/**
 * Dynamically loads a workflow module by name, searching local then global
 * workflow directories. Caches loaded modules by resolved absolute file path.
 */
export async function loadWorkflow(name: string, cwd: string): Promise<WorkflowModule> {
  // Validate workflow name to prevent path traversal
  validateWorkflowName(name);

  const dirs = resolveWorkflowsDirs(cwd);

  for (const dir of dirs) {
    const filePath = join(dir, name, 'main.ts');

    // Check cache before I/O
    const cached = workflowCache.get(filePath);
    if (cached) return cached;

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
    } catch (err: unknown) {
      if (isEnoentError(err)) continue;
      throw err;
    }

    // Bust Bun's module cache so re-imports after eviction pick up disk changes.
    // Bust Bun's module cache so re-imports after eviction pick up disk changes.
    // Bun supports require() in ESM context and respects require.cache,
    // unlike import() which uses a separate internal ESM module cache.
    //
    // IMPORTANT: evicting only `main.ts` is NOT enough — Bun reuses cached
    // transitive imports (shared `.lib/*.ts` modules, sibling workflow files)
    // because their cache entries remain. A long-lived daemon would keep
    // serving stale workflow code after edits. Evict EVERY cache entry whose
    // resolved path lives under a workflow directory so the whole module
    // tree is re-read from disk on each load.
    const resolved = require.resolve(filePath);
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete require.cache[resolved];
    const workflowRoots = dirs.map((d) => resolve(d));
    for (const cachePath of Object.keys(require.cache)) {
      if (workflowRoots.some((root) => cachePath.startsWith(root + sep) || cachePath === root)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete require.cache[cachePath];
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(filePath);
    const workflow: WorkflowModule = mod.default ?? mod;

    if (typeof workflow.run !== 'function') {
      throw new Error(`Workflow '${name}' does not export a 'run' function.`);
    }

    // Size-based FIFO eviction: when cache exceeds 50 entries, evict the oldest entry
    if (workflowCache.size > 50) {
      const oldest = workflowCache.keys().next().value;
      if (oldest !== undefined) {
        workflowCache.delete(oldest);
      }
    }

    workflowCache.set(filePath, workflow);
    return workflow;
  }

  throw new Error(`Workflow '${name}' not found.`);
}

// ─── listWorkflows ──────────────────────────────────────────────────────────

/**
 * Lists available workflow files across local and global directories.
 * Returns entries sorted by name, then by source (local first).
 */
export async function listWorkflows(cwd: string): Promise<WorkflowEntry[]> {
  const dirs = resolveWorkflowsDirs(cwd);
  const dirEntries: { dir: string; source: 'local' | 'global' }[] = [
    { dir: dirs[0], source: 'local' },
    { dir: dirs[1], source: 'global' },
  ];
  const results: WorkflowEntry[] = [];

  for (const { dir, source } of dirEntries) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err: unknown) {
      if (isEnoentError(err)) continue;
      throw err;
    }

    for (const entry of entries) {
      // Skip hidden directories
      if (entry.startsWith('.')) continue;

      const entryPath = join(dir, entry);

      // Only include directories
      try {
        const entryStat = await stat(entryPath);
        if (!entryStat.isDirectory()) continue;
      } catch (err: unknown) {
        if (isEnoentError(err)) continue;
        throw err;
      }

      // Check that main.ts exists inside the directory
      const mainPath = join(entryPath, 'main.ts');
      try {
        const mainStat = await stat(mainPath);
        if (!mainStat.isFile()) continue;
      } catch (err: unknown) {
        if (isEnoentError(err)) continue;
        throw err;
      }

      results.push({ name: entry, source, path: mainPath });
    }
  }

  // Sort by name, then by source (local first)
  results.sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    // local before global
    if (a.source === b.source) return 0;
    return a.source === 'local' ? -1 : 1;
  });

  return results;
}
