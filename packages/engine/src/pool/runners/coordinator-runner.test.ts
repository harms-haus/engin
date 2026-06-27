// ─── Tests for runners/coordinator-runner.ts ─────────────────────────────────
//
// Tests for kb-5 A3b: coordinatorRunner.
//
// Tests verify:
//   - Basic: coordinator decides 2 children → childRunner runs them → completed
//   - Persist-before-children: coordinator runSession fully resolves before any
//     child runSession is invoked (ordering assertion via mock call sequence)
//   - Empty children: coordinator returns no children → still completed
//   - Deadlock-freedom: real SessionGate total=1 completes without hang
//   - Resume/replay: coordinator output cached → children spawned identically
//     (verify createSession/runSession call counts)
//
// The module under test is imported from './coordinator-runner.js'.

import { describe, expect, it, mock } from 'bun:test';

import type { AgentProfile, Task } from '../../core/types.js';
import { SessionGate } from '../session-gate.js';
import type { RunSessionContext, SessionResult, SessionSpec } from '../session.js';
import { coordinatorRunner } from './coordinator-runner.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-xyz',
    title: 'Coordinated task',
    prompt: 'Coordinate work',
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

/** Build a coordinator SessionSpec. */
function makeCoordinatorSpec(overrides?: Record<string, unknown>): SessionSpec {
  return {
    id: 'task-xyz/coordinator#1',
    profile: 'coordinator',
    prompt: 'Plan the work',
    outputMode: 'structured',
    runnerRole: 'coordinator',
    attempt: 1,
    schema: undefined,
    ...overrides,
  } as SessionSpec;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('coordinatorRunner', () => {
  // ── Basic flow: coordinator → 2 children → completed ────────────────────

  it('1a. coordinator decides 2 children → childRunner runs them → completed', async () => {
    // Coordinator returns structured data with children array
    const coordinatorData = { children: ['write code', 'write tests'] };
    const gateRunCalls: string[] = [];

    const gate = {
      run: mock(
        async (profile: { provider: string; model: string }, fn: (h: { signal: AbortSignal }) => Promise<unknown>) => {
          gateRunCalls.push(`${profile.provider}:${profile.model}`);
          return fn({ signal: new AbortController().signal });
        },
      ),
    } as unknown as RunnerContext['gate'];

    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('coordinator')) {
        return { mode: 'structured', data: coordinatorData } satisfies SessionResult;
      }
      // children
      return { mode: 'text', text: 'child result' } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });

    // childRunner creates a runner for each child in the coordinator result
    const childRunner: (result: unknown) => Runner = (result) => {
      const data = result as { children: string[] };
      return async (childCtx: RunnerContext) => {
        for (let i = 0; i < data.children.length; i++) {
          await childCtx.gate.run({ provider: 'openai', model: 'gpt-4o' }, async () =>
            childCtx.runSession({
              spec: {
                id: `${childCtx.task.id}/worker[${i}]#1`,
                profile: 'worker',
                prompt: data.children[i],
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

    const runner = coordinatorRunner(makeCoordinatorSpec(), { childRunner });

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // 1 coordinator + 2 children = 3 gate.run calls
    expect(gateRunCalls).toHaveLength(3);
    // Coordinator was called with correct ID
    const coordinatorCalls = (runSession as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
      (c[0] as RunSessionContext).spec.id.includes('coordinator'),
    );
    expect(coordinatorCalls).toHaveLength(1);
  });

  it('1b. coordinator returns empty children list → still completed', async () => {
    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('coordinator')) {
        return { mode: 'structured', data: { children: [] } } satisfies SessionResult;
      }
      return { mode: 'text', text: 'should not be called' } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });

    const childRunner: (result: unknown) => Runner = () => {
      return async () => ({ status: 'completed' });
    };

    const runner = coordinatorRunner(makeCoordinatorSpec(), { childRunner });
    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // Only the coordinator session should have been called
    expect(runSession).toHaveBeenCalledTimes(1);
  });

  // ── Persist-before-children ─────────────────────────────────────────────

  it('2. persist-before-children: coordinator runSession fully resolves before any child runSession', async () => {
    const timeline: string[] = [];

    const gate = {
      run: mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
        fn({ signal: new AbortController().signal }),
      ),
    } as unknown as RunnerContext['gate'];

    const runSession = mock(async (rsctx: RunSessionContext) => {
      timeline.push(`start:${rsctx.spec.id}`);
      // Simulate async work
      await new Promise((r) => setTimeout(r, 5));
      timeline.push(`end:${rsctx.spec.id}`);
      if (rsctx.spec.id.includes('coordinator')) {
        return { mode: 'structured', data: { children: ['write code', 'write tests'] } } satisfies SessionResult;
      }
      return { mode: 'text', text: 'child result' } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });

    const childRunner: (result: unknown) => Runner = (result) => {
      const data = result as { children: string[] };
      return async (childCtx: RunnerContext) => {
        for (let i = 0; i < data.children.length; i++) {
          await childCtx.gate.run({ provider: 'openai', model: 'gpt-4o' }, async () =>
            childCtx.runSession({
              spec: {
                id: `${childCtx.task.id}/worker[${i}]#1`,
                profile: 'worker',
                prompt: data.children[i],
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

    const runner = coordinatorRunner(makeCoordinatorSpec(), { childRunner });
    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });

    // Assert ordering: coordinator end must come before any child start
    const coordinatorEndIdx = timeline.findIndex((e) => e.startsWith('end:') && e.includes('coordinator'));
    const firstChildStartIdx = timeline.findIndex((e) => e.startsWith('start:') && e.includes('worker'));

    expect(coordinatorEndIdx).toBeGreaterThanOrEqual(0);
    expect(firstChildStartIdx).toBeGreaterThanOrEqual(0);
    expect(coordinatorEndIdx).toBeLessThan(firstChildStartIdx);
  });

  // ── Deadlock-freedom under total cap 1 ──────────────────────────────────

  it('3. deadlock-freedom: real SessionGate total=1 completes within timeout', async () => {
    const gate = new SessionGate({ total: 1, perModel: {} });

    const coordinatorData = { children: ['task A', 'task B'] };
    const runSession = mock(async (rsctx: RunSessionContext) => {
      await new Promise((r) => setTimeout(r, 5));
      if (rsctx.spec.id.includes('coordinator')) {
        return { mode: 'structured', data: coordinatorData } satisfies SessionResult;
      }
      return { mode: 'text', text: 'child ok' } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });

    const childRunner: (result: unknown) => Runner = (result) => {
      const data = result as { children: string[] };
      return async (childCtx: RunnerContext) => {
        for (let i = 0; i < data.children.length; i++) {
          await childCtx.gate.run({ provider: 'openai', model: 'gpt-4o' }, async () =>
            childCtx.runSession({
              spec: {
                id: `${childCtx.task.id}/worker[${i}]#1`,
                profile: 'worker',
                prompt: data.children[i],
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

    const runner = coordinatorRunner(makeCoordinatorSpec(), { childRunner });

    const result = await Promise.race([
      runner(ctx).then((o) => ({ type: 'completed' as const, outcome: o })),
      new Promise<{ type: 'timeout' }>((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 5000)),
    ]);

    expect(result.type).toBe('completed');
    if (result.type === 'completed') {
      expect(result.outcome).toEqual({ status: 'completed' });
    }
    // Coordinator + 2 children all ran
    expect(runSession).toHaveBeenCalledTimes(3);
  }, 10000);

  // ── Resume/replay: cached coordinator output ────────────────────────────

  it('4. resume/replay: coordinator output cached → children spawned identically', async () => {
    const gate = {
      run: mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
        fn({ signal: new AbortController().signal }),
      ),
    } as unknown as RunnerContext['gate'];

    const runSessionCalls: string[] = [];
    const runSession = mock(async (rsctx: RunSessionContext) => {
      runSessionCalls.push(rsctx.spec.id);
      if (rsctx.spec.id.includes('coordinator')) {
        // Cached coordinator result
        return {
          mode: 'structured',
          data: { children: ['cached task A', 'cached task B'] },
          cached: true,
        } as SessionResult;
      }
      return { mode: 'text', text: 'child result from cache', cached: true } as SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });

    const childRunnerCalls: { result: unknown }[] = [];
    const childRunner: (result: unknown) => Runner = (result) => {
      childRunnerCalls.push({ result });
      const data = result as { children: string[] };
      return async (childCtx: RunnerContext) => {
        for (let i = 0; i < data.children.length; i++) {
          await childCtx.gate.run({ provider: 'openai', model: 'gpt-4o' }, async () =>
            childCtx.runSession({
              spec: {
                id: `${childCtx.task.id}/worker[${i}]#1`,
                profile: 'worker',
                prompt: data.children[i],
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

    const runner = coordinatorRunner(makeCoordinatorSpec(), { childRunner });
    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // Coordinator was called (cache hit = no model call, but runSession still invoked)
    expect(runSessionCalls).toContain('task-xyz/coordinator#1');
    // Both children were spawned from cached coordinator data
    expect(runSessionCalls).toContain('task-xyz/worker[0]#1');
    expect(runSessionCalls).toContain('task-xyz/worker[1]#1');
    // childRunner was called exactly once with the coordinator result
    expect(childRunnerCalls).toHaveLength(1);
    const coordinatorResult = childRunnerCalls[0].result as { children: string[] };
    expect(coordinatorResult.children).toEqual(['cached task A', 'cached task B']);
  });
});
