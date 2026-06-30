// ─── Integration Spike: Deadlock-Freedom (SessionPlan contract) ──────────
//
// Verify that composed SessionPlan runner trees never deadlock when driven
// through the SessionScheduler under the tightest SessionGate cap (total=1).
// These are real regression tests against the existing (done) modules — they
// are NOT TDD-red; they validate that the composition of SessionGate +
// SessionScheduler + SessionPlan runner combinators is deadlock-free.
//
// Two cases (gate-level serialization under total=1 and the forbidden
// nested-held acquire are covered in session-gate.test.ts and are
// intentionally NOT duplicated here):
//   1. A single task whose runnerFactory is
//      linearRunner([reviewRunner(…), reviewRunner(…)]) driven through the
//      SessionScheduler under total=1 → task reaches 'complete', no hang.
//   2. A single task whose runnerFactory is
//      linearRunner([coordinatorRunner(…, parallelRunner([…])), singleSession])
//      — deep nesting — driven through the SessionScheduler under total=1 →
//      task reaches 'complete', no hang.
//
// Mock strategy: real SessionGate ({ total:1, perModel:{} }),
// real SessionScheduler + TaskGraph, and REAL SessionPlan combinators
// (linearRunner / coordinatorRunner / parallelRunner / reviewRunner /
// singleSession). The top-level runner's `execute` is swapped for a canned
// resolver (see {@link withCannedExecute}) so no real agent sessions are
// spun up. This is sound because the SessionScheduler only ever invokes the
// TOP-LEVEL runner's `execute` — child runners are driven solely through
// their `plan()` generators, which the parent forwards. Crucially, this file
// does NOT register a process-global `mock.module` for runScheduledSession,
// so it cannot interfere with sibling spike files that exercise the real
// runSession path.

import { describe, expect, it } from 'bun:test';

import type { AgentProfile, Task } from '../core/types.js';

import { coordinatorRunner } from './runners/coordinator-runner.js';
import { linearRunner } from './runners/linear-runner.js';
import { parallelRunner } from './runners/parallel-runner.js';
import { reviewRunner } from './runners/review-runner.js';
import type { SessionPlanContext, SessionPlanRunner } from './runners/session-plan-types.js';
import { singleSession } from './runners/single-session.js';
import { SessionGate } from './session-gate.js';
import { SessionScheduler } from './session-scheduler.js';
import type { SessionResult, SessionSpec } from './session.js';
import { TaskGraph } from './task-graph.js';

// ─── Fixture helpers ───────────────────────────────────────────────────────

function makeTask(id: string, overrides?: Partial<Task>): Task {
  return {
    id,
    title: `Task ${id}`,
    prompt: `prompt-${id}`,
    profile: 'executor',
    files: [],
    dependencies: [],
    status: 'ready',
    phaseId: 'test',
    worktree: 'none',
    ...overrides,
  };
}

function makeProfile(id: string): AgentProfile {
  return {
    id,
    name: id,
    provider: 'p',
    model: 'm',
    thinkingLevel: 'off',
    systemPrompt: `You are ${id}.`,
    excludeTools: [],
    includeTools: [],
  };
}

const profiles = new Map<string, AgentProfile>([
  ['executor', makeProfile('executor')],
  ['reviewer', makeProfile('reviewer')],
  ['coordinator', makeProfile('coordinator')],
  ['worker', makeProfile('worker')],
]);

/**
 * Wrap a SessionPlanRunner, replacing its `execute` with a canned resolver
 * that returns immediately (no real session / model calls). Structured-mode
 * sessions (e.g. reviews) approve so the review loop terminates in one round;
 * text sessions return a canned string.
 *
 * The SessionScheduler only ever calls the TOP-LEVEL runner's `execute` — it
 * never reaches into child runners' `execute` methods (children are driven
 * solely via their `plan()` generators, which the parent forwards). So this
 * single override intercepts every session the scheduler starts, regardless
 * of how deeply the runner tree is composed.
 */
