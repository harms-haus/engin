/**
 * @fileoverview Source-contract tests for the fireOnDecisionHook extraction.
 *
 * These tests assert the STRUCTURAL requirements of the completed refactor:
 *   1. `fireOnDecisionHook` is exported from `runner-utils.ts`
 *   2. All three call sites (linear-steps-runner, reflection-runner,
 *      phase-tasks) call `fireOnDecisionHook(...)` instead of the inline
 *      ~15-line `hookRegistry?.hasSubscribers('onDecision')` boilerplate.
 *   3. The inline boilerplate block is removed from all three call sites.
 *
 * They use the `tryReadSource` pattern from `hook-registry-threading.test.ts`:
 * source files are read at runtime and matched against regex patterns. Every
 * assertion is RED until the implementer completes the extraction, then goes
 * GREEN. This provides a definitive, grep-level checklist that the refactor is
 * done — complementing the behavioral characterization tests in
 * linear-steps-runner.test.ts / reflection-runner.test.ts / phase-tasks.test.ts
 * (which pin down the OBSERVABLE behavior the extraction must preserve).
 *
 * The behavioral tests (188 of them) already pass against the current inline
 * code; they are the safety net. These source-contract tests are the
 * completion signal.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source paths ───────────────────────────────────────────────────────────

const POOL_SRC = resolve(import.meta.dir, '../../packages/engine/src/pool');
const CORE_SRC = resolve(import.meta.dir, '../../packages/engine/src/core');

const RUNNER_UTILS_TS = resolve(POOL_SRC, 'runner-utils.ts');
const LINEAR_STEPS_TS = resolve(POOL_SRC, 'linear-steps-runner.ts');
const REFLECTION_TS = resolve(POOL_SRC, 'reflection-runner.ts');
const PHASE_TASKS_TS = resolve(CORE_SRC, 'phase-tasks.ts');

/** Read a source file defensively (empty string when absent) so the file
 *  compiles now and assertions are RED until the source lands. */
function tryReadSource(absPath: string): string {
  return existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
}

// ═══════════════════════════════════════════════════════════════════════════
// runner-utils.ts — fireOnDecisionHook export
// ═══════════════════════════════════════════════════════════════════════════

