// ─── Barrel verification: packages/cli/src/index.ts ─────────────────────────
//
// The CLI package barrel (`packages/cli/src/index.ts`) must export ONLY the
// CLI's own public API. It must NOT re-export the engine or TUI packages'
// public surfaces — doing so violates separation of concerns and makes the
// CLI package a "god barrel" that every consumer reaches into for engine/TUI
// types instead of depending on those packages directly.
//
// CONTRACT UNDER TEST:
//
//   1. The barrel re-exports the CLI's own public API from `./cli.js`:
//        - main                       (async function — binary entrypoint)
//        - parseArgs                  (function)
//        - USAGE                      (string)
//        - VERSION                    (string)
//        - initCommand                (function)
//        - resumeCommand              (function)
//        - runCommand                 (function)
//        - serverUpCommand            (function)
//        - serverDownCommand          (function)
//        - serverStatusCommand        (function)
//        - CliOptions                 (type — see structural test below)
//
//   2. The barrel does NOT re-export ANY value from `@harms-haus/engin-engine`.
//      Verified exhaustively against the engine barrel's runtime namespace AND
//      via targeted spot-checks on representative engine internals
//      (LanePool, TaskTracker, createHarness, startDaemon, loadEnvFiles, …).
//
//   3. The barrel does NOT re-export ANY value from `@harms-haus/engin-tui`.
//      Verified exhaustively against the tui barrel's runtime namespace AND
//      via targeted spot-checks (WorkflowTUI, createWsBackedTui, cyan, …).
//
// Why both exhaustive + targeted checks?
//   - The EXHAUSTIVE check (barrel ∩ engine === ∅) catches any future leak,
//     even for symbols nobody thought to list. It is collision-free: none of
//     the CLI's own API names are also exported by engine or tui, so a
//     non-empty intersection can only mean real leakage.
//   - The TARGETED checks give clear, named failure messages for the most
//     commonly-abused engine/TUI symbols and are independent of how the
//     engine/tui barrels are loaded/mocked elsewhere in the suite.
//
// NOTE: This suite is written test-first. Against the current source the
// barrel still does `export * from '@harms-haus/engin-engine'` and
// `export * from '@harms-haus/engin-tui'`, so:
//   - the "exports CLI public API" group is RED (the CLI API is absent), and
//   - the "does not re-export engine/TUI" groups are RED (everything leaks).
// They turn GREEN once the barrel is changed to `export * from './cli.js'`.

import { describe, expect, it } from 'bun:test';

// ── Barrels under test ──────────────────────────────────────────────────────
import * as cliBarrel from '../../packages/cli/src/index.js';
import * as engineBarrel from '../../packages/engine/src/index.js';
import * as tuiBarrel from '../../packages/tui/src/index.js';

// ── CLI source (for the CliOptions structural check) ────────────────────────
import type { CliOptions } from '../../packages/cli/src/cli/parse-args.js';
import { parseArgs } from '../../packages/cli/src/cli/parse-args.js';

// Cast the CLI barrel to a record so we can probe arbitrary export names at
// runtime without TypeScript errors for names that are deliberately NOT
// exported (which is exactly what several assertions below verify).
const cliExports = cliBarrel as unknown as Record<string, unknown>;

// The CLI's own public value exports — the complete set the barrel must expose.
const CLI_API_NAMES = [
  'main',
  'parseArgs',
  'USAGE',
  'VERSION',
  'initCommand',
  'resumeCommand',
  'runCommand',
  'serverUpCommand',
  'serverDownCommand',
  'serverStatusCommand',
] as const;

// ── Pre-computed leak sets (exhaustive checks) ──────────────────────────────
const cliKeys = new Set(Object.keys(cliBarrel));
const leakedEngineKeys = Object.keys(engineBarrel).filter((k) => cliKeys.has(k));
const leakedTuiKeys = Object.keys(tuiBarrel).filter((k) => cliKeys.has(k));

// ═════════════════════════════════════════════════════════════════════════════
// 1. The barrel exports the CLI's own public API
// ═════════════════════════════════════════════════════════════════════════════

