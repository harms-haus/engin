// Tests for the extracted core/task-feedback module (Part A).
//
// `appendReviewFeedback` was previously defined inline in core/utils.ts. It is
// being extracted into its own core-layer module so that cross-layer consumers
// (pool/* and tracking/*) can depend on it without pulling in the larger
// utils module or — critically — without creating a `tracking → pool`
// dependency. These tests pin down the extracted module's behavior and the
// required re-export kept on core/utils.ts.

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendReviewFeedback } from '../../packages/engine/src/core/task-feedback.js';
// Import the same-named export from core/utils.js to assert the re-export
// contract required by Part A (existing external consumers keep working).
import { appendReviewFeedback as reExportedAppendReviewFeedback } from '../../packages/engine/src/core/utils.js';

// ─── appendReviewFeedback ──────────────────────────────────────────────────

describe('appendReviewFeedback (core/task-feedback module)', () => {
  it('initializes reviewFeedback array when absent and pushes the feedback', () => {
    const task: { reviewFeedback?: string[] } = {};
    appendReviewFeedback(task, 'first feedback');
    expect(task.reviewFeedback).toEqual(['first feedback']);
  });

  it('appends to an existing reviewFeedback array without replacing entries', () => {
    const task: { reviewFeedback?: string[] } = { reviewFeedback: ['existing'] };
    appendReviewFeedback(task, 'new feedback');
    expect(task.reviewFeedback).toEqual(['existing', 'new feedback']);
  });

  it('accumulates multiple feedback entries in insertion order', () => {
    const task: { reviewFeedback?: string[] } = {};
    appendReviewFeedback(task, 'first');
    appendReviewFeedback(task, 'second');
    appendReviewFeedback(task, 'third');
    expect(task.reviewFeedback).toEqual(['first', 'second', 'third']);
  });

  it('preserves a pre-existing empty array and pushes into it', () => {
    const task: { reviewFeedback?: string[] } = { reviewFeedback: [] };
    appendReviewFeedback(task, 'only entry');
    expect(task.reviewFeedback).toEqual(['only entry']);
  });

  it('only initializes the reviewFeedback field (does not add unrelated fields)', () => {
    const task: { reviewFeedback?: string[] } = {};
    appendReviewFeedback(task, 'fb');
    expect(Object.keys(task)).toEqual(['reviewFeedback']);
  });

  it('mutates the task object in place (returns void)', () => {
    const task: { reviewFeedback?: string[] } = {};
    const ret = appendReviewFeedback(task, 'fb');
    expect(ret).toBeUndefined();
    expect(task.reviewFeedback).toEqual(['fb']);
  });

  it('does not overwrite an existing array reference (same array identity)', () => {
    const original: string[] = ['a'];
    const task: { reviewFeedback?: string[] } = { reviewFeedback: original };
    appendReviewFeedback(task, 'b');
    // The same array instance should have been mutated, not replaced.
    expect(task.reviewFeedback).toBe(original);
    expect(task.reviewFeedback).toEqual(['a', 'b']);
  });
});

// ─── Re-export contract (Part A) ───────────────────────────────────────────

describe('appendReviewFeedback re-export from core/utils.ts', () => {
  it('is the exact same function reference exported by core/task-feedback', () => {
    // Part A requires core/utils.ts to keep a re-export
    // `export { appendReviewFeedback } from './task-feedback.js'` so existing
    // external consumers continue to work. The re-export must resolve to the
    // identical function (not a wrapper), which we assert via reference
    // equality.
    expect(reExportedAppendReviewFeedback).toBe(appendReviewFeedback);
  });

  it('behaves identically when invoked through the utils re-export', () => {
    const task: { reviewFeedback?: string[] } = {};
    reExportedAppendReviewFeedback(task, 'via-utils');
    expect(task.reviewFeedback).toEqual(['via-utils']);
  });
});

// ─── Layering invariant (Part A motivation) ────────────────────────────────
//
// `appendReviewFeedback` was extracted to `core/` so that cross-layer
// consumers (pool/* and tracking/*) can depend on it without creating a
// `tracking → pool` dependency (pool depends on tracking, never the
// reverse). D1 removed the last tracking consumer of this helper
// (task-status.ts no longer imports it), but the invariant that no tracking
// file imports from `../pool/` is still enforced generally below.

describe('tracking layer does not depend on pool layer', () => {
  const trackingDir = join(process.cwd(), 'packages', 'engine', 'src', 'tracking');

  it('no tracking source file imports from ../pool/', () => {
    const files = readdirSync(trackingDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(join(trackingDir, file), 'utf-8');
      const lines = contents
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes("from '../pool/") || l.includes('from "../pool/'));
      for (const line of lines) offenders.push(`${file}: ${line}`);
    }
    expect(offenders).toEqual([]);
  });
});
