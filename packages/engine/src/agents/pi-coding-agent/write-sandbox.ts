// ─── Write Sandbox ──────────────────────────────────────────────────────────
//
// A pi `tool_call` extension that confines filesystem-mutating tools (`write`,
// `edit`) to a set of allowed directories, AND blocks `bash` commands whose
// `cd` target resolves outside the sandbox. Without the bash guard, an agent
// can simply `cd` out of the worktree and write via `sed -i`, `cat >`, a
// Python `open(...,'w')`, or any redirect — bypassing the `write`/`edit`
// path check entirely.
//
// When an agent attempts a write/edit outside the sandbox, or runs a bash
// command that `cd`s outside it, the call is blocked and the reason is
// returned to the model as an error tool result — so the agent can correct
// course and retry inside the sandbox instead of silently failing.
//
// Path resolution mirrors pi's built-in write/edit tools for the initial
// lexical resolution (expand `~`, strip a single leading `@`, resolve relatives
// against the agent cwd). The sandbox then additionally canonicalizes both the
// target and the allowed-dir boundaries with `fs.realpathSync` so that symlinks
// pointing outside an allowed dir cannot be used to escape confinement — the
// containment decision reflects the real on-disk target rather than the lexical
// path the tool was invoked with.
//
// Limitations of the bash guard: it inspects literal `cd`/`pushd` targets and
// does NOT expand shell variables or command substitution. A `cd $VAR` or
// `cd $(...)` whose expansion escapes the sandbox is not caught by this layer
// — true confinement requires an OS-level sandbox (landlock/bwrap) around the
// session process. This guard closes the common, accidental `cd <abs-path>`
// leak (the failure mode observed in practice).

import type { ExtensionFactory, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

/** Built-in tools that mutate a single file via a `path` argument. */
const SANDBOXED_TOOLS = new Set<string>(['write', 'edit']);

/** Shell builtins that change the process working directory. */
const CD_BUILTINS = new Set<string>(['cd', 'pushd']);

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

// ─── Bash `cd` target extraction ────────────────────────────────────────────
//
// Parses a bash command string to find `cd`/`pushd` targets that resolve
// outside the sandbox. The parser is a best-effort lexical scan: it splits the
// command into simple commands at unquoted shell control operators, then for
// each simple command whose first word is `cd`/`pushd` it extracts the first
// non-option argument (the directory operand). Quoted spans and backslash
// escapes are respected at both levels so paths containing spaces or literal
// operators survive. Relative targets resolve left-to-right against the running
// cwd (starting at the session cwd), so `cd sub && cd ..` is analyzed in the
// context the shell would actually evaluate.

/**
 * Split a bash command string into "simple command" segments at unquoted shell
 * control operators (`&&`, `||`, `;`, `|`, `&`, newlines, `(`, `)`, backticks).
 * Quoted spans and backslash escapes are passed through verbatim so operators
 * inside quotes do not split. Operator characters are dropped from segments.
 */
export function splitSimpleCommands(command: string): string[] {
  const segments: string[] = [];
  let cur = '';
  let i = 0;
  const flush = (): void => {
    const trimmed = cur.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    cur = '';
  };
  while (i < command.length) {
    const ch = command[i];
    // Pass through quoted spans verbatim (track closes, escapes inside dquotes).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      cur += ch;
      i++;
      while (i < command.length) {
        const c = command[i];
        if (c === '\\' && quote === '"' && i + 1 < command.length) {
          cur += c + command[i + 1];
          i += 2;
          continue;
        }
        cur += c;
        i++;
        if (c === quote) break;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += ch + command[i + 1];
      i += 2;
      continue;
    }
    // Two-char operators first so `&&` is not seen as two `&`.
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      flush();
      i += 2;
      continue;
    }
    if (
      ch === ';' ||
      ch === '|' ||
      ch === '&' ||
      ch === '\n' ||
      ch === '\r' ||
      ch === '(' ||
      ch === ')' ||
      ch === '`'
    ) {
      flush();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return segments;
}

/**
 * Tokenize a simple-command segment into shell words, honoring single/double
 * quotes and backslash escapes. `$VAR` / `${VAR}` / `$(...)` are NOT expanded —
 * the literal text is returned (see the module header limitation note).
 */
export function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur = '';
  let hasCur = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasCur) {
        words.push(cur);
        cur = '';
        hasCur = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      hasCur = true;
      const quote = ch;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && quote === '"' && i + 1 < s.length) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += s[i];
        i++;
      }
      i++; // skip closing quote (or end of string)
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) {
      hasCur = true;
      cur += s[i + 1];
      i += 2;
      continue;
    }
    hasCur = true;
    cur += ch;
    i++;
  }
  if (hasCur) words.push(cur);
  return words;
}

