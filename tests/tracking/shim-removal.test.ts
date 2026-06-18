// ─── Shim removal: structural contract ──────────────────────────────────────
//
// The backward-compat re-export shims
//   • packages/engine/src/tracking/evolve.ts
//   • packages/engine/src/tracking/event-types.ts
// have been DELETED. Every consumer that previously imported from those local
// paths must now import directly from the bare specifiers
//   • @engin/shared/evolve
//   • @engin/shared/event-types
//
// This suite pins the refactor by reading the engine source files and asserting
// the import surface matches the post-cleanup contract. These tests are RED
// before the cleanup lands and GREEN once the shims are gone and the consumers
// have been switched over.
//

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENGINE_ROOT = resolve(import.meta.dir, '../../packages/engine/src');

const SHIM_PATHS = {
  evolve: resolve(ENGINE_ROOT, 'tracking/evolve.ts'),
  eventTypes: resolve(ENGINE_ROOT, 'tracking/event-types.ts'),
};

function readSource(rel: string): string {
  return readFileSync(resolve(ENGINE_ROOT, rel), 'utf-8');
}

/** Assert a source file contains a given substring. */
function expectImports(source: string, specifier: string): void {
  expect(source).toContain(specifier);
}

/** Assert a source file does NOT contain a given (now-forbidden) substring. */
function expectNotImports(source: string, specifier: string): void {
  expect(source.includes(specifier)).toBe(false);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('shim files are deleted', () => {
  it('packages/engine/src/tracking/evolve.ts no longer exists', () => {
    expect(existsSync(SHIM_PATHS.evolve)).toBe(false);
  });

  it('packages/engine/src/tracking/event-types.ts no longer exists', () => {
    expect(existsSync(SHIM_PATHS.eventTypes)).toBe(false);
  });
});

describe('engine barrel (src/index.ts) re-exports from @engin/shared', () => {
  const barrel = readSource('index.ts');

  it('re-exports event-types directly from @engin/shared/event-types', () => {
    expectImports(barrel, '@engin/shared/event-types');
    // The old local-shim wildcard must be gone.
    expectNotImports(barrel, "'./tracking/event-types.js'");
  });

  it('re-exports evolve directly from @engin/shared/evolve', () => {
    expectImports(barrel, '@engin/shared/evolve');
    // The old local-shim wildcard must be gone.
    expectNotImports(barrel, "'./tracking/evolve.js'");
  });
});

describe('engine consumers import directly from @engin/shared', () => {
  it('tracking/event-store.ts sources event-types + evolve from @engin/shared', () => {
    const src = readSource('tracking/event-store.ts');
    expectImports(src, '@engin/shared/event-types');
    expectImports(src, '@engin/shared/evolve');
    // The intra-package shim imports must be gone.
    expectNotImports(src, "'./event-types.js'");
    expectNotImports(src, "'./evolve.js'");
  });

  it('tracking/store-callbacks.ts sources EventType from @engin/shared', () => {
    const src = readSource('tracking/store-callbacks.ts');
    expectImports(src, '@engin/shared/event-types');
    expectNotImports(src, "'./event-types.js'");
  });

  it('server/status-bridge.ts sources event-types from @engin/shared', () => {
    const src = readSource('server/status-bridge.ts');
    expectImports(src, '@engin/shared/event-types');
    expectNotImports(src, "'../tracking/event-types.js'");
  });
});

describe('no engine source file imports the deleted shim paths', () => {
  // A catch-all grep across the engine package so that any future consumer
  // accidentally re-introducing a `./tracking/event-types.js` or
  // `./tracking/evolve.js` import is caught here.
  const engineFiles: string[] = [
    'index.ts',
    'tracking/event-store.ts',
    'tracking/store-callbacks.ts',
    'tracking/task-status.ts',
    'tracking/workflow-status.ts',
    'tracking/workflow-serializer.ts',
    'tracking/audit-log.ts',
    'server/status-bridge.ts',
  ];

  for (const rel of engineFiles) {
    it(`${rel} does not import from the deleted tracking shims`, () => {
      const src = readSource(rel);
      expectNotImports(src, "'./tracking/event-types.js'");
      expectNotImports(src, "'./tracking/evolve.js'");
      expectNotImports(src, "'../tracking/event-types.js'");
      expectNotImports(src, "'../tracking/evolve.js'");
      // Within-package relative shim imports (used by event-store/store-callbacks)
      expectNotImports(src, "'./evolve.js'");
      expectNotImports(src, "'./event-types.js'");
    });
  }
});
