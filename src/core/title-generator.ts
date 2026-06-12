// ─── Title Generator ────────────────────────────────────────────────────────
import type { ZodType } from 'zod';
import { z } from 'zod';

import { createHarness } from './harness-factory.js';
import { loadProfilesFromDirs } from './profile.js';
import { promptForStructured } from './structured-output.js';
import type { StatusCallbacks } from './types.js';

// ─── Schema ─────────────────────────────────────────────────────────────────

export const TitleSchema = z.object({
  title: z.string().describe('A concise 3-8 word title summarizing the task'),
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

// ─── generateWorkflowTitle ──────────────────────────────────────────────────

export async function generateWorkflowTitle(options: TitleGeneratorOptions): Promise<string> {
  try {
    // 1. Load profiles
    const profiles = await loadProfilesFromDirs(options.profilesDirs);
    const profile = profiles.get(options.profileId ?? 'scout');
    if (!profile) {
      throw new Error(`Profile "${options.profileId ?? 'scout'}" not found.`);
    }

    // 2. Create harness
    const { session, dispose } = await createHarness({
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
      dispose();
    }
  } catch {
    return fallbackTitle(options.taskPrompt);
  }
}
