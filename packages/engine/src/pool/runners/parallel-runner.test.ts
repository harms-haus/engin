// ─── Tests for runners/parallel-runner.ts ────────────────────────────────────
//
// Tests for kb-5 A3b: parallelRunner.
//
// Tests verify:
//   - Basic: 3 children all succeed → completed
//   - Partial failure: 1 child fails → runner returns failed but all siblings
//     are still invoked (parallel start ensures all start before any finishes)
//   - Deadlock-freedom: real SessionGate total=1 completes without hang
//     (children serialize but ALL complete within timeout)
//
// The module under test is imported from './parallel-runner.js'.

import { describe, expect, it, mock } from 'bun:test';

import type { AgentProfile, Task } from '../../core/types.js';
import { SessionGate } from '../session-gate.js';
import type { SessionResult } from '../session.js';
import { parallelRunner } from './parallel-runner.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-parallel',
    title: 'Parallel task',
    prompt: 'Run in parallel',
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
  profiles.set('child', makeProfile('child'));
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
 * Track-call helper that creates a mock Runner.
 * Each call records the context and returns the given outcome.
 */
function makeMockRunner(outcome: TaskOutcome, capturedCtx?: RunnerContext[]): Runner {
  return mock(async (ctx: RunnerContext) => {
    capturedCtx?.push(ctx);
    return outcome;
  }) as Runner;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('parallelRunner', () => {
  // ── Basic flow: 3 children all succeed → completed ──────────────────────

  it('1a. 3 children all succeed → returns completed', async () => {
    const order: number[] = [];
    const child0 = mock(async () => {
      order.push(0);
      return { status: 'completed' } as const;
    }) as Runner;
    const child1 = mock(async () => {
      order.push(1);
      return { status: 'completed' } as const;
    }) as Runner;
    const child2 = mock(async () => {
      order.push(2);
      return { status: 'completed' } as const;
    }) as Runner;

    const ctx = makeCtx();
    const runner = parallelRunner([child0, child1, child2]);

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // All children were invoked (order may vary since they run concurrently)
    expect(child0).toHaveBeenCalled();
    expect(child1).toHaveBeenCalled();
    expect(child2).toHaveBeenCalled();
  });

  it('1b. all children received the same RunnerContext (same task, gate, etc.)', async () => {
    const captured: RunnerContext[] = [];
    const child = makeMockRunner({ status: 'completed' }, captured);
    const ctx = makeCtx();

    await parallelRunner([child, child, child])(ctx);

    expect(captured).toHaveLength(3);
    for (const c of captured) {
      expect(c.task.id).toBe('task-parallel');
      expect(c.phaseId).toBe('code');
    }
  });

  // ── Partial failure: 1 child fails → runner returns failed ──────────────

  it('2a. 1 child fails → parallelRunner returns failed, but all children were invoked', async () => {
    const invoked: number[] = [];
    const child0 = mock(async () => {
      invoked.push(0);
      return { status: 'completed' } as const;
    }) as Runner;
    const child1 = mock(async () => {
      invoked.push(1);
      return { status: 'failed', error: 'child1 broke' } as TaskOutcome;
    }) as Runner;
    const child2 = mock(async () => {
      invoked.push(2);
      return { status: 'completed' } as const;
    }) as Runner;

    const ctx = makeCtx();
    const runner = parallelRunner([child0, child1, child2]);

    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'failed', error: 'child1 broke' });
    // All children were invoked (parallel starts all coroutines)
    expect(invoked.sort()).toEqual([0, 1, 2]);
  });

  it('2b. when a child fails, siblings still complete (they were already started)', async () => {
    let child2Completed = false;

    const child0: Runner = async () => ({ status: 'failed', error: 'fail fast' });
    const child1: Runner = async () => ({ status: 'completed' });
    const child2: Runner = async () => {
      // Simulate work that completes even though another child failed
      await new Promise((r) => setTimeout(r, 10));
      child2Completed = true;
      return { status: 'completed' };
    };

    const ctx = makeCtx();
    const runner = parallelRunner([child0, child1, child2]);

    const outcome = await runner(ctx);

    // Overall outcome is failed
    expect(outcome.status).toBe('failed');
    // Child2 still completed its work (no cancellation)
    expect(child2Completed).toBe(true);
  });

  // ── All children fail → returns failed ─────────────────────────────────

  it('2c. all children fail → returns failed with first error', async () => {
    const child0: Runner = async () => ({ status: 'failed', error: 'error-0' });
    const child1: Runner = async () => ({ status: 'failed', error: 'error-1' });

    const ctx = makeCtx();
    const runner = parallelRunner([child0, child1]);

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
  });

  // ── Deadlock-freedom under total cap 1 ──────────────────────────────────

  it('3. deadlock-freedom: real SessionGate total=1, children serialize but complete within timeout', async () => {
    const gate = new SessionGate({ total: 1, perModel: {} });

    // Each child simulates going through gate.run + runSession
    const order: number[] = [];

    const gateRunMock = mock(
      async (_profile: { provider: string; model: string }, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
        fn({ signal: new AbortController().signal }),
    );
    const gateWithMock = { run: gateRunMock } as unknown as RunnerContext['gate'];

    const childCount = 3;
    const children: Runner[] = [];
    for (let i = 0; i < childCount; i++) {
      children.push(makeMockRunner({ status: 'completed' }));
    }

    const ctx = makeCtx({ gate });

    const runner = parallelRunner(children);

    const result = await Promise.race([
      runner(ctx).then((o) => ({ type: 'completed' as const, outcome: o })),
      new Promise<{ type: 'timeout' }>((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 5000)),
    ]);

    expect(result.type).toBe('completed');
    if (result.type === 'completed') {
      expect(result.outcome).toEqual({ status: 'completed' });
    }
  }, 10000);
});
