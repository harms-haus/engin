// ─── Tests for core/path-relativizer.ts — recursive path relativization ─────
//
// Validates the `relativizePathsIn` utility that rewrites absolute worktree
// paths inside structured values (strings, objects, arrays) to their
// repo-relative tails. This is the produce-side transform applied at every
// result-capture seam so that paths crossing task boundaries never leak
// absolute worktree locations.
//
// Full implementation; all assertions PASS.

import { describe, expect, it } from 'bun:test';

import { relativizePathsIn } from './path-relativizer.js';

// ── Root used across most tests ─────────────────────────────────────────────

const ROOT = '/wt/foo';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('relativizePathsIn', () => {
  // ── Basic string stripping ───────────────────────────────────────────────

  it('strips a single-root prefix from an absolute path', () => {
    expect(relativizePathsIn('/wt/foo/src/a.ts', [ROOT])).toBe('src/a.ts');
  });

  it('returns "." when the string exactly equals the root', () => {
    expect(relativizePathsIn('/wt/foo', [ROOT])).toBe('.');
  });

  // ── Longest-root-first ───────────────────────────────────────────────────

  it('applies the deepest (longest) matching root first', () => {
    const roots = ['/wt/foo', '/wt/foo/task-x'];

    // Deeper root wins: /wt/foo/task-x/src/b.ts → src/b.ts (not task-x/src/b.ts)
    expect(relativizePathsIn('/wt/foo/task-x/src/b.ts', roots)).toBe('src/b.ts');

    // Shallower root applies for paths outside the deeper root
    expect(relativizePathsIn('/wt/foo/other.ts', roots)).toBe('other.ts');
  });

  // ── Boundary safety ──────────────────────────────────────────────────────

  it('does NOT corrupt a path that only shares a prefix (no trailing /)', () => {
    // /wt/foobar does NOT start with /wt/foo/ (the trailing slash is critical)
    expect(relativizePathsIn('/wt/foobar/baz.ts', [ROOT])).toBe('/wt/foobar/baz.ts');
  });

  it('does NOT match a path that shares a partial directory name', () => {
    expect(relativizePathsIn('/wt/fo/a.ts', [ROOT])).toBe('/wt/fo/a.ts');
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it('is idempotent: applying twice yields the same result as applying once', () => {
    const input = {
      absolute: '/wt/foo/src/main.ts',
      already: 'src/other.ts',
      nested: { deep: '/wt/foo/lib/util.ts' },
    };
    const once = relativizePathsIn(input, [ROOT]) as typeof input;
    const twice = relativizePathsIn(once, [ROOT]) as typeof input;
    expect(twice).toStrictEqual(once);
  });

  // ── Already-relative / no-match pass-through ──────────────────────────────

  it('leaves already-relative paths untouched', () => {
    expect(relativizePathsIn('src/a.ts', [ROOT])).toBe('src/a.ts');
  });

  it('leaves arbitrary non-path strings untouched', () => {
    expect(relativizePathsIn('not-a-path', [ROOT])).toBe('not-a-path');
  });

  it('leaves URLs untouched', () => {
    expect(relativizePathsIn('http://x/y', [ROOT])).toBe('http://x/y');
  });

  // ── Non-string leaves pass through ───────────────────────────────────────

  it('passes through numeric values', () => {
    expect(relativizePathsIn(42, [ROOT])).toBe(42);
  });

  it('passes through boolean values', () => {
    expect(relativizePathsIn(true, [ROOT])).toBe(true);
  });

  it('passes through null', () => {
    expect(relativizePathsIn(null, [ROOT])).toBeNull();
  });

  it('passes through undefined', () => {
    expect(relativizePathsIn(undefined, [ROOT])).toBeUndefined();
  });

  // ── Nested objects ───────────────────────────────────────────────────────

  it('recursively relativizes paths in nested objects', () => {
    const input = { file: '/wt/foo/x.ts', meta: { path: '/wt/foo/sub/y.ts' } };
    expect(relativizePathsIn(input, [ROOT])).toStrictEqual({
      file: 'x.ts',
      meta: { path: 'sub/y.ts' },
    });
  });

  // ── Arrays ───────────────────────────────────────────────────────────────

  it('recursively relativizes paths in arrays', () => {
    const input = ['/wt/foo/a.ts', 'not-a-path', '/wt/foo/b.ts'];
    expect(relativizePathsIn(input, [ROOT])).toStrictEqual(['a.ts', 'not-a-path', 'b.ts']);
  });

  // ── Empty roots array ────────────────────────────────────────────────────

  it('returns input unchanged when roots array is empty', () => {
    const input = { file: '/wt/foo/a.ts', items: ['/wt/foo/b.ts', 42] };
    const result = relativizePathsIn(input, []);
    expect(result).toStrictEqual(input);
  });

  // ── Input is NOT mutated ─────────────────────────────────────────────────

  it('does not mutate the original input object', () => {
    const input = { file: '/wt/foo/x.ts', meta: { path: '/wt/foo/sub/y.ts' } };
    const original = JSON.parse(JSON.stringify(input));
    relativizePathsIn(input, [ROOT]);
    expect(input).toStrictEqual(original);
  });

  it('does not mutate the original input array', () => {
    const input = ['/wt/foo/a.ts', 'not-a-path', '/wt/foo/b.ts'];
    const original = [...input];
    relativizePathsIn(input, [ROOT]);
    expect(input).toStrictEqual(original);
  });

  // ── Non-plain objects are NOT recursed ───────────────────────────────────

  it('does not recurse into non-plain objects (Date / class instances)', () => {
    const inst = Object.assign(new Date(0), { path: '/wt/foo/x.ts' });
    expect(relativizePathsIn(inst, [ROOT])).toBe(inst); // same reference, not recursed
  });
});
