// Tests for the new prompt-builder exports (Parts B and C).
//
// Part B — `buildValidationRetryPrompt` is being moved out of an inline private
// function in core/phase-tasks.ts into pool/prompt-builder.ts and exported.
//
// Part C — Two NEW compose helpers are being added to pool/prompt-builder.ts,
// encapsulating item/worker-output task construction that currently lives as
// inline code inside map-runner.ts and council-runner.ts:
//   - composeItemPrompt(task, itemIndex, totalItems, item)
//   - composeWorkerOutputsPrompt(task, outputs)
//
// These tests pin down the exact prompt shape produced by each helper so that
// the runner refactor (tasks 11/12) can consume them without behavior change.

import { describe, expect, it } from 'bun:test';
import type { Task } from '../../packages/engine/src/core/types.js';
import {
  buildValidationRetryPrompt,
  composeItemPrompt,
  composeWorkerOutputsPrompt,
} from '../../packages/engine/src/pool/prompt-builder.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const baseTask: Task = {
  id: 'task-1',
  title: 'Build feature X',
  prompt: 'Create a login page',
  profile: 'coder',
  files: ['src/login.ts'],
  dependencies: [],
  status: 'ready',
  phaseId: 'phase-1',
};

// ─── buildValidationRetryPrompt (Part B) ───────────────────────────────────

describe('buildValidationRetryPrompt', () => {
  it('starts with the original prompt verbatim', () => {
    const result = buildValidationRetryPrompt('Write the plan', 'missing field');
    expect(result.startsWith('Write the plan')).toBe(true);
  });

  it('appends the delimited validation-failure header', () => {
    const result = buildValidationRetryPrompt('Write the plan', 'missing field');
    expect(result).toContain('--- Previous attempt failed validation ---');
  });

  it('includes the error message prefixed with "Error: "', () => {
    const result = buildValidationRetryPrompt('Write the plan', 'schema mismatch');
    expect(result).toContain('Error: schema mismatch');
  });

  it('includes the "Please correct the output and try again." instruction', () => {
    const result = buildValidationRetryPrompt('Write the plan', 'boom');
    expect(result).toContain('Please correct the output and try again.');
  });

  it('places the original prompt before the error block', () => {
    const result = buildValidationRetryPrompt('ORIGINAL', 'oops');
    const promptIdx = result.indexOf('ORIGINAL');
    const headerIdx = result.indexOf('--- Previous attempt failed validation ---');
    expect(promptIdx).toBeLessThan(headerIdx);
    expect(headerIdx).toBeGreaterThan(-1);
  });

  it('produces the exact expected multi-line output for a known input', () => {
    const result = buildValidationRetryPrompt('Do the thing', 'bad json');
    expect(result).toBe(
      [
        'Do the thing',
        '',
        '--- Previous attempt failed validation ---',
        'Error: bad json',
        'Please correct the output and try again.',
      ].join('\n'),
    );
  });

  it('preserves a multi-line original prompt without altering it', () => {
    const original = 'Line one\nLine two\nLine three';
    const result = buildValidationRetryPrompt(original, 'err');
    expect(result.startsWith(original + '\n')).toBe(true);
  });

  it('handles an empty error string (still prefixes with "Error: ")', () => {
    const result = buildValidationRetryPrompt('Prompt', '');
    expect(result).toContain('Error: ');
    // Ensure there's a blank line between the prompt and the header
    expect(result).toContain('Prompt\n\n--- Previous attempt failed validation ---');
  });
});

// ─── composeItemPrompt (Part C — map-runner extraction) ────────────────────

describe('composeItemPrompt', () => {
  it('returns a Task that spreads all original fields', () => {
    const result = composeItemPrompt(baseTask, 0, 3, 'item-a');
    expect(result.id).toBe(baseTask.id);
    expect(result.title).toBe(baseTask.title);
    expect(result.profile).toBe(baseTask.profile);
    expect(result.files).toBe(baseTask.files);
    expect(result.dependencies).toBe(baseTask.dependencies);
    expect(result.status).toBe(baseTask.status);
    expect(result.phaseId).toBe(baseTask.phaseId);
  });

  it('appends the "## Item X of Y" header using 1-based item numbering', () => {
    const result = composeItemPrompt(baseTask, 0, 3, 'item-a');
    // itemIndex 0 → "Item 1", totalItems 3 → "of 3"
    expect(result.prompt).toContain('## Item 1 of 3');
  });

  it('computes the 1-based index from itemIndex for arbitrary positions', () => {
    const result = composeItemPrompt(baseTask, 4, 10, 'item');
    expect(result.prompt).toContain('## Item 5 of 10');
  });

  it('appends a string item verbatim after the header', () => {
    const result = composeItemPrompt(baseTask, 0, 2, 'hello-world');
    // Original prompt + "\n## Item 1 of 2\n" + "hello-world"
    expect(result.prompt).toBe(baseTask.prompt + '\n## Item 1 of 2\nhello-world');
  });

  it('serializes a non-string item via JSON.stringify', () => {
    const item = { name: 'widget', count: 3 };
    const result = composeItemPrompt(baseTask, 0, 2, item);
    expect(result.prompt).toContain('## Item 1 of 2');
    expect(result.prompt).toContain(JSON.stringify(item));
  });

  it('serializes a number item via JSON.stringify', () => {
    const result = composeItemPrompt(baseTask, 0, 2, 42);
    expect(result.prompt.endsWith('## Item 1 of 2\n42')).toBe(true);
  });

  it('serializes an array item via JSON.stringify', () => {
    const item = [1, 2, 3];
    const result = composeItemPrompt(baseTask, 0, 2, item);
    expect(result.prompt).toContain(JSON.stringify(item));
  });

  it('produces the exact expected prompt for a known string item', () => {
    const result = composeItemPrompt(baseTask, 1, 4, 'payload');
    // itemIndex 1 → "Item 2", totalItems 4
    expect(result.prompt).toBe('Create a login page\n## Item 2 of 4\npayload');
  });

  it('does not mutate the original task prompt', () => {
    const originalPrompt = baseTask.prompt;
    composeItemPrompt(baseTask, 0, 2, 'item');
    expect(baseTask.prompt).toBe(originalPrompt);
  });

  it('returns a new object (not the same reference as the input task)', () => {
    const result = composeItemPrompt(baseTask, 0, 2, 'item');
    expect(result).not.toBe(baseTask);
  });
});

