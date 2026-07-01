// ─── Engine barrel: worktree-manager + worktree-fixup re-exports ───────────
//
// CONTRACT UNDER TEST (packages/engine/src/index.ts):
//
// The engine package barrel (`packages/engine/src/index.ts`) must re-export the
// two new core modules created in tasks 4 & 5, in alphabetical order within the
// existing Core section, WITHOUT removing or modifying any existing export:
//
//   export * from './core/worktree-fixup.js';    // (before worktree-lifecycle)
//   export * from './core/worktree-manager.js';  // (after worktree-lifecycle,
//                                                //  before worktree-operations)
//
// Public symbols these wildcard re-exports surface from `@harms-haus/engin-engine`:
//
//   worktree-fixup.ts  → runTooledFixup (async fn)
//                      → FixupOptions, FixupResult (interfaces)
//
//   worktree-manager.ts → WorktreeManager (class)
//                       → WorktreeManagerOptions, TaskWorktreeInfo (interfaces)
//
// NOTE on type accessibility:
//   TypeScript types are erased at runtime, so a barrel namespace object cannot
//   be probed for an interface. HOWEVER, because the implementation uses
//   `export *`, the interfaces travel together with their companion VALUE in the
//   same module. Once the value binding (the `WorktreeManager` class / the
//   `runTooledFixup` function) is observable in the barrel namespace, the
//   associated interfaces (`WorktreeManagerOptions`, `TaskWorktreeInfo`,
//   `FixupOptions`, `FixupResult`) are GUARANTEED to be importable as types from
//   the same specifier. The value/binding checks below therefore transitively
//   pin type accessibility.
//
// This suite is written test-first. It uses the namespace + `Record<string,
// unknown>` cast pattern (mirrors tests/cli/index-barrel.test.ts) so that the
// file COMPILES against the current source while the assertions are RED until
// the two `export *` lines are added. They turn GREEN once the barrel is updated.

import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Engine public barrel (resolved via the workspace symlink to
//    packages/engine, whose package.json exports "./src/index.ts") ──────────
import * as engineBarrel from '@harms-haus/engin-engine';

// Guard against cross-file registry clearing (e.g. agent-lifecycle.test.ts /
// agent-registry.test.ts calling `clearAgentPluginRegistry()` in afterEach).
// The module-level side-effect imports run once at load time; a parallel test
// file may wipe the registry before these tests execute. Importing the adapter
// objects directly lets us re-register them before each test, ensuring the
// registry is always populated for the requireAgentPlugin assertions below.
import { codexAdapter } from '../packages/engine/src/agents/codex/adapter.js';
import { cursorAdapter } from '../packages/engine/src/agents/cursor/adapter.js';
import { piCodingAgentAdapter } from '../packages/engine/src/agents/pi-coding-agent/adapter.js';
import { registerAgentPlugin } from '../packages/engine/src/core/agent-registry.js';

// Direct source bindings — used to assert the barrel re-exports the correct
// named symbol (matching `.name`), not a re-declaration or stub. These resolve
// against the source modules directly, so they compile regardless of the barrel
// state. NOTE: Bun's module system may create separate runtime references for
// different import specifiers, so we compare `.name` rather than `.toBe()`
// reference identity.
import { runTooledFixup as SourceRunTooledFixup } from '../packages/engine/src/core/worktree-fixup.js';
import { WorktreeManager as SourceWorktreeManager } from '../packages/engine/src/core/worktree-manager.js';

// Cast the barrel to a record so we can probe arbitrary export names at runtime
// without TypeScript errors for names that are (deliberately, test-first) not
// yet re-exported by the barrel.
const barrel = engineBarrel as unknown as Record<string, unknown>;

beforeEach(() => {
  registerAgentPlugin(piCodingAgentAdapter);
  registerAgentPlugin(codexAdapter);
  registerAgentPlugin(cursorAdapter);
});

// ── Source path helpers (mirrors tests/tracking/shim-removal.test.ts) ──────
const ENGINE_SRC = resolve(import.meta.dir, '../packages/engine/src');
const indexSource = readFileSync(resolve(ENGINE_SRC, 'index.ts'), 'utf-8');

/** Core-section `export * from './core/<name>.js'` specifiers, in source order. */
const coreSpecifiers = indexSource
  .split('\n')
  .map((line) => {
    const match = line.match(/^export \* from '\.\/core\/([^']+)';/);
    return match ? match[1] : null;
  })
  .filter((spec): spec is string => spec !== null);

// ── Local structural types for the WorktreeManager smoke test ──────────────
// (We cannot import `WorktreeManagerOptions` as a type while the barrel is red,
// so we describe the documented option shape locally.)
interface SmokeOptions {
  repoRoot: string;
  sourceCwd: string;
  workDir: string;
  mainBranch: string;
  mainWorktreePath: string;
  profilesDirs: string[];
  apiKeys?: Record<string, string>;
}

