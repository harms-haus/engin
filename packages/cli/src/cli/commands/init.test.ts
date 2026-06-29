// ─── Tests for cli/commands/init.ts — init command extraction ───────────────
//
// Drives the extraction of `initCommand` into its own focused module. The
// command is a thin wrapper around the engine's `initDefaultConfig()` plus a
// success log; these tests pin both its structural export and its observable
// behavior (creates the global config dir and logs the init message).
//
// Module under test: ./init.js

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { initCommand } from './init.js';

/** Minimal CliOptions for the init command. */
function initOptions(): Parameters<typeof initCommand>[0] {
  return {
    command: 'init',
    cwd: process.cwd(),
    verbose: false,
    apiKeys: {},
    warnings: [],
  };
}

describe('initCommand — structural contract', () => {
  it('is an exported async function', () => {
    expect(typeof initCommand).toBe('function');
  });
});

describe('initCommand — behavior', () => {
  it('creates the global config directory and logs the init message', async () => {
    // Point XDG_CONFIG_HOME at a throwaway dir so initDefaultConfig() writes
    // there instead of polluting the real user config.
    const tempHome = mkdtempSync(join(tmpdir(), 'engin-init-'));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempHome;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await initCommand(initOptions());

      const expectedDir = join(tempHome, 'engin');
      expect(existsSync(expectedDir)).toBe(true);
      // The success message names the initialized directory.
      expect(logs.some((line) => line.includes(expectedDir))).toBe(true);
      expect(logs.some((line) => line.toLowerCase().includes('initializ'))).toBe(true);
    } finally {
      console.log = origLog;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
