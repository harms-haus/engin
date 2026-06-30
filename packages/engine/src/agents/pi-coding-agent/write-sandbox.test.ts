// ─── Tests for write-sandbox bash `cd` confinement ───────────────────────────
//
// The write-sandbox extension blocks `write`/`edit` whose target resolves
// outside the allowed dirs, and ALSO blocks `bash` commands whose `cd`/`pushd`
// target resolves outside. The bash guard exists because an agent can otherwise
// `cd` out of the worktree and write via `sed`/`cat`/Python/redirects, bypassing
// the path check.
//
// These tests exercise the pure parsing helpers (`splitSimpleCommands`,
// `shellWords`) and the end-to-end `findEscapingCdTarget` scanner against the
// real on-disk layout, so symlink/`..` resolution is exercised truthfully.

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findEscapingCdTarget, resolveAllowedDirs, shellWords, splitSimpleCommands } from './write-sandbox.js';

// ─── Fixture ────────────────────────────────────────────────────────────────
//
// A real temp layout so `canonicalizePath` (realpathSync) resolves truthfully:
//
//   <root>/worktree/        ← the sandbox / session cwd
//   <root>/main-repo/       ← a sibling OUTSIDE the sandbox (the leak target)
//   <root>/worktree/evil-link → symlink → main-repo (in-sandbox link pointing OUT)

const root = mkdtempSync(join(tmpdir(), 'ws-cd-'));
const worktree = join(root, 'worktree');
const mainRepo = join(root, 'main-repo');
mkdirSync(worktree, { recursive: true });
mkdirSync(mainRepo, { recursive: true });
mkdirSync(join(worktree, 'sub'), { recursive: true });
// A symlink INSIDE the worktree that points to a directory OUTSIDE it —
// canonicalization must reveal the real (outside) target and block it.
symlinkSync(mainRepo, join(worktree, 'evil-link'));

const allowed = resolveAllowedDirs([worktree], worktree);

// ─── splitSimpleCommands ────────────────────────────────────────────────────

describe('splitSimpleCommands', () => {
  it('splits on && , || , ; , | , newlines, and parentheses', () => {
    expect(splitSimpleCommands('cd /a && cd /b')).toEqual(['cd /a', 'cd /b']);
    expect(splitSimpleCommands('cd /a || cd /b')).toEqual(['cd /a', 'cd /b']);
    expect(splitSimpleCommands('cd /a; cd /b')).toEqual(['cd /a', 'cd /b']);
    expect(splitSimpleCommands('cd /a | cd /b')).toEqual(['cd /a', 'cd /b']);
    expect(splitSimpleCommands('cd /a\ncd /b')).toEqual(['cd /a', 'cd /b']);
    expect(splitSimpleCommands('(cd /a)')).toEqual(['cd /a']);
  });

  it('does not split on operators inside quotes', () => {
    expect(splitSimpleCommands('cd "a && b"')).toEqual(['cd "a && b"']);
    expect(splitSimpleCommands("echo 'x | y' && cd /a")).toEqual(["echo 'x | y'", 'cd /a']);
  });

  it('respects backslash escapes outside quotes', () => {
    expect(splitSimpleCommands('cd a\\&b && cd /c')).toEqual(['cd a\\&b', 'cd /c']);
  });
});

// ─── shellWords ─────────────────────────────────────────────────────────────

describe('shellWords', () => {
  it('splits on whitespace', () => {
    expect(shellWords('cd /a/b')).toEqual(['cd', '/a/b']);
  });

  it('preserves spaces inside quotes', () => {
    expect(shellWords('cd "my dir"')).toEqual(['cd', 'my dir']);
    expect(shellWords("cd 'my dir'")).toEqual(['cd', 'my dir']);
  });

  it('handles backslash escapes inside double quotes', () => {
    // \" inside dquotes → literal "
    expect(shellWords('cd "a\\"b"')).toEqual(['cd', 'a"b']);
  });

  it('leaves $VAR / $(...) literals unexpanded', () => {
    expect(shellWords('cd $HOME')).toEqual(['cd', '$HOME']);
    expect(shellWords('cd $(pwd)')).toEqual(['cd', '$(pwd)']);
  });
});

// ─── findEscapingCdTarget — allowed cases ───────────────────────────────────

