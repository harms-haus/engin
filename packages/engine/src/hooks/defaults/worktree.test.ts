// ─── RED spec for the agent-strategy hook consolidation ─────────────────────
//
// `createDefaultOnRunMergeConflict` (workflow.ts), `createDefaultOnMergeConflict`
// (worktree.ts), and `createDefaultOnCommitFailure` (worktree.ts) previously
// each shipped an IDENTICAL body — `async (_args, _ctx) => ({ strategy:
// 'agent' })` — and each captured but NEVER used its `(profilesDirs, apiKeys?)`
// parameters. This refactor consolidates that shared body into a SINGLE
// internal helper, `createAgentStrategyHook`, exported from a dedicated
// `hooks/defaults/shared.ts` (so it is reused across BOTH worktree.ts and
// workflow.ts without a cross-module coupling between those two files).
//
// Contract this suite encodes (the TARGET behavior):
//   1. `createAgentStrategyHook` is exported from ./shared.js and takes NO
//      parameters — the shared core OMITS the dead profilesDirs/apiKeys. Only
//      the EXPORTED factory wrappers carry those params (public-API / future
//      override surface).
//   2. The helper returns the agent-strategy marker hook: resolves
//      `{ strategy: 'agent' }`, never throws on bad paths, carries no
//      `resolvedFiles`.
//   3. The three PUBLIC factories DELEGATE to the helper: each factory's
//      returned hook produces the SAME marker the helper produces.
//   4. The three public factories keep their names AND their FULL
//      `(profilesDirs, apiKeys?)` signatures UNCHANGED (the refactor must NOT
//      drop `profilesDirs` / `apiKeys` from the exported wrappers).
//
// Module under test: ./shared.js (+ the delegating factories in ./worktree.js
// and ./workflow.js).
//
// NOTE: `./shared.js` does not exist yet — this is the RED spec for the
// consolidation. The `import { createAgentStrategyHook } from './shared.js'`
// fails to resolve against the current code, so every test below fails until
// the green team lands `shared.ts` + wires the three factories through it.
// The existing `worktree-defaults.test.ts` and `workflow.test.ts` suites remain
// the behavior-pinning characterization suites; this file drives the NEW
// structural contract and is intentionally focused on the consolidation.

import { describe, expect, it } from 'bun:test';

import type { Task } from '../../core/types.js';
import { createHookRegistry } from '../registry.js';
import type { HookContext } from '../types.js';
import { createAgentStrategyHook } from './shared.js';
import { createDefaultOnRunMergeConflict } from './workflow.js';
import { createDefaultOnCommitFailure, createDefaultOnMergeConflict } from './worktree.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Minimal HookContext — mirrors makeCtx in the sibling default test files. */
function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: createHookRegistry(),
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

/** Minimal Task fixture (the consolidated hooks ignore it; shape only matters for typing). */
function makeTask(): Task {
  return {
    id: 'task-1',
    title: 'Do thing',
    prompt: 'p',
    profile: 'coder',
    files: [],
    dependencies: [],
    status: 'active',
    phaseId: 'code',
    worktree: 'none',
  };
}

/**
 * Loose invocation type for the helper. The helper is reused by factories with
 * three DIFFERENT args types (OnRunMergeConflictArgs, OnMergeConflictArgs,
 * OnCommitFailureArgs), so its public args type is intentionally generic; we
 * invoke it with arbitrary payloads here to prove it ignores them.
 */
type AnyAgentHook = (
  args: unknown,
  ctx: HookContext,
) => Promise<{ strategy: 'agent'; resolvedFiles?: string[] } | undefined>;

/** Invoke the shared helper's returned hook with an arbitrary args payload. */
function invokeHelper(args: unknown, ctx: HookContext = makeCtx()) {
  return (createAgentStrategyHook() as AnyAgentHook)(args, ctx);
}

/** The single marker every agent-strategy hook must produce. */
const AGENT_MARKER = { strategy: 'agent' } as const;

// ── createAgentStrategyHook (the shared internal helper) ───────────────────

