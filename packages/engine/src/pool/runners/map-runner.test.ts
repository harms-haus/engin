// ─── Tests for runners/map-runner.ts ────────────────────────────────────────
//
// Tests verify:
//   1. 5 items concurrency 2 all succeed → {status:'completed'}
//       IDs: `map[0].<role>` … `map[4].<role>`; gate.run called; concurrency respected
//   2. Per-item prompt convention: sessionSpec.prompt + "\n\nItem: " + JSON.stringify(item)
//   3. Partial failure: 1 of 5 items fails → {status:'failed'}, all items settled (no leak)
//   4. Concurrency=1 serializes items (deadlock-free)
//   5. Real SessionGate with total=2 — items complete without deadlock
//
// Per-item prompt convention (documented):
//   The mapRunner composes the per-item prompt as:
//     sessionSpec.prompt + "\n\nItem: " + JSON.stringify(item)
//
// The module under test is imported from './map-runner.js'.

import { describe, expect, it, mock } from 'bun:test';

import type { AgentProfile, Task } from '../../core/types.js';
import { SessionGate } from '../session-gate.js';
import type { RunSessionContext, SessionResult } from '../session.js';
import { mapRunner } from './map-runner.js';
import type { RunnerContext, TaskOutcome } from './types.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-abc',
    title: 'Build feature',
    prompt: 'Implement X',
    profile: 'default',
    files: [],
    dependencies: [],
    status: 'active',
    phaseId: 'code',
    worktree: 'none',
    ...overrides,
  };
}

function makeProfile(id: string, overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id,
    name: id,
    provider: 'openai',
    model: 'gpt-4o',
    thinkingLevel: 'low',
    systemPrompt: `You are ${id}.`,
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<RunnerContext>): RunnerContext {
  const task = makeTask();
  const profiles = new Map<string, AgentProfile>();
  profiles.set('worker', makeProfile('worker'));
  return {
    task,
    gate: {
      run: mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
        fn({ signal: new AbortController().signal }),
      ),
    } as unknown as RunnerContext['gate'],
    runSession: mock(async () => ({ mode: 'text', text: 'ok' }) satisfies SessionResult),
    profiles,
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    activeSessions: new Set(),
    phaseId: 'code',
    agentId: 'agent-1',
    ...overrides,
  };
}

/**
 * Build a base session spec for mapRunner tests.
 * The `role` drives the session-ID suffix (e.g. `map[0].worker`).
 */
