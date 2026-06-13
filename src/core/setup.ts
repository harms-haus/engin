import { join } from 'node:path';
import { ensureDir, getGlobalConfigDir } from './config.js';

// ─── Installation ───────────────────────────────────────────────────────────

/**
 * Creates the default directory structure inside the global config directory
 * (~/.config/engin/). Ensures the "workflows"
 * subdirectory exists.
 */
export async function initDefaultConfig(): Promise<{
  createdDirs: string[];
}> {
  const globalDir = getGlobalConfigDir();

  const workflowsDir = join(globalDir, 'workflows');

  await ensureDir(workflowsDir);

  return { createdDirs: ['workflows'] };
}