describe('createAgentStrategyHook (shared internal helper)', () => {
  it('is exported from ./shared.js as a function', () => {
    expect(typeof createAgentStrategyHook).toBe('function');
  });

  it('takes NO parameters — the helper omits the dead profilesDirs/apiKeys', () => {
    // The consolidation's whole point: the shared core drops the unused
    // (profilesDirs, apiKeys) params. Only the EXPORTED factory wrappers keep
    // them for public-API compatibility. `.length` is the runtime proof that
    // the helper declares no parameters.
    expect(createAgentStrategyHook.length).toBe(0);
  });

  it('is callable with zero arguments and returns a hook function', () => {
    const hook = createAgentStrategyHook();
    expect(typeof hook).toBe('function');
  });

  it('the returned hook resolves { strategy: "agent" } (the pure delegation marker)', async () => {
    const result = await invokeHelper({ conflicts: ['a.ts'], worktreePath: '/wt', repoRoot: '/r' });
    expect(result).toEqual(AGENT_MARKER);
  });

  it('the marker carries no resolvedFiles — resolution happens downstream', async () => {
    const result = await invokeHelper({ conflicts: ['a.ts'], worktreePath: '/wt', repoRoot: '/r' });
    expect(result?.resolvedFiles).toBeUndefined();
  });

  it('never throws, even pointed at non-existent paths (does not touch the filesystem)', async () => {
    await expect(invokeHelper({ conflicts: ['x'], worktreePath: '/nope', repoRoot: '/nope' })).resolves.toEqual(
      AGENT_MARKER,
    );
  });

  it('returns the same marker regardless of the args payload', async () => {
    const empty = await invokeHelper({ conflicts: [], worktreePath: '/w', repoRoot: '/r' });
    const populated = await invokeHelper({ conflicts: ['a', 'b'], worktreePath: '/w', repoRoot: '/r' });
    expect(empty).toEqual(populated);
    expect(populated).toEqual(AGENT_MARKER);
  });

  it('resolves a value (wins in a first-wins composition — never abstains with undefined)', async () => {
    const result = await invokeHelper({ conflicts: ['a'], worktreePath: '/w', repoRoot: '/r' });
    expect(result).toBeDefined();
  });
});

// ── The three exported factories delegate to createAgentStrategyHook ─────────
//
// Black-box delegation cannot be *proven* (the observable marker is identical
// whether the factory inlines it or delegates). These tests pin the strongest
// observable contract: every factory's hook produces the EXACT marker the
// shared helper produces — i.e. the helper is the single source of truth for
// the agent-strategy marker. Combined with the helper-existence tests above,
// the factories must route through it.

describe('the three exported factories delegate to createAgentStrategyHook', () => {
  it('createDefaultOnMergeConflict: factory hook produces the SAME marker as the shared helper', async () => {
    const fromHelper = await invokeHelper({ conflicts: ['a'], worktreePath: '/w', repoRoot: '/r' });
    const fromFactory = await createDefaultOnMergeConflict(['/profiles'])(
      { task: makeTask(), conflicts: ['a'], worktreePath: '/w', mainBranch: 'main' },
      makeCtx(),
    );
    expect(fromFactory).toEqual(fromHelper);
    expect(fromFactory).toEqual(AGENT_MARKER);
  });

  it('createDefaultOnCommitFailure: factory hook produces the SAME marker as the shared helper', async () => {
    const fromHelper = await invokeHelper({ errors: ['lint'], worktreePath: '/w' });
    const fromFactory = await createDefaultOnCommitFailure(['/profiles'])(
      { task: makeTask(), errors: ['lint'], worktreePath: '/w' },
      makeCtx(),
    );
    expect(fromFactory).toEqual(fromHelper);
    expect(fromFactory).toEqual(AGENT_MARKER);
  });

  it('createDefaultOnRunMergeConflict: factory hook produces the SAME marker as the shared helper', async () => {
    const fromHelper = await invokeHelper({ conflicts: ['a'], worktreePath: '/w', repoRoot: '/r' });
    const fromFactory = await createDefaultOnRunMergeConflict(['/profiles'])(
      { conflicts: ['a'], worktreePath: '/w', repoRoot: '/r' },
      makeCtx(),
    );
    expect(fromFactory).toEqual(fromHelper);
    expect(fromFactory).toEqual(AGENT_MARKER);
  });

  it('every factory hook is a fresh function instance per call (no shared singleton state)', () => {
    // Delegation must still produce an independent hook per factory call — the
    // shared helper must not memoize a single instance that callers mutate.
    expect(createDefaultOnMergeConflict(['/a'])).not.toBe(createDefaultOnMergeConflict(['/b']));
    expect(createDefaultOnCommitFailure(['/a'])).not.toBe(createDefaultOnCommitFailure(['/b']));
    expect(createDefaultOnRunMergeConflict(['/a'])).not.toBe(createDefaultOnRunMergeConflict(['/b']));
    expect(createAgentStrategyHook()).not.toBe(createAgentStrategyHook());
  });
});