describe('CLI barrel — exports the CLI public API', () => {
  it('exposes all CLI public value exports by name', () => {
    for (const name of CLI_API_NAMES) {
      expect(cliBarrel).toHaveProperty(name);
    }
  });

  it('exports main, parseArgs and the command handlers as functions', () => {
    const fns = [
      'main',
      'parseArgs',
      'initCommand',
      'resumeCommand',
      'runCommand',
      'serverUpCommand',
      'serverDownCommand',
      'serverStatusCommand',
    ];
    for (const name of fns) {
      expect(typeof cliExports[name]).toBe('function');
    }
  });

  it('exports USAGE as a non-empty string', () => {
    expect(typeof cliExports['USAGE']).toBe('string');
    expect(String(cliExports['USAGE']).length).toBeGreaterThan(0);
  });

  it('exports VERSION as a non-empty string', () => {
    expect(typeof cliExports['VERSION']).toBe('string');
    expect(String(cliExports['VERSION']).length).toBeGreaterThan(0);
  });

  it('parseArgs from the barrel is the same binding as the source parseArgs', () => {
    // A true re-export, not a re-declaration.
    expect(cliExports['parseArgs']).toBe(parseArgs);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1b. CliOptions type contract
//
// Types are erased at runtime, so the CliOptions re-export cannot be probed via
// the namespace object. Instead we (a) confirm the canonical source type
// resolves and (b) verify parseArgs() returns a value that structurally
// satisfies CliOptions. After the fix, `export * from './cli.js'` propagates
// cli.ts's `export type { CliOptions }`, making the type importable from the
// barrel at compile time.
// ═════════════════════════════════════════════════════════════════════════════

describe('CLI barrel — CliOptions type contract', () => {
  it('parseArgs() returns a value structurally satisfying CliOptions', () => {
    const options: CliOptions = parseArgs(['develop', 'do-thing', '--verbose']);
    expect(options.command).toBe('run');
    expect(typeof options.cwd).toBe('string');
    expect(options.verbose).toBe(true);
    expect(Array.isArray(options.warnings)).toBe(true);
    expect(options.apiKeys).toEqual({});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The barrel does NOT re-export engine internals (exhaustive + targeted)
// ═════════════════════════════════════════════════════════════════════════════

describe('CLI barrel — does NOT re-export engine internals', () => {
  it('shares NO value export with the engine barrel (exhaustive)', () => {
    // Collision-free: none of the CLI API names are exported by engine, so any
    // overlap here is unambiguously leaked engine surface.
    expect(leakedEngineKeys).toEqual([]);
  });

  it.each([
    'LanePool',
    'TaskTracker',
    'WorkflowStatusTracker',
    'createHarness',
    'resolveProfilesDirs',
    'loadProfilesFromDirs',
    'loadProfiles',
    'loadProfile',
    'clearProfileCache',
    'loadEnvFiles',
    'startDaemon',
    'stopDaemon',
    'isServerAlive',
    'isPidAlive',
    'initDefaultConfig',
    'getGlobalConfigDir',
    'getDefaultWorkDir',
    'getServerPidfilePath',
    'getServerLogPath',
    'readPidfile',
    'writePidfile',
    'removeStalePidfile',
    'scanPastRuns',
    'ensureDir',
  ])('does not re-export engine internal: %s', (name) => {
    expect(cliBarrel).not.toHaveProperty(name);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The barrel does NOT re-export TUI internals (exhaustive + targeted)
// ═════════════════════════════════════════════════════════════════════════════

describe('CLI barrel — does NOT re-export TUI internals', () => {
  it('shares NO value export with the tui barrel (exhaustive)', () => {
    expect(leakedTuiKeys).toEqual([]);
  });

  it.each([
    'WorkflowTUI',
    'createWsBackedTui',
    'cyan',
    'dim',
    'bold',
    'underline',
    'green',
    'red',
    'yellow',
    'blue',
    'magenta',
    'statusColor',
    'statusIcon',
    'borderLine',
    'stripAnsi',
    'bgDark',
    'bgStatusBar',
    'darkRed',
  ])('does not re-export TUI internal: %s', (name) => {
    expect(cliBarrel).not.toHaveProperty(name);
  });
});
