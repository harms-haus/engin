// ─── Engine barrel: re-export the hooks barrel into the public API ────────
//
// CONTRACT UNDER TEST (packages/engine/src/index.ts):
//
// This task wires the hooks barrel into the engine package's public API by
// adding ONE line to the Core section of packages/engine/src/index.ts:
//
//   export * from './hooks/index.js';
//
// placed AFTER the existing `./core/*.js` exports and BEFORE the Pool section.
// Because hooks/index.ts already re-exports the mechanism modules (types,
// registry, compose) and the defaults barrel, this single line surfaces the
// entire hook system through `@harms-haus/engin-engine`:
//
//   HookRegistry         (class)         ← registry.ts
//   createHookRegistry   (fn)            ← registry.ts
//   composeHooks         (fn)            ← compose.ts
//   (+ every type from types.ts, transitively, via `export *`)
//
// Placement requirement (from the task): "in the Core section (after the
// existing core exports, before Pool)". The line must appear after the last
// `./core/*.js` export (now worktree-operations.js, after write-sandbox.js was
// removed) and before `./pool/index.js`.
//
// Regression requirement: no pre-existing export may be removed or shadowed.
//
// This suite is written TEST-FIRST, mirroring tests/engine-index.test.ts:
//   • The engine package barrel ALREADY exists, so `import * as engineBarrel
//     from '@harms-haus/engin-engine'` compiles. We cast it to
//     `Record<string, unknown>` and probe for the hooks value exports, which
//     are `undefined` (RED) until the re-export line is added.
//   • Source-level checks read index.ts and assert the exact line and its
//     placement. These are RED (line absent) until the edit lands.
//   • Direct source bindings for the identity check come from the hooks source
//     modules, which already exist.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Engine public barrel (resolved via the workspace symlink to
//    packages/engine, whose package.json exports "./src/index.ts") ──────────
import * as engineBarrel from '@harms-haus/engin-engine';

// Direct source bindings — assert the barrel is a genuine re-export (same
// binding identity), not a re-declaration. These modules already exist.
import { composeHooks as SourceComposeHooks } from '../packages/engine/src/hooks/compose.js';
import {
  createHookRegistry as SourceCreateHookRegistry,
  HookRegistry as SourceHookRegistry,
} from '../packages/engine/src/hooks/registry.js';

// Cast the barrel to a record so we can probe arbitrary export names at runtime
// without TypeScript errors for names that are (deliberately, test-first) not
// yet re-exported by the barrel.
const barrel = engineBarrel as unknown as Record<string, unknown>;

// ── Source path helpers (mirrors tests/engine-index.test.ts) ───────────────
const ENGINE_SRC = resolve(import.meta.dir, '../packages/engine/src');
const indexSource = readFileSync(resolve(ENGINE_SRC, 'index.ts'), 'utf-8');

// The hooks export line mandated by the task.
const HOOKS_EXPORT_LINE = "export * from './hooks/index.js';";

/** Index (0-based char offset) of a substring in the barrel source, or -1. */
function indexOfInSource(needle: string): number {
  return indexSource.indexOf(needle);
}

