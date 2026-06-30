// ─── Tests: no VALUE-LEVEL circular dependency between worktree-manager & worktree-lifecycle ─
//
// BACKGROUND
// `worktree-manager.ts` and `worktree-lifecycle.ts` form a VALUE-LEVEL
// (runtime) import cycle:
//
//   worktree-lifecycle.ts  ──value──▶  worktree-manager.ts   (imports the
//                                                      `WorktreeManager` class
//                                                      and constructs it)
//   worktree-manager.ts   ──value──▶  worktree-lifecycle.ts  (imports the
//                                                      `resolveConflictsWithAgent`
//                                                      function and calls it)
//
// Value-level cycles are dangerous: depending on module-evaluation order, one
// module observes the other's bindings as `undefined` / in the temporal dead
// zone during module initialization. Type-only imports (`import type`) are
// ERASED at compile time and create NO runtime edge, so inverting one
// direction to type-only (or removing/injecting the value dependency) breaks
// the cycle without changing runtime behavior.
//
// TARGET (this spec)
// The bidirectional value-level cycle MUST be broken. At MOST ONE of the two
// directions may carry a value import — the other must be type-only or absent.
//
// WHY STATIC ANALYSIS
// With ES-module live bindings, this particular cycle does not throw at
// runtime today (neither file consumes the other's value during module-eval —
// both usages sit inside functions invoked later, by which time both modules
// are fully initialized). A runtime smoke test therefore cannot reliably FAIL
// now, so it cannot drive the fix. Inspecting the import clauses statically is
// the only way to assert the architectural invariant and have it FAIL against
// the current source.
//
// MECHANISM-AGNOSTIC
// These tests assert the OUTCOME (cycle broken), not the mechanism. Any valid
// fix passes: inverting either direction to `import type`, removing a value
// import, injecting the dependency, or relocating the symbol to a neutral
// module. They FAIL only while BOTH directions remain value imports.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const MANAGER_SRC = readFileSync(join(import.meta.dir, 'worktree-manager.ts'), 'utf8');
const LIFECYCLE_SRC = readFileSync(join(import.meta.dir, 'worktree-lifecycle.ts'), 'utf8');

// ─── Static import-clause parser ──────────────────────────────────────────
//
// Returns the names of the bindings imported as VALUES (runtime edges) from
// the module whose base name is `moduleName` within `source`.
//
// Bindings imported via a statement-level `import type { ... }` or an inline
// `{ type X }` qualifier are EXCLUDED — they are erased at compile time and do
// not form a runtime edge (which is exactly the property that breaks a cycle).
//
// Handles named imports (`{ A, B }`, `{ type A, B }`, `{ A as C }`), default
// imports, and namespace imports (`* as N`), across `./`, `../`, and bare
// specifiers with optional `.js`.

function valueImportsFrom(source: string, moduleName: string): string[] {
  const name = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The clause `[^;]*?` cannot cross a `;`, so a match is confined to a single
  // import statement and never bleeds from an earlier `import` keyword across
  // intervening statements to a later `from '<target>'`.
  const re = new RegExp(`import\\s+(type\\s+)?([^;]*?)\\s+from\\s+['"](?:\\.{1,2}/)*${name}(?:\\.js)?['"]`, 'g');
  const values: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const isTypeOnlyStatement = m[1] != null; // a leading `import type`
    if (isTypeOnlyStatement) continue; // every binding is erased → no runtime edge
    const clause = m[2].trim();
    if (clause.startsWith('{')) {
      const inner = clause.replace(/^\{/, '').replace(/\}\s*$/, '');
      for (const raw of inner.split(',')) {
        const part = raw.trim();
        if (!part) continue;
        if (/^type\b/.test(part)) continue; // inline `type X` → erased at compile time
        values.push(part);
      }
    } else {
      // default import, namespace import, or `default, { named }` — runtime value(s).
      values.push(clause);
    }
  }
  return values;
}

describe('value-level circular dependency: worktree-manager ↔ worktree-lifecycle', () => {
  /** Value (runtime) bindings worktree-manager imports FROM worktree-lifecycle. */
  const managerToLifecycle = () => valueImportsFrom(MANAGER_SRC, 'worktree-lifecycle');
  /** Value (runtime) bindings worktree-lifecycle imports FROM worktree-manager. */
  const lifecycleToManager = () => valueImportsFrom(LIFECYCLE_SRC, 'worktree-manager');

  // ── parser sanity (self-documenting; must always pass) ──────────────────

  it('parser classifies a plain named value import as a value', () => {
    expect(valueImportsFrom("import { WorktreeManager } from './worktree-manager.js';", 'worktree-manager')).toEqual([
      'WorktreeManager',
    ]);
  });

  it('parser classifies a statement-level `import type` as NON-value (erased)', () => {
    expect(
      valueImportsFrom("import type { WorktreeManager } from './worktree-manager.js';", 'worktree-manager'),
    ).toEqual([]);
  });

  it('parser classifies an inline `{ type X }` as NON-value (erased)', () => {
    expect(
      valueImportsFrom("import { type WorktreeManager } from './worktree-manager.js';", 'worktree-manager'),
    ).toEqual([]);
  });

  it('parser keeps a value binding next to an inline type binding in the same statement', () => {
    expect(valueImportsFrom("import { type WorktreeManager, resolveConflictsWithAgent } from './x.js';", 'x')).toEqual([
      'resolveConflictsWithAgent',
    ]);
  });

  // ── the architectural invariant (FAILS until the cycle is broken) ────────

  it('at most one direction carries a value import (the cycle is broken on at least one side)', () => {
    const intoLifecycle = managerToLifecycle(); // manager → lifecycle
    const intoManager = lifecycleToManager(); // lifecycle → manager

    // A value-level cycle exists iff BOTH directions carry at least one
    // runtime binding. Today BOTH are non-empty (manager value-imports
    // `resolveConflictsWithAgent`; lifecycle value-imports `WorktreeManager`),
    // so this assertion FAILS. Breaking EITHER direction to type-only /
    // removed / injected makes one side empty and dissolves the cycle.
    const valueDirectionCount = Number(intoLifecycle.length > 0) + Number(intoManager.length > 0);

    if (valueDirectionCount > 1) {
      throw new Error(
        `value-level circular dependency still present. ` +
          `worktree-manager → worktree-lifecycle value bindings: ${JSON.stringify(intoLifecycle)}. ` +
          `worktree-lifecycle → worktree-manager value bindings: ${JSON.stringify(intoManager)}. ` +
          `Invert ONE direction to \`import type\` (or remove/inject the value dependency).`,
      );
    }

    expect(valueDirectionCount).toBeLessThanOrEqual(1);
  });
});