/**
 * From the word list of a simple command, return the directory operand of a
 * `cd`/`pushd` invocation: the first non-option argument after any options
 * (and after a `--` terminator). Returns `undefined` for a bare `cd`, `cd -`
 * (previous directory), or `cd --` — these targets cannot be lexically resolved
 * and are left for the caller to skip.
 */
function cdDirectoryOperand(words: string[]): string | undefined {
  // Skip leading env-var assignments (`FOO=bar cd /x`).
  let idx = 0;
  while (idx < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[idx])) idx++;
  if (idx >= words.length || !CD_BUILTINS.has(words[idx])) return undefined;

  let j = idx + 1;
  let sawDashDash = false;
  while (j < words.length) {
    const w = words[j];
    if (!sawDashDash && w === '--') {
      sawDashDash = true;
      j++;
      continue;
    }
    // An option token like `-P`/`-L` (but NOT the single `-`, which is OLDPWD).
    if (!sawDashDash && w.startsWith('-') && w.length > 1) {
      j++;
      continue;
    }
    break; // first non-option word — this is the directory operand (or `-`).
  }
  const target = words[j];
  if (target === undefined || target === '' || target === '-') return undefined;
  return target;
}

/**
 * Decide whether a `cd`/`pushd` target (already resolved to an absolute path)
 * is permitted by the sandbox. Uses canonicalized containment like the
 * write/edit check, but falls back to lexical resolution when the target (or
 * its parent) does not yet exist — `cd` into a not-yet-existing directory
 * inside the sandbox is harmless (bash will error) and must not be a false
 * positive.
 */
function isCdTargetAllowed(resolvedTarget: string, resolvedAllowedDirs: string[]): boolean {
  let checkPath: string;
  try {
    checkPath = canonicalizePath(resolvedTarget);
  } catch {
    checkPath = resolvedTarget; // leaf + parent missing — best-effort lexical check.
  }
  for (const dir of resolvedAllowedDirs) {
    if (isPathWithin(checkPath, dir)) return true;
  }
  return false;
}

/**
 * Scan a bash command string for the first `cd`/`pushd` target that resolves
 * outside `resolvedAllowedDirs`. Relative targets resolve left-to-right against
 * a running cwd (starting at `cwd`) so chained `cd`s are analyzed in context.
 * Returns the first escaping target (raw + resolved) or `null` when every `cd`
 * stays inside the sandbox (or there are none).
 */
export function findEscapingCdTarget(
  command: string,
  resolvedAllowedDirs: string[],
  cwd: string,
): { raw: string; resolved: string } | null {
  let currentCwd = cwd;
  for (const segment of splitSimpleCommands(command)) {
    const words = shellWords(segment);
    const raw = cdDirectoryOperand(words);
    if (raw === undefined) continue;

    const resolved = resolveToolPath(raw, currentCwd);
    if (isCdTargetAllowed(resolved, resolvedAllowedDirs)) {
      // Allowed: advance the running cwd so a later relative `cd` resolves
      // from here (mirrors shell semantics, avoids false positives like
      // `cd sub && cd ..`).
      currentCwd = resolved;
      continue;
    }
    return { raw, resolved };
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

/** Extract the `command` argument from a bash tool call. Returns `undefined` when not inspectable. */
function readCommandArg(event: ToolCallEvent): string | undefined {
  if (isToolCallEventType('bash', event)) {
    return event.input.command;
  }
  // Defensive: a custom tool shadowing the `bash` name with a different shape.
  const rawCommand = (event as { input?: { command?: unknown } }).input?.command;
  return typeof rawCommand === 'string' ? rawCommand : undefined;
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
      // `write`/`edit`: confine the target `path` to the allowed dirs.
      if (SANDBOXED_TOOLS.has(event.toolName)) {
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
      }

      // `bash`: block commands that `cd`/`pushd` to a target outside the
      // sandbox. Without this, an agent can `cd` out of the worktree and write
      // via `sed`/`cat`/Python/redirects, bypassing the path check above.
      if (event.toolName === 'bash') {
        const command = readCommandArg(event);
        if (command == null) return; // nothing to inspect — let the tool itself validate

        const escape = findEscapingCdTarget(command, resolvedAllowed, cwd);
        if (escape === null) return;

        return {
          block: true,
          reason:
            `Refused: bash command changes directory (cd/pushd) to "${escape.raw}" ` +
            `(${escape.resolved}), which is outside the allowed sandbox. Run commands ` +
            `from the session working directory (${cwd}); you may only cd within: ` +
            `${resolvedAllowed.join(', ')}.`,
        };
      }
    });
  };
}
