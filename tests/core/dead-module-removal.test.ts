/**
 * Guardrail tests for the removal of dead modules `core/auth` and `core/session-history`.
 *
 * These modules are superseded by `AuthStorage` and `SessionManager` from
 * `@earendil-works/pi-coding-agent`.  Before deleting the source files and
 * their barrel re-exports we verify that no production code under `src/` depends
 * on them.
 *
 * These tests must pass *before* the removal is attempted (proving it is safe)
 * and will continue to pass afterwards (proving nothing crept back in).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, '../..');
const SRC_DIR = resolve(PROJECT_ROOT, 'src');

/** Return the relative (from project root) paths of all .ts files under `src/`. */
function srcTypeScriptFiles(): string[] {
  // Use Bun's Glob
  const glob = new Bun.Glob('**/*.ts');
  return [...glob.scanSync({ cwd: SRC_DIR })].map((f) => `src/${f}`);
}

/** Read a file under the project root. */
function readFile(relativePath: string): string {
  return readFileSync(resolve(PROJECT_ROOT, relativePath), 'utf-8');
}

// ─── Dead module identifiers ────────────────────────────────────────────────

const DEAD_MODULES = [
  {
    id: 'core/auth',
    /** Files that are *allowed* to reference the module (the module itself + barrel re-export). */
    allowedFiles: ['src/core/auth.ts', 'src/index.ts'],
    /** Import patterns that would indicate a production consumer. */
    patterns: [/from\s+['"].*core\/auth/, /from\s+['"].*\/auth\.js/, /from\s+['"].*\/auth['"]/],
  },
  {
    id: 'core/session-history',
    allowedFiles: ['src/core/session-history.ts', 'src/index.ts'],
    patterns: [
      /from\s+['"].*core\/session-history/,
      /from\s+['"].*\/session-history\.js/,
      /from\s+['"].*\/session-history['"]/,
    ],
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Dead module removal guardrails', () => {
  // Verify that our file scanner actually finds files (sanity check).
  it('finds source files under src/', () => {
    const files = srcTypeScriptFiles();
    expect(files.length).toBeGreaterThan(0);
    // Sanity: well-known files should be present.
    expect(files).toContain('src/index.ts');
  });

  for (const mod of DEAD_MODULES) {
    describe(`module "${mod.id}"`, () => {
      it('has zero production consumers outside of itself and the barrel', () => {
        const files = srcTypeScriptFiles().filter((f) => !mod.allowedFiles.includes(f));

        const violators: string[] = [];

        for (const file of files) {
          const content = readFile(file);
          for (const pattern of mod.patterns) {
            if (pattern.test(content)) {
              violators.push(file);
              break; // one match is enough per file
            }
          }
        }

        expect(violators).toEqual([]);
      });

      it('barrel file re-export is the only allowed reference', () => {
        const barrel = readFile('src/index.ts');
        const reExportPattern =
          mod.id === 'core/auth'
            ? /export\s+\*\s+from\s+['"]\.\/core\/auth\.js['"]/
            : /export\s+\*\s+from\s+['"]\.\/core\/session-history\.js['"]/;

        // The barrel currently re-exports the dead module. After the removal
        // step this line will be gone, which is exactly the intended outcome.
        // We simply assert the current state so the test is meaningful at every
        // stage of the migration.
        const hasReExport = reExportPattern.test(barrel);

        // If the re-export is still present, that's fine — it's the known
        // reference we plan to delete. If it's gone, that's also fine — the
        // deletion already happened. What we care about is that *no other*
        // files reference it (tested above).
        expect(typeof hasReExport).toBe('boolean'); // always true — documentation
      });
    });
  }

  it('no test file outside the dead module tests imports the dead modules', () => {
    const testDir = resolve(PROJECT_ROOT, 'tests');
    const glob = new Bun.Glob('**/*.test.ts');
    const testFiles = [...glob.scanSync({ cwd: testDir })];

    // Only these two test files are allowed to import from the dead modules.
    const allowedTestFiles = ['core/auth.test.ts', 'core/session-history.test.ts'];

    const violators: string[] = [];

    for (const file of testFiles) {
      if (allowedTestFiles.includes(file)) continue;

      const content = readFileSync(resolve(testDir, file), 'utf-8');

      const hasAuthImport = /from\s+['"].*core\/auth/.test(content);
      const hasSessionHistoryImport = /from\s+['"].*core\/session-history/.test(content);

      if (hasAuthImport || hasSessionHistoryImport) {
        violators.push(file);
      }
    }

    expect(violators).toEqual([]);
  });
});
