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

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Engine public barrel (resolved via the workspace symlink to
//    packages/engine, whose package.json exports "./src/index.ts") ──────────
import * as engineBarrel from '@harms-haus/engin-engine';

// Direct source bindings — used to assert the barrel is a genuine re-export
// (same binding identity), not a re-declaration. These resolve against the
// source modules directly, so they compile regardless of the barrel state.
import { runTooledFixup as SourceRunTooledFixup } from '../packages/engine/src/core/worktree-fixup.js';
import { WorktreeManager as SourceWorktreeManager } from '../packages/engine/src/core/worktree-manager.js';

// Cast the barrel to a record so we can probe arbitrary export names at runtime
// without TypeScript errors for names that are (deliberately, test-first) not
// yet re-exported by the barrel.
const barrel = engineBarrel as unknown as Record<string, unknown>;

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
  prune(): Promise<void>;
  finalMergeToMain(): Promise<{ success: boolean; conflicts: string[]; conflictsResolved: boolean }>;
  resolveFinalMergeConflicts(conflicts: string[], taskPrompt: string): Promise<boolean>;
  abortFinalMerge(): Promise<void>;
  cleanup(): Promise<{ cleanupError?: string }>;
  getWorktreeInfo(): { worktreePath: string; branchName: string; originalCwd: string };
}

// The complete set of PRE-EXISTING core wildcard exports — none may be removed.
const ORIGINAL_CORE_SPECIFIERS = [
  'agent-loop.js',
  'config.js',
  'git.js',
  'harness-factory.js',
  'phase-tasks.js',
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
  'write-sandbox.js',
] as const;

// A representative, cross-section sample of pre-existing VALUE exports that must
// remain present after the change (Core / Tracking / Server / Pool). Typed as a
// plain `string[]` so `it.each` infers the callback parameter as `string`
// (mirrors tests/cli/index-barrel.test.ts).
const PRESERVED_VALUE_EXPORTS: string[] = [
  'createHarness',
  'loadProfilesFromDirs',
  'generateWorkflowTitle',
  'runMultiStepTask',
  'ensureDir',
  'loadEnvFiles',
  'EventStore',
  'createStoreCallbacks',
  'StatusBridge',
  'startControlServer',
  'startDaemon',
  'LanePool',
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

  it('barrel.WorktreeManager is the SAME binding as the source class (genuine re-export)', () => {
    expect(barrel.WorktreeManager).toBe(SourceWorktreeManager);
  });

  it('barrel.runTooledFixup is the SAME binding as the source function (genuine re-export)', () => {
    expect(barrel.runTooledFixup).toBe(SourceRunTooledFixup);
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
      'prune',
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

  it('the new symbols do not collide with (shadow) any existing export', () => {
    // If an existing module already exported `WorktreeManager` or
    // `runTooledFixup`, `export *` ambiguity would silently drop the new one.
    // Binding-equality with the source modules (asserted above) rules that out.
    expect(barrel.WorktreeManager).toBe(SourceWorktreeManager);
    expect(barrel.runTooledFixup).toBe(SourceRunTooledFixup);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. index.ts source — Core section structure & ordering
// ═══════════════════════════════════════════════════════════════════════════════

describe('index.ts — Core section re-exports the new modules in order', () => {
  it("contains the exact `export * from './core/worktree-fixup.js'` line", () => {
    expect(indexSource).toContain("export * from './core/worktree-fixup.js';");
  });

  it("contains the exact `export * from './core/worktree-manager.js'` line", () => {
    expect(indexSource).toContain("export * from './core/worktree-manager.js';");
  });

  it('lists both new modules in the Core section', () => {
    expect(coreSpecifiers).toContain('worktree-fixup.js');
    expect(coreSpecifiers).toContain('worktree-manager.js');
  });

  it('places worktree-fixup.js BEFORE worktree-lifecycle.js', () => {
    const fixupIdx = coreSpecifiers.indexOf('worktree-fixup.js');
    const lifecycleIdx = coreSpecifiers.indexOf('worktree-lifecycle.js');

    expect(fixupIdx).toBeGreaterThanOrEqual(0);
    expect(lifecycleIdx).toBeGreaterThanOrEqual(0);
    expect(fixupIdx).toBeLessThan(lifecycleIdx);
  });

  it('places worktree-manager.js BETWEEN worktree-lifecycle.js and worktree-operations.js', () => {
    const lifecycleIdx = coreSpecifiers.indexOf('worktree-lifecycle.js');
    const managerIdx = coreSpecifiers.indexOf('worktree-manager.js');
    const operationsIdx = coreSpecifiers.indexOf('worktree-operations.js');

    expect(lifecycleIdx).toBeGreaterThanOrEqual(0);
    expect(managerIdx).toBeGreaterThanOrEqual(0);
    expect(operationsIdx).toBeGreaterThanOrEqual(0);
    expect(lifecycleIdx).toBeLessThan(managerIdx);
    expect(managerIdx).toBeLessThan(operationsIdx);
  });

  it('keeps the entire Core section in alphabetical order', () => {
    // The Core wildcard specifiers must be strictly alphabetical in source
    // order. This subsumes the two placement requirements above and guards
    // against the new lines being appended at the end of the file/section.
    const sorted = [...coreSpecifiers].sort();
    expect(coreSpecifiers).toEqual(sorted);
  });

  it('does not remove or rename any pre-existing Core wildcard export', () => {
    for (const spec of ORIGINAL_CORE_SPECIFIERS) {
      expect(coreSpecifiers).toContain(spec);
    }
  });

  it('adds exactly three Core wildcard exports (21 total after the change)', () => {
    // 18 pre-existing core exports + 3 new (phase-runner, worktree-fixup,
    // worktree-manager) = 21.
    expect(coreSpecifiers).toHaveLength(ORIGINAL_CORE_SPECIFIERS.length + 3);
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

  it('still has the named createStoreCallbacks re-export', () => {
    expect(indexSource).toContain("export { createStoreCallbacks } from './tracking/store-callbacks.js';");
  });

  it('still wildcard-exports the Server control-server module', () => {
    expect(indexSource).toContain("export * from './server/control-server.js';");
  });
});