// A representative sample of PRE-EXISTING value exports across sections that
// must remain present after the change (typed as string[] so it.each infers
// the callback parameter as string — mirrors tests/engine-index.test.ts).
const PRESERVED_VALUE_EXPORTS: string[] = [
  // NOTE: `createHarness` was removed from the barrel — harness-factory.js was
  // deleted and is not re-exported from the engine public surface.
  'runMultiStepTask',
  'EventStore',
  'createStoreCallbacks',
  'StatusBridge',
  'startDaemon',
  'LanePool',
  'WorktreeManager',
  'runTooledFixup',
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1. The hooks value exports are surfaced through the engine barrel
// ═══════════════════════════════════════════════════════════════════════════════

describe('engine barrel — surfaces the hooks value exports', () => {
  it('exports HookRegistry (class constructor)', () => {
    expect(typeof barrel.HookRegistry).toBe('function');
  });

  it('exports createHookRegistry (factory function)', () => {
    expect(typeof barrel.createHookRegistry).toBe('function');
  });

  it('exports composeHooks (composition-seam function)', () => {
    expect(typeof barrel.composeHooks).toBe('function');
  });

  it('barrel.HookRegistry is the SAME binding as the source class (genuine re-export)', () => {
    expect(barrel.HookRegistry).toBe(SourceHookRegistry);
  });

  it('barrel.createHookRegistry is the SAME binding as the source factory', () => {
    expect(barrel.createHookRegistry).toBe(SourceCreateHookRegistry);
  });

  it('barrel.composeHooks is the SAME binding as the source function', () => {
    expect(barrel.composeHooks).toBe(SourceComposeHooks);
  });

  it('the hooks symbols do not collide with (shadow) any existing export', () => {
    // If an existing module already exported these names, `export *` ambiguity
    // would silently drop them. Binding-equality with the source modules
    // (asserted above) rules that out.
    expect(barrel.HookRegistry).toBe(SourceHookRegistry);
    expect(barrel.createHookRegistry).toBe(SourceCreateHookRegistry);
    expect(barrel.composeHooks).toBe(SourceComposeHooks);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. index.ts source — the hooks re-export line is present and placed correctly
// ═══════════════════════════════════════════════════════════════════════════════

describe('index.ts — hooks re-export line present and placed in the Core section', () => {
  it("contains the exact `export * from './hooks/index.js'` line", () => {
    expect(indexSource).toContain(HOOKS_EXPORT_LINE);
  });

  it('appears AFTER the last core export (worktree-operations.js)', () => {
    // "after the existing core exports" — the hooks line must come after the
    // final `./core/*.js` wildcard export. write-sandbox.js was removed from
    // the barrel, so the last core export is now worktree-operations.js.
    const hooksIdx = indexOfInSource(HOOKS_EXPORT_LINE);
    const lastCoreIdx = indexOfInSource("export * from './core/worktree-operations.js';");
    expect(hooksIdx).toBeGreaterThan(-1);
    expect(lastCoreIdx).toBeGreaterThan(-1);
    expect(hooksIdx).toBeGreaterThan(lastCoreIdx);
  });

  it('appears BEFORE the Pool section export', () => {
    // "before Pool" — the hooks line must come before the pool barrel export.
    const hooksIdx = indexOfInSource(HOOKS_EXPORT_LINE);
    const poolIdx = indexOfInSource("export * from './pool/index.js';");
    expect(hooksIdx).toBeGreaterThan(-1);
    expect(poolIdx).toBeGreaterThan(-1);
    expect(hooksIdx).toBeLessThan(poolIdx);
  });

  it('appears within the Core section (after the Core header, before the Pool header)', () => {
    // The Core section opens with the `// ─── Core ───` comment and closes at
    // the `// ─── Pool ───` comment. The hooks line must sit between them.
    const coreHeaderIdx = indexOfInSource('// ─── Core');
    const poolHeaderIdx = indexOfInSource('// ─── Pool');
    const hooksIdx = indexOfInSource(HOOKS_EXPORT_LINE);
    expect(coreHeaderIdx).toBeGreaterThan(-1);
    expect(poolHeaderIdx).toBeGreaterThan(-1);
    expect(hooksIdx).toBeGreaterThan(coreHeaderIdx);
    expect(hooksIdx).toBeLessThan(poolHeaderIdx);
  });

  it('re-exports the hooks barrel exactly once (no duplicate line)', () => {
    const occurrences = indexSource.split(HOOKS_EXPORT_LINE).length - 1;
    expect(occurrences).toBe(1);
  });

  it('does NOT re-export individual hooks submodules directly (everything goes through hooks/index.js)', () => {
    // The review feedback this task resolves: defaults (and the mechanism
    // modules) must NOT be piecemeal re-exported from the engine barrel. The
    // single hooks/index.js seam is the only sanctioned path.
    expect(indexSource).not.toContain("export * from './hooks/registry.js';");
    expect(indexSource).not.toContain("export * from './hooks/compose.js';");
    expect(indexSource).not.toContain("export * from './hooks/types.js';");
    expect(indexSource).not.toContain("export * from './hooks/defaults/index.js';");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Regression — no existing exports removed
// ═══════════════════════════════════════════════════════════════════════════════

describe('engine barrel — existing exports preserved (regression)', () => {
  it.each(PRESERVED_VALUE_EXPORTS)('still exports value: %s', (name: string) => {
    expect(barrel).toHaveProperty(name);
    expect(typeof barrel[name]).toBe('function');
  });

  it('still wildcard-exports the Pool barrel', () => {
    expect(indexSource).toContain("export * from './pool/index.js';");
  });

  it('still has the named createStoreCallbacks re-export', () => {
    expect(indexSource).toContain("export { createStoreCallbacks } from './tracking/store-callbacks.js';");
  });

  it('still re-exports @engin/shared/event-types and @engin/shared/evolve', () => {
    expect(indexSource).toContain("export * from '@engin/shared/event-types';");
    expect(indexSource).toContain("export * from '@engin/shared/evolve';");
  });
});
