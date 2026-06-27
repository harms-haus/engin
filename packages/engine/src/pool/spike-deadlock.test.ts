// ─── Integration Spike: Deadlock-Freedom ──────────────────────────────────
//
// Verify that composed runner trees never deadlock under the tightest
// SessionGate cap (total=1). These are real regression tests against the
// existing (done) modules — they are NOT TDD-red; they validate that the
// composition of SessionGate + runner combinators is deadlock-free.
//
// Four cases:
//   1. 8 independent gate.run calls awaited together (Promise.all) under
//      total=1 → all complete (serialize), no hang (5s timeout).
//   2. linearRunner([reviewRunner, reviewRunner]) — real runner combinators,
//      mocked runSession, real SessionGate with total=1.
//   3. linearRunner([coordinatorRunner(…, parallelRunner([…])), reviewSession])
//      — deep nesting under total=1.
//   4. Forbidden nested-held acquire: a callback that synchronously calls
//      gate.run on the same gate while holding the last total slot either
//      throws DeadlockError or completes (never hangs).
//
// Mock strategy: real SessionGate ({ total:1, perModel:{} }), mock
// runSession on the RunnerContext to resolve immediately. The runners call
// ctx.gate.run internally via the real gate.

import { describe, expect, it, mock } from 'bun:test';

import type { AgentProfile, Task } from '../core/types.js';
import { coordinatorRunner } from './runners/coordinator-runner.js';
import { linearRunner } from './runners/linear-runner.js';
import { parallelRunner } from './runners/parallel-runner.js';
import { reviewRunner } from './runners/review-runner.js';
import { singleSession } from './runners/single-session.js';
import type { RunnerContext, TaskOutcome } from './runners/types.js';
import { DeadlockError, SessionGate } from './session-gate.js';
import type { RunSessionContext, SessionResult } from './session.js';

// ─── Fixture helpers ───────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'spike-task',
    title: 'Spike deadlock test',
    prompt: 'Execute the work',
    profile: 'executor',
    files: [],
    dependencies: [],
    status: 'active',
    phaseId: 'test',
    worktree: 'none',
    ...overrides,
  };
}

