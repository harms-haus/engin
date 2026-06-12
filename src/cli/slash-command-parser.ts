// Design note: This parser intentionally only supports workflow commands (e.g. /develop).
// It does NOT support CLI meta-commands like init, web, resume - those must be
// invoked directly from the shell, not from the interactive composer. If a user
// types /web it will be treated as a workflow name lookup, which will fail with
// "workflow not found" at run time.

import { validateWorkflowName } from '../core/utils.js';

export type SlashCommandResult =
  | { ok: true; workflowName: string; taskPrompt: string; verbose: boolean; worktree: boolean; maxConcurrent: number }
  | { ok: false; error: string };

export function parseSlashCommand(input: string): SlashCommandResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: 'Please enter a command. Type /workflow-name <task> to start.' };
  }

  if (!/^\s*\//.test(input)) {
    return { ok: false, error: 'Commands must start with /. Type /workflow-name <task> to start.' };
  }

  // Strip the leading '/' and extract the workflow name
  const afterSlash = trimmed.slice(1);
  const nameMatch = afterSlash.match(/^[a-zA-Z0-9_-]+/);
  if (!nameMatch) {
    return { ok: false, error: 'Missing workflow name. Type /workflow-name <task> to start.' };
  }

  const workflowName = nameMatch[0];

  try {
    validateWorkflowName(workflowName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'Invalid workflow name: ' + message };
  }

  // Remaining text after the workflow name token
  const remaining = afterSlash.slice(nameMatch[0].length).trim();
  const tokens = remaining.split(/\s+/).filter(Boolean);

  let verbose = false;
  let worktree = false;
  let maxConcurrent = 5;
  const promptParts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--verbose') {
      verbose = true;
    } else if (token === '--worktree') {
      worktree = true;
    } else if (token === '--max-concurrent') {
      const next = tokens[i + 1];
      if (next === undefined) {
        return { ok: false, error: '--max-concurrent requires a positive integer' };
      }
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { ok: false, error: '--max-concurrent requires a positive integer' };
      }
      maxConcurrent = parsed;
      i++; // skip the value token
    } else {
      promptParts.push(token);
    }
  }

  const taskPrompt = promptParts.join(' ');

  if (taskPrompt.length === 0) {
    return {
      ok: false,
      error: 'Missing task prompt. Usage: /workflow-name [--verbose] [--worktree] [--max-concurrent N] <task prompt>',
    };
  }

  return { ok: true, workflowName, taskPrompt, verbose, worktree, maxConcurrent };
}
