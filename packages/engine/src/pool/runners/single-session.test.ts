// ─── Tests for runners/single-session.ts (SessionPlan contract) ──────────
//
// Tests verify:
//   1. plan() yields exactly one batch with the correct deterministic ID
//   2. execute() calls runScheduledSession and returns its result
//   3. The factory creates a fresh runner instance each call
//
// Mock strategy:
//   - Shared mock via `test-fixtures.ts` → `mockRunScheduledSession`
//   - We construct a real SessionPlanRunner via the factory and test its
//     plan()/execute() methods directly.

import { describe, expect, it } from 'bun:test';
import type { SessionResult, SessionSpec } from '../session.js';
import {
  CANNED_RESULT,
  makePlanContext,
  makeSSSpec,
  mockRunScheduledSession,
  setupRunScheduledSessionMock,
} from './test-fixtures.js';

// ─── Import module under test ────────────────────────────────────────────

import { singleSession } from './single-session.js';

// ─── Mock wiring ─────────────────────────────────────────────────────────

setupRunScheduledSessionMock();

// ─── Tests ────────────────────────────────────────────────────────────────

describe('singleSession (SessionPlan)', () => {
  // ── 1. plan yields exactly one batch ──────────────────────────────────

  it('1a. plan yields a single batch [spec]', async () => {
    const factory = singleSession(makeSSSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    expect(first.done).toBeFalse();
    expect(first.value).toBeInstanceOf(Array);
    expect(first.value).toHaveLength(1);

    // Provide empty results to let the generator finish
    const second = await gen.next([] as SessionResult[]);
    expect(second.done).toBeTrue();
    expect(second.value).toBeUndefined();
  });

  // ── 2. Deterministic ID: `${taskId}/${role}#${attempt}` ──────────────

  it('2a. spec ID follows convention with default attempt=1', async () => {
    const factory = singleSession(makeSSSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    const spec = (first.value as SessionSpec[])[0];
    expect(spec.id).toBe('task-abc/executor#1');
    expect(spec.runnerRole).toBe('executor');
    expect(spec.attempt).toBe(1);
  });

  it('2b. spec ID uses provided attempt number', async () => {
    const factory = singleSession(makeSSSpec({ role: 'executor', attempt: 3 }));
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    const spec = (first.value as SessionSpec[])[0];
    expect(spec.id).toBe('task-abc/executor#3');
    expect(spec.attempt).toBe(3);
  });

  it('2c. spec ID uses different task ID from context', async () => {
    const factory = singleSession(makeSSSpec({ role: 'reviewer' }));
    const runner = factory();
    const ctx = makePlanContext({ task: { ...makePlanContext().task, id: 'task-xyz' } });
    const gen = runner.plan(ctx);

    const first = await gen.next();
    const spec = (first.value as SessionSpec[])[0];
    expect(spec.id).toBe('task-xyz/reviewer#1');
  });

  it('2d. spec carries user-provided fields (profile, prompt, outputMode)', async () => {
    const factory = singleSession(
      makeSSSpec({
        profile: 'executor',
        prompt: 'Custom prompt text',
        outputMode: 'structured',
      }),
    );
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next();
    const spec = (first.value as SessionSpec[])[0];
    expect(spec.profile).toBe('executor');
    expect(spec.prompt).toBe('Custom prompt text');
    expect(spec.outputMode).toBe('structured');
  });

  // ── 3. plan returns undefined (no aggregated terminal results) ──────

  it('3. plan returns undefined after batch settles', async () => {
    const factory = singleSession(makeSSSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next(); // consume the yield
    const result = await gen.next([CANNED_RESULT]); // settle the batch
    expect(result.done).toBeTrue();
    expect(result.value).toBeUndefined();
  });

  // ── 4. execute delegates to runScheduledSession ──────────────────────

  it('4a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const factory = singleSession(makeSSSpec());
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = {
      id: 'task-abc/executor#1',
      profile: 'executor',
      prompt: 'Do the work',
      outputMode: 'text',
      runnerRole: 'executor',
      attempt: 1,
    };

    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('4b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const factory = singleSession(makeSSSpec());
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = {
      id: 'task-abc/executor#1',
      profile: 'executor',
      prompt: 'Do the work',
      outputMode: 'text',
      runnerRole: 'executor',
      attempt: 1,
    };

    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 5. Factory creates fresh instances ───────────────────────────────

  it('5. factory returns a new runner instance each call', async () => {
    const factory = singleSession(makeSSSpec());

    const runnerA = factory();
    const runnerB = factory();

    expect(runnerA).not.toBe(runnerB);
    expect(runnerA.plan).toBeInstanceOf(Function);
    expect(runnerA.execute).toBeInstanceOf(Function);
    expect(runnerB.plan).toBeInstanceOf(Function);
    expect(runnerB.execute).toBeInstanceOf(Function);
  });

  // ── 6. Plan generator protocol: accepts results via next() ─────────

  it('6. plan generator accepts results array via next(results) and completes', async () => {
    const factory = singleSession(makeSSSpec());
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Start the generator
    const first = await gen.next();
    expect(first.done).toBeFalse();

    // Feed results back (simulating scheduler after batch settles)
    const results: SessionResult[] = [{ mode: 'text', text: 'done' }];
    const second = await gen.next(results);
    expect(second.done).toBeTrue();
    expect(second.value).toBeUndefined();
  });
});
