import { describe, expect, it } from 'bun:test';
import { parseSlashCommand } from '../../src/cli/slash-command-parser.js';

// ─── Happy-path parsing ────────────────────────────────────────────────────

describe('parseSlashCommand – valid inputs', () => {
  it('parses a basic command with workflow name and task prompt', () => {
    const result = parseSlashCommand('/develop build the auth module');
    expect(result).toEqual({
      ok: true,
      workflowName: 'develop',
      taskPrompt: 'build the auth module',
      verbose: false,
      worktree: false,
      maxConcurrent: 5,
    });
  });

  it('parses --verbose flag', () => {
    const result = parseSlashCommand('/develop --verbose fix the bug');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verbose).toBe(true);
    expect(result.taskPrompt).toBe('fix the bug');
    expect(result.worktree).toBe(false);
    expect(result.maxConcurrent).toBe(5);
  });

  it('parses --worktree flag', () => {
    const result = parseSlashCommand('/review --worktree check the code');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.worktree).toBe(true);
    expect(result.taskPrompt).toBe('check the code');
    expect(result.verbose).toBe(false);
    expect(result.maxConcurrent).toBe(5);
  });

  it('parses --max-concurrent with integer value', () => {
    const result = parseSlashCommand('/develop --max-concurrent 3 do the thing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.maxConcurrent).toBe(3);
    expect(result.taskPrompt).toBe('do the thing');
    expect(result.verbose).toBe(false);
    expect(result.worktree).toBe(false);
  });

  it('parses all flags together', () => {
    const result = parseSlashCommand('/develop --verbose --worktree --max-concurrent 10 refactor everything');
    expect(result).toEqual({
      ok: true,
      workflowName: 'develop',
      taskPrompt: 'refactor everything',
      verbose: true,
      worktree: true,
      maxConcurrent: 10,
    });
  });

  it('collects multi-word task prompt', () => {
    const result = parseSlashCommand('/develop implement user authentication with OAuth2 and JWT tokens');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskPrompt).toBe('implement user authentication with OAuth2 and JWT tokens');
  });

  it('handles flags interspersed with task words', () => {
    const result = parseSlashCommand('/develop do --verbose something --worktree cool');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verbose).toBe(true);
    expect(result.worktree).toBe(true);
    expect(result.taskPrompt).toBe('do something cool');
  });

  it('supports workflow names with hyphens and underscores', () => {
    const result = parseSlashCommand('/my-cool_workflow do stuff');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflowName).toBe('my-cool_workflow');
  });
});

// ─── Error cases ────────────────────────────────────────────────────────────

describe('parseSlashCommand – error cases', () => {
  it('returns error for empty input', () => {
    const result = parseSlashCommand('');
    expect(result).toEqual({
      ok: false,
      error: 'Please enter a command. Type /workflow-name <task> to start.',
    });
  });

  it('returns error for whitespace-only input', () => {
    const result = parseSlashCommand('   ');
    expect(result).toEqual({
      ok: false,
      error: 'Please enter a command. Type /workflow-name <task> to start.',
    });
  });

  it('returns error when input does not start with /', () => {
    const result = parseSlashCommand('develop build it');
    expect(result).toEqual({
      ok: false,
      error: 'Commands must start with /. Type /workflow-name <task> to start.',
    });
  });

  it('returns error when / is not followed by a valid workflow name token', () => {
    const result = parseSlashCommand('/!invalid do stuff');
    expect(result).toEqual({
      ok: false,
      error: 'Missing workflow name. Type /workflow-name <task> to start.',
    });
  });

  it('returns error when only /workflow-name is provided without task prompt', () => {
    const result = parseSlashCommand('/develop');
    expect(result).toEqual({
      ok: false,
      error: 'Missing task prompt. Usage: /workflow-name [--verbose] [--worktree] [--max-concurrent N] <task prompt>',
    });
  });

  it('returns error when only flags are provided but no task prompt', () => {
    const result = parseSlashCommand('/develop --verbose --worktree');
    expect(result).toEqual({
      ok: false,
      error: 'Missing task prompt. Usage: /workflow-name [--verbose] [--worktree] [--max-concurrent N] <task prompt>',
    });
  });

  it('returns error for path-traversal workflow name (should catch, not throw)', () => {
    // ".." is not matched by the [a-zA-Z0-9_-]+ regex, so it fails at the
    // name-extraction step, not at validateWorkflowName. Either way the parser
    // returns an error result and never throws.
    const result = parseSlashCommand('/../etc/passwd do stuff');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('workflow name');
  });

  it('extracts valid prefix when workflow name contains forward slash', () => {
    // The regex extracts "foo" before the "/"; "/bar" becomes part of the remaining tokens
    const result = parseSlashCommand('/foo/bar do stuff');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflowName).toBe('foo');
    expect(result.taskPrompt).toBe('/bar do stuff');
  });

  it('never throws – path-traversal input returns error result', () => {
    // ".." is not in [a-zA-Z0-9_-] so the regex rejects it at extraction;
    // validateWorkflowName's try/catch is defence-in-depth. Either way, no throw.
    expect(() => parseSlashCommand('/../etc do stuff')).not.toThrow();
    const result = parseSlashCommand('/../etc do stuff');
    expect(result.ok).toBe(false);
  });

  it('returns error when --max-concurrent is not followed by a valid positive integer', () => {
    const result = parseSlashCommand('/develop --max-concurrent abc do stuff');
    expect(result).toEqual({
      ok: false,
      error: '--max-concurrent requires a positive integer',
    });
  });

  it('returns error when --max-concurrent is followed by zero', () => {
    const result = parseSlashCommand('/develop --max-concurrent 0 do stuff');
    expect(result).toEqual({
      ok: false,
      error: '--max-concurrent requires a positive integer',
    });
  });

  it('returns error when --max-concurrent is followed by negative number', () => {
    const result = parseSlashCommand('/develop --max-concurrent -1 do stuff');
    expect(result).toEqual({
      ok: false,
      error: '--max-concurrent requires a positive integer',
    });
  });

  it('returns error when --max-concurrent is at end with no value', () => {
    const result = parseSlashCommand('/develop --max-concurrent');
    expect(result).toEqual({
      ok: false,
      error: '--max-concurrent requires a positive integer',
    });
  });
});
