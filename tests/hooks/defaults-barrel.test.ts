// ─── hooks/defaults barrel: the single re-export seam for default hooks ────
//
// CONTRACT UNDER TEST (packages/engine/src/hooks/defaults/index.ts):
//
// This barrel is the single re-export seam for all default hook
// implementations. Every `defaults-*.ts` file adds its named re-exports
// HERE — not scattered across `hooks/index.ts`. Review feedback:
// "all defaults go through defaults/index.ts, and hooks/index.ts
// re-exports it once."
//
// The barrel must:
//
//   1. Live at packages/engine/src/hooks/defaults/index.ts.
//   2. Carry the documented file-header doc comment.
//   3. Use named re-exports (`export { ... } from './…'`) — never wildcard
//      re-exports — for a fixed, auditable set of default hook symbols.
//
// This suite verifies file existence, the header comment, and the exact set
// of exported symbols (both at source level and via runtime dynamic import).

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Path helpers ───────────────────────────────────────────────────────────

const ENGINE_SRC = resolve(import.meta.dir, '../../packages/engine/src');
const HOOKS_SRC = resolve(ENGINE_SRC, 'hooks');
const DEFAULTS_DIR = resolve(HOOKS_SRC, 'defaults');
const DEFAULTS_INDEX = resolve(DEFAULTS_DIR, 'index.ts');

/**
 * Read a source file defensively: returns its UTF-8 contents if present, or an
 * empty string if the file does not exist yet. An empty string fails every
 * `.toContain(...)` assertion — the desired RED state for a not-yet-created
 * file — without throwing at test-collection time. Mirrors the readSource
 * helper in tests/tracking/shim-removal.test.ts but null-safe.
 */
function tryReadSource(absPath: string): string {
  return existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
}

/**
 * Load the defaults barrel at runtime via a VARIABLE specifier. Because the
 * specifier is not a string literal, TypeScript does not resolve it at compile
 * time (the call is typed `Promise<any>`), so this file compiles even while
 * the barrel does not yet exist. At runtime the import rejects (module-not-
 * found) until the file is created — the RED state — and resolves once it is.
 */
async function loadDefaultsBarrel(): Promise<Record<string, unknown>> {
  const specifier = resolve(HOOKS_SRC, 'defaults/index.js');
  return (await import(specifier)) as Record<string, unknown>;
}

// ── File & directory existence ─────────────────────────────────────────────

describe('hooks/defaults barrel — existence', () => {
  it('creates the packages/engine/src/hooks/defaults/ directory', () => {
    expect(existsSync(DEFAULTS_DIR)).toBe(true);
  });

  it('creates packages/engine/src/hooks/defaults/index.ts', () => {
    expect(existsSync(DEFAULTS_INDEX)).toBe(true);
  });
});

// ── Header doc comment ─────────────────────────────────────────────────────

describe('hooks/defaults barrel — header doc comment', () => {
  const src = tryReadSource(DEFAULTS_INDEX);

  it('carries the documented file-header doc comment', () => {
    // The exact comment mandated by the task:
    //   /** Barrel for default hook implementations. Each defaults-*.ts file
    //       adds its export here. */
    expect(src).toContain('/**');
    expect(src).toContain('*/');
    expect(src).toContain('Barrel for default hook implementations');
    expect(src).toContain('Each defaults-*.ts file');
    expect(src).toContain('adds its export here');
  });
});

// ── Expected exports ──────────────────────────────────────────────────────

/**
 * The sorted list of named exports the barrel must surface. Maintained as
 * the single source of truth — tests below assert the runtime namespace
 * matches this list exactly.
 */
const EXPECTED_EXPORTS = [
  'createDefaultAfterPhase',
  'createDefaultAuditor',
  'createDefaultBeforeTaskWorktreeCreate',
  'createDefaultOnCommitFailure',
  'createDefaultOnMergeConflict',
  'createDefaultOnPersist',
  'createDefaultOnRestore',
  'createDefaultOnRunMergeConflict',
  'createDefaultPopulateWorktree',
  'defaultAfterTaskWorktreeCreate',
  'defaultBeforePhaseTransition',
  'defaultBeforeRunMerge',
  'defaultBeforeStepPrompt',
  'defaultCollectContext',
  'defaultOnPhaseSettled',
  'defaultOnTaskMerge',
  'defaultOnWorkflowAbort',
  'defaultOnWorkflowResume',
  'defaultShouldRetryPhase',
] as const;

describe('hooks/defaults barrel — exports', () => {
  const src = tryReadSource(DEFAULTS_INDEX);

  it('uses named re-exports (no `export *` wildcard re-exports)', () => {
    // The barrel uses `export { ... } from './…'` for each symbol — never
    // wildcard re-exports that could leak unintended symbols.
    expect(src).not.toMatch(/export\s+\*/);
  });

  it('declares no direct value exports (function / class / const / let / var / default)', () => {
    expect(src).not.toMatch(/export\s+(default\s+)?(function|class|const|let|var)\b/);
  });

  it('loads at runtime with the expected exported symbols', async () => {
    const mod = await loadDefaultsBarrel();
    expect(mod).toBeTypeOf('object');

    const keys = Object.keys(mod).sort();
    const expected = [...EXPECTED_EXPORTS].sort();

    // Exact list — no missing, no extra.
    expect(keys).toEqual(expected);
  });

  it('does not throw when imported (no circular / missing-dependency runtime error)', async () => {
    await expect(loadDefaultsBarrel()).resolves.toBeDefined();
  });

  it('contains key regression-guard names in the source file', () => {
    // Smoke-check: a few representative names must appear as named re-exports
    // in the source text. This catches wholesale accidental deletion even if
    // the runtime check above is skipped.
    expect(src).toContain('createDefaultAuditor');
    expect(src).toContain('defaultBeforeStepPrompt');
    expect(src).toContain('defaultOnPhaseSettled');
    expect(src).toContain('defaultCollectContext');
  });
});