function makeProfile(id: string, overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id,
    name: id,
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    thinkingLevel: 'off',
    systemPrompt: `You are ${id}.`,
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

/**
 * Build a RunnerContext with a real SessionGate (total=1) and a mock
 * runSession that resolves immediately.
 *
 * The mock runSession is a spy so tests can inspect call counts.
 */
function makeCtx(overrides?: Partial<RunnerContext>): RunnerContext {
  const task = makeTask();
  const gate = new SessionGate({ total: 1, perModel: {} });
  const profiles = new Map<string, AgentProfile>();
  profiles.set('executor', makeProfile('executor'));
  profiles.set('reviewer', makeProfile('reviewer'));
  profiles.set('coordinator', makeProfile('coordinator'));
  profiles.set('worker', makeProfile('worker'));

  return {
    task,
    gate,
    runSession: mock(async (rsctx: RunSessionContext): Promise<SessionResult> => {
      if (rsctx.spec.id.includes('review') || rsctx.spec.id.includes('coord')) {
        return {
          mode: 'structured',
          data: { approved: true },
        } satisfies SessionResult;
      }
      return {
        mode: 'text',
        text: 'mock output',
      } satisfies SessionResult;
    }),
    profiles,
    sessionBaseDir: '/tmp/spike-deadlock-sessions',
    cwd: '/tmp/project',
    activeSessions: new Set(),
    phaseId: 'test',
    agentId: 'agent-1',
    ...overrides,
  };
}

type RaceResult = { type: 'completed'; outcome: TaskOutcome } | { type: 'timeout' };

/** Safety timeout — any test that hits this wins the argument that it hung. */
function timeout(ms = 5000): Promise<RaceResult> {
  return new Promise<RaceResult>((resolve) => setTimeout(() => resolve({ type: 'timeout' }), ms));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('spike-deadlock', () => {
  // ── 1. 8 independent gate.run calls under total=1 ──────────────────────

  it('1. 8 independent gate.run() calls under total=1 serialize without hang', async () => {
    const gate = new SessionGate({ total: 1, perModel: {} });
    const profile = { provider: 'p', model: 'm' };

    const results = await Promise.all([
      gate.run(profile, async () => 'r0'),
      gate.run(profile, async () => 'r1'),
      gate.run(profile, async () => 'r2'),
      gate.run(profile, async () => 'r3'),
      gate.run(profile, async () => 'r4'),
      gate.run(profile, async () => 'r5'),
      gate.run(profile, async () => 'r6'),
      gate.run(profile, async () => 'r7'),
    ]);

    expect(results).toHaveLength(8);
    // FIFO ordering: calls complete in submission order.
    expect(results).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
  }, 5000);

  // ── 2. linearRunner([reviewRunner, reviewRunner]) under total=1 ─────────

  it('2. linearRunner([reviewRunner, reviewRunner]) under total=1 completes', async () => {
    const ctx = makeCtx();

    const runner = linearRunner([
      reviewRunner(
        {
          profile: 'executor',
          prompt: 'Execute first review block',
          outputMode: 'text',
          role: 'linear[0].executor',
          runnerRole: 'executor',
          attempt: 1,
        },
        {
          profile: 'reviewer',
          prompt: 'Review first block',
          outputMode: 'structured',
          role: 'linear[0].reviewer',
          runnerRole: 'reviewer',
          attempt: 1,
        },
      ),
      reviewRunner(
        {
          profile: 'executor',
          prompt: 'Execute second review block',
          outputMode: 'text',
          role: 'linear[1].executor',
          runnerRole: 'executor',
          attempt: 1,
        },
        {
          profile: 'reviewer',
          prompt: 'Review second block',
          outputMode: 'structured',
          role: 'linear[1].reviewer',
          runnerRole: 'reviewer',
          attempt: 1,
        },
      ),
    ]);

    const raceResult = await Promise.race([
      runner(ctx).then((o) => ({ type: 'completed' as const, outcome: o })),
      timeout(),
    ]);

    expect(raceResult.type).toBe('completed');
    if (raceResult.type === 'completed') {
      expect(raceResult.outcome.status).toBe('completed');
    }
  }, 10_000);

  // ── 3. Deep nesting: coordinatorRunner → parallelRunner → reviewSession ─

  it('3. linearRunner([coordinatorRunner(…, parallelRunner([…])), reviewSession]) under total=1 completes', async () => {
    const ctx = makeCtx();

    // The coordinator produces a structured plan. The childRunner factory
    // returns a parallelRunner with two workers based on the plan.
    const runner = linearRunner([
      coordinatorRunner(
        {
          id: `${ctx.task.id}/coord#1`,
          profile: 'coordinator',
          prompt: 'Produce a plan',
          outputMode: 'structured',
          runnerRole: 'coordinator',
          attempt: 1,
        },
        {
          childRunner: (_coordData: unknown) =>
            parallelRunner([
              singleSession({
                profile: 'worker',
                prompt: 'Execute worker 0',
                outputMode: 'text',
                role: 'worker[0]',
                runnerRole: 'worker',
                attempt: 1,
              }),
              singleSession({
                profile: 'worker',
                prompt: 'Execute worker 1',
                outputMode: 'text',
                role: 'worker[1]',
                runnerRole: 'worker',
                attempt: 1,
              }),
            ]),
        },
      ),
      singleSession({
        profile: 'reviewer',
        prompt: 'Review the work',
        outputMode: 'structured',
        role: 'reviewer',
        runnerRole: 'reviewer',
        attempt: 1,
      }),
    ]);

    const raceResult = await Promise.race([
      runner(ctx).then((o) => ({ type: 'completed' as const, outcome: o })),
      timeout(),
    ]);

    expect(raceResult.type).toBe('completed');
    if (raceResult.type === 'completed') {
      expect(raceResult.outcome.status).toBe('completed');
    }
  }, 10_000);

  // ── 4. Forbidden nested-held acquire ──────────────────────────────────
  //
  // When a callback synchronously calls gate.run on the same gate while
  // holding the last total slot, the gate either throws DeadlockError
  // (if implemented) or the inner call completes after the outer releases
  // (but in practice the inner call would hang forever since no slot is
  // available). The SessionGate #12 test accepts either outcome as long
  // as the test never hangs.

  it('4. re-entrant run() on last slot either throws DeadlockError or completes (never hangs)', async () => {
    const gate = new SessionGate({ total: 1, perModel: {} });
    const profile = { provider: 'p', model: 'm' };

    const outcome = await Promise.race([
      gate
        .run(profile, async () => {
          // Synchronous re-entrant call while holding the only slot.
          return gate.run(profile, async () => 'inner');
        })
        .then(
          () => 'completed' as const,
          (e: unknown) => {
            if (e instanceof DeadlockError) return 'deadlock-error' as const;
            throw e; // Unexpected error — let it propagate
          },
        ),
      timeout(2000),
    ]);

    // Must not hang.
    expect(outcome === 'deadlock-error' || outcome === 'completed').toBe(true);
  }, 5000);
});
