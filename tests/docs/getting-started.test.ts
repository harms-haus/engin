// ─── Documentation: Programmatic quick start ───────────────────────────────
//
// CONTRACT UNDER TEST (docs/guides/getting-started.md):
//
// The "Programmatic quick start" section of the Getting Started guide contains a
// TypeScript code example that consumers copy verbatim. `createHarness` was
// removed from the public API in favour of the agent plugin system
// (`requireAgentPlugin` + `plugin.createSession`). The documented example MUST
// therefore:
//
//   1. NOT import or call the removed `createHarness`.
//   2. Import `requireAgentPlugin` from `@harms-haus/engin-engine`.
//   3. Still import `loadProfilesFromDirs`, `promptForStructured`, and
//      `resolveProfilesDirs` (these are unchanged).
//   4. Obtain its session via
//      `requireAgentPlugin(profile.agent).createSession({ profile, cwd })`.
//   5. Keep the surrounding `try { ... } finally { session.dispose(); }` block.
//   6. Keep the `promptForStructured(session, ...)` usage unchanged.
//
// These assertions are written test-first against the markdown file so they are
// RED until the documentation is updated, and GREEN once it references the
// correct, compilable API surface.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GUIDE_PATH = resolve(import.meta.dir, '../../docs/guides/getting-started.md');

const guide = readFileSync(GUIDE_PATH, 'utf-8');

/** Extract the first fenced ```typescript block from the markdown. */
function extractFirstTsBlock(markdown: string): string {
  const match = markdown.match(/```typescript\n([\s\S]*?)```/);
  if (!match || match[1] === undefined) {
    throw new Error('No fenced ```typescript code block found in getting-started.md');
  }
  return match[1];
}

const tsBlock = extractFirstTsBlock(guide);

describe('docs/guides/getting-started.md — Programmatic quick start', () => {
  describe('removed createHarness API', () => {
    it('does not import createHarness', () => {
      // The import of the removed symbol must be gone entirely.
      expect(tsBlock).not.toContain('createHarness');
    });

    it('does not call createHarness', () => {
      expect(tsBlock).not.toMatch(/\bcreateHarness\s*\(/);
    });

    it('does not destructure { session, dispose } from createHarness', () => {
      // The old shape was `const { session, dispose } = await createHarness(...)`.
      // That destructuring must no longer reference createHarness.
      expect(tsBlock).not.toMatch(/createHarness/);
    });
  });

  describe('imports from @harms-haus/engin-engine', () => {
    it('imports requireAgentPlugin', () => {
      expect(tsBlock).toContain('requireAgentPlugin');
    });

    it('still imports loadProfilesFromDirs', () => {
      expect(tsBlock).toContain('loadProfilesFromDirs');
    });

    it('still imports promptForStructured', () => {
      expect(tsBlock).toContain('promptForStructured');
    });

    it('still imports resolveProfilesDirs', () => {
      expect(tsBlock).toContain('resolveProfilesDirs');
    });

    it('imports the four expected symbols from @harms-haus/engin-engine', () => {
      // The import block should declare all four value imports from the engine
      // entry point and must not list createHarness.
      const importBlockMatch = tsBlock.match(/import\s*\{([^}]*)\}\s*from\s*['"]@harms-haus\/engin-engine['"]/);
      expect(importBlockMatch, 'expected an engine import block').not.toBeNull();
      const importBlock = importBlockMatch![1];

      for (const symbol of [
        'requireAgentPlugin',
        'loadProfilesFromDirs',
        'promptForStructured',
        'resolveProfilesDirs',
      ]) {
        expect(importBlock).toContain(symbol);
      }
      expect(importBlock).not.toContain('createHarness');
    });
  });

  describe('session creation via the plugin system', () => {
    it('resolves the plugin via requireAgentPlugin(profile.agent)', () => {
      expect(tsBlock).toContain('requireAgentPlugin(profile.agent)');
    });

    it('calls createSession with { profile, cwd }', () => {
      // The documented call is:
      //   const session = await requireAgentPlugin(profile.agent)
      //     .createSession({ profile, cwd });
      // We assert both the awaited assignment to `session` and the createSession
      // argument shape, allowing for line-wrapping.
      expect(tsBlock).toMatch(/createSession\s*\(\s*\{\s*profile\s*,\s*cwd\s*\}\s*\)/);
    });

    it('assigns the session to a `session` variable', () => {
      // The example must keep a `session` binding so that the try/finally +
      // promptForStructured calls below compile against it.
      expect(tsBlock).toMatch(/const\s+session\s*=\s*await\s+requireAgentPlugin/);
    });
  });

  describe('unchanged surrounding structure', () => {
    it('keeps the try/finally with session.dispose()', () => {
      expect(tsBlock).toMatch(/try\s*\{/);
      expect(tsBlock).toMatch(/finally\s*\{/);
      expect(tsBlock).toContain('session.dispose()');
    });

    it('keeps the promptForStructured(session, ...) usage', () => {
      expect(tsBlock).toMatch(/promptForStructured\s*\(\s*session\s*,/);
    });

    it('does not call a standalone dispose() free variable', () => {
      // The old createHarness returned `{ session, dispose }` and the finally
      // block called `dispose();` directly. The new shape returns a session,
      // so disposal goes through `session.dispose()`. There must be no bare
      // `dispose();` statement on its own line (note: `session.dispose()` is
      // a method call and is expected).
      expect(tsBlock).not.toMatch(/^\s*dispose\s*\(\s*\)\s*;?\s*$/m);
    });

    it('does not destructure a dispose binding from the session factory', () => {
      // The old line was `const { session, dispose } = await createHarness(...)`.
      // The new factory returns the session directly, so no `dispose` variable
      // is bound from it.
      expect(tsBlock).not.toMatch(/\{[^}]*\bdispose\b[^}]*\}\s*=\s*await/);
    });
  });

  describe('guide-level references', () => {
    it('the Programmatic quick start section still exists', () => {
      expect(guide).toContain('## Programmatic quick start');
    });

    it('no longer mentions createHarness anywhere in the guide', () => {
      // After the fix, the removed symbol should not appear anywhere in the
      // Getting Started guide — not in prose, not in code.
      expect(guide).not.toContain('createHarness');
    });
  });
});
