import { describe, expect, it } from 'bun:test';
import type { Task } from '../../src/core/types.js';
import { buildPrompt } from '../../src/pool/prompt-builder.js';
import type { StepDefinition } from '../../src/pool/types.js';

describe('buildPrompt (prompt-builder module)', () => {
  const baseTask: Task = {
    id: 'task-1',
    title: 'Build feature X',
    prompt: 'Create a login page',
    profile: 'coder',
    files: ['src/login.ts', 'src/auth.ts'],
    dependencies: [],
    status: 'ready',
  };

  const baseStep: StepDefinition = {
    name: 'implement',
    profileId: 'coder',
    isReadOnly: false,
  };

  it('includes task title in the prompt', () => {
    const result = buildPrompt(baseTask, baseStep);
    expect(result).toContain('## Task: Build feature X');
  });

  it('includes step name in the prompt', () => {
    const result = buildPrompt(baseTask, baseStep);
    expect(result).toContain('## Step: implement');
  });

  it('includes task prompt in the output', () => {
    const result = buildPrompt(baseTask, baseStep);
    expect(result).toContain('Create a login page');
  });

  it('includes relevant files when present', () => {
    const result = buildPrompt(baseTask, baseStep);
    expect(result).toContain('## Relevant Files');
    expect(result).toContain('src/login.ts');
    expect(result).toContain('src/auth.ts');
  });

  it('does not include relevant files section when files array is empty', () => {
    const task: Task = { ...baseTask, files: [] };
    const result = buildPrompt(task, baseStep);
    expect(result).not.toContain('## Relevant Files');
  });

  it('does not include relevant files section when files is undefined', () => {
    const task: Task = { ...baseTask, files: undefined as unknown as string[] };
    const result = buildPrompt(task, baseStep);
    expect(result).not.toContain('## Relevant Files');
  });

  it('does not include review feedback when reviewFeedback is empty', () => {
    const task: Task = { ...baseTask, reviewFeedback: [] };
    const result = buildPrompt(task, baseStep);
    expect(result).not.toContain('## Review Feedback History');
  });

  it('does not include review feedback when reviewFeedback is undefined', () => {
    const task: Task = { ...baseTask, reviewFeedback: undefined };
    const result = buildPrompt(task, baseStep);
    expect(result).not.toContain('## Review Feedback History');
  });

  it('includes review feedback history when present', () => {
    const task: Task = {
      ...baseTask,
      reviewFeedback: ['Fix the null check', 'Add error handling'],
    };
    const result = buildPrompt(task, baseStep);
    expect(result).toContain('## Review Feedback History (please address all items)');
    expect(result).toContain('Attempt 1: Fix the null check');
    expect(result).toContain('Attempt 2: Add error handling');
  });

  it('includes single review feedback entry', () => {
    const task: Task = {
      ...baseTask,
      reviewFeedback: ['Fix the null check'],
    };
    const result = buildPrompt(task, baseStep);
    expect(result).toContain('Review Feedback History');
    expect(result).toContain('Attempt 1: Fix the null check');
  });

  it('accumulates feedback from multiple rejections', () => {
    const task: Task = {
      ...baseTask,
      reviewFeedback: ['Missing error handling', 'Needs input validation', 'Add logging'],
    };
    const result = buildPrompt(task, baseStep);
    expect(result).toContain('Attempt 1: Missing error handling');
    expect(result).toContain('Attempt 2: Needs input validation');
    expect(result).toContain('Attempt 3: Add logging');
  });

  it('separates sections with blank lines', () => {
    const result = buildPrompt(baseTask, baseStep);
    // Task title, step name, blank line, prompt — check the prompt body appears
    expect(result).toMatch(/## Task:.*\n## Step:.*\n\nCreate a login page/);
  });

  it('returns a string', () => {
    const result = buildPrompt(baseTask, baseStep);
    expect(typeof result).toBe('string');
  });

  it('uses correct review step name', () => {
    const reviewStep: StepDefinition = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
    };
    const result = buildPrompt(baseTask, reviewStep);
    expect(result).toContain('## Step: review');
  });

  it('handles task with minimal fields', () => {
    const minimalTask: Task = {
      id: 't1',
      title: 'Do stuff',
      prompt: 'Just do it',
      profile: 'coder',
      files: [],
      dependencies: [],
      status: 'ready',
    };
    const result = buildPrompt(minimalTask, baseStep);
    expect(result).toContain('## Task: Do stuff');
    expect(result).toContain('## Step: implement');
    expect(result).toContain('Just do it');
    expect(result).not.toContain('## Relevant Files');
    expect(result).not.toContain('## Review Feedback');
  });

  it('handles task with all sections populated', () => {
    const fullTask: Task = {
      id: 't1',
      title: 'Full task',
      prompt: 'Do everything',
      profile: 'coder',
      files: ['a.ts', 'b.ts'],
      dependencies: [],
      status: 'ready',
      reviewFeedback: ['First issue', 'Second issue'],
    };
    const result = buildPrompt(fullTask, baseStep);
    expect(result).toContain('## Task: Full task');
    expect(result).toContain('## Step: implement');
    expect(result).toContain('Do everything');
    expect(result).toContain('## Relevant Files');
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
    expect(result).toContain('## Review Feedback History');
    expect(result).toContain('Attempt 1: First issue');
    expect(result).toContain('Attempt 2: Second issue');
  });
});
