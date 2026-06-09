import { join } from 'node:path';
import { ensureDir, getGlobalConfigDir } from './core/config.js';

// ─── Installation ───────────────────────────────────────────────────────────

/**
 * Creates the default directory structure inside the global config directory
 * (~/.config/engin/). Ensures "profiles" and "workflows"
 * subdirectories exist.
 */
export async function initDefaultConfig(): Promise<{
  createdDirs: string[];
}> {
  const globalDir = getGlobalConfigDir();

  const profilesDir = join(globalDir, 'profiles');
  const workflowsDir = join(globalDir, 'workflows');

  await ensureDir(profilesDir);
  await ensureDir(workflowsDir);

  return { createdDirs: ['profiles', 'workflows'] };
}
