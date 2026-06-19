// ─── Step-level influence hooks + CONTEXT_BLOCK_REDUCER ────────────────────
//
// CONTRACT UNDER TEST (packages/engine/src/hooks/types.ts + reducers.ts):
//
// This task grows the empty `WorkflowHooks` interface with the first two
// STEP-LEVEL influence hooks (added via declaration merging in types.ts), and
// ships the reducer file that folds collectContext contributions:
//
//   // types.ts (declaration merge onto WorkflowHooks)
//   export interface WorkflowHooks {
//     /** pipeline: transforms the step prompt before it reaches the agent */
//     beforeStepPrompt?:
//       | PipelineHook<string, BeforeStepPromptArgs>
//       | PipelineHook<string, BeforeStepPromptArgs>[];
//     /** all-run: collects labeled context blocks; folded by CONTEXT_BLOCK_REDUCER */
//     collectContext?:
//       | AllRunHook<ContextBlock, CollectContextArgs>
//       | AllRunHook<ContextBlock, CollectContextArgs>[];
//   }
//
//   export type BeforeStepPromptArgs = {
//     task: Task; step: StepDefinition; prompt: string;
//     cwd: string; worktreeCwd?: string;
//   };
//   export type CollectContextArgs = {
//     task: Task; step: StepDefinition; cwd: string; worktreeCwd?: string;
//   };
//   export type ContextBlock = { label: string; content: string };
//
//   // reducers.ts (NEW — created ONCE here; later tasks append more reducers)
//   import type { ContextBlock } from './types.js';
//   export const CONTEXT_BLOCK_REDUCER = (
//     acc: ContextBlock[] | undefined, next: ContextBlock,
//   ): ContextBlock[] => [...(acc ?? []), next];
//
// `Task` is imported (type-only) from `../core/types.js`; `StepDefinition`
// from `../pool/types.js`. `worktreeCwd` is the per-task worktree path (the
// "two-cwd world"); `cwd` is the run cwd.
//
// This suite is written TEST-FIRST, mirroring tests/hooks/index-barrel.test.ts
// and defaults-barrel.test.ts:
//   • Source-level checks read types.ts / reducers.ts defensively (empty
//     string when absent) so the file COMPILES against the current source
//     while the assertions are RED until the source lands.
//   • Runtime checks load reducers.ts via a VARIABLE specifier so TypeScript
//     does not eagerly resolve the (not-yet-existing) module at compile time;
//     they are RED (module-not-found) until reducers.ts lands, then GREEN.
//
// NOTE: the barrel re-export of reducers.js + CONTEXT_BLOCK_REDUCER binding
// identity live in tests/hooks/index-barrel.test.ts (the hooks-barrel suite
// owns every barrel re-export / binding-identity check). This file owns the
// type definitions and the reducer's runtime behavior.

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Path helpers ───────────────────────────────────────────────────────────

const HOOKS_SRC = resolve(import.meta.dir, '../../packages/engine/src/hooks');
const TYPES_TS = resolve(HOOKS_SRC, 'types.ts');
const REDUCERS_TS = resolve(HOOKS_SRC, 'reducers.ts');

/**
 * Read a source file defensively: returns its UTF-8 contents if present, or an
 * empty string if the file does not exist yet. An empty string fails every
 * `.toContain(...)` / `.toMatch(...)` assertion — the desired RED state for a
 * not-yet-created file — without throwing at test-collection time. Mirrors
 * the tryReadSource helper in tests/hooks/defaults-barrel.test.ts.
 */
function tryReadSource(absPath: string): string {
  return existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
}

/**
 * A local mirror of the expected `ContextBlock` shape. Defined WITHOUT
 * importing the (not-yet-existing, when these tests are written) `ContextBlock`
 * export so this file compiles before the source lands. The reducer's runtime
 * behavior is exercised against this shape.
 */
interface TestContextBlock {
  label: string;
  content: string;
}

/**
 * The reducer's expected signature: `(acc, next) => acc`-with-next-appended,
 * seeded from `undefined`.
 */
type ContextBlockReducer = (acc: TestContextBlock[] | undefined, next: TestContextBlock) => TestContextBlock[];

