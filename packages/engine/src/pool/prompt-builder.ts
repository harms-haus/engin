import type { Task } from '../core/types.js';
import { collectFileSection } from './file-context.js';
import type { StepDefinition } from './types.js';

/**
 * Build the prompt text for a step. On retry, appends review feedback.
 * File contents from `task.files` are pre-loaded and injected as code blocks.
 *
 * `opts.skipFiles` (default `false`) omits the `task.files` contents block —
 * used on session resume where the file contents are already in context —
 * but does NOT affect the review feedback section, which is always appended
 * when present.
 */
export async function buildPrompt(
  task: Task,
  step: StepDefinition,
  cwd: string,
  opts?: { skipFiles?: boolean },
): Promise<string> {
  const parts: string[] = [];

  parts.push(`## Task: ${task.title}`);
  parts.push(`## Step: ${step.name}`);
  parts.push('');

  // ─── File contents section ─────────────────────────────────────────────
  //
  // File inlining is delegated to the shared `collectFileSection` helper
  // (./file-context.ts), which is the single source of truth shared with the
  // default `collectContext` hook — guaranteeing byte-identical sections.
  if (!opts?.skipFiles && task.files?.length) {
    const sections = await Promise.all(task.files.map((fp) => collectFileSection(fp, cwd)));
    for (const section of sections) {
      if (section !== null) parts.push(section);
    }
  }

  parts.push(task.prompt);

  if (task.reviewFeedback && task.reviewFeedback.length > 0) {
    parts.push('');
    parts.push('## Review Feedback History (please address all items)');
    task.reviewFeedback.forEach((fb, i) => {
      parts.push(`Attempt ${i + 1}: ${fb}`);
    });
  }

  return parts.join('\n');
}

// ─── Validation-retry prompt builder ────────────────────────────────────────

/**
 * Rebuild a prompt to ask the agent to fix a validation failure on retry.
 * Appends a delimited error block to the original prompt.
 *
 * Used by step/task runners that re-prompt within the SAME session when a
 * file-based `validateOutput` gate returns an error.
 */
export function buildValidationRetryPrompt(originalPrompt: string, error: string): string {
  return [
    originalPrompt,
    '',
    '--- Previous attempt failed validation ---',
    `Error: ${error}`,
    'Please correct the output and try again.',
  ].join('\n');
}

// ─── Item / Worker-Output task composers ────────────────────────────────────
//
// These encapsulate prompt construction currently inlined inside the runner
// bodies (map-runner, council-runner). Each returns a NEW Task object that
// spreads every original field and appends a section to `prompt`.

/**
 * Build an item-specific task for fan-out runners (e.g. {@link mapRunner}).
 *
 * Spreads `task` and appends a `## Item X of Y` header followed by the
 * serialized item to the prompt. `itemIndex` is 0-based and converted to a
 * 1-based label; `totalItems` is rendered verbatim. String items are appended
 * verbatim, every other type is `JSON.stringify`-ed.
 *
 * The original task is NOT mutated.
 */
export function composeItemPrompt(task: Task, itemIndex: number, totalItems: number, item: unknown): Task {
  const itemStr = typeof item === 'string' ? item : JSON.stringify(item);
  return {
    ...task,
    prompt: task.prompt + '\n' + `## Item ${itemIndex + 1} of ${totalItems}` + '\n' + itemStr,
  };
}

/**
 * Build a synthesizer task for council-style runners (e.g.
 * {@link councilRunner}).
 *
 * Spreads `task` and appends a `## Worker Outputs` section listing every output
 * under a 0-based `### Worker {i}` heading. String outputs are kept verbatim;
 * every other type is `JSON.stringify`-ed. Blocks are joined with a blank
 * line, mirroring the inlined construction previously in council-runner.ts.
 *
 * The original task is NOT mutated.
 */
export function composeWorkerOutputsPrompt(task: Task, outputs: unknown[]): Task {
  const workerOutputsText = outputs
    .map((output, i) => {
      const formatted = typeof output === 'string' ? output : JSON.stringify(output);
      return `### Worker ${i}\n${formatted}`;
    })
    .join('\n\n');

  return {
    ...task,
    prompt: task.prompt + '\n\n## Worker Outputs\n' + workerOutputsText,
  };
}
