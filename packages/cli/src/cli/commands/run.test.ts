// ─── Tests for cli/commands/run.ts — run command extraction ─────────────────
//
// Drives the extraction of `runCommand` (plus its DEFAULT_SERVER_PORT /
// DEFAULT_SERVER_HOST helpers) into its own focused module, and pins the
// command's input-validation behavior so the refactor is provably behavior-
// preserving.
//
// Only the early-validation code paths are exercised here: they throw before
// any daemon, git, or readline interaction, so no live server is required.
//
// Module under test: ./run.js

import { describe, expect, it } from 'bun:test';

import type { CliOptions } from '../parse-args.js';
import { runCommand } from './run.js';

/** Build a run-command CliOptions, overriding selected fields. */
function runOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    command: 'run',
    cwd: process.cwd(),
    verbose: false,
    apiKeys: {},
    warnings: [],
    ...overrides,
  };
}

describe('runCommand — structural contract', () => {
  it('is an exported async function', () => {
    expect(typeof runCommand).toBe('function');
  });
});

describe('runCommand — required-argument validation', () => {
  it('throws when workflowName is missing', async () => {
    await expect(runCommand(runOptions({ workflowName: undefined, taskPrompt: 'do thing' }))).rejects.toThrow(
      /workflow name is required/i,
    );
  });

  it('throws when taskPrompt is missing', async () => {
    await expect(runCommand(runOptions({ workflowName: 'my-flow', taskPrompt: undefined }))).rejects.toThrow(
      /task prompt is required/i,
    );
  });

  it('throws when both workflowName and taskPrompt are missing (workflow checked first)', async () => {
    await expect(runCommand(runOptions())).rejects.toThrow(/workflow name is required/i);
  });
});

describe('runCommand — workflow-name validation (delegated to engine)', () => {
  it('rejects a workflow name containing a path separator "/"', async () => {
    await expect(runCommand(runOptions({ workflowName: 'evil/path', taskPrompt: 'do thing' }))).rejects.toThrow(
      /Invalid workflow name/,
    );
  });

  it('rejects a workflow name containing ".."', async () => {
    await expect(runCommand(runOptions({ workflowName: '..', taskPrompt: 'do thing' }))).rejects.toThrow(
      /Invalid workflow name/,
    );
  });
});
