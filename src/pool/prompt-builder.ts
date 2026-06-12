import type { Task } from '../core/types.js';
import type { StepDefinition } from './types.js';

/**
 * Build the prompt text for a step. On retry, appends review feedback.
 */
export function buildPrompt(task: Task, step: StepDefinition): string {
  const parts: string[] = [];

  parts.push(`## Task: ${task.title}`);
  parts.push(`## Step: ${step.name}`);
  parts.push('');
  parts.push(task.prompt);

  if (task.files && task.files.length > 0) {
    parts.push('');
    parts.push(`## Relevant Files\n${task.files.join('\n')}`);
  }

  if (task.reviewFeedback && task.reviewFeedback.length > 0) {
    parts.push('');
    parts.push('## Review Feedback History (please address all items)');
    task.reviewFeedback.forEach((fb, i) => {
      parts.push(`Attempt ${i + 1}: ${fb}`);
    });
  }

  return parts.join('\n');
}