function withCannedExecute(runner: SessionPlanRunner): SessionPlanRunner {
  const cannedExecute = async (_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> => {
    if (spec.outputMode === 'structured') {
      return { mode: 'structured', data: { approved: true } };
    }
    return { mode: 'text', text: 'mock output' };
  };

  return { ...runner, execute: cannedExecute };
}

/** Race a promise against a safety timeout — any test that hits this wins the
 *  argument that it hung. */
function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT: hung after ${ms}ms`)), ms)),
  ]);
}

/** Build a SessionScheduler + TaskGraph with a real SessionGate and the given
 *  tasks (each with a runnerFactory). Default total capacity is 1 (the
 *  tightest cap — exercises serialization / parking / unparking). */
function buildScheduler(
  tasks: Array<{ task: Task; runnerFactory: () => SessionPlanRunner }>,
  total = 1,
): SessionScheduler {
  const graph = new TaskGraph();
  for (const { task, runnerFactory } of tasks) {
    graph.addTask(task, runnerFactory);
  }
  const gate = new SessionGate({ total, perModel: {} });
  return new SessionScheduler({
    graph,
    gate,
    profiles,
    sessionBaseDir: '/tmp/spike-deadlock-sessions',
    cwd: '/tmp/project',
    activeSessions: new Set(),
    phaseId: 'test',
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('spike-deadlock', () => {
  // ── 1. linearRunner([reviewRunner, reviewRunner]) under total=1 ─────────

  it('1. linearRunner([reviewRunner, reviewRunner]) under total=1 completes via scheduler', async () => {
    const taskId = 'spike-linear';

    const runnerFactory = (): SessionPlanRunner =>
      withCannedExecute(
        linearRunner([
          reviewRunner(
            {
              profile: 'executor',
              prompt: 'Execute first review block',
              outputMode: 'text',
              role: 'linear-exec-0',
            },
            {
              profile: 'reviewer',
              prompt: 'Review first block',
              outputMode: 'structured',
              role: 'linear-review-0',
            },
          )(),
          reviewRunner(
            {
              profile: 'executor',
              prompt: 'Execute second review block',
              outputMode: 'text',
              role: 'linear-exec-1',
            },
            {
              profile: 'reviewer',
              prompt: 'Review second block',
              outputMode: 'structured',
              role: 'linear-review-1',
            },
          )(),
        ])(),
      );

    const scheduler = buildScheduler([{ task: makeTask(taskId), runnerFactory }]);

    const result = await withTimeout(scheduler.run());

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
  });

  // ── 2. Deep nesting: coordinatorRunner → parallelRunner → singleSession ─

  it('2. linearRunner([coordinatorRunner(…, parallelRunner([…])), singleSession]) under total=1 completes', async () => {
    const taskId = 'spike-coord';

    const runnerFactory = (): SessionPlanRunner =>
      withCannedExecute(
        linearRunner([
          coordinatorRunner(
            {
              id: `${taskId}/coord#1`,
              profile: 'coordinator',
              prompt: 'Produce a plan',
              outputMode: 'text',
              runnerRole: 'coordinator',
              attempt: 1,
            },
            {
              childRunner: () =>
                parallelRunner([
                  singleSession({
                    profile: 'worker',
                    prompt: 'Execute worker 0',
                    outputMode: 'text',
                    role: 'worker[0]',
                    runnerRole: 'worker',
                    attempt: 1,
                  })(),
                  singleSession({
                    profile: 'worker',
                    prompt: 'Execute worker 1',
                    outputMode: 'text',
                    role: 'worker[1]',
                    runnerRole: 'worker',
                    attempt: 1,
                  })(),
                ])(),
            },
          )(),
          singleSession({
            profile: 'reviewer',
            prompt: 'Review the work',
            outputMode: 'structured',
            role: 'final-review',
            runnerRole: 'reviewer',
            attempt: 1,
          })(),
        ])(),
      );

    const scheduler = buildScheduler([{ task: makeTask(taskId), runnerFactory }]);

    const result = await withTimeout(scheduler.run());

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
  });
});
