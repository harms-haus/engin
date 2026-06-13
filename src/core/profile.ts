import matter from 'gray-matter';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentProfile, ThinkingLevel } from './types.js';

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Module-level cache for loaded profiles, keyed by resolved directory path.
 * Profiles are unlikely to change during a workflow run, so caching avoids
 * redundant disk reads on every agent invocation.
 */
const profileCache = new Map<string, Map<string, AgentProfile>>();

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return VALID_THINKING_LEVELS.includes(value as ThinkingLevel);
}

/**
 * Parse a markdown file with frontmatter into an AgentProfile.
 *
 * Expected frontmatter fields:
 *   - name?       (defaults to filename without .md)
 *   - provider    (required)
 *   - model       (required)
 *   - thinkingLevel? (defaults to "medium")
 *   - excludeTools?  (defaults to [])
 *   - includeTools?  (defaults to [])
 *
 * The body (content after frontmatter) becomes the system prompt.
 */
export function parseProfile(content: string, filename: string): AgentProfile {
  const { data, content: body } = matter(content);

  const id = basename(filename, '.md');
  const name = (data.name as string | undefined) ?? id;

  if (data.provider == null || data.provider === '') {
    throw new Error(`Profile "${id}" is missing required frontmatter field "provider".`);
  }
  if (data.model == null || data.model === '') {
    throw new Error(`Profile "${id}" is missing required frontmatter field "model".`);
  }

  let thinkingLevel: ThinkingLevel = 'medium';
  if (data.thinkingLevel != null) {
    if (!isThinkingLevel(data.thinkingLevel)) {
      throw new Error(
        `Profile "${id}" has invalid thinkingLevel "${data.thinkingLevel}". ` +
          `Valid values: ${VALID_THINKING_LEVELS.join(', ')}.`,
      );
    }
    thinkingLevel = data.thinkingLevel;
  }

  return {
    id,
    name,
    provider: data.provider as string,
    model: data.model as string,
    thinkingLevel,
    systemPrompt: body.trim(),
    excludeTools: (data.excludeTools as string[] | undefined) ?? [],
    includeTools: (data.includeTools as string[] | undefined) ?? [],
  };
}

/**
 * Load all .md agent profiles from a directory.
 * Returns a Map keyed by profile id (filename without .md).
 * Results are cached in-memory — repeated calls with the same directory
 * return the cached Map without hitting disk.
 * Throws if the directory does not exist.
 */
export async function loadProfiles(dirPath: string): Promise<Map<string, AgentProfile>> {
  const cached = profileCache.get(dirPath);
  if (cached) {
    return cached;
  }

  let dirStat;
  try {
    dirStat = await stat(dirPath);
  } catch {
    throw new Error(`Directory does not exist: ${dirPath}`);
  }

  if (!dirStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }

  const entries = await readdir(dirPath);
  const mdFiles = entries.filter((entry) => entry.endsWith('.md'));

  const profiles = new Map<string, AgentProfile>();

  for (const file of mdFiles) {
    const filePath = join(dirPath, file);
    const content = await readFile(filePath, 'utf-8');
    const profile = parseProfile(content, file);
    profiles.set(profile.id, profile);
  }

  if (profileCache.size > 20) {
    const oldestKey = profileCache.keys().next().value;
    if (oldestKey !== undefined) {
      profileCache.delete(oldestKey);
    }
  }

  profileCache.set(dirPath, profiles);
  return profiles;
}

/**
 * Load a single profile by id from a directory.
 * Uses the cached directory listing when available.
 * Throws if the profile is not found.
 */
export async function loadProfile(dirPath: string, profileId: string): Promise<AgentProfile> {
  const profiles = await loadProfiles(dirPath);
  const profile = profiles.get(profileId);

  if (!profile) {
    throw new Error(`Profile "${profileId}" not found in directory: ${dirPath}`);
  }

  return profile;
}

/**
 * Load a single profile directly from a .md file path.
 * Bypasses the directory cache — use when you know the exact file.
 * Throws if the file does not exist or is invalid.
 */
export async function loadProfileSingle(filePath: string): Promise<AgentProfile> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Profile file does not exist: ${filePath}`);
  }
  return parseProfile(content, basename(filePath));
}

/**
 * Load and merge agent profiles from multiple directories.
 *
 * Directories are processed in reverse order (last entry first) so that
 * entries earlier in the array ("local" dirs) naturally override later
 * entries ("global" dirs) when profile IDs collide.
 *
 * Directories that do not exist or are not directories are silently skipped.
 * Any other error (e.g. a malformed .md file) is re-thrown.
 *
 * The merged result is NOT cached — only the per-directory results from
 * `loadProfiles` use the module-level cache.
 */
export async function loadProfilesFromDirs(dirs: string[]): Promise<Map<string, AgentProfile>> {
  const merged = new Map<string, AgentProfile>();

  for (let i = dirs.length - 1; i >= 0; i--) {
    try {
      const profiles = await loadProfiles(dirs[i]);
      for (const [id, profile] of profiles) {
        merged.set(id, profile);
      }
    } catch (err: unknown) {
      // Skip directories that don't exist or aren't directories.
      // Primary check: Node.js system error codes from stat()/readdir().
      // Fallback check: custom error messages thrown by loadProfiles.
      if (
        (err instanceof Error &&
          'code' in err &&
          ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR')) ||
        (err instanceof Error &&
          (err.message.startsWith('Directory does not exist') || err.message.startsWith('Path is not a directory')))
      ) {
        continue;
      }
      throw err;
    }
  }

  return merged;
}

/**
 * Clear the in-memory profile cache.
 * Call this to force a fresh read on the next loadProfiles() call.
 */
export function clearProfileCache(): void {
  profileCache.clear();
}