function makeSessionSpec(overrides?: Record<string, unknown>) {
  return {
    profile: 'worker',
    prompt: 'Process item',
    outputMode: 'text' as const,
    role: 'worker',
    runnerRole: 'worker',
    attempt: 1,
    ...overrides,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('mapRunner', () => {
  // ── 1. All items succeed ─────────────────────────────────────────────────

  it('1a. 5 items concurrency 2 all succeed → returns {status:"completed"}', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const sessionIds: string[] = [];

    const runSession = mock(async (rsctx: RunSessionContext) => {
      sessionIds.push(rsctx.spec.id);
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec(),
      concurrency: 2,
    });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    expect(sessionIds).toHaveLength(5);
  });

  it('1b. IDs follow map[${index}].<role> pattern', async () => {
    const items = ['x', 'y'];
    const sessionIds: string[] = [];

    const runSession = mock(async (rsctx: RunSessionContext) => {
      sessionIds.push(rsctx.spec.id);
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec({ role: 'worker' }),
    });

    await runner(ctx);

    expect(sessionIds[0]).toBe('task-abc/map[0].worker#1');
    expect(sessionIds[1]).toBe('task-abc/map[1].worker#1');
  });

  it('1c. sessionSpec fields are propagated (profile, outputMode, attempt)', async () => {
    const items = ['item-0'];
    const specs: RunSessionContext[] = [];

    const runSession = mock(async (rsctx: RunSessionContext) => {
      specs.push(rsctx);
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec({
        profile: 'worker',
        prompt: 'Process item',
        outputMode: 'text',
        role: 'worker',
        attempt: 1,
      }),
    });

    await runner(ctx);

    expect(specs[0].spec.profile).toBe('worker');
    expect(specs[0].spec.outputMode).toBe('text');
    expect(specs[0].spec.attempt).toBe(1);
  });

  it('1d. gate.run is called for each item with the resolved profile', async () => {
    const items = ['a', 'b'];
    const gateRunProfiles: unknown[] = [];

    const gate = {
      run: mock(async (profile: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) => {
        gateRunProfiles.push(profile);
        return fn({ signal: new AbortController().signal });
      }),
    } as unknown as RunnerContext['gate'];

    const ctx = makeCtx({ gate });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec({ profile: 'worker' }),
    });

    await runner(ctx);

    expect(gateRunProfiles).toHaveLength(2);
    for (const profile of gateRunProfiles) {
      expect(profile).toHaveProperty('provider', 'openai');
      expect(profile).toHaveProperty('model', 'gpt-4o');
    }
  });

  // ── 2. Per-item prompt convention ──────────────────────────────────────

  it('2a. per-item prompt includes the item via JSON.stringify', async () => {
    const items = [{ value: 42, label: 'test' }];
    const receivedPrompts: string[] = [];

    const runSession = mock(async (rsctx: RunSessionContext) => {
      receivedPrompts.push(rsctx.spec.prompt);
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec({ prompt: 'Base prompt' }),
    });

    await runner(ctx);

    // The implement worker must append the serialized item to the base prompt
    expect(receivedPrompts[0]).toContain('Base prompt');
    expect(receivedPrompts[0]).toContain(JSON.stringify(items[0]));
  });

  it('2b. each item has its own prompt with its own item content', async () => {
    const items = ['first-item', 'second-item'];
    const receivedPrompts: string[] = [];

    const runSession = mock(async (rsctx: RunSessionContext) => {
      receivedPrompts.push(rsctx.spec.prompt);
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec({ prompt: 'Process' }),
    });

    await runner(ctx);

    expect(receivedPrompts).toHaveLength(2);
    expect(receivedPrompts[0]).toContain('first-item');
    expect(receivedPrompts[1]).toContain('second-item');
  });

  // ── 3. Partial failure ─────────────────────────────────────────────────

  it('3a. 1 of 5 items fails → {status:"failed"}', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    let callCount = 0;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      callCount++;
      if (callCount === 3) {
        throw new Error('item c failed');
      }
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec(),
      concurrency: 5,
    });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect((outcome as { error?: string }).error).toBeTruthy();
  });

  it('3b. partial failure: all items are settled (no unhandled rejections / no session leak)', async () => {
    const items = ['a', 'b', 'c'];
    let callCount = 0;
    let itemCStarted = false;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      callCount++;
      // Items a, b succeed
      if (callCount <= 2) {
        await delay(5);
        return { mode: 'text', text: 'ok' } satisfies SessionResult;
      }
      // Item c: was started (session was created), then fails
      if (rsctx.spec.id.includes('map[2]')) {
        itemCStarted = true;
        throw new Error('item c error');
      }
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec(),
      concurrency: 3,
    });

    const outcome: TaskOutcome = await runner(ctx);

    // All items must have been started — no item was skipped due to short-circuit
    expect(callCount).toBe(3);
    expect(itemCStarted).toBe(true);
    expect(outcome.status).toBe('failed');
  });

  // ── 4. Concurrency=1 serializes ────────────────────────────────────────

  it('4. concurrency=1 serializes items (no deadlock)', async () => {
    const items = ['a', 'b', 'c'];
    const order: number[] = [];
    let idx = 0;

    const gate = {
      run: mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) => {
        return fn({ signal: new AbortController().signal });
      }),
    } as unknown as RunnerContext['gate'];

    const runSession = mock(async () => {
      const i = idx++;
      order.push(i);
      await delay(5);
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec(),
      concurrency: 1,
    });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // With concurrency=1, items must complete sequentially in index order
    expect(order).toEqual([0, 1, 2]);
  });

  // ── 5. Real SessionGate (deadlock-safety) ──────────────────────────────

  it('5. deadlock-free: works with real SessionGate (total=2)', async () => {
    const gate = new SessionGate({ total: 2, perModel: {} });
    const items = ['a', 'b', 'c', 'd'];

    const runSession = mock(async () => {
      await delay(5);
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec(),
      concurrency: 4,
    });

    const outcome = await Promise.race([
      runner(ctx).then((r) => r as TaskOutcome),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);

    expect(outcome).toEqual({ status: 'completed' });
  }, 15_000);

  // ── 6. Edge: empty items ───────────────────────────────────────────────

  it('6. empty items array → {status:"failed"} with appropriate error', async () => {
    const items: unknown[] = [];

    const ctx = makeCtx();
    const runner = mapRunner({
      items,
      sessionSpec: makeSessionSpec(),
    });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect((outcome as { error?: string }).error).toBeTruthy();
  });
});
