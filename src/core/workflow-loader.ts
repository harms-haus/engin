import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

  // Size-based FIFO eviction: when cache exceeds 50 entries, evict the oldest entry
  if (workflowCache.size > 50) {
    const oldest = workflowCache.keys().next().value;
    if (oldest !== undefined) {
      workflowCache.delete(oldest);
    }
  }

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

    const mod = await import(pathToFileURL(filePath).href);
    const workflow: WorkflowModule = mod.default ?? mod;

    if (typeof workflow.run !== 'function') {
      throw new Error(`Workflow '${name}' does not export a 'run' function.`);
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
