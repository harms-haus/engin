/**
 * @fileoverview Source-contract tests for the onDecision hook pattern
 * across the three runner files and multi-step-task.
 *
 * These tests assert the STRUCTURAL requirements of the current state:
 *   1. The settle helpers (settleResult, settleBySeverity, handleRunnerError)
 *      are exported from `runner-utils.ts` — the deduplication from commit
 *      8567c29 unified these but did NOT extract the onDecision boilerplate.
 *   2. `fireOnDecisionHook` is NOT exported from runner-utils.ts (the
 *      onDecision extraction was not performed).
 *   3. All three call sites (linear-steps-runner, reflection-runner,
 *      multi-step-task) contain inline `hookRegistry?.hasSubscribers('onDecision')`
 *      boilerplate with `invokeObserve('onDecision', ...)`.
 *   4. Each call site also has `onStatus?.onDecision?.(...)` inline (the
 *      store callback fires alongside the hook).
 *
 * They use the `tryReadSource` pattern from `hook-registry-threading.test.ts`:
 * source files are read at runtime and matched against regex patterns. Every
 * assertion is RED until the source matches, then goes GREEN.
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
const MULTI_STEP_TASK_TS = resolve(CORE_SRC, 'multi-step-task.ts');

/** Read a source file defensively (empty string when absent) so the file
 *  compiles now and assertions are RED until the source lands. */
function tryReadSource(absPath: string): string {
  return existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
}

// ═══════════════════════════════════════════════════════════════════════════
// runner-utils.ts — settle helpers (the actual unification from commit 8567c29)
// ═══════════════════════════════════════════════════════════════════════════

describe('source: runner-utils.ts — exported settle helpers', () => {
  const src = tryReadSource(RUNNER_UTILS_TS);

  it('exports settleBySeverity (used by linear-steps and reflection runners)', () => {
    expect(src).toMatch(/export\s+function\s+settleBySeverity\b/);
  });

  it('exports settleResult (used by reflection runner)', () => {
    expect(src).toMatch(/export\s+function\s+settleResult\b/);
  });

  it('exports buildExecCtx (builds StepExecutionContext from TaskRunnerContext)', () => {
    expect(src).toMatch(/export\s+function\s+buildExecCtx\b/);
  });

  it('exports handleRunnerError (uniform error envelope for runners)', () => {
    expect(src).toMatch(/export\s+function\s+handleRunnerError\b/);
  });

  it('does NOT export fireOnDecisionHook (onDecision remains inline in runners)', () => {
    expect(src).not.toMatch(/export\s+(?:async\s+)?function\s+fireOnDecisionHook\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Call site: linear-steps-runner.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('source: linear-steps-runner.ts — inline onDecision hook', () => {
  const src = tryReadSource(LINEAR_STEPS_TS);

  it('imports settle helpers from ./runner-utils.js', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bsettleBySeverity\b[^}]*\}\s*from\s*['"]\.\/runner-utils\.js['"]/);
  });

  it('gates the onDecision hook on ctx.hookRegistry?.hasSubscribers("onDecision")', () => {
    expect(src).toMatch(/ctx\.hookRegistry\s*\?\.\s*hasSubscribers\(['"]onDecision['"]\)/);
  });

  it('calls ctx.hookRegistry.invokeObserve("onDecision", ...) inline', () => {
    expect(src).toMatch(/ctx\.hookRegistry\.invokeObserve\(\s*['"]onDecision['"]/);
  });

  it('keeps the onStatus?.onDecision?.(...) call inline (store callback)', () => {
    expect(src).toMatch(/onStatus\s*\?\.\s*onDecision\s*\?\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Call site: reflection-runner.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('source: reflection-runner.ts — inline onDecision hook', () => {
  const src = tryReadSource(REFLECTION_TS);

  it('imports settle helpers from ./runner-utils.js', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bsettleBySeverity\b[^}]*\}\s*from\s*['"]\.\/runner-utils\.js['"]/);
  });

  it('gates the onDecision hook on ctx.hookRegistry?.hasSubscribers("onDecision")', () => {
    expect(src).toMatch(/ctx\.hookRegistry\s*\?\.\s*hasSubscribers\(['"]onDecision['"]\)/);
  });

  it('calls ctx.hookRegistry.invokeObserve("onDecision", ...) inline', () => {
    expect(src).toMatch(/ctx\.hookRegistry\.invokeObserve\(\s*['"]onDecision['"]/);
  });

  it('keeps the onStatus?.onDecision?.(...) call inline (store callback)', () => {
    expect(src).toMatch(/onStatus\s*\?\.\s*onDecision\s*\?\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Call site: multi-step-task.ts (re-exported via phase-tasks.ts barrel)
// ═══════════════════════════════════════════════════════════════════════════

describe('source: multi-step-task.ts — inline onDecision hook', () => {
  const src = tryReadSource(MULTI_STEP_TASK_TS);

  it('imports HookRegistry (type-only) from ../hooks/types.js', () => {
    expect(src).toMatch(/import\s+type\s*\{[^}]*\bHookRegistry\b[^}]*\}\s*from\s*['"]\.\.\/hooks\/types\.js['"]/);
  });

  it('gates the onDecision hook on hookRegistry?.hasSubscribers("onDecision")', () => {
    expect(src).toMatch(/hookRegistry\s*\?\.\s*hasSubscribers\(['"]onDecision['"]\)/);
  });

  it('calls hookRegistry.invokeObserve("onDecision", ...) inline', () => {
    expect(src).toMatch(/hookRegistry\.invokeObserve\(\s*['"]onDecision['"]/);
  });

  it('keeps the onStatus?.onDecision?.(...) call inline (store callback)', () => {
    expect(src).toMatch(/onStatus\s*\?\.\s*onDecision\s*\?\./);
  });
});