/**
 * Load reducers.ts at runtime via a VARIABLE specifier. Because the specifier
 * is not a string literal, TypeScript does not resolve it at compile time, so
 * this file compiles even while reducers.ts does not yet exist. At runtime the
 * import rejects (module-not-found) until the file is created — the RED state
 * — and resolves once it is.
 */
async function loadReducers(): Promise<{ CONTEXT_BLOCK_REDUCER: ContextBlockReducer }> {
  const specifier = resolve(HOOKS_SRC, 'reducers.js');
  return (await import(specifier)) as { CONTEXT_BLOCK_REDUCER: ContextBlockReducer };
}

// ─── types.ts — beforeStepPrompt field on WorkflowHooks ────────────────────

describe('types.ts — WorkflowHooks.beforeStepPrompt', () => {
  const src = tryReadSource(TYPES_TS);

  it('declares an optional `beforeStepPrompt` field on WorkflowHooks', () => {
    // Declaration merging appends an OPTIONAL field (the `?`), so an empty
    // hooks object stays valid. The field name must appear on WorkflowHooks.
    expect(src).toMatch(/beforeStepPrompt\s*\?:/);
  });

  it('types beforeStepPrompt as PipelineHook<string, BeforeStepPromptArgs>', () => {
    // The single-subscriber form: a pipeline over the prompt STRING whose
    // args are BeforeStepPromptArgs. The Value generic is pinned to `string`
    // (the prompt) — not `unknown`.
    expect(src).toContain('PipelineHook<string, BeforeStepPromptArgs>');
  });

  it('accepts an ARRAY of beforeStepPrompt subscribers (single fn OR fn[])', () => {
    // The union with `PipelineHook<string, BeforeStepPromptArgs>[]` lets a
    // workflow register multiple pipeline subscribers in one shot.
    expect(src).toContain('PipelineHook<string, BeforeStepPromptArgs>[]');
  });
});

// ─── types.ts — collectContext field on WorkflowHooks ──────────────────────

describe('types.ts — WorkflowHooks.collectContext', () => {
  const src = tryReadSource(TYPES_TS);

  it('declares an optional `collectContext` field on WorkflowHooks', () => {
    expect(src).toMatch(/collectContext\s*\?:/);
  });

  it('types collectContext as AllRunHook<ContextBlock, CollectContextArgs>', () => {
    // An all-run hook: every subscriber contributes ONE ContextBlock; the
    // registry folds contributions via CONTEXT_BLOCK_REDUCER.
    expect(src).toContain('AllRunHook<ContextBlock, CollectContextArgs>');
  });

  it('accepts an ARRAY of collectContext subscribers (single fn OR fn[])', () => {
    expect(src).toContain('AllRunHook<ContextBlock, CollectContextArgs>[]');
  });
});

// ─── types.ts — BeforeStepPromptArgs ───────────────────────────────────────

describe('types.ts — BeforeStepPromptArgs', () => {
  const src = tryReadSource(TYPES_TS);

  it('is exported from types.ts (so reducers/consumers can name it)', () => {
    // Accept either `export type …` or `export interface …`; the task uses the
    // object-literal type form. Must be a top-level EXPORT (not just a local).
    expect(src).toMatch(/export\s+(?:type|interface)\s+BeforeStepPromptArgs\b/);
  });

  it('carries task, step, prompt, cwd, and optional worktreeCwd', () => {
    // The two-cwd world: `cwd` = run cwd; `worktreeCwd` = per-task worktree
    // path (optional — present only when worktree isolation is active).
    // `prompt` is the initial step prompt string fed to the pipeline.
    expect(src).toContain('task:');
    expect(src).toContain('step:');
    expect(src).toContain('prompt:');
    expect(src).toContain('cwd:');
    expect(src).toMatch(/worktreeCwd\s*\?:/);
  });
});

// ─── types.ts — CollectContextArgs ─────────────────────────────────────────

