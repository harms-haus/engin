// ─── Tests for runners/single-session.ts ────────────────────────────────────
//
// Tests 1–3, 13 from the kb-4 contract spec.
//
// Tests verify:
//   1. success → {status:'completed'}; SessionError → rethrows; deterministic ID
//   2. gate.run is called with the correct resolved profile
//  13. deadlock-safety: singleSession under a real SessionGate with total=1 completes
//
// The module under test is imported from './single-session.js'.

import { describe, expect, it, mock } from 'bun:test';

import type { AgentProfile, Task } from '../../core/types.js';
import { SessionGate } from '../session-gate.js';
import type { SessionResult } from '../session.js';
import { SessionError } from '../session.js';
import { singleSession } from './single-session.js';
import type { RunnerContext, TaskOutcome } from './types.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-abc',
    title: 'Build feature',
    prompt: 'Implement X',
    profile: 'executor',
    files: [],
    dependencies: [],
    status: 'active',
    phaseId: 'code',
    worktree: 'none',
    ...overrides,
  };
}

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'executor',
    name: 'Executor',
    provider: 'openai',
    model: 'gpt-4o',
    thinkingLevel: 'low',
    systemPrompt: 'You are an executor.',
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<RunnerContext>): RunnerContext {
  const task = makeTask();
  const profiles = new Map<string, AgentProfile>();
  profiles.set('executor', makeProfile());
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

/** Build a spec for singleSession — uses `role` (the public API name). */
function makeSpec(overrides?: Record<string, unknown>) {
  return {
    profile: 'executor',
    prompt: 'Do the work',
    outputMode: 'text' as const,
    role: 'executor',
    runnerRole: 'executor',
    attempt: 1,
    ...overrides,
  };
}

function makeSessionError(msg: string, retryable = false): SessionError {
  return new SessionError(msg, { kind: retryable ? 'transient' : 'permanent', retryable });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('singleSession', () => {
  // ── 1. success / failure / deterministic ID ──────────────────────────────

  it('1a. success → returns {status: "completed"}', async () => {
    const ctx = makeCtx();
    const runner = singleSession(makeSpec());
    const outcome: TaskOutcome = await runner(ctx);
    expect(outcome.status).toBe('completed');
  });

  it('1b. SessionError → propagates (rethrows)', async () => {
    const error = makeSessionError('agent crashed');
    const ctx = makeCtx({
      runSession: mock(async () => {
        throw error;
      }),
    });
    const runner = singleSession(makeSpec());

    await expect(runner(ctx)).rejects.toBe(error);
  });

  it('1c. deterministic ID is `${taskId}/${role}#1` and runnerRole matches role', async () => {
    const ctx = makeCtx();
    const runner = singleSession(makeSpec({ role: 'executor' }));

    await runner(ctx);

    const call = (ctx.runSession as ReturnType<typeof mock>).mock.calls[0];
    const specPassed = call[0].spec as { id: string; runnerRole: string; attempt: number };
    expect(specPassed.id).toBe('task-abc/executor#1');
    expect(specPassed.runnerRole).toBe('executor');
    expect(specPassed.attempt).toBe(1);
  });

  // ── 2. gate.run is used with the correct profile ─────────────────────────

  it('2. gate.run is called with the profile resolved from ctx.profiles', async () => {
    const gateRunMock = mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
      fn({ signal: new AbortController().signal }),
    );
    const ctx = makeCtx({
      gate: { run: gateRunMock } as unknown as RunnerContext['gate'],
    });
    const runner = singleSession(makeSpec());

    await runner(ctx);

    expect(gateRunMock).toHaveBeenCalledTimes(1);
    const profileArg = (gateRunMock as ReturnType<typeof mock>).mock.calls[0][0] as { provider: string; model: string };
    expect(profileArg.provider).toBe('openai');
    expect(profileArg.model).toBe('gpt-4o');
  });

  // ── 13. deadlock-safety: real SessionGate with total=1 ───────────────────

  it('13. deadlock-safety: completes under a real SessionGate with total=1', async () => {
    const gate = new SessionGate({ total: 1, perModel: {} });
    const ctx = makeCtx({ gate });
    const runner = singleSession(makeSpec());

    const result = await Promise.race([
      runner(ctx).then(() => 'completed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);

    expect(result).toBe('completed');
  }, 5000);
});
