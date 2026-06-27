// ─── Tests for runners/branch-runner.ts ──────────────────────────────────────
//
// Tests verify:
//   1. First-matching condition runs; remaining branches NOT evaluated
//   2. No branch matches + default provided → default runner executes
//   3. No branch matches + no default → {status:'failed', error:'No branch matched'}
//   4. Conditions evaluated in strict order; only first matching runner invoked
//   5. Async conditions (return Promise<boolean>) work correctly
//
// The module under test is imported from './branch-runner.js'.

import { describe, expect, it, mock } from 'bun:test';

import type { AgentProfile, Task } from '../../core/types.js';
import type { SessionResult } from '../session.js';
import { branchRunner } from './branch-runner.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';

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
 * Create a mock Runner that tracks calls and returns the given outcome.
 * Optionally collects the RunnerContext objects passed to it.
 */
function makeMockRunner(outcome: TaskOutcome, capturedCtx?: RunnerContext[]): Runner {
  return mock(async (ctx: RunnerContext) => {
    capturedCtx?.push(ctx);
    return outcome;
  }) as Runner;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('branchRunner', () => {
  // ── 1. First matching condition runs ────────────────────────────────────

  it('1a. first condition matches → its runner executes', async () => {
    const runnerA = makeMockRunner({ status: 'completed' });
    const runnerB = makeMockRunner({ status: 'completed' });

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [
        { condition: () => true, runner: runnerA },
        { condition: () => true, runner: runnerB },
      ],
    });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    expect(runnerA).toHaveBeenCalledTimes(1);
  });

  it('1b. second runner NOT invoked when first matches', async () => {
    const runnerA = makeMockRunner({ status: 'completed' });
    const runnerB = makeMockRunner({ status: 'completed' });

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [
        { condition: () => true, runner: runnerA },
        { condition: () => true, runner: runnerB },
      ],
    });

    await runner(ctx);

    expect(runnerA).toHaveBeenCalledTimes(1);
    expect(runnerB).not.toHaveBeenCalled();
  });

  it('1c. the child runner receives the parent RunnerContext (same task id)', async () => {
    const capturedCtx: RunnerContext[] = [];
    const childRunner = makeMockRunner({ status: 'completed' }, capturedCtx);

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [{ condition: () => true, runner: childRunner }],
    });

    await runner(ctx);

    expect(capturedCtx).toHaveLength(1);
    expect(capturedCtx[0].task.id).toBe('task-abc');
  });

  // ── 2. No match + default → default runs ───────────────────────────────

  it('2. no matching branch + default provided → default runner executes', async () => {
    const defaultRunner = makeMockRunner({ status: 'completed' });

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [
        { condition: () => false, runner: makeMockRunner({ status: 'completed' }) },
        { condition: () => false, runner: makeMockRunner({ status: 'completed' }) },
      ],
      default: defaultRunner,
    });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    expect(defaultRunner).toHaveBeenCalledTimes(1);
  });

  it('2b. default runner also receives the parent RunnerContext', async () => {
    const capturedCtx: RunnerContext[] = [];
    const defaultRunner = makeMockRunner({ status: 'completed' }, capturedCtx);

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [{ condition: () => false, runner: makeMockRunner({ status: 'completed' }) }],
      default: defaultRunner,
    });

    await runner(ctx);

    expect(capturedCtx).toHaveLength(1);
    expect(capturedCtx[0].task.id).toBe('task-abc');
  });

  // ── 3. No match + no default → failed ──────────────────────────────────

  it('3. no matching branch + no default → {status:"failed", error matches /no branch matched/i}', async () => {
    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [{ condition: () => false, runner: makeMockRunner({ status: 'completed' }) }],
    });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect((outcome as { error?: string }).error).toMatch(/no branch matched/i);
  });

  // ── 4. Conditions evaluated in order ───────────────────────────────────

  it('4a. conditions evaluated in order; first match stops evaluation', async () => {
    const evalOrder: number[] = [];

    const runnerA = makeMockRunner({ status: 'completed' });
    const runnerB = makeMockRunner({ status: 'completed' });

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [
        {
          condition: () => {
            evalOrder.push(0);
            return true;
          },
          runner: runnerA,
        },
        {
          condition: () => {
            evalOrder.push(1);
            return true;
          },
          runner: runnerB,
        },
      ],
    });

    await runner(ctx);

    // Second condition should not have been evaluated since first matched
    expect(evalOrder).toEqual([0]);
    expect(runnerA).toHaveBeenCalledTimes(1);
    expect(runnerB).not.toHaveBeenCalled();
  });

  it('4b. when first condition is false, second is evaluated and its runner runs', async () => {
    const evalOrder: number[] = [];

    const runnerA = makeMockRunner({ status: 'completed' });
    const runnerB = makeMockRunner({ status: 'completed' });

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [
        {
          condition: () => {
            evalOrder.push(0);
            return false;
          },
          runner: runnerA,
        },
        {
          condition: () => {
            evalOrder.push(1);
            return true;
          },
          runner: runnerB,
        },
      ],
    });

    await runner(ctx);

    expect(evalOrder).toEqual([0, 1]);
    expect(runnerA).not.toHaveBeenCalled();
    expect(runnerB).toHaveBeenCalledTimes(1);
  });

  // ── 5. Async conditions ────────────────────────────────────────────────

  it('5a. async condition (returns Promise<true>) → matching runner executes', async () => {
    const runnerA = makeMockRunner({ status: 'completed' });

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [
        {
          condition: async () => {
            await delay(5);
            return true;
          },
          runner: runnerA,
        },
      ],
    });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    expect(runnerA).toHaveBeenCalledTimes(1);
  });

  it('5b. async conditions evaluated in order; first true match stops further evaluation', async () => {
    const evalOrder: number[] = [];

    const runnerA = makeMockRunner({ status: 'completed' });
    const runnerB = makeMockRunner({ status: 'completed' });

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [
        {
          condition: async () => {
            evalOrder.push(0);
            await delay(5);
            return true;
          },
          runner: runnerA,
        },
        {
          condition: async () => {
            evalOrder.push(1);
            return true;
          },
          runner: runnerB,
        },
      ],
    });

    await runner(ctx);

    expect(evalOrder).toEqual([0]);
    expect(runnerA).toHaveBeenCalledTimes(1);
    expect(runnerB).not.toHaveBeenCalled();
  });

  it('5c. async condition returning false → continues to next branch', async () => {
    const runnerB = makeMockRunner({ status: 'completed' });

    const ctx = makeCtx();
    const runner = branchRunner({
      branches: [
        {
          condition: async () => {
            await delay(5);
            return false;
          },
          runner: makeMockRunner({ status: 'completed' }),
        },
        {
          condition: () => true,
          runner: runnerB,
        },
      ],
    });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    expect(runnerB).toHaveBeenCalledTimes(1);
  });
});
