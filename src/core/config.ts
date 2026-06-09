import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns the global configuration directory for workflow-harness.
 * Uses $XDG_CONFIG_HOME/workflow-harness if XDG_CONFIG_HOME is set and non-empty,
 * otherwise falls back to ~/.config/workflow-harness.
 */
export function getGlobalConfigDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) {
        return join(xdg, "workflow-harness");
    }
    return join(homedir(), ".config", "workflow-harness");
}

/**
 * Returns the local (project-level) configuration directory for workflow-harness.
 */
export function getLocalConfigDir(cwd: string): string {
    return join(cwd, ".workflow-harness");
}

/**
 * Returns profile directories in override-priority order (local first).
 * Does NOT check whether the directories exist.
 */
export function resolveProfilesDirs(cwd: string): string[] {
    return [
        join(getLocalConfigDir(cwd), "profiles"),
        join(getGlobalConfigDir(), "profiles"),
    ];
}

/**
 * Returns workflow directories in override-priority order (local first).
 * Does NOT check whether the directories exist.
 */
export function resolveWorkflowsDirs(cwd: string): string[] {
    return [
        join(getLocalConfigDir(cwd), "workflows"),
        join(getGlobalConfigDir(), "workflows"),
    ];
}

/**
 * Returns the default working directory for a named workflow.
 */
export function getDefaultWorkDir(cwd: string, workflowName: string): string {
    return join(getLocalConfigDir(cwd), "work", workflowName);
}

/**
 * Recursively creates a directory. Re-throws any errors.
 */
export async function ensureDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
}
