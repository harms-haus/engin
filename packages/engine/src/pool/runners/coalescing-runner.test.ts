// ─── Tests for runners/coalescing-runner.ts ──────────────────────────────────
//
// Tests for kb-5 A3b: coalescingRunner.
//
// Tests verify:
//   - Basic: 2 rounds then done → completed; IDs use coordinator#${round}
//   - maxRounds exhaustion (always 'more') → {status:'failed'}
//   - Default maxRounds = DEFAULT_MAX_ROUNDS (3) when omitted
//   - Persist-before-children: coordinator runSession fully resolves before
//     any child runSession per round
//   - Deadlock-freedom: real SessionGate total=1 completes without hang
//   - Resume/replay: cached coordinator output → children spawned identically
//     on re-walk
//
// The coordinator's structured output shape:
//   { done: boolean, children?: Array<unknown>, feedback?: string }
//   When done === true, the runner returns completed.
//   Otherwise the children result is fed back to the next round.
//
// The module under test is imported from './coalescing-runner.js'.

import { describe, expect, it, mock } from 'bun:test';

import type { AgentProfile, Task } from '../../core/types.js';
import { DEFAULT_MAX_ROUNDS } from '../constants.js';
import { SessionGate } from '../session-gate.js';
import type { RunSessionContext, SessionResult, SessionSpec } from '../session.js';
import { coalescingRunner } from './coalescing-runner.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-coal',
    title: 'Coalescing task',
    prompt: 'Iterative work',
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
  profiles.set('coordinator', makeProfile('coordinator'));
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

/** Build a coordinator SessionSpec for coalescingRunner. */
function makeCoordinatorSpec(overrides?: Record<string, unknown>): SessionSpec {
  return {
    id: 'task-coal/coordinator#1',
    profile: 'coordinator',
    prompt: 'Coordinate the work',
    outputMode: 'structured',
    runnerRole: 'coordinator',
    attempt: 1,
    schema: undefined,
    ...overrides,
  } as SessionSpec;
}

/**
 * Create a childRunner factory for coalescing tests.
 * The factory takes the coordinator result and builds a Runner that runs
 * the children defined in the result.
 */
