// ─── parseArgs: --worktree flag removal ────────────────────────────────────
//
// The `--worktree` CLI flag was removed: worktrees are now automatic for git
// repos (the server decides; the client learns the worktree identity from the
// run_started summary). These tests specify the post-removal contract:
//
//   1. `USAGE` no longer advertises `--worktree`.
//   2. `parseArgs` treats `--worktree` as a no-op (it does NOT throw) and
//      emits a one-time informational migration warning instead, so existing
//      scripts/aliases don't hard-fail with a generic "Unknown flag" error.
//   3. `CliOptions` / parseArgs results no longer carry a `worktree` field.

import { describe, expect, it } from 'bun:test';
import { USAGE, parseArgs } from '../../packages/cli/src/cli/parse-args.js';

// ═══════════════════════════════════════════════════════════════════════════════
// USAGE string
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseArgs: --worktree removed from USAGE', () => {
  it('USAGE does not advertise the --worktree flag', () => {
    expect(USAGE).not.toContain('--worktree');
  });

  it('USAGE does not mention worktrees at all in the options section', () => {
    // The line "Run workflow in a git worktree" must be gone.
    expect(USAGE).not.toMatch(/run workflow in a git worktree/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// --worktree is now a no-op that emits an informational warning
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseArgs: --worktree accepted as a no-op with a migration warning', () => {
  it('does not throw for run with --worktree and emits the migration warning', () => {
    const result = parseArgs(['develop', 'do-task', '--worktree']);
    expect(result.command).toBe('run');
    expect(result.workflowName).toBe('develop');
    expect(result.taskPrompt).toBe('do-task');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/--worktree is no longer needed/i)]));
  });

  it('does not throw for --worktree before the command', () => {
    const result = parseArgs(['--worktree', 'develop', 'do-task']);
    expect(result.command).toBe('run');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/--worktree is no longer needed/i)]));
  });

  it('does not throw for server up --worktree', () => {
    const result = parseArgs(['server', 'up', '--worktree']);
    expect(result.command).toBe('server');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/--worktree is no longer needed/i)]));
  });

  it('does not throw for resume --worktree', () => {
    const result = parseArgs(['resume', 'some-session', '--worktree']);
    expect(result.command).toBe('resume');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/--worktree is no longer needed/i)]));
  });

  it('does not throw for init --worktree', () => {
    const result = parseArgs(['init', '--worktree']);
    expect(result.command).toBe('init');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/--worktree is no longer needed/i)]));
  });

  it('emits the migration warning only once when --worktree is repeated', () => {
    const result = parseArgs(['develop', 'do-task', '--worktree', '--worktree']);
    const worktreeWarnings = result.warnings.filter((w) => /--worktree is no longer needed/i.test(w));
    expect(worktreeWarnings).toHaveLength(1);
  });

  it('still parses a normal run command without --worktree', () => {
    const result = parseArgs(['develop', 'do-task', '--verbose']);
    expect(result.command).toBe('run');
    expect(result.workflowName).toBe('develop');
    expect(result.taskPrompt).toBe('do-task');
    expect(result.verbose).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseArgs results no longer carry a `worktree` field
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseArgs: results omit the worktree field', () => {
  it('run result has no worktree property', () => {
    expect(parseArgs(['develop', 'do-task'])).not.toHaveProperty('worktree');
  });

  it('server up result has no worktree property', () => {
    expect(parseArgs(['server', 'up'])).not.toHaveProperty('worktree');
  });

  it('resume result has no worktree property', () => {
    expect(parseArgs(['resume', 'session-1'])).not.toHaveProperty('worktree');
  });

  it('init result has no worktree property', () => {
    expect(parseArgs(['init'])).not.toHaveProperty('worktree');
  });

  it('help result has no worktree property', () => {
    expect(parseArgs(['--help'])).not.toHaveProperty('worktree');
  });
});
