// ─── Write Sandbox ──────────────────────────────────────────────────────────
//
// A pi `tool_call` extension that confines filesystem-mutating tools (`write`,
// `edit`) to a set of allowed directories. When an agent attempts to write or
// edit a path that resolves outside the sandbox, the call is blocked and the
// reason is returned to the model as an error tool result — so the agent can
// correct course and retry inside the sandbox instead of silently failing.
//
// Path resolution mirrors pi's built-in write/edit tools for the initial
// lexical resolution (expand `~`, strip a single leading `@`, resolve relatives
// against the agent cwd). The sandbox then additionally canonicalizes both the
// target and the allowed-dir boundaries with `fs.realpathSync` so that symlinks
// pointing outside an allowed dir cannot be used to escape confinement — the
// containment decision reflects the real on-disk target rather than the lexical
// path the tool was invoked with.

import type { ExtensionFactory, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

/** Built-in tools that mutate a single file via a `path` argument. */
const SANDBOXED_TOOLS = new Set<string>(['write', 'edit']);

// ─── Path helpers ───────────────────────────────────────────────────────────

/**
 * Resolve a tool `path` argument the same way pi's write/edit tools do.
 *
 * Mirrors `normalizePath` + `resolvePath` from
 * `@earendil-works/pi-coding-agent/dist/utils/paths`: `~` expansion, a single
 * leading `@` is stripped, and relative paths resolve against `cwd`.
 */
export function resolveToolPath(inputPath: string, cwd: string): string {
  let p = inputPath;
  if (p.startsWith('@')) p = p.slice(1);

  const home = homedir();
  if (p === '~') return home;
  if (p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\'))) {
    p = home + p.slice(1); // preserve the separator
  }

  return isAbsolute(p) ? resolvePath(p) : resolvePath(cwd, p);
}

/**
 * Canonicalize a path by following symlinks via `fs.realpathSync`.
 *
 * If the path itself does not exist (e.g. a brand-new file being created),
 * canonicalize the existing parent directory and re-append the basename, so
 * that symlinks in any ancestor component are still resolved. Any other
 * `realpathSync` failure (e.g. a missing parent, permission error) is
 * re-thrown so callers can fail closed rather than silently fall back to
 * lexical resolution.
 */
export function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch (err) {
    // ENOENT (or similar): the leaf doesn't exist yet. Canonicalize the
    // parent and re-append the basename so ancestor symlinks are resolved.
    const parent = dirname(p);
    try {
      const realParent = realpathSync(parent);
      return resolvePath(realParent, basename(p));
    } catch {
      // Parent is also missing/inaccessible — propagate the original error so
      // the caller fails closed.
      throw err;
    }
  }
}

/**
 * True when `target` is `dir` itself or lives somewhere beneath it.
 *
 * Both inputs are resolved lexically before comparison. Callers should pass
 * already-canonicalized (symlink-resolved) paths when the containment decision
 * must reflect the real on-disk location (see `canonicalizePath`).
 */
export function isPathWithin(target: string, dir: string): boolean {
  const rel = relative(resolvePath(dir), resolvePath(target));
  if (rel === '') return true; // target IS dir
  if (rel === '..') return false;
  if (rel.startsWith(`..${sep}`)) return false; // escaped above dir
  if (isAbsolute(rel)) return false; // different drive/root (Windows)
  return true;
}

/**
 * Resolve every entry in a list of allowed dirs against `cwd`, then
 * canonicalize each boundary with `fs.realpathSync` so symlink-based escapes
 * are caught by the subsequent containment check. Throws if an allowed dir
 * cannot be canonicalized (fail closed).
 */
export function resolveAllowedDirs(allowedDirs: string[], cwd: string): string[] {
  return allowedDirs.map((d) => canonicalizePath(resolveToolPath(d, cwd)));
}

/**
 * Decide whether a resolved target path is permitted by the sandbox.
 * Returns the first matching allowed dir, or `null` when denied.
 *
 * The target is canonicalized with `fs.realpathSync` (falling back to the
 * canonicalized parent + basename when the leaf doesn't yet exist) before the
 * containment check, so symlinks that escape an allowed dir are rejected. If
 * canonicalization fails for any reason, the write is denied (fail closed).
 */
export function findAllowedDir(target: string, resolvedAllowedDirs: string[]): string | null {
  let canonicalTarget: string;
  try {
    canonicalTarget = canonicalizePath(target);
  } catch {
    return null; // fail closed — cannot verify the real target
  }
  for (const dir of resolvedAllowedDirs) {
    if (isPathWithin(canonicalTarget, dir)) return dir;
  }
  return null;
}

// ─── Tool-call inspection ───────────────────────────────────────────────────

/** Extract the `path` argument from a write/edit tool call. Returns `undefined` when not inspectable. */
function readPathArg(event: ToolCallEvent): string | undefined {
  if (isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
    return event.input.path;
  }
  // Defensive: a custom tool shadowing the `write`/`edit` name with a different shape.
  const rawPath = (event as { input?: { path?: unknown } }).input?.path;
  return typeof rawPath === 'string' ? rawPath : undefined;
}

// ─── Extension factory ──────────────────────────────────────────────────────

export interface WriteSandboxOptions {
  /** Directories the agent may write/edit within. Absolute or relative to `cwd`. */
  allowedDirs: string[];
  /** The agent's working directory, used to resolve relative paths (both target and allowed dirs). */
  cwd: string;
}

/**
 * Build a pi extension factory that blocks `write`/`edit` calls whose target
 * path resolves outside `allowedDirs`.
 *
 * Install by passing the factory to a `DefaultResourceLoader` via its
 * `extensionFactories` option. The hook fires headlessly (no UI/command
 * bindings required): pi's `AgentSession` routes `tool_call` handlers through
 * the agent's `beforeToolCall` hook, and a blocked result is returned to the
 * model as an error tool result.
 */
export function createWriteSandboxExtension({ allowedDirs, cwd }: WriteSandboxOptions): ExtensionFactory {
  const resolvedAllowed = resolveAllowedDirs(allowedDirs, cwd);

  return (pi) => {
    pi.on('tool_call', (event) => {
      if (!SANDBOXED_TOOLS.has(event.toolName)) return;

      const inputPath = readPathArg(event);
      if (inputPath == null) return; // nothing to inspect — let the tool itself validate

      const resolved = resolveToolPath(inputPath, cwd);
      const allowed = findAllowedDir(resolved, resolvedAllowed);
      if (allowed !== null) return;

      return {
        block: true,
        reason:
          `Refused: path "${inputPath}" resolves outside the allowed write sandbox ` +
          `(${resolved}). You may only create or modify files under: ${resolvedAllowed.join(', ')}.`,
      };
    });
  };
}