// ─── composeWorkerOutputsPrompt (Part C — council-runner extraction) ───────

describe('composeWorkerOutputsPrompt', () => {
  it('returns a Task that spreads all original fields', () => {
    const result = composeWorkerOutputsPrompt(baseTask, ['out-1', 'out-2']);
    expect(result.id).toBe(baseTask.id);
    expect(result.title).toBe(baseTask.title);
    expect(result.profile).toBe(baseTask.profile);
    expect(result.files).toBe(baseTask.files);
    expect(result.dependencies).toBe(baseTask.dependencies);
    expect(result.phaseId).toBe(baseTask.phaseId);
  });

  it('appends the "## Worker Outputs" header after the original prompt', () => {
    const result = composeWorkerOutputsPrompt(baseTask, ['a']);
    expect(result.prompt).toContain('## Worker Outputs');
    const promptIdx = result.prompt.indexOf(baseTask.prompt);
    const headerIdx = result.prompt.indexOf('## Worker Outputs');
    expect(promptIdx).toBeLessThan(headerIdx);
  });

  it('formats each output under a 0-based "### Worker {i}" heading', () => {
    const result = composeWorkerOutputsPrompt(baseTask, ['a', 'b', 'c']);
    expect(result.prompt).toContain('### Worker 0');
    expect(result.prompt).toContain('### Worker 1');
    expect(result.prompt).toContain('### Worker 2');
  });

  it('keeps string outputs verbatim under their worker heading', () => {
    const result = composeWorkerOutputsPrompt(baseTask, ['alpha']);
    expect(result.prompt).toContain('### Worker 0\nalpha');
  });

  it('serializes object outputs via JSON.stringify', () => {
    const outputs = [{ summary: 'ok' }];
    const result = composeWorkerOutputsPrompt(baseTask, outputs);
    expect(result.prompt).toContain('### Worker 0');
    expect(result.prompt).toContain(JSON.stringify(outputs[0]));
  });

  it('serializes number outputs via JSON.stringify', () => {
    const result = composeWorkerOutputsPrompt(baseTask, [7]);
    expect(result.prompt).toContain('### Worker 0\n7');
  });

  it('joins multiple worker blocks with a blank line', () => {
    const result = composeWorkerOutputsPrompt(baseTask, ['a', 'b']);
    // workerOutputsText = "### Worker 0\na\n\n### Worker 1\nb"
    expect(result.prompt).toContain('### Worker 0\na\n\n### Worker 1\nb');
  });

  it('produces the exact expected prompt for multiple string outputs', () => {
    const result = composeWorkerOutputsPrompt(baseTask, ['a', 'b']);
    expect(result.prompt).toBe('Create a login page\n\n## Worker Outputs\n### Worker 0\na\n\n### Worker 1\nb');
  });

  it('produces the exact expected prompt for a single object output', () => {
    const obj = { x: 1 };
    const result = composeWorkerOutputsPrompt(baseTask, [obj]);
    expect(result.prompt).toBe('Create a login page\n\n## Worker Outputs\n### Worker 0\n' + JSON.stringify(obj));
  });

  it('appends only the header (with trailing newline) when outputs is empty', () => {
    // [].map(...).join('\n\n') === '' → prompt = base + "\n\n## Worker Outputs\n"
    const result = composeWorkerOutputsPrompt(baseTask, []);
    expect(result.prompt).toBe('Create a login page\n\n## Worker Outputs\n');
  });

  it('does not mutate the original task prompt', () => {
    const originalPrompt = baseTask.prompt;
    composeWorkerOutputsPrompt(baseTask, ['a', 'b']);
    expect(baseTask.prompt).toBe(originalPrompt);
  });

  it('returns a new object (not the same reference as the input task)', () => {
    const result = composeWorkerOutputsPrompt(baseTask, ['a']);
    expect(result).not.toBe(baseTask);
  });
});
