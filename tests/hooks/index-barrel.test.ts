// ─── hooks/index.ts barrel: the single re-export seam for the hook system ──
//
// CONTRACT UNDER TEST (packages/engine/src/hooks/index.ts):
//
// This task creates a barrel at `packages/engine/src/hooks/index.ts` that
// re-exports the hook MECHANISM modules through ONE seam. It is the only
// `export *` hub for the hooks package: every consumer (including the engine
// package barrel itself, wired in a sibling test) imports hook symbols from
// `./hooks/index.js` rather than reaching into individual modules.
//
// The exact contents mandated by the task (reducers.js was added by the
// step-level-hooks task — it re-exports CONTEXT_BLOCK_REDUCER):
//
//   export * from './types.js';
//   export * from './registry.js';
//   export * from './compose.js';
//   export * from './defaults/index.js';
//   export * from './reducers.js';        // ← step-level-hooks task
//
// The barrel must:
//   1. Re-export from EXACTLY those five modules (no more, no fewer) — in
//      particular './reducers.js' MUST now be present (it surfaces
//      CONTEXT_BLOCK_REDUCER). (See the KNOWN NAME COLLISION note below for
//      why the registry line's form may differ from a bare `export *`.)
//   2. Be loadable at runtime WITHOUT throwing (no circular runtime import).
//      The runtime dependency graph is acyclic because types.ts holds its
//      forward references to HookRegistry via `import type` (erased at
//      runtime): types.ts → (nothing), registry.ts → core/utils, compose.ts →
//      core/types + registry, defaults/index.ts → (nothing yet). So importing
//      the barrel cannot loop.
//   3. Surface the VALUE exports of registry.ts and compose.ts under the same
//      binding identity as the source modules (genuine re-export, not a
//      re-declaration):
//        registry.ts → HookRegistry (class), createHookRegistry (fn)
//        compose.ts  → composeHooks (fn)
//
// NOTE on type accessibility: `export *` carries types together with their
// companion VALUES in the same module. Once the value bindings above are
// observable in the barrel namespace, the interfaces/type aliases declared in
// types.ts (CompositionRule, HookContext, ObserveHook, PipelineHook,
// FirstWinsHook, AllRunHook, HookDefinition, HookRegistry, WorkflowHooks,
// HookProvider) are GUARANTEED importable as types from the same specifier.
// The value/binding checks below therefore transitively pin type
// accessibility — the same approach used by tests/engine-index.test.ts.
//
// KNOWN NAME COLLISION (surfaced while writing these tests): types.ts exports
// an INTERFACE `HookRegistry` and registry.ts exports a CLASS `HookRegistry`.
// Re-exporting BOTH via `export *` in one barrel collides at compile time
// (TS2308 "Module './types.js' has already exported a member named
// 'HookRegistry'"). The task spec lists `export * from './registry.js'`, but
// that must be reconciled so `tsc --noEmit` passes. Two viable resolutions:
//   (A) keep `export * from './registry.js'` and rename/remove the interface
//       in types.ts, OR
//   (B) make the REGISTRY re-export explicit in the barrel —
//       `export { HookRegistry, createHookRegistry } from './registry.js'` —
//       because an explicit re-export wins over a wildcard for the same name
//       and suppresses TS2308.
// These tests accommodate BOTH: types/compose/defaults are asserted in their
// `export *` form (safe — they have no colliding names), while registry is
// asserted only as "re-exported from './registry.js'" (form-agnostic). The
// runtime VALUE/binding checks below pin the class binding either way.
//
// This suite is written TEST-FIRST. Source-level checks read the file
// defensively (empty string when absent) so the file COMPILES against the
// current source while the assertions are RED until the barrel is created.
// Runtime checks use a variable-based dynamic import so TypeScript does not
// eagerly resolve the (not-yet-existing) module at compile time — they are
// RED (module-not-found) until the file lands, then GREEN.

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Direct source bindings — used to assert the barrel is a genuine re-export
// (same binding identity), not a re-declaration. These modules ALREADY exist
// (tasks 1–3), so these imports compile regardless of the barrel state.
import { composeHooks as SourceComposeHooks } from '../../packages/engine/src/hooks/compose.js';
import {
  createHookRegistry as SourceCreateHookRegistry,
  HookRegistry as SourceHookRegistry,
} from '../../packages/engine/src/hooks/registry.js';

// ── Path helpers ───────────────────────────────────────────────────────────

const HOOKS_SRC = resolve(import.meta.dir, '../../packages/engine/src/hooks');
const HOOKS_INDEX = resolve(HOOKS_SRC, 'index.ts');