describe('types.ts — CollectContextArgs', () => {
  const src = tryReadSource(TYPES_TS);

  it('is exported from types.ts', () => {
    expect(src).toMatch(/export\s+(?:type|interface)\s+CollectContextArgs\b/);
  });

  it('carries task, step, cwd, and optional worktreeCwd (NO prompt)', () => {
    // Mirrors BeforeStepPromptArgs MINUS `prompt` — collectContext does not
    // receive the prompt (it produces context that beforeStepPrompt may fold
    // in). worktreeCwd remains optional.
    expect(src).toContain('task:');
    expect(src).toContain('step:');
    expect(src).toContain('cwd:');
    expect(src).toMatch(/worktreeCwd\s*\?:/);
  });
});

// ─── types.ts — ContextBlock ───────────────────────────────────────────────

describe('types.ts — ContextBlock', () => {
  const src = tryReadSource(TYPES_TS);

  it('is exported from types.ts', () => {
    // reducers.ts imports `ContextBlock` from './types.js', so it MUST be a
    // top-level export of types.ts (not just a local alias).
    expect(src).toMatch(/export\s+(?:type|interface)\s+ContextBlock\b/);
  });

  it('is { label: string; content: string }', () => {
    // A labeled block of context text (file contents, diffs, …) prepended or
    // appended to the prompt. Both fields are required strings.
    expect(src).toContain('label: string');
    expect(src).toContain('content: string');
  });
});

// ─── types.ts — Task / StepDefinition imports ──────────────────────────────

describe('types.ts — Task and StepDefinition imports', () => {
  const src = tryReadSource(TYPES_TS);

  it("imports Task (type-only) from '../core/types.js'", () => {
    // `Task` lives in core/types.ts. The import must be type-only so types.ts
    // stays free of runtime circular dependencies (the mechanism-only invariant).
    expect(src).toMatch(/import\s+type\s*\{[^}]*\bTask\b[^}]*\}\s*from\s*['"]\.\.\/core\/types\.js['"]/);
  });

  it("imports StepDefinition (type-only) from '../pool/types.js'", () => {
    // `StepDefinition` is surfaced via pool/types.ts (which re-exports it from
    // core/types.ts). The task pins the import path to ../pool/types.js.
    expect(src).toMatch(/import\s+type\s*\{[^}]*\bStepDefinition\b[^}]*\}\s*from\s*['"]\.\.\/pool\/types\.js['"]/);
  });
});

// ─── reducers.ts — file existence & structure ──────────────────────────────

describe('reducers.ts — existence & structure', () => {
  it('creates packages/engine/src/hooks/reducers.ts', () => {
    // The reducer file is created ONCE here. Later tasks that need additional
    // reducers (e.g. for onPhaseSettled) APPEND to this same file — they must
    // NOT create separate reducer files.
    expect(existsSync(REDUCERS_TS)).toBe(true);
  });

  it("imports ContextBlock (type-only) from './types.js'", () => {
    // reducers.ts depends only on the type-level ContextBlock from its sibling
    // types.ts — a type-only import keeps reducers.ts free of any runtime
    // import of types.ts (which has no runtime value exports anyway).
    const src = tryReadSource(REDUCERS_TS);
    expect(src).toContain("import type { ContextBlock } from './types.js'");
  });

  it('exports a named const CONTEXT_BLOCK_REDUCER', () => {
    const src = tryReadSource(REDUCERS_TS);
    expect(src).toMatch(/export\s+const\s+CONTEXT_BLOCK_REDUCER\b/);
  });

  it('has the reducer signature (acc: ContextBlock[] | undefined, next: ContextBlock): ContextBlock[]', () => {
    // The accumulator is `ContextBlock[] | undefined` (the registry seeds
    // all-run folds with `undefined` — the reducer's identity); `next` is a
    // single ContextBlock contribution; the return is the accumulated array.
    const src = tryReadSource(REDUCERS_TS);
    expect(src).toContain('acc: ContextBlock[] | undefined');
    expect(src).toContain('next: ContextBlock');
    expect(src).toContain(': ContextBlock[]');
  });

  it('concatenates by spreading the accumulator with a nullish-coalesced default', () => {
    // `[...(acc ?? []), next]` — appends `next` to a copy of `acc`, defaulting
    // a missing accumulator to an empty array (the all-run identity element).
    const src = tryReadSource(REDUCERS_TS);
    expect(src).toContain('[...');
    expect(src).toContain('(acc ?? [])');
    expect(src).toContain(', next]');
  });
});

