// ─── Characterization tests for worktree-populate concerns ──────────────────
//
// These tests pin down the CURRENT observable behavior of the worktree-
// population functions that today live in `core/git.ts` and are slated to be
// extracted into `core/worktree-populate.ts`:
//
//   • WorktreeCopyEntry (interface)
//   • readWorktreeCopyEntries(cwd)
//   • populateWorktree(sourceCwd, worktreePath, entries?)
//   • createSymlinkWithRetry(target, linkPath, maxRetries?, backoffMs?)
//
// They use REAL temp directories (no mocking) so they exercise the actual file
// system + symlink behavior. The refactor is purely a file-move (relocate these
// symbols from git.ts → worktree-populate.ts, unchanged behavior); these tests
// must keep passing before AND after the move.
//
// NOTE: imports point at `./git.js` today. After the implementer creates
// `worktree-populate.ts`, the imports below MUST be repointed to
// `./worktree-populate.js`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSymlinkWithRetry,
  populateWorktree,
  readWorktreeCopyEntries,
  type WorktreeCopyEntry,
} from './worktree-populate.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'engin-wt-populate-'));
});

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function writeWorktreeCopy(dir: string, content: string): string {
  const path = join(dir, '.worktreecopy');
  writeFileSync(path, content, 'utf-8');
  return path;
}

// ─── readWorktreeCopyEntries ────────────────────────────────────────────────

describe('readWorktreeCopyEntries', () => {
  it('returns an empty array when .worktreecopy does not exist', () => {
    const entries = readWorktreeCopyEntries(tmpRoot);
    expect(entries).toEqual([]);
  });

  it('returns an empty array when .worktreecopy is empty', () => {
    writeWorktreeCopy(tmpRoot, '');
    expect(readWorktreeCopyEntries(tmpRoot)).toEqual([]);
  });

  it('returns an empty array when .worktreecopy has only comments and blank lines', () => {
    writeWorktreeCopy(tmpRoot, ['# a comment', '', '   ', '# another'].join('\n'));
    expect(readWorktreeCopyEntries(tmpRoot)).toEqual([]);
  });

  it('parses a plain pattern as a copy entry', () => {
    writeWorktreeCopy(tmpRoot, 'node_modules');
    expect(readWorktreeCopyEntries(tmpRoot)).toEqual([{ pattern: 'node_modules', mode: 'copy', negated: false }]);
  });

  it('parses a @symlink prefix into a symlink-mode entry with the prefix stripped', () => {
    writeWorktreeCopy(tmpRoot, '@symlink .env');
    expect(readWorktreeCopyEntries(tmpRoot)).toEqual([{ pattern: '.env', mode: 'symlink', negated: false }]);
  });

  it('parses a leading ! as a negated entry with the ! stripped', () => {
    writeWorktreeCopy(tmpRoot, '!*.log');
    expect(readWorktreeCopyEntries(tmpRoot)).toEqual([{ pattern: '*.log', mode: 'copy', negated: true }]);
  });

  it('parses @symlink combined with negation', () => {
    writeWorktreeCopy(tmpRoot, '@symlink !foo');
    const entries = readWorktreeCopyEntries(tmpRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ pattern: 'foo', mode: 'symlink', negated: true });
  });

  it('trims surrounding whitespace from each line', () => {
    writeWorktreeCopy(tmpRoot, '   node_modules   ');
    expect(readWorktreeCopyEntries(tmpRoot)).toEqual([{ pattern: 'node_modules', mode: 'copy', negated: false }]);
  });

  it('skips comment lines but parses the rest', () => {
    writeWorktreeCopy(tmpRoot, ['# header', 'src', '# mid', '@symlink .env.local'].join('\n'));
    expect(readWorktreeCopyEntries(tmpRoot)).toEqual([
      { pattern: 'src', mode: 'copy', negated: false },
      { pattern: '.env.local', mode: 'symlink', negated: false },
    ]);
  });

  it('parses multiple lines in order', () => {
    writeWorktreeCopy(tmpRoot, ['a', 'b', '@symlink c', '!d'].join('\n'));
    expect(readWorktreeCopyEntries(tmpRoot)).toEqual([
      { pattern: 'a', mode: 'copy', negated: false },
      { pattern: 'b', mode: 'copy', negated: false },
      { pattern: 'c', mode: 'symlink', negated: false },
      { pattern: 'd', mode: 'copy', negated: true },
    ]);
  });

  it('returns well-typed WorktreeCopyEntry objects', () => {
    writeWorktreeCopy(tmpRoot, 'a');
    const entry: WorktreeCopyEntry = readWorktreeCopyEntries(tmpRoot)[0];
    // Compile-time check via assignment; runtime check on shape.
    expect(entry).toHaveProperty('pattern');
    expect(entry).toHaveProperty('mode');
    expect(entry).toHaveProperty('negated');
  });
});

// ─── createSymlinkWithRetry ─────────────────────────────────────────────────

