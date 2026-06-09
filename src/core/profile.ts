import matter from "gray-matter";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { AgentProfile, ThinkingLevel } from "./types.js";

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
];

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

    const id = basename(filename, ".md");
    const name = (data.name as string | undefined) ?? id;

    if (data.provider == null || data.provider === "") {
        throw new Error(`Profile "${id}" is missing required frontmatter field "provider".`);
    }
    if (data.model == null || data.model === "") {
        throw new Error(`Profile "${id}" is missing required frontmatter field "model".`);
    }

    const thinkingLevel: ThinkingLevel =
        data.thinkingLevel != null
            ? isThinkingLevel(data.thinkingLevel)
                ? data.thinkingLevel
                : ((() => {
                      throw new Error(
                          `Profile "${id}" has invalid thinkingLevel "${data.thinkingLevel}". ` +
                              `Valid values: ${VALID_THINKING_LEVELS.join(", ")}.`,
                      );
                  })() as ThinkingLevel)
            : "medium";

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
    const mdFiles = entries.filter((entry) => entry.endsWith(".md"));

    const profiles = new Map<string, AgentProfile>();

    for (const file of mdFiles) {
        const filePath = join(dirPath, file);
        const content = await readFile(filePath, "utf-8");
        const profile = parseProfile(content, file);
        profiles.set(profile.id, profile);
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
        content = await readFile(filePath, "utf-8");
    } catch {
        throw new Error(`Profile file does not exist: ${filePath}`);
    }
    return parseProfile(content, basename(filePath));
}

/**
 * Clear the in-memory profile cache.
 * Call this to force a fresh read on the next loadProfiles() call.
 */
export function clearProfileCache(): void {
    profileCache.clear();
}