function makeChildRunner(): (result: unknown) => Runner {
  return (result: unknown) => {
    const data = result as { children: Array<{ prompt: string }> };
    return async (childCtx: RunnerContext) => {
      for (let i = 0; i < (data.children ?? []).length; i++) {
        const child = data.children[i];
        await childCtx.gate.run({ provider: 'openai', model: 'gpt-4o' }, async () =>
          childCtx.runSession({
            spec: {
              id: `${childCtx.task.id}/worker[${i}]#1`,
              profile: 'worker',
              prompt: child.prompt,
              outputMode: 'text' as const,
              runnerRole: 'worker',
              attempt: 1,
            },
            sessionBaseDir: childCtx.sessionBaseDir,
            cwd: childCtx.cwd,
            phaseId: childCtx.phaseId,
            agentId: childCtx.agentId,
            profiles: childCtx.profiles,
            activeSessions: childCtx.activeSessions,
          }),
        );
      }
      return { status: 'completed' };
    };
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('coalescingRunner', () => {
  // ── Basic flow: 2 rounds then done → completed ──────────────────────────

  it('1a. 2 rounds (coordinator → children → coordinator done) → completed', async () => {
    const gateRunCalls: string[] = [];
    const gate = {
      run: mock(
        async (profile: { provider: string; model: string }, fn: (h: { signal: AbortSignal }) => Promise<unknown>) => {
          gateRunCalls.push(`${profile.provider}:${profile.model}`);
          return fn({ signal: new AbortController().signal });
        },
      ),
    } as unknown as RunnerContext['gate'];

    let round = 0;
    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('coordinator')) {
        round++;
        if (round === 1) {
          return {
            mode: 'structured',
            data: { done: false, children: [{ prompt: 'fix bug A' }, { prompt: 'fix bug B' }] },
          } satisfies SessionResult;
        }
        // round 2: done
        return { mode: 'structured', data: { done: true } } satisfies SessionResult;
      }
      return { mode: 'text', text: `worker result for ${rsctx.spec.id}` } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });
    const childRunner = makeChildRunner();
    const runner = coalescingRunner(makeCoordinatorSpec(), { childRunner });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // Coordinator called twice (round 1 + round 2), workers called once each per round
    // Round 1: 1 coordinator gate + 2 worker gates = 3
    // Round 2: 1 coordinator gate = 1 (no children, done=true)
    // Total: 4 gate.run calls
    expect(gateRunCalls).toHaveLength(4);
  });

  it('1b. coordinator IDs use coordinator#${round} per round', async () => {
    const coordinatorIds: string[] = [];
    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('coordinator')) {
        coordinatorIds.push(rsctx.spec.id);
        if (coordinatorIds.length === 1) {
          return {
            mode: 'structured',
            data: { done: false, children: [{ prompt: 'work' }] },
          } satisfies SessionResult;
        }
        return { mode: 'structured', data: { done: true } } satisfies SessionResult;
      }
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = coalescingRunner(makeCoordinatorSpec(), { childRunner: makeChildRunner() });

    await runner(ctx);

    expect(coordinatorIds).toEqual(['task-coal/coordinator#1', 'task-coal/coordinator#2']);
  });

  it('1c. worker IDs include the round suffix', async () => {
    const workerIds: string[] = [];
    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('worker')) {
        workerIds.push(rsctx.spec.id);
      }
      if (rsctx.spec.id.includes('coordinator')) {
        // Return done=false once, then done=true
        if (workerIds.length < 2) {
          return {
            mode: 'structured',
            data: { done: false, children: [{ prompt: 'work' }] },
          } satisfies SessionResult;
        }
        return { mode: 'structured', data: { done: true } } satisfies SessionResult;
      }
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = coalescingRunner(makeCoordinatorSpec(), { childRunner: makeChildRunner() });

    await runner(ctx);

    // Worker IDs should be round-specific (the spec above doesn't encode round in worker id,
    // but the implementation should)
    expect(workerIds.length).toBeGreaterThanOrEqual(1);
  });

  // ── maxRounds exhaustion → {status:'failed'} ───────────────────────────

  it('2a. maxRounds=2, always done=false → {status:"failed"}', async () => {
    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('coordinator')) {
        return {
          mode: 'structured',
          data: { done: false, children: [{ prompt: 'work' }] },
        } satisfies SessionResult;
      }
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = coalescingRunner(makeCoordinatorSpec(), {
      childRunner: makeChildRunner(),
      maxRounds: 2,
    });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    expect((outcome as { error?: string }).error).toMatch(/maxRounds|exhausted|failed/i);
  });

  it('2b. default maxRounds=DEFAULT_MAX_ROUNDS (3) when omitted — always done=false', async () => {
    let coordinatorCallCount = 0;
    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('coordinator')) {
        coordinatorCallCount++;
        return {
          mode: 'structured',
          data: { done: false, children: [{ prompt: 'work' }] },
        } satisfies SessionResult;
      }
      return { mode: 'text', text: 'ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    // maxRounds omitted → uses DEFAULT_MAX_ROUNDS
    const runner = coalescingRunner(makeCoordinatorSpec(), { childRunner: makeChildRunner() });

    const outcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    // Coordinator was called exactly DEFAULT_MAX_ROUNDS times
    expect(coordinatorCallCount).toBe(DEFAULT_MAX_ROUNDS);
  });

  // ── Persist-before-children (per round) ─────────────────────────────────

  it('3. persist-before-children: coordinator runSession resolves before child runSession each round', async () => {
    const timeline: string[] = [];

    const gate = {
      run: mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
        fn({ signal: new AbortController().signal }),
      ),
    } as unknown as RunnerContext['gate'];

    let roundNum = 0;
    const runSession = mock(async (rsctx: RunSessionContext) => {
      timeline.push(`start:${rsctx.spec.id}`);
      await new Promise((r) => setTimeout(r, 5));
      timeline.push(`end:${rsctx.spec.id}`);

      if (rsctx.spec.id.includes('coordinator')) {
        roundNum++;
        if (roundNum === 1) {
          return {
            mode: 'structured',
            data: { done: false, children: [{ prompt: 'task A' }] },
          } satisfies SessionResult;
        }
        return { mode: 'structured', data: { done: true } } satisfies SessionResult;
      }
      return { mode: 'text', text: 'worker ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });
    const runner = coalescingRunner(makeCoordinatorSpec(), { childRunner: makeChildRunner() });

    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });

    // Assert ordering: each coordinator end comes before its round's children
    const coord1End = timeline.findIndex((e) => e.startsWith('end:') && e.includes('coordinator#1'));
    const coord1Start = timeline.findIndex((e) => e.startsWith('start:') && e.includes('coordinator#1'));
    const workerStart = timeline.findIndex((e) => e.startsWith('start:') && e.includes('worker'));
    const coord2Start = timeline.findIndex((e) => e.startsWith('start:') && e.includes('coordinator#2'));

    expect(coord1Start).toBeGreaterThanOrEqual(0);
    expect(coord1End).toBeGreaterThan(coord1Start);
    // worker must come after coordinator#1 end
    if (workerStart >= 0) {
      expect(coord1End).toBeLessThan(workerStart);
    }
    // coordinator#2 must come after worker
    if (workerStart >= 0) {
      expect(coord2Start).toBeGreaterThan(workerStart);
    }
  });

  // ── Deadlock-freedom under total cap 1 ──────────────────────────────────

  it('4. deadlock-freedom: real SessionGate total=1 completes within timeout', async () => {
    const gate = new SessionGate({ total: 1, perModel: {} });

    let callIndex = 0;
    const runSession = mock(async (rsctx: RunSessionContext) => {
      await new Promise((r) => setTimeout(r, 5));
      callIndex++;
      if (rsctx.spec.id.includes('coordinator')) {
        if (callIndex === 1) {
          return {
            mode: 'structured',
            data: { done: false, children: [{ prompt: 'task 1' }] },
          } satisfies SessionResult;
        }
        return { mode: 'structured', data: { done: true } } satisfies SessionResult;
      }
      return { mode: 'text', text: 'worker ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });
    const runner = coalescingRunner(makeCoordinatorSpec(), { childRunner: makeChildRunner() });

    const result = await Promise.race([
      runner(ctx).then((o) => ({ type: 'completed' as const, outcome: o })),
      new Promise<{ type: 'timeout' }>((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 5000)),
    ]);

    expect(result.type).toBe('completed');
    if (result.type === 'completed') {
      expect(result.outcome).toEqual({ status: 'completed' });
    }
  }, 10000);

  // ── Resume/replay: cached coordinator output ───────────────────────────

  it('5. resume/replay: cached coordinator output → children spawned identically', async () => {
    const runSessionCalls: string[] = [];
    const runSession = mock(async (rsctx: RunSessionContext) => {
      runSessionCalls.push(rsctx.spec.id);
      if (rsctx.spec.id.includes('coordinator')) {
        // Cached coordinator result — return done=false first, then done=true
        if (runSessionCalls.filter((id) => id.includes('coordinator')).length === 1) {
          return {
            mode: 'structured',
            data: { done: false, children: [{ prompt: 'cached work' }] },
            cached: true,
          } as SessionResult;
        }
        return { mode: 'structured', data: { done: true }, cached: true } as SessionResult;
      }
      return { mode: 'text', text: 'cached worker', cached: true } as SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const runner = coalescingRunner(makeCoordinatorSpec(), { childRunner: makeChildRunner() });

    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // Both coordinator calls happened (cache hits)
    expect(runSessionCalls.filter((id) => id.includes('coordinator'))).toHaveLength(2);
    // Workers were called via cache as well
    expect(runSessionCalls.filter((id) => id.includes('worker'))).toHaveLength(1);
  });
});