describe('findEscapingCdTarget — allowed', () => {
  it('returns null when there is no cd', () => {
    expect(findEscapingCdTarget('ls -la', allowed, worktree)).toBeNull();
    expect(findEscapingCdTarget('bun test packages/x', allowed, worktree)).toBeNull();
  });

  it('allows cd into a subdirectory of the worktree', () => {
    expect(findEscapingCdTarget('cd sub && bun test', allowed, worktree)).toBeNull();
  });

  it('allows cd . and cd back via chained relatives that stay inside', () => {
    expect(findEscapingCdTarget('cd sub && cd ..', allowed, worktree)).toBeNull();
  });

  it('allows absolute cd into the worktree itself', () => {
    expect(findEscapingCdTarget(`cd ${worktree}`, allowed, worktree)).toBeNull();
  });

  it('skips bare cd and cd - (unresolvable targets)', () => {
    expect(findEscapingCdTarget('cd', allowed, worktree)).toBeNull();
    expect(findEscapingCdTarget('cd -', allowed, worktree)).toBeNull();
  });

  it('skips cd options like -P / -L before the operand', () => {
    expect(findEscapingCdTarget('cd -P sub', allowed, worktree)).toBeNull();
  });

  it('treats -- as the option terminator', () => {
    // after --, "-P-ish" would be the operand; here a real subdir.
    expect(findEscapingCdTarget('cd -- sub', allowed, worktree)).toBeNull();
  });
});

// ─── findEscapingCdTarget — escaping cases ──────────────────────────────────

describe('findEscapingCdTarget — escaping', () => {
  it('blocks absolute cd into a sibling outside the sandbox', () => {
    const got = findEscapingCdTarget(`cd ${mainRepo} && cat > x`, allowed, worktree);
    expect(got).not.toBeNull();
    expect(got!.raw).toBe(mainRepo);
    expect(got!.resolved).toBe(mainRepo);
  });

  it('blocks the exact leak pattern observed in the wild (cd main-repo && python rewrite)', () => {
    const cmd = `cd ${mainRepo} && cat > /tmp/patch.py << 'EOF' && python3 /tmp/patch.py`;
    const got = findEscapingCdTarget(cmd, allowed, worktree);
    expect(got).not.toBeNull();
    expect(got!.raw).toBe(mainRepo);
  });

  it('blocks relative cd that escapes above the worktree (..)', () => {
    const got = findEscapingCdTarget('cd ..', allowed, worktree);
    expect(got).not.toBeNull();
    expect(got!.resolved).toBe(join(worktree, '..'));
  });

  it('blocks cd via ../sibling', () => {
    const got = findEscapingCdTarget('cd ../main-repo', allowed, worktree);
    expect(got).not.toBeNull();
  });

  it('blocks pushd to an outside path', () => {
    const got = findEscapingCdTarget(`pushd ${mainRepo}`, allowed, worktree);
    expect(got).not.toBeNull();
    expect(got!.raw).toBe(mainRepo);
  });

  it('blocks a quoted outside target', () => {
    const got = findEscapingCdTarget(`cd "${mainRepo}"`, allowed, worktree);
    expect(got).not.toBeNull();
    expect(got!.raw).toBe(mainRepo);
  });

  it('reports the FIRST escaping cd when multiple are present', () => {
    const got = findEscapingCdTarget(`cd ${mainRepo} && cd ${worktree}`, allowed, worktree);
    expect(got).not.toBeNull();
    expect(got!.raw).toBe(mainRepo);
  });

  it('blocks an in-sandbox symlink whose real target is outside', () => {
    // `evil-link` lives inside the worktree but points at the outside main-repo;
    // canonicalization follows the symlink and blocks the real target. The
    // reported `resolved` is the lexical path (what the agent typed); the
    // containment check uses the canonicalized real target internally.
    const got = findEscapingCdTarget('cd evil-link', allowed, worktree);
    expect(got).not.toBeNull();
    expect(got!.resolved).toBe(join(worktree, 'evil-link'));
  });

  it('resolves chained relatives left-to-right so escapes are caught', () => {
    // sub is inside; ../../main-repo climbs above the worktree root to the
    // outside sibling. Two `..` are required — one `..` lands back inside.
    const got = findEscapingCdTarget('cd sub && cd ../../main-repo', allowed, worktree);
    expect(got).not.toBeNull();
    expect(got!.resolved).toBe(join(join(worktree, 'sub'), '..', '..', 'main-repo'));
  });
});
