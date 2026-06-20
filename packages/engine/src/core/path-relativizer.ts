// ─── Path relativizer ──────────────────────────────────────────────────────
//
// Recursively rewrites absolute worktree paths inside structured values
// (strings, plain objects, arrays) to their repo-relative tails. This is the
// produce-side transform applied at every result-capture seam so that paths
// crossing task boundaries never leak absolute worktree locations.

/**
 * Recursively rewrite absolute worktree paths inside `value` to their
 * repo-relative tails. For every STRING leaf:
 *   - if it === root  -> replace with '.'   (exact-root self-reference)
 *   - else if it startsWith(root + '/') -> replace with the portion after root+'/' (posix '/')
 *   - otherwise leave it untouched.
 * Roots are deduped + sorted by length DESCENDING internally so a deeper root
 * wins over a shallower one. Only ONE root applies per string (first match).
 * Non-string leaves pass through; objects/arrays recursed (return NEW values,
 * do NOT mutate input). Idempotent: re-applying is a no-op.
 *
 * Assumes acyclic, JSON-shaped input; cycles are not detected and would
 * overflow the stack.
 */
export function relativizePathsIn(value: unknown, roots: string[]): unknown {
  // Dedupe + sort roots by length DESCENDING so the deepest (longest) matching
  // root wins. Only one root applies per string (first match after sort).
  const sortedRoots = Array.from(new Set(roots)).sort((a, b) => b.length - a.length);
  return relativize(value, sortedRoots);
}

/**
 * Returns true when `value` is a plain object (created by `{}` / `new Object()`
 * or `Object.create(null)`), i.e. an object whose prototype is either `null`
 * or `Object.prototype`. Arrays, class instances, dates, maps, etc. are NOT
 * plain objects.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Recursive core. Returns NEW containers for arrays/objects; never mutates
 * `value`. Non-string, non-container leaves pass through by reference/value.
 */
function relativize(value: unknown, roots: string[]): unknown {
  if (typeof value === 'string') {
    return relativizeString(value, roots);
  }
  if (Array.isArray(value)) {
    return value.map((item) => relativize(item, roots));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = relativize(value[key], roots);
    }
    return out;
  }
  return value;
}

/**
 * Apply the first matching root to a single string leaf. Boundary match is
 * start-of-string ONLY: exact equality OR `root + '/'` prefix. A bare substring
 * match mid-path MUST NOT apply (hence the trailing slash). Uses posix `/`
 * literally — no node:path.sep, no normalization.
 */
function relativizeString(s: string, roots: string[]): string {
  // Empty-string leaf is never a path — leave it untouched (per spec).
  if (s === '') return s;
  for (const root of roots) {
    if (s === root) return '.';
    const prefix = root + '/';
    if (s.startsWith(prefix)) return s.slice(prefix.length);
  }
  return s;
}
