import { stat, readdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkflowsDirs } from "./config.js";
import type { WorkflowModule } from "./types.js";

// ─── Cache ──────────────────────────────────────────────────────────────────

const workflowCache = new Map<string, WorkflowModule>();

/** Clears the module-level workflow cache. */
export function clearWorkflowCache(): void {
    workflowCache.clear();
}

// ─── Supported extensions ───────────────────────────────────────────────────

const WORKFLOW_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts"] as const;

// ─── loadWorkflow ───────────────────────────────────────────────────────────

/**
 * Dynamically loads a workflow module by name, searching local then global
 * workflow directories. Caches loaded modules by resolved absolute file path.
 */
export async function loadWorkflow(name: string, cwd: string): Promise<WorkflowModule> {
    // Validate workflow name to prevent path traversal
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
        throw new Error(`Invalid workflow name: "${name}". Names must not contain path separators or "..".`);
    }

    const dirs = resolveWorkflowsDirs(cwd);

    for (const dir of dirs) {
        for (const ext of WORKFLOW_EXTENSIONS) {
            const filePath = join(dir, name + ext);

            try {
                const fileStat = await stat(filePath);
                if (!fileStat.isFile()) continue;
            } catch {
                continue;
            }

            // Check cache first
            const cached = workflowCache.get(filePath);
            if (cached) return cached;

            const mod = await import(pathToFileURL(filePath).href);
            const workflow: WorkflowModule = mod.default ?? mod;

            if (typeof workflow.run !== "function") {
                throw new Error(`Workflow '${name}' does not export a 'run' function.`);
            }

            workflowCache.set(filePath, workflow);
            return workflow;
        }
    }

    throw new Error(
        `Workflow '${name}' not found. Use 'workflow-harness list' to see available workflows.`,
    );
}

// ─── listWorkflows ──────────────────────────────────────────────────────────

/**
 * Lists available workflow files across local and global directories.
 * Returns entries sorted by name, then by source (local first).
 */
export async function listWorkflows(
    cwd: string,
): Promise<Array<{ name: string; source: "local" | "global"; path: string }>> {
    const dirs = resolveWorkflowsDirs(cwd);
    const sourceLabels: Array<"local" | "global"> = ["local", "global"];
    const results: Array<{ name: string; source: "local" | "global"; path: string }> = [];

    const extSet = new Set<string>(WORKFLOW_EXTENSIONS);

    for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i];
        const source = sourceLabels[i];

        let entries: string[];
        try {
            entries = await readdir(dir);
        } catch {
            // Directory does not exist — skip
            continue;
        }

        for (const entry of entries) {
            const ext = extname(entry);
            if (!extSet.has(ext)) continue;

            const name = basename(entry, ext);
            const fullPath = join(dir, entry);

            // Only include files, not directories
            try {
                const fileStat = await stat(fullPath);
                if (!fileStat.isFile()) continue;
            } catch {
                continue;
            }

            results.push({ name, source, path: fullPath });
        }
    }

    // Sort by name, then by source (local first)
    results.sort((a, b) => {
        const nameCmp = a.name.localeCompare(b.name);
        if (nameCmp !== 0) return nameCmp;
        // local before global
        if (a.source === b.source) return 0;
        return a.source === "local" ? -1 : 1;
    });

    return results;
}
