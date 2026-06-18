/**
 * Migration verification: web backward-compat shims are DELETED and their
 * former consumers source bindings directly from canonical modules.
 *
 * This task removes two shim modules from the web package:
 *
 *   - src/store/evolve-client.ts — re-exported `evolve` (as `evolveClient`) and
 *     `MAX_AGENT_LOG` from @engin/shared/evolve, and `MAX_RUN_LOG` from
 *     @engin/shared/event-types.
 *   - src/types.ts — re-exported `isServerMessage`, `ClientMessage`,
 *     `ServerMessage` from ./protocol-types.
 *
 * After deletion the sole runtime consumer (workflow-store.ts) must import
 * those bindings directly from @engin/shared/*, and NO web source/test file may
 * import from the deleted module paths.
 *
 * These assertions are intentionally RED until the source migration lands and
 * GREEN thereafter, giving a clear go/no-go signal for the migration step.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src

function readSrc(rel: string): string {
  return readFileSync(join(here, rel), 'utf8');
}

function srcExists(rel: string): boolean {
  return existsSync(join(here, rel));
}

/** Recursively collect every .ts/.tsx file under a directory. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Extract every `from '...'` import/export specifier from source text. */
function specifiers(src: string): string[] {
  const re = /\bfrom\s+['"]([^'"]+)['"]/g;
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

/** True if a relative specifier points at the deleted `types.ts` shim.
 *  Matches `./types`, `../types`, `../../types` … but NOT the hyphenated
 *  `protocol-types` / `event-types` modules (their last segment is `-types`). */
function isDeletedTypesShim(spec: string): boolean {
  return spec === './types' || spec.endsWith('/types');
}

/** True if a relative specifier points at the deleted `evolve-client.ts` shim. */
function isDeletedEvolveClientShim(spec: string): boolean {
  return spec === './evolve-client' || spec.endsWith('/evolve-client');
}

// Files whose contents legitimately reference the deleted specifiers as test
// data (string-literal assertions), so they are excluded from the dangling-
// import scan to avoid false self-matches.
const SCAN_IGNORE = (basename: string): boolean => /shim-deletion/.test(basename) || /migration/.test(basename);

// ─── Shim files are deleted ─────────────────────────────────────────────────

describe('shim deletion — evolve-client.ts and types.ts are removed', () => {
  it('src/store/evolve-client.ts no longer exists', () => {
    expect(srcExists('store/evolve-client.ts')).toBe(false);
  });

  it('src/types.ts no longer exists', () => {
    expect(srcExists('types.ts')).toBe(false);
  });
});

// ─── workflow-store.ts imports from canonical sources ───────────────────────

describe('workflow-store — sources evolve / caps directly from @engin/shared', () => {
  const src = () => readSrc('store/workflow-store.ts');

  it("imports evolve (aliased as evolveClient) + MAX_AGENT_LOG from '@engin/shared/evolve'", () => {
    expect(src()).toContain("from '@engin/shared/evolve'");
    // The local alias keeps the existing call-sites (`evolveClient(...)`) intact.
    expect(src()).toMatch(/\bevolve\s+as\s+evolveClient\b/);
    expect(src()).toMatch(/\bMAX_AGENT_LOG\b/);
  });

  it("imports MAX_RUN_LOG from '@engin/shared/event-types'", () => {
    expect(src()).toContain("from '@engin/shared/event-types'");
    expect(src()).toMatch(/\bMAX_RUN_LOG\b/);
  });

  it("no longer imports from the deleted './evolve-client' shim", () => {
    expect(src()).not.toContain("from './evolve-client'");
  });
});

// ─── No dangling imports of the deleted modules anywhere in src ─────────────

describe('no web source/test file imports the deleted shim modules', () => {
  const offenders: string[] = [];
  for (const file of collectSourceFiles(here)) {
    const basename = file.split(/[\\/]/).pop() ?? '';
    if (SCAN_IGNORE(basename)) continue;
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (isDeletedEvolveClientShim(spec) || isDeletedTypesShim(spec)) {
        offenders.push(`${relative(here, file)}  →  ${spec}`);
      }
    }
  }

  it('no file imports from evolve-client or the bare types shim', () => {
    expect(offenders).toEqual([]);
  });
});