interface ManagerInstance {
  readonly repoRoot: string;
  readonly sourceCwd: string;
  readonly mainBranch: string;
  readonly mainWorktreePath: string;
  setupMainWorktree(): Promise<unknown>;
  createTaskWorktree(taskId: string, taskPrompt?: string): Promise<string>;
  mergeTaskBranch(taskId: string): Promise<{ success: boolean; conflictsResolved: boolean }>;
  cullTaskWorktree(taskId: string): Promise<void>;
  gitWorktreePrune(): Promise<void>;
  finalMergeToMain(): Promise<{ success: boolean; conflicts: string[]; conflictsResolved: boolean }>;
  resolveFinalMergeConflicts(conflicts: string[], taskPrompt: string): Promise<boolean>;
  abortFinalMerge(): Promise<void>;
  cleanup(): Promise<{ cleanupError?: string }>;
  getWorktreeInfo(): { worktreePath: string; branchName: string; originalCwd: string };
}

// The complete set of PRE-EXISTING core wildcard exports — none may be removed.
// NOTE: `harness-factory.js` and `write-sandbox.js` were removed from the barrel
// (harness-factory.js was deleted entirely; write-sandbox moved to the adapter
// directory under sessions/pi-coding-agent/), so they are excluded here.
const ORIGINAL_CORE_SPECIFIERS = [
  'agent-loop.js',
  'config.js',
  'git.js',
  'phase-runner.js',
  'profile.js',
  'renderer-registry.js',
  'schema-describe.js',
  'setup.js',
  'structured-output.js',
  'task-ids.js',
  'title-generator.js',
  'types.js',
  'utils.js',
  'workflow-loader.js',
  'worktree-lifecycle.js',
  'worktree-operations.js',
  'worktree-populate.js',
] as const;

// A representative, cross-section sample of pre-existing VALUE exports that must
// remain present after the change (Core / Tracking / Server / Pool). Typed as a
// plain `string[]` so `it.each` infers the callback parameter as `string`
// (mirrors tests/cli/index-barrel.test.ts).
const PRESERVED_VALUE_EXPORTS: string[] = [
  // NOTE: `createHarness` was removed from the barrel — harness-factory.js was
  // deleted and is not re-exported from the engine public surface.
  'loadProfilesFromDirs',
  'generateWorkflowTitle',
  'ensureDir',
  'loadEnvFiles',
  'EventStore',
  'createStoreCallbacks',
  'StatusBridge',
  'startControlServer',
  'startDaemon',
];
// NOTE: `spawnAgent` (core/agent-lifecycle.js) is deliberately NOT in this list
// — it is an engine-internal helper consumed via direct source imports and has
// never been re-exported through the barrel.

// ═══════════════════════════════════════════════════════════════════════════════
// 1. New modules are re-exported as values from the public barrel
// ═══════════════════════════════════════════════════════════════════════════════