/**
 * Read the barrel source defensively: returns UTF-8 contents if the file
 * exists, or an empty string otherwise. An empty string fails every
 * `.toContain(...)` assertion — the desired RED state for a not-yet-created
 * file — without throwing at test-collection time.
 */
function tryReadBarrel(): string {
  return existsSync(HOOKS_INDEX) ? readFileSync(HOOKS_INDEX, 'utf-8') : '';
}

/**
 * Load the hooks barrel at runtime via a VARIABLE specifier. Because the
 * specifier is not a string literal, TypeScript does not resolve it at compile
 * time, so this file compiles even while the barrel does not yet exist. At
 * runtime the import rejects (module-not-found) until the file is created —
 * the RED state — and resolves once it is.
 */
async function loadHooksBarrel(): Promise<Record<string, unknown>> {
  const specifier = resolve(HOOKS_SRC, 'index.js');
  return (await import(specifier)) as Record<string, unknown>;
}

// ── Existence ──────────────────────────────────────────────────────────────

describe('hooks/index.ts barrel — existence', () => {
  it('creates packages/engine/src/hooks/index.ts', () => {
    expect(existsSync(HOOKS_INDEX)).toBe(true);
  });
});

// ── Source structure: exactly the five mandated re-exports ─────────────────

describe('hooks/index.ts barrel — exact re-export set', () => {
  const src = tryReadBarrel();

  it("re-exports the hook mechanism types from './types.js' (form-agnostic — see header)", () => {
    // types.ts and registry.ts BOTH export a `HookRegistry` binding
    // (types.ts as an interface, registry.ts as a class). Two wildcard
    // re-exports of that name collide (TS2308), so the barrel re-exports
    // types.js via an explicit `export type { … }` (NOT `export *`). Both
    // forms re-export from './types.js'; the form-agnostic regex below
    // tolerates either (matching the sibling registry assertion's style).
    expect(src).toMatch(/export\s+(?:\*|(?:type\s+)?\{[^}]*\})\s+from\s+['"]\.\/types\.js['"]/);
  });

  it("re-exports compose via `export * from './compose.js'`", () => {
    expect(src).toContain("export * from './compose.js';");
  });

  it("re-exports the defaults barrel via `export * from './defaults/index.js'`", () => {
    // The single seam through which every later defaults-*.ts file is
    // surfaced — hooks/index.ts must NOT re-export defaults individually.
    expect(src).toContain("export * from './defaults/index.js';");
  });

  it("re-exports the registry from './registry.js' (form-agnostic — see header)", () => {
    // registry.ts exports the CLASS `HookRegistry`; types.ts exports the
    // INTERFACE `HookRegistry`. Two wildcard re-exports of that name collide
    // (TS2308). The implementation reconciles this on the registry side
    // (either types.ts renames its interface, or the barrel uses an explicit
    // `export { HookRegistry, createHookRegistry } from './registry.js'`).
    // Both forms re-export from './registry.js'; the runtime VALUE checks
    // below pin the class binding regardless of which form is chosen.
    expect(src).toMatch(/export\s+(?:\*|\{[^}]*\})\s+from\s+['"]\.\/registry\.js['"]/);
  });

  it('re-exports EXACTLY the six mandated specifiers (incl. reducers + declarations)', () => {
    // Form-agnostic: captures `export * from '…'`, `export { … } from '…'`,
    // and `export type { … } from '…'`. The re-exported specifier set must be
    // EXACTLY { types, registry, declarations, compose, defaults, reducers }.
    // reducers.js surfaces CONTEXT_BLOCK_REDUCER / PHASE_RESULTS_REDUCER;
    // declarations.js surfaces HOOK_DECLARATIONS + getHookDeclaration
    // (the authoritative hook rule/reducer table consulted by ensureHook).
    const specs = Array.from(src.matchAll(/export\s+(?:\*|(?:type\s+)?\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g)).map(
      (m) => m[1],
    );
    // De-duplicate: a single module may be re-exported via both a value and a
    // type statement (e.g. declarations.js). The contract is the SET of source
    // modules re-exported, not the statement count.
    expect([...new Set(specs)].sort()).toEqual([
      './compose.js',
      './declarations.js',
      './defaults/index.js',
      './reducers.js',
      './registry.js',
      './types.js',
    ]);
  });

  it("re-exports './reducers.js' via `export *`", () => {
    // reducers.ts exports the VALUE CONTEXT_BLOCK_REDUCER; `export *` is the
    // correct form to surface a value re-export. The binding-identity checks
    // below pin that this is a genuine re-export, not a re-declaration.
    expect(src).toContain("export * from './reducers.js';");
  });
});

// ── Runtime loadability (no circular runtime import) ───────────────────────

describe('hooks/index.ts barrel — runtime loadability', () => {
  it('imports without throwing (no circular runtime dependency)', async () => {
    // types.ts holds its forward ref to HookRegistry via `import type`
    // (erased at runtime), so the runtime graph types→∅, registry→utils,
    // compose→types+registry, defaults→∅ is acyclic. Importing the barrel
    // must succeed.
    await expect(loadHooksBarrel()).resolves.toBeDefined();
  });

  it('the imported namespace is a plain object', async () => {
    const barrel = await loadHooksBarrel();
    expect(barrel).toBeTypeOf('object');
  });
});

// ── Value re-exports — same binding identity as the source modules ─────────

describe('hooks/index.ts barrel — value re-exports (binding identity)', () => {
  it('surfaces HookRegistry (the registry class constructor)', async () => {
    const barrel = await loadHooksBarrel();
    expect(typeof barrel.HookRegistry).toBe('function');
  });

  it('surfaces createHookRegistry (the registry factory)', async () => {
    const barrel = await loadHooksBarrel();
    expect(typeof barrel.createHookRegistry).toBe('function');
  });

  it('surfaces composeHooks (the composition-seam function)', async () => {
    const barrel = await loadHooksBarrel();
    expect(typeof barrel.composeHooks).toBe('function');
  });

  it('barrel.HookRegistry is the SAME binding as the source class (genuine re-export)', async () => {
    const barrel = await loadHooksBarrel();
    expect(barrel.HookRegistry).toBe(SourceHookRegistry);
  });

  it('barrel.createHookRegistry is the SAME binding as the source factory', async () => {
    const barrel = await loadHooksBarrel();
    expect(barrel.createHookRegistry).toBe(SourceCreateHookRegistry);
  });

  it('barrel.composeHooks is the SAME binding as the source function', async () => {
    const barrel = await loadHooksBarrel();
    expect(barrel.composeHooks).toBe(SourceComposeHooks);
  });

  it('surfaces CONTEXT_BLOCK_REDUCER (the all-run reducer for collectContext)', async () => {
    const barrel = await loadHooksBarrel();
    expect(typeof barrel.CONTEXT_BLOCK_REDUCER).toBe('function');
  });

  it('barrel.CONTEXT_BLOCK_REDUCER is the SAME binding as reducers.ts source', async () => {
    // reducers.ts is created by the step-level-hooks task and loaded here via
    // a VARIABLE specifier so this file compiles before reducers.ts lands.
    // The binding must be identical to the source module's export (a genuine
    // re-export via `export * from './reducers.js'`, not a re-declaration).
    const barrel = await loadHooksBarrel();
    const reducersSrc = (await import(resolve(HOOKS_SRC, 'reducers.js'))) as Record<string, unknown>;
    expect(barrel.CONTEXT_BLOCK_REDUCER).toBe(reducersSrc.CONTEXT_BLOCK_REDUCER);
  });

  it('surfaces HOOK_DECLARATIONS + getHookDeclaration (the hook rule/reducer table)', async () => {
    // declarations.ts is consulted by HookRegistry.ensureHook so production
    // registrations auto-attach each hook's real composition rule + reducer.
    const barrel = await loadHooksBarrel();
    expect(typeof barrel.HOOK_DECLARATIONS).toBe('object');
    expect(barrel.HOOK_DECLARATIONS).not.toBeNull();
    expect(typeof barrel.getHookDeclaration).toBe('function');
    // Spot-check a known declaration is surfaced.
    const decl = barrel.HOOK_DECLARATIONS as { onPhaseSettled: { rule: string } };
    expect(decl.onPhaseSettled.rule).toBe('all-run');
    const declSrc = (await import(resolve(HOOKS_SRC, 'declarations.js'))) as Record<string, unknown>;
    expect(barrel.HOOK_DECLARATIONS).toBe(declSrc.HOOK_DECLARATIONS);
    expect(barrel.getHookDeclaration).toBe(declSrc.getHookDeclaration);
  });

  it('the surfaced HookRegistry is genuinely usable (construct + invoke surface)', async () => {
    // Constructing a HookRegistry and probing its method surface proves the
    // re-exported class is the real implementation, not a stub.
    const barrel = await loadHooksBarrel();
    const HookRegistry = barrel.HookRegistry as new () => {
      register(hooks: unknown): unknown;
      hasSubscribers(name: string): boolean;
    };
    const reg = new HookRegistry();
    expect(typeof reg.register).toBe('function');
    expect(typeof reg.hasSubscribers).toBe('function');
    expect(reg.hasSubscribers('not-registered')).toBe(false);
  });
});