describe('source: runner-utils.ts — fireOnDecisionHook export', () => {
  const src = tryReadSource(RUNNER_UTILS_TS);

  it('imports HookRegistry (type-only) from ../hooks/types.js', () => {
    expect(src).toMatch(/import\s+type\s*\{[^}]*\bHookRegistry\b[^}]*\}\s*from\s*['"]\.\.\/hooks\/types\.js['"]/);
  });

  it('exports a function named fireOnDecisionHook', () => {
    expect(src).toMatch(/export\s+async\s+function\s+fireOnDecisionHook\b/);
  });

  it('accepts hookRegistry as the first parameter (HookRegistry | undefined)', () => {
    expect(src).toMatch(/fireOnDecisionHook\s*\(\s*hookRegistry\s*:\s*HookRegistry\s*\|\s*undefined/);
  });

  it('accepts the args object { agentId, decision, reasoning, taskId, phaseId } as the second parameter', () => {
    expect(src).toMatch(/args\s*:\s*\{[^}]*agentId[^}]*decision[^}]*reasoning[^}]*taskId[^}]*phaseId[^}]*\}/s);
  });

  it('accepts a ctx parameter with cwd, worktreeCwd?, workDir?, signal?', () => {
    expect(src).toMatch(/ctx\s*:\s*\{\s*cwd:\s*string/);
    expect(src).toMatch(/worktreeCwd\s*\?\s*:\s*string/);
    expect(src).toMatch(/workDir\s*\?\s*:\s*string/);
    expect(src).toMatch(/signal\s*\?\s*:\s*AbortSignal/);
  });

  it('returns Promise<void>', () => {
    expect(src).toMatch(/\)\s*:\s*Promise<void>/);
  });

  it('gates on hookRegistry?.hasSubscribers("onDecision")', () => {
    expect(src).toMatch(/hookRegistry\s*\?\.\s*hasSubscribers\(['"]onDecision['"]\)/);
  });

  it('invokes invokeObserve("onDecision", args, hookCtx) when subscribers exist', () => {
    expect(src).toMatch(/invokeObserve\(\s*['"]onDecision['"]\s*,/);
  });

  it('resolves cwd as worktreeCwd ?? ctx.cwd', () => {
    // The hook context cwd must use worktreeCwd when available, falling back
    // to ctx.cwd. This covers both the runner pattern (worktreeCwd ?? ctx.cwd)
    // and the phase-tasks pattern (effectiveCwd passed as cwd).
    expect(src).toMatch(/worktreeCwd\s*\?\?\s*ctx\.cwd/);
  });

  it('defaults workDir to ctx.cwd when ctx.workDir is not provided', () => {
    // ctx.workDir ?? ctx.cwd — so the phase-tasks call site (which passes a
    // distinct workDir) overrides it, while the runner call sites (which omit
    // workDir) get ctx.cwd.
    expect(src).toMatch(/workDir\s*\?\?\s*ctx\.cwd/);
  });

  // NOTE: signal forwarding is verified behaviorally in runner-utils.test.ts
  // (fireOnDecisionHook > forwards ctx.signal into the hookCtx). We omit a
  // source-contract assertion for it here because /signal:\s*ctx\.signal/
  // also matches the pre-existing buildExecCtx function, producing a false
  // positive.
});

// ═══════════════════════════════════════════════════════════════════════════
// Call site: linear-steps-runner.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('source: linear-steps-runner.ts — calls fireOnDecisionHook', () => {
  const src = tryReadSource(LINEAR_STEPS_TS);

  it('imports fireOnDecisionHook from ./runner-utils.js', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bfireOnDecisionHook\b[^}]*\}\s*from\s*['"]\.\/runner-utils\.js['"]/);
  });

  it('calls fireOnDecisionHook(...) in the rejection path', () => {
    expect(src).toMatch(/fireOnDecisionHook\s*\(/);
  });

  it('removes the inline hookRegistry?.hasSubscribers("onDecision") boilerplate', () => {
    // After extraction, the inline `if (ctx.hookRegistry?.hasSubscribers('onDecision'))`
    // block must be gone — replaced by the helper call.
    expect(src).not.toMatch(/ctx\.hookRegistry\s*\?\.\s*hasSubscribers\(['"]onDecision['"]\)/);
  });

  it('keeps the onStatus?.onDecision?.(...) call inline (NOT extracted)', () => {
    // The onStatus callback stays — only the hook-firing is extracted.
    expect(src).toMatch(/onStatus\s*\?\.\s*onDecision\s*\?\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Call site: reflection-runner.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('source: reflection-runner.ts — calls fireOnDecisionHook', () => {
  const src = tryReadSource(REFLECTION_TS);

  it('imports fireOnDecisionHook from ./runner-utils.js', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bfireOnDecisionHook\b[^}]*\}\s*from\s*['"]\.\/runner-utils\.js['"]/);
  });

  it('calls fireOnDecisionHook(...) in the critic-rejection path', () => {
    expect(src).toMatch(/fireOnDecisionHook\s*\(/);
  });

  it('removes the inline hookRegistry?.hasSubscribers("onDecision") boilerplate', () => {
    expect(src).not.toMatch(/ctx\.hookRegistry\s*\?\.\s*hasSubscribers\(['"]onDecision['"]\)/);
  });

  it('keeps the onStatus?.onDecision?.(...) call inline (NOT extracted)', () => {
    expect(src).toMatch(/onStatus\s*\?\.\s*onDecision\s*\?\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Call site: phase-tasks.ts (runMultiStepTask)
// ═══════════════════════════════════════════════════════════════════════════

describe('source: phase-tasks.ts — calls fireOnDecisionHook', () => {
  const src = tryReadSource(PHASE_TASKS_TS);

  it('imports fireOnDecisionHook from ../pool/runner-utils.js', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bfireOnDecisionHook\b[^}]*\}\s*from\s*['"]\.\.\/pool\/runner-utils\.js['"]/);
  });

  it('calls fireOnDecisionHook(...) in the step-rejection path', () => {
    expect(src).toMatch(/fireOnDecisionHook\s*\(/);
  });

  it('removes the inline hookRegistry?.hasSubscribers("onDecision") boilerplate', () => {
    expect(src).not.toMatch(/hookRegistry\s*\?\.\s*hasSubscribers\(['"]onDecision['"]\)/);
  });

  it('keeps the onStatus?.onDecision?.(...) call inline (NOT extracted)', () => {
    expect(src).toMatch(/onStatus\s*\?\.\s*onDecision\s*\?\./);
  });
});
