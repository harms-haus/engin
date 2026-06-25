// ─── Title Generator ────────────────────────────────────────────────────────
import type { ZodType } from 'zod';
import { z } from 'zod';

import { requireAgentPlugin } from './agent-registry.js';
import { loadProfilesFromDirs } from './profile.js';
import { promptForStructured } from './structured-output.js';
import type { StatusCallbacks } from './types.js';

// ─── Schema ─────────────────────────────────────────────────────────────────

export const TitleSchema = z.object({
  title: z.string().describe('A concise 3-8 word title summarizing the task'),
});

export const TitleAndBranchSchema = z.object({
  title: z.string().describe('A concise 3-8 word title summarizing the task'),
  branchName: z.string().describe('A short kebab-case git branch name (3-8 words, lowercase, hyphens only)'),
});

// ─── Options ────────────────────────────────────────────────────────────────

export interface TitleGeneratorOptions {
  profilesDirs: string[];
  taskPrompt: string;
  cwd: string;
  apiKeys?: Record<string, string>;
  onStatus?: StatusCallbacks;
  profileId?: string;
  agentId?: string;
  customPrompt?: string;
  schema?: ZodType;
}

// ─── Fallback Helper ────────────────────────────────────────────────────────

function fallbackTitle(taskPrompt: string): string {
  if (taskPrompt.length > 60) {
    return taskPrompt.slice(0, 57) + '...';
  }
  return taskPrompt;
}

/**
 * Derive a deterministic kebab-case branch name from a task prompt by taking
 * the first few whitespace-separated tokens, lowercasing them, and joining
 * with hyphens. Non-alphanumeric characters are treated as separators so the
 * result is always a valid git branch name.
 */
function sanitizeFallbackBranchName(taskPrompt: string): string {
  return taskPrompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, 8)
    .join('-');
}

// ─── generateWorkflowTitle ──────────────────────────────────────────────────

export async function generateWorkflowTitle(options: TitleGeneratorOptions): Promise<string> {
  try {
    // 1. Load profiles
    const profiles = await loadProfilesFromDirs(options.profilesDirs);
    const profile = profiles.get(options.profileId ?? 'scout');
    if (!profile) {
      throw new Error(`Profile "${options.profileId ?? 'scout'}" not found.`);
    }

    // 2. Create session via agent plugin
    const session = await requireAgentPlugin(profile.agent).createSession({
      profile,
      cwd: options.cwd,
      apiKeys: options.apiKeys,
      agentId: options.agentId ?? 'title-generator',
      onAgentStatus: options.onStatus,
    });

    try {
      // 3. Build prompt
      let prompt: string;
      if (options.customPrompt) {
        prompt = `${options.customPrompt}\nTask: ${options.taskPrompt}`;
      } else {
        prompt =
          'You are a title generator. Generate a concise 3-8 word title summarizing the following task.\n' +
          '\n' +
          `Task: ${options.taskPrompt}\n` +
          '\n' +
          'Respond with a JSON object containing a title field with your concise title.';
      }

      // 4. Prompt for structured output
      const effectiveSchema = options.schema ?? TitleSchema;
      const { result } = await promptForStructured(session, prompt, effectiveSchema);

      return (result as { title: string }).title;
    } finally {
      session.dispose();
    }
  } catch {
    return fallbackTitle(options.taskPrompt);
  }
}

// ─── generateTitleAndBranch ─────────────────────────────────────────────────

/**
 * Generate both a concise workflow title AND a kebab-case git branch name in
 * a single LLM call.
 *
 * Uses the same harness creation flow as {@link generateWorkflowTitle} but
 * prompts for both fields at once (via {@link TitleAndBranchSchema}) to avoid
 * a second round-trip when setting up a worktree.
 *
 * On any failure the function resolves to a deterministic fallback derived
 * from the task prompt rather than throwing.
 */
export async function generateTitleAndBranch(
  options: TitleGeneratorOptions,
): Promise<{ title: string; branchName: string }> {
  try {
    // 1. Load profiles
    const profiles = await loadProfilesFromDirs(options.profilesDirs);
    const profile = profiles.get(options.profileId ?? 'scout');
    if (!profile) {
      throw new Error(`Profile "${options.profileId ?? 'scout'}" not found.`);
    }

    // 2. Create session via agent plugin
    const session = await requireAgentPlugin(profile.agent).createSession({
      profile,
      cwd: options.cwd,
      apiKeys: options.apiKeys,
      agentId: options.agentId ?? 'title-generator',
      onAgentStatus: options.onStatus,
    });

    try {
      // 3. Build prompt
      let prompt: string;
      if (options.customPrompt) {
        prompt = `${options.customPrompt}\nTask: ${options.taskPrompt}`;
      } else {
        prompt =
          'You are a title and branch name generator. Generate a concise 3-8 word title AND a short kebab-case git branch name for the following task. The branch name must be lowercase, use hyphens only, and be 3-8 words.\n\n' +
          `Task: ${options.taskPrompt}\n\n` +
          'Respond with a JSON object containing a title field and a branchName field.';
      }

      // 4. Prompt for structured output using the combined schema
      const { result } = await promptForStructured(session, prompt, TitleAndBranchSchema);

      const { title, branchName } = result as { title: string; branchName: string };
      return { title, branchName };
    } finally {
      session.dispose();
    }
  } catch {
    return {
      title: fallbackTitle(options.taskPrompt),
      branchName: sanitizeFallbackBranchName(options.taskPrompt),
    };
  }
}