// ─── CONTEXT_BLOCK_REDUCER — runtime behavior ──────────────────────────────
//
// These load reducers.ts via a variable specifier (see loadReducers) so the
// file compiles now; they are RED (module-not-found) until reducers.ts lands.

describe('CONTEXT_BLOCK_REDUCER — behavior', () => {
  it('is a function', async () => {
    const { CONTEXT_BLOCK_REDUCER } = await loadReducers();
    expect(typeof CONTEXT_BLOCK_REDUCER).toBe('function');
  });

  it('seeds from an undefined accumulator → [next]', async () => {
    // The registry invokes all-run reducers with acc = undefined for the first
    // contribution (the reducer's identity element). The result must be a
    // single-element array containing that contribution.
    const { CONTEXT_BLOCK_REDUCER } = await loadReducers();
    const block: TestContextBlock = { label: 'file.ts', content: 'export const x = 1;' };
    expect(CONTEXT_BLOCK_REDUCER(undefined, block)).toEqual([block]);
  });

  it('treats an empty-array accumulator like undefined → [next]', async () => {
    const { CONTEXT_BLOCK_REDUCER } = await loadReducers();
    const block: TestContextBlock = { label: 'diff', content: '@@ ...' };
    expect(CONTEXT_BLOCK_REDUCER([], block)).toEqual([block]);
  });

  it('appends a new contribution to the end of an existing accumulator', async () => {
    const { CONTEXT_BLOCK_REDUCER } = await loadReducers();
    const a: TestContextBlock = { label: 'a', content: 'A' };
    const b: TestContextBlock = { label: 'b', content: 'B' };
    expect(CONTEXT_BLOCK_REDUCER([a], b)).toEqual([a, b]);
  });

  it('preserves subscriber order across a multi-contribution fold', async () => {
    // Simulates how the registry folds an all-run hook: seed with undefined,
    // then reduce each contribution in subscriber order. The final array must
    // reflect registration order (first subscriber first).
    const { CONTEXT_BLOCK_REDUCER } = await loadReducers();
    const b1: TestContextBlock = { label: 'files', content: 'file contents' };
    const b2: TestContextBlock = { label: 'diff', content: 'unified diff' };
    const b3: TestContextBlock = { label: 'notes', content: 'context notes' };
    let acc: TestContextBlock[] | undefined = undefined;
    for (const block of [b1, b2, b3]) {
      acc = CONTEXT_BLOCK_REDUCER(acc, block);
    }
    expect(acc).toEqual([b1, b2, b3]);
  });

  it('returns a NEW array (does not return the accumulator by reference)', async () => {
    // `[...acc, next]` always allocates; the result must never be `===` the
    // input accumulator. This is what makes the reducer safe to chain.
    const { CONTEXT_BLOCK_REDUCER } = await loadReducers();
    const acc: TestContextBlock[] = [{ label: 'a', content: 'A' }];
    const next: TestContextBlock = { label: 'b', content: 'B' };
    const result = CONTEXT_BLOCK_REDUCER(acc, next);
    expect(result).not.toBe(acc);
    expect(result).toEqual([acc[0], next]);
  });

  it('does NOT mutate the input accumulator', async () => {
    // Spreading copies element references into a new array; the original
    // accumulator's length/contents are unchanged after the call.
    const { CONTEXT_BLOCK_REDUCER } = await loadReducers();
    const acc: TestContextBlock[] = [{ label: 'a', content: 'A' }];
    const next: TestContextBlock = { label: 'b', content: 'B' };
    CONTEXT_BLOCK_REDUCER(acc, next);
    expect(acc).toEqual([{ label: 'a', content: 'A' }]);
    expect(acc).toHaveLength(1);
  });

  it('preserves block object identity in the result (no deep clone)', async () => {
    // The reducer appends the exact contribution object — callers can later
    // mutate the block and observe it in the aggregated array.
    const { CONTEXT_BLOCK_REDUCER } = await loadReducers();
    const block: TestContextBlock = { label: 'file', content: 'c' };
    const result = CONTEXT_BLOCK_REDUCER(undefined, block);
    expect(result[0]).toBe(block);
  });
});