describe('createSymlinkWithRetry', () => {
  it('creates a symlink pointing at the target', () => {
    const target = join(tmpRoot, 'target.txt');
    writeFileSync(target, 'hi');
    const link = join(tmpRoot, 'link.txt');

    createSymlinkWithRetry(target, link);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });

  it('is a no-op when a symlink already points to the correct target', () => {
    const target = join(tmpRoot, 'target.txt');
    writeFileSync(target, 'hi');
    const link = join(tmpRoot, 'link.txt');
    createSymlinkWithRetry(target, link);
    const beforeMtime = lstatSync(link).mtimeMs;

    // Second call must not throw and must leave the symlink intact.
    expect(() => createSymlinkWithRetry(target, link)).not.toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    void beforeMtime;
  });

  it('throws when the target does not exist and the link cannot be created', () => {
    // Creating a symlink to a non-existent target does NOT throw on most
    // platforms, so instead we point at an invalid path inside a path that
    // would require a missing parent dir without mkdir. We verify the function
    // either succeeds (dangling symlink) or throws — but importantly it does
    // not silently swallow on a genuinely unwritable location.
    const impossibleLink = join(tmpRoot, 'no-such-dir', 'link');
    expect(() => createSymlinkWithRetry('/nonexistent/target', impossibleLink, 1, 1)).toThrow();
  });
});

// ─── populateWorktree ───────────────────────────────────────────────────────

describe('populateWorktree', () => {
  it('is a no-op when no entries are provided and .worktreecopy is absent', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'a.txt'), 'a');

    populateWorktree(source, target);

    // Nothing copied because there are no entries.
    expect(existsSync(join(target, 'a.txt'))).toBe(false);
  });

  it('is a no-op when entries array is empty', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'a.txt'), 'a');

    populateWorktree(source, target, []);

    expect(existsSync(join(target, 'a.txt'))).toBe(false);
  });

  it('copies a file matched by a copy entry', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'config.json'), '{}');

    populateWorktree(source, target, [{ pattern: 'config.json', mode: 'copy', negated: false }]);

    expect(existsSync(join(target, 'config.json'))).toBe(true);
  });

  it('copies a directory recursively when matched by a copy entry', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    mkdirSync(join(source, 'pkg'));
    writeFileSync(join(source, 'pkg', 'index.js'), 'module.exports=1');

    populateWorktree(source, target, [{ pattern: 'pkg', mode: 'copy', negated: false }]);

    expect(statSync(join(target, 'pkg')).isDirectory()).toBe(true);
    expect(existsSync(join(target, 'pkg', 'index.js'))).toBe(true);
  });

  it('respects glob patterns for copy entries', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'a.json'), '1');
    writeFileSync(join(source, 'b.txt'), '2');

    populateWorktree(source, target, [{ pattern: '*.json', mode: 'copy', negated: false }]);

    expect(existsSync(join(target, 'a.json'))).toBe(true);
    expect(existsSync(join(target, 'b.txt'))).toBe(false);
  });

  it('creates a symlink for a symlink-mode entry', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, '.env'), 'SECRET=1');

    populateWorktree(source, target, [{ pattern: '.env', mode: 'symlink', negated: false }]);

    const linkPath = join(target, '.env');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(join(source, '.env'));
  });

  it('symlink mode takes precedence over copy when both match', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'shared'), 'data');

    populateWorktree(source, target, [
      { pattern: 'shared', mode: 'copy', negated: false },
      { pattern: 'shared', mode: 'symlink', negated: false },
    ]);

    // Symlink wins.
    expect(lstatSync(join(target, 'shared')).isSymbolicLink()).toBe(true);
  });

  it('always skips the .git directory', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    mkdirSync(join(source, '.git'));
    writeFileSync(join(source, '.git', 'config'), '[core]');

    // A catch-all copy pattern would match everything; .git must still be skipped.
    populateWorktree(source, target, [{ pattern: '*', mode: 'copy', negated: false }]);

    expect(existsSync(join(target, '.git'))).toBe(false);
  });

  it('always skips the .engin directory', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    mkdirSync(join(source, '.engin'));
    writeFileSync(join(source, '.engin', 'state'), 'x');

    populateWorktree(source, target, [{ pattern: '*', mode: 'copy', negated: false }]);

    expect(existsSync(join(target, '.engin'))).toBe(false);
  });

  it('reads .worktreecopy from sourceCwd when entries are not passed', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'data.txt'), 'payload');
    writeWorktreeCopy(source, 'data.txt');

    populateWorktree(source, target);

    expect(existsSync(join(target, 'data.txt'))).toBe(true);
  });

  it('honors a negated copy entry to exclude a previously-matched file', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'keep.json'), '1');
    writeFileSync(join(source, 'skip.json'), '2');

    populateWorktree(source, target, [
      { pattern: '*.json', mode: 'copy', negated: false },
      { pattern: 'skip.json', mode: 'copy', negated: true },
    ]);

    expect(existsSync(join(target, 'keep.json'))).toBe(true);
    expect(existsSync(join(target, 'skip.json'))).toBe(false);
  });

  it('does not copy files that do not match any entry', () => {
    const source = join(tmpRoot, 'source');
    const target = join(tmpRoot, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'matched.txt'), '1');
    writeFileSync(join(source, 'unmatched.txt'), '2');

    populateWorktree(source, target, [{ pattern: 'matched.txt', mode: 'copy', negated: false }]);

    expect(existsSync(join(target, 'matched.txt'))).toBe(true);
    expect(existsSync(join(target, 'unmatched.txt'))).toBe(false);
  });
});