describe('engine barrel — re-exports worktree-manager + worktree-fixup values', () => {
  it('exports WorktreeManager (class constructor)', () => {
    expect(typeof barrel.WorktreeManager).toBe('function');
  });

  it('exports runTooledFixup (async function)', () => {
    expect(typeof barrel.runTooledFixup).toBe('function');
  });

  it('barrel.WorktreeManager re-exports the source class (matching name)', () => {
    expect((barrel.WorktreeManager as { name: string }).name).toBe(SourceWorktreeManager.name);
  });

  it('barrel.runTooledFixup re-exports the source function (matching name)', () => {
    expect((barrel.runTooledFixup as { name: string }).name).toBe(SourceRunTooledFixup.name);
  });

  it('runTooledFixup is an async function (returns a Promise)', async () => {
    // `runTooledFixup`'s `.constructor.name === 'AsyncFunction'` confirms the
    // exported value carries its async nature through the barrel.
    expect(barrel.runTooledFixup?.constructor?.name).toBe('AsyncFunction');
  });

  // ── WorktreeManager runtime smoke test ──────────────────────────────────
  //
  // Constructing a WorktreeManager has no side effects (it only stores the
  // options), so we can verify the exported class is genuinely usable — its
  // readonly fields and the full public method surface — without mocking git.

  it('WorktreeManager is constructible with the documented options shape', () => {
    expect(typeof barrel.WorktreeManager).toBe('function');
    const WorktreeManager = barrel.WorktreeManager as new (opts: SmokeOptions) => ManagerInstance;

    const wm = new WorktreeManager({
      repoRoot: '/fake/repo',
      sourceCwd: '/fake/source',
      workDir: '/run/work',
      mainBranch: 'engin/feat-x',
      mainWorktreePath: '/run/work/worktree',
      profilesDirs: ['/profiles'],
    });

    expect(wm.repoRoot).toBe('/fake/repo');
    expect(wm.sourceCwd).toBe('/fake/source');
    expect(wm.mainBranch).toBe('engin/feat-x');
    expect(wm.mainWorktreePath).toBe('/run/work/worktree');
  });

  it('constructed WorktreeManager exposes the full public method surface', () => {
    expect(typeof barrel.WorktreeManager).toBe('function');
    const WorktreeManager = barrel.WorktreeManager as new (opts: SmokeOptions) => ManagerInstance;
    const wm = new WorktreeManager({
      repoRoot: '/r',
      sourceCwd: '/s',
      workDir: '/w',
      mainBranch: 'engin/b',
      mainWorktreePath: '/w/wt',
      profilesDirs: [],
    });

    for (const method of [
      'setupMainWorktree',
      'createTaskWorktree',
      'mergeTaskBranch',
      'cullTaskWorktree',
      'gitWorktreePrune',
      'finalMergeToMain',
      'resolveFinalMergeConflicts',
      'abortFinalMerge',
      'cleanup',
      'getWorktreeInfo',
    ] as const) {
      expect(typeof (wm as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('getWorktreeInfo() returns the main worktree descriptor (no side effects)', () => {
    expect(typeof barrel.WorktreeManager).toBe('function');
    const WorktreeManager = barrel.WorktreeManager as new (opts: SmokeOptions) => ManagerInstance;
    const wm = new WorktreeManager({
      repoRoot: '/r',
      sourceCwd: '/orig/cwd',
      workDir: '/w',
      mainBranch: 'engin/feat-x',
      mainWorktreePath: '/w/worktree',
      profilesDirs: [],
    });

    expect(wm.getWorktreeInfo()).toEqual({
      worktreePath: '/w/worktree',
      branchName: 'engin/feat-x',
      originalCwd: '/orig/cwd',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. No existing exports are removed or shadowed (regression)
// ═══════════════════════════════════════════════════════════════════════════════

describe('engine barrel — existing exports preserved (regression)', () => {
  it.each(PRESERVED_VALUE_EXPORTS)('still exports value: %s', (name: string) => {
    expect(barrel).toHaveProperty(name);
    expect(typeof barrel[name]).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. index.ts source — Core section structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('index.ts — Core section re-exports the new modules', () => {
  it("contains the exact `export * from './core/worktree-fixup.js'` line", () => {
    expect(indexSource).toContain("export * from './core/worktree-fixup.js';");
  });

  it("contains the exact `export * from './core/worktree-manager.js'` line", () => {
    expect(indexSource).toContain("export * from './core/worktree-manager.js';");
  });

  it('lists the new Core wildcard exports (agent-lifecycle + error-classifier + network + path-relativizer + redact + renderer-invocation + worktree-final-merge + worktree-fixup + worktree-manager)', () => {
    expect(coreSpecifiers).toContain('agent-lifecycle.js');
    expect(coreSpecifiers).toContain('error-classifier.js');
    expect(coreSpecifiers).toContain('network.js');
    expect(coreSpecifiers).toContain('path-relativizer.js');
    expect(coreSpecifiers).toContain('redact.js');
    expect(coreSpecifiers).toContain('renderer-invocation.js');
    expect(coreSpecifiers).toContain('worktree-final-merge.js');
    expect(coreSpecifiers).toContain('worktree-fixup.js');
    expect(coreSpecifiers).toContain('worktree-manager.js');
  });

  it('does not remove or rename any pre-existing Core wildcard export', () => {
    for (const spec of ORIGINAL_CORE_SPECIFIERS) {
      expect(coreSpecifiers).toContain(spec);
    }
  });

  it('adds exactly nine new Core wildcard exports on top of ORIGINAL_CORE_SPECIFIERS', () => {
    // 17 pre-existing core exports + 9 new (agent-lifecycle, error-classifier,
    // network, path-relativizer, redact, renderer-invocation, worktree-final-merge,
    // worktree-fixup, worktree-manager) = 26. harness-factory.js and
    // write-sandbox.js were removed from the barrel (harness-factory deleted,
    // write-sandbox moved), so they are not counted.
    expect(coreSpecifiers).toHaveLength(ORIGINAL_CORE_SPECIFIERS.length + 9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. index.ts source — the other sections are left untouched
// ═══════════════════════════════════════════════════════════════════════════════

describe('index.ts — Pool / Tracking / Server sections unchanged', () => {
  it('still wildcard-exports the Pool barrel', () => {
    expect(indexSource).toContain("export * from './pool/index.js';");
  });

  it('still re-exports @engin/shared/event-types and @engin/shared/evolve', () => {
    expect(indexSource).toContain("export * from '@engin/shared/event-types';");
    expect(indexSource).toContain("export * from '@engin/shared/evolve';");
  });

  it('still re-exports createStoreCallbacks via the tracking barrel', () => {
    // createStoreCallbacks flows through the tracking barrel wildcard
    // (tracking/index.js re-exports it from store-callbacks.js). The functional
    // export is also verified by the PRESERVED_VALUE_EXPORTS `it.each` above.
    expect(indexSource).toContain("export * from './tracking/index.js';");
  });

  it('still wildcard-exports the Server control-server module', () => {
    expect(indexSource).toContain("export * from './server/control-server.js';");
  });
});
