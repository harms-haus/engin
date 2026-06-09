import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Returns the global configuration directory for engin.
 * Uses $XDG_CONFIG_HOME/engin if XDG_CONFIG_HOME is set and non-empty,
 * otherwise falls back to ~/.config/engin.
 */
export function getGlobalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    return join(xdg, 'engin');
  }
  return join(homedir(), '.config', 'engin');
}

/**
 * Returns the local (project-level) configuration directory for engin.
 */
export function getLocalConfigDir(cwd: string): string {
  return join(cwd, '.engin');
}

/**
 * Returns profile directories in override-priority order (local first).
 * Does NOT check whether the directories exist.
 *
 * When `workflowName` is a non-empty string, returns workflow-scoped
 * profile directories under `workflows/<workflowName>/profiles`.
 * When `workflowName` is omitted or empty, returns an empty array.
 */
export function resolveProfilesDirs(cwd: string, workflowName?: string): string[] {
  if (!workflowName || workflowName.length === 0) {
    return [];
  }
  if (workflowName.includes('/') || workflowName.includes('\\') || workflowName.includes('..')) {
    throw new Error(`Invalid workflow name: "${workflowName}". Names must not contain path separators or "..".`);
  }
  return [
    join(getLocalConfigDir(cwd), 'workflows', workflowName, 'profiles'),
    join(getGlobalConfigDir(), 'workflows', workflowName, 'profiles'),
  ];
}

/**
 * Returns workflow directories in override-priority order (local first).
 * Does NOT check whether the directories exist.
 */
export function resolveWorkflowsDirs(cwd: string): string[] {
  return [join(getLocalConfigDir(cwd), 'workflows'), join(getGlobalConfigDir(), 'workflows')];
}

/**
 * Returns the default working directory for a named workflow.
 */
export function getDefaultWorkDir(cwd: string, workflowName: string): string {
  return join(getLocalConfigDir(cwd), 'work', workflowName);
}

/**
 * Recursively creates a directory. Re-throws any errors.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Result of loading .env files from global and local config directories.
 */
export interface LoadEnvResult {
  loadedFiles: string[]; // paths of .env files that existed and were parsed
  skippedFiles: string[]; // paths of .env files that did not exist
  keysSet: string[]; // env var names actually written to process.env (excluding already-set keys)
}

/** Environment variable names that are never loaded from .env files due to security risks. */
const BLOCKED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'PATH',
  'HOME',
  'SHELL',
]);

/**
 * Loads .env files from global and local config directories, merges them
 * (local overrides global), and sets keys into process.env only if they are
 * not already defined.
 *
 * Synchronous because .env loading must complete before any command dispatch.
 */
export function loadEnvFiles(cwd: string): LoadEnvResult {
  const globalEnvPath = join(getGlobalConfigDir(), '.env');
  const localEnvPath = join(getLocalConfigDir(cwd), '.env');

  const loadedFiles: string[] = [];
  const skippedFiles: string[] = [];
  let globalVars: Record<string, string> = {};
  let localVars: Record<string, string> = {};

  for (const envPath of [globalEnvPath, localEnvPath]) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      const parsed = parse(content);
      loadedFiles.push(envPath);
      if (envPath === globalEnvPath) {
        globalVars = parsed;
      } else {
        localVars = parsed;
      }
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        skippedFiles.push(envPath);
      } else {
        throw err;
      }
    }
  }

  const merged = { ...globalVars, ...localVars };
  const keysSet: string[] = [];

  for (const [key, value] of Object.entries(merged)) {
    if (BLOCKED_ENV_KEYS.has(key)) {
      continue;
    }
    if (!(key in process.env)) {
      process.env[key] = value;
      keysSet.push(key);
    }
  }

  return { loadedFiles, skippedFiles, keysSet };
}
