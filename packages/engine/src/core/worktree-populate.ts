// ─── Worktree Populate ──────────────────────────────────────────────────────
//
// Worktree-population concerns: `.worktreecopy` parsing, file copying, and
// symlink creation. These are the file-system primitives used by
// `WorktreeManager` and the default `populateWorktree` hook to seed a fresh
// worktree from the source cwd according to `.worktreecopy` rules.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import ignore from 'ignore';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Describes one parsed entry from a `.worktreecopy` file.
 */
export interface WorktreeCopyEntry {
  pattern: string;
  mode: 'copy' | 'symlink';
  negated: boolean;
}

// ─── Symlink Helpers ────────────────────────────────────────────────────────

/**
 * Creates a symlink at `linkPath` pointing to `target`, retrying on transient
 * errors (EEXIST, EPERM, etc.) with a synchronous backoff between attempts.
 *
 * If a symlink already exists at `linkPath` and points to the correct target,
 * this is a no-op.
 */
export function createSymlinkWithRetry(target: string, linkPath: string, maxRetries = 3, backoffMs = 75): void {
  // No-op when an existing symlink already points to the correct target
  try {
    if (existsSync(linkPath) && readlinkSync(linkPath) === target) {
      return;
    }
  } catch {
    // linkPath is not a symlink or does not exist — proceed to creation
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      symlinkSync(target, linkPath);
      return;
    } catch (err) {
      if (attempt < maxRetries) {
        Bun.sleepSync(backoffMs);
        continue;
      }
      throw err;
    }
  }
}

// ─── .worktreecopy Parsing ──────────────────────────────────────────────────

/**
 * Parses `.worktreecopy` from `cwd` into structured {@link WorktreeCopyEntry}s.
 *
 * - Lines starting with `@symlink ` become symlink-mode entries (prefix stripped).
 * - Lines starting with `!` become negated entries (prefix stripped).
 * - `#` comments and blank lines are skipped.
 *
 * Returns an empty array when the file does not exist.
 */
export function readWorktreeCopyEntries(cwd: string): WorktreeCopyEntry[] {
  try {
    const content = readFileSync(join(cwd, '.worktreecopy'), 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line): WorktreeCopyEntry => {
        let pattern = line;
        let mode: 'copy' | 'symlink' = 'copy';
        let negated = false;

        if (pattern.startsWith('@symlink ')) {
          mode = 'symlink';
          pattern = pattern.slice('@symlink '.length);
        }

        if (pattern.startsWith('!')) {
          negated = true;
          pattern = pattern.slice(1);
        }

        return { pattern, mode, negated };
      });
  } catch {
    return [];
  }
}

// ─── Worktree Population ────────────────────────────────────────────────────

/**
 * Populates `worktreePath` from `sourceCwd` according to `.worktreecopy` rules.
 *
 * Copy-mode entries are matched with gitignore semantics and copied (files via
 * `copyFileSync`, directories recursively via `cpSync`). Symlink-mode entries
 * are matched similarly and replaced with symlinks via {@link createSymlinkWithRetry}.
 *
 * Only the top-level entries of `sourceCwd` are considered for matching — there
 * is no recursive descent. The `.git` and `.engin` directories are always skipped.
 */
export function populateWorktree(sourceCwd: string, worktreePath: string, entries?: WorktreeCopyEntry[]): void {
  const resolvedEntries = entries ?? readWorktreeCopyEntries(sourceCwd);
  if (resolvedEntries.length === 0) {
    return;
  }

  const copyEntries = resolvedEntries.filter((entry) => entry.mode === 'copy');
  const symlinkEntries = resolvedEntries.filter((entry) => entry.mode === 'symlink');

  const copyIgnore = ignore().add(copyEntries.map((entry) => (entry.negated ? `!${entry.pattern}` : entry.pattern)));
  const symlinkIgnore = ignore().add(
    symlinkEntries.map((entry) => (entry.negated ? `!${entry.pattern}` : entry.pattern)),
  );

  for (const name of readdirSync(sourceCwd)) {
    if (name === '.git' || name === '.engin') {
      continue;
    }

    const sourceFullPath = join(sourceCwd, name);
    const targetFullPath = join(worktreePath, name);

    // Symlink mode takes precedence: matched entries become symlinks
    if (symlinkIgnore.ignores(name)) {
      mkdirSync(dirname(targetFullPath), { recursive: true });
      createSymlinkWithRetry(sourceFullPath, targetFullPath);
      continue;
    }

    // Copy mode: matched files/directories are copied (no recursive matching)
    if (copyIgnore.ignores(name)) {
      if (statSync(sourceFullPath).isDirectory()) {
        cpSync(sourceFullPath, targetFullPath, { recursive: true });
      } else {
        mkdirSync(dirname(targetFullPath), { recursive: true });
        copyFileSync(sourceFullPath, targetFullPath);
      }
    }
  }
}