// ── Public API preserved: full (profilesDirs, apiKeys?) signatures ──────────
//
// The refactor MUST NOT drop `profilesDirs` / `apiKeys` from the exported
// factory wrappers (they are the public override surface). `.length === 2` is
// the runtime proof that both parameters remain declared on each factory.

describe('public API preserved: factories keep the (profilesDirs, apiKeys?) signature', () => {
  it('createDefaultOnMergeConflict declares both profilesDirs and apiKeys (.length === 2)', () => {
    expect(createDefaultOnMergeConflict.length).toBe(2);
  });

  it('createDefaultOnCommitFailure declares both profilesDirs and apiKeys (.length === 2)', () => {
    expect(createDefaultOnCommitFailure.length).toBe(2);
  });

  it('createDefaultOnRunMergeConflict declares both profilesDirs and apiKeys (.length === 2)', () => {
    expect(createDefaultOnRunMergeConflict.length).toBe(2);
  });

  it('createDefaultOnMergeConflict accepts apiKeys as the 2nd argument and still returns a hook', () => {
    const hook = createDefaultOnMergeConflict(['/profiles'], { OPENAI_API_KEY: 'sk-test' });
    expect(typeof hook).toBe('function');
  });

  it('createDefaultOnCommitFailure accepts apiKeys as the 2nd argument and still returns a hook', () => {
    const hook = createDefaultOnCommitFailure(['/profiles'], { ANTHROPIC_API_KEY: 'sk-test' });
    expect(typeof hook).toBe('function');
  });

  it('createDefaultOnRunMergeConflict accepts apiKeys as the 2nd argument and still returns a hook', () => {
    const hook = createDefaultOnRunMergeConflict(['/profiles'], { OPENAI_API_KEY: 'sk-test' });
    expect(typeof hook).toBe('function');
  });

  it('apiKeys is still OPTIONAL on every factory — each works with profilesDirs alone', () => {
    expect(typeof createDefaultOnMergeConflict(['/profiles'])).toBe('function');
    expect(typeof createDefaultOnCommitFailure(['/profiles'])).toBe('function');
    expect(typeof createDefaultOnRunMergeConflict(['/profiles'])).toBe('function');
  });
});

// ── Single source of truth: all four entry points agree ────────────────────
//
// The helper + the three factories must all resolve to the one canonical
// agent-strategy marker. If any path drifted (e.g. a factory re-inlined a
// stale body), this cross-check fails.

describe('single source of truth: helper + three factories all resolve { strategy: "agent" }', () => {
  it('all four entry points produce deepEqual markers', async () => {
    const fromHelper = await invokeHelper({ conflicts: ['a'], worktreePath: '/w', repoRoot: '/r' });
    const fromMerge = await createDefaultOnMergeConflict(['/profiles'])(
      { task: makeTask(), conflicts: ['a'], worktreePath: '/w', mainBranch: 'main' },
      makeCtx(),
    );
    const fromCommit = await createDefaultOnCommitFailure(['/profiles'])(
      { task: makeTask(), errors: ['lint'], worktreePath: '/w' },
      makeCtx(),
    );
    const fromRunMerge = await createDefaultOnRunMergeConflict(['/profiles'])(
      { conflicts: ['a'], worktreePath: '/w', repoRoot: '/r' },
      makeCtx(),
    );

    expect(fromHelper).toEqual(AGENT_MARKER);
    expect(fromMerge).toEqual(fromHelper);
    expect(fromCommit).toEqual(fromHelper);
    expect(fromRunMerge).toEqual(fromHelper);
  });

  it('none of the four entry points populate resolvedFiles', async () => {
    const fromHelper = await invokeHelper({ conflicts: ['a'], worktreePath: '/w', repoRoot: '/r' });
    const fromMerge = await createDefaultOnMergeConflict(['/profiles'])(
      { task: makeTask(), conflicts: ['a'], worktreePath: '/w', mainBranch: 'main' },
      makeCtx(),
    );
    const fromCommit = await createDefaultOnCommitFailure(['/profiles'])(
      { task: makeTask(), errors: ['lint'], worktreePath: '/w' },
      makeCtx(),
    );
    const fromRunMerge = await createDefaultOnRunMergeConflict(['/profiles'])(
      { conflicts: ['a'], worktreePath: '/w', repoRoot: '/r' },
      makeCtx(),
    );

    expect(fromHelper?.resolvedFiles).toBeUndefined();
    expect(fromMerge?.resolvedFiles).toBeUndefined();
    expect(fromCommit?.resolvedFiles).toBeUndefined();
    expect(fromRunMerge?.resolvedFiles).toBeUndefined();
  });
});
