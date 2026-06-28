// ─── Tests for runners/map-runner.ts (SessionPlan contract) ─────────────
//
// Tests verify:
//   1. plan() yields one batch with one spec per item
//   2. Per-item prompt: spec.prompt + "\n\nItem: " + JSON.stringify(item)
//   3. ID convention: `${taskId}/map[${index}].${role}#${attempt}`
//   4. Empty items → plan generator returns immediately
//   5. execute() calls runScheduledSession and returns its result
//   6. Factory creates a fresh runner instance each call
//   7. Spec fields (profile, outputMode, attempt, etc.) are propagated
//   8. Custom role is used in session IDs
//
// Mock strategy:
//   - Shared mock via `test-fixtures.ts` → `mockRunScheduledSession`
//   - We construct a real SessionPlanRunner via the factory and test its
//     plan()/execute() methods directly.

import { describe, expect, it } from 'bun:test';
import type { SessionSpec } from '../session.js';
import {
  CANNED_RESULT,
  makePlanContext,
  mockRunScheduledSession,
  setupRunScheduledSessionMock,
} from './test-fixtures.js';

// ─── Import module under test ────────────────────────────────────────────

import { mapRunner } from './map-runner.js';

// ─── Mock wiring ─────────────────────────────────────────────────────────

setupRunScheduledSessionMock();

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeSpec(overrides?: Partial<SessionSpec>): SessionSpec {
  return {
    id: 'base-spec-id', // will be overridden by map runner
    profile: 'executor',
    prompt: 'Process item',
    outputMode: 'text',
    runnerRole: 'worker',
    attempt: 1,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('mapRunner (SessionPlan)', () => {
  // ── 1. plan yields one batch with one spec per item ───────────────

  it('1a. plan yields one batch with 3 specs for 3 items', async () => {
    const items = ['a', 'b', 'c'];
    const factory = mapRunner({ items, spec: makeSpec() });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    expect(first.done).toBe(false);
    const batch = first.value as SessionSpec[];
    expect(batch).toHaveLength(3);
  });

  it('1b. batch contains exactly one spec per item', async () => {
    const items = ['x', 'y'];
    const factory = mapRunner({ items, spec: makeSpec() });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    expect(first.value as SessionSpec[]).toHaveLength(2);

    const done = await gen.next([CANNED_RESULT, CANNED_RESULT]);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // ── 2. Per-item prompt convention ─────────────────────────────────

  it('2a. per-item prompt includes the item via JSON.stringify', async () => {
    const items = [{ value: 42, label: 'test' }];
    const factory = mapRunner({ items, spec: makeSpec({ prompt: 'Base prompt' }) });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const batch = first.value as SessionSpec[];
    expect(batch[0].prompt).toContain('Base prompt');
    expect(batch[0].prompt).toContain(JSON.stringify(items[0]));
  });

  it('2b. each item has its own prompt with its own item content', async () => {
    const items = ['first-item', 'second-item'];
    const factory = mapRunner({ items, spec: makeSpec({ prompt: 'Process' }) });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const batch = first.value as SessionSpec[];
    expect(batch[0].prompt).toContain('first-item');
    expect(batch[1].prompt).toContain('second-item');
  });

  // ── 3. ID convention ─────────────────────────────────────────────

  it('3a. IDs follow map[${index}].<role> pattern with default role "worker"', async () => {
    const items = ['a', 'b'];
    const factory = mapRunner({ items, spec: makeSpec() });
    const runner = factory();
    const ctx = makePlanContext({ task: { ...makePlanContext().task, id: 'task-abc' } });
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const batch = first.value as SessionSpec[];
    expect(batch[0].id).toBe('task-abc/map[0].worker#1');
    expect(batch[1].id).toBe('task-abc/map[1].worker#1');
  });

  it('3b. IDs use custom role when provided', async () => {
    const items = ['a'];
    const factory = mapRunner({ items, spec: makeSpec(), role: 'analyst' });
    const runner = factory();
    const ctx = makePlanContext({ task: { ...makePlanContext().task, id: 'task-xyz' } });
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const batch = first.value as SessionSpec[];
    expect(batch[0].id).toBe('task-xyz/map[0].analyst#1');
  });

  it('3c. IDs use custom attempt from spec', async () => {
    const items = ['a'];
    const factory = mapRunner({ items, spec: makeSpec({ attempt: 3 }) });
    const runner = factory();
    const ctx = makePlanContext({ task: { ...makePlanContext().task, id: 'task-abc' } });
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const batch = first.value as SessionSpec[];
    expect(batch[0].id).toBe('task-abc/map[0].worker#3');
    expect(batch[0].attempt).toBe(3);
  });

  // ── 4. Empty items ───────────────────────────────────────────────

  it('4. empty items array → plan generator returns immediately', async () => {
    const items: unknown[] = [];
    const factory = mapRunner({ items, spec: makeSpec() });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const result = await gen.next();
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  // ── 5. execute delegates to runScheduledSession ──────────────────

  it('5a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const factory = mapRunner({ items: ['a'], spec: makeSpec() });
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = {
      id: 'task-abc/map[0].worker#1',
      profile: 'executor',
      prompt: 'Process item\n\nItem: "a"',
      outputMode: 'text',
      runnerRole: 'worker',
      attempt: 1,
    };

    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('5b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const factory = mapRunner({ items: ['a'], spec: makeSpec() });
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = {
      id: 'task-abc/map[0].worker#1',
      profile: 'executor',
      prompt: 'Process item\n\nItem: "a"',
      outputMode: 'text',
      runnerRole: 'worker',
      attempt: 1,
    };

    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 6. Factory creates fresh instances ──────────────────────────

  it('6. factory returns a new runner instance each call', async () => {
    const factory = mapRunner({ items: ['a'], spec: makeSpec() });

    const runnerA = factory();
    const runnerB = factory();

    expect(runnerA).not.toBe(runnerB);
    expect(runnerA.plan).toBeInstanceOf(Function);
    expect(runnerA.execute).toBeInstanceOf(Function);
  });

  // ── 7. Spec fields propagation ──────────────────────────────────

  it('7a. spec fields (profile, outputMode, runnerRole) are propagated', async () => {
    const items = ['item-0'];
    const factory = mapRunner({
      items,
      spec: makeSpec({
        profile: 'custom-profile',
        outputMode: 'structured',
        runnerRole: 'analyst',
      }),
    });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const spec = (first.value as SessionSpec[])[0];
    expect(spec.profile).toBe('custom-profile');
    expect(spec.outputMode).toBe('structured');
    expect(spec.runnerRole).toBe('worker'); // runnerRole is set to role, not spec.runnerRole
  });

  it('7b. isReadOnly is propagated when set', async () => {
    const items = ['item-0'];
    const factory = mapRunner({
      items,
      spec: { ...makeSpec(), isReadOnly: true },
    });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const spec = (first.value as SessionSpec[])[0];
    expect(spec.isReadOnly).toBe(true);
  });

  // ── 8. Items with different types ───────────────────────────────

  it('8a. string items are handled correctly', async () => {
    const items = ['hello'];
    const factory = mapRunner({ items, spec: makeSpec() });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const spec = (first.value as SessionSpec[])[0];
    expect(spec.prompt).toContain('"hello"');
  });

  it('8b. number items are handled correctly', async () => {
    const items = [42];
    const factory = mapRunner({ items, spec: makeSpec() });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const spec = (first.value as SessionSpec[])[0];
    expect(spec.prompt).toContain('42');
  });

  it('8c. object items are handled via JSON.stringify', async () => {
    const items = [{ name: 'test', value: 1 }];
    const factory = mapRunner({ items, spec: makeSpec() });
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    const first = await gen.next([]);
    const spec = (first.value as SessionSpec[])[0];
    expect(spec.prompt).toContain('"name"');
    expect(spec.prompt).toContain('"test"');
    expect(spec.prompt).toContain('"value"');
    expect(spec.prompt).toContain('1');
  });
});
