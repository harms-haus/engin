// ─── Tests for pool/constants.ts — shared engine constants ─────────────────
//
// This module houses engine-wide runtime constants that are shared across
// multiple consumers. The first such constant is `DEFAULT_MAX_ROUNDS` — the
// default ceiling on retry/fixer rounds, previously duplicated as a local
// `const DEFAULT_MAX_ROUNDS = 3` in BOTH:
//   - pool/fix-loop.ts   (the fixLoop primitive's default maxRounds)
//   - core/phase-runner.ts (the PhaseRunner's default maxRounds)
//
// The consolidation refactor extracts the constant into this single shared
// location so both consumers import from one place. These tests pin the
// constant's value and shape so the refactor is provably behavior-preserving:
// both modules MUST continue to default to exactly 3 rounds.

import { describe, expect, it } from 'bun:test';
import { DEFAULT_MAX_ROUNDS } from './constants.js';

describe('DEFAULT_MAX_ROUNDS (shared constant)', () => {
  it('is the number 3 (the historical ≤3-rounds retry / fixer bound)', () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(3);
  });

  it('is a finite positive integer (not NaN, not Infinity)', () => {
    expect(Number.isInteger(DEFAULT_MAX_ROUNDS)).toBe(true);
    expect(Number.isFinite(DEFAULT_MAX_ROUNDS)).toBe(true);
    expect(DEFAULT_MAX_ROUNDS).toBeGreaterThan(0);
  });
});
