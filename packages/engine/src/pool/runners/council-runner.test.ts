// ─── Tests for runners/council-runner.ts ─────────────────────────────────────
//
// Tests for kb-5 A3b: councilRunner.
//
// Tests verify:
//   - Basic: 3 workers → synthesizer → completed; IDs follow convention
//   - Partial failure: 1 worker fails → continue with remaining
//   - All workers fail: all workers fail → {status:'failed'}, synthesizer NOT called
//   - Deadlock-freedom: real SessionGate total=1 completes without hang
//   - Resume/replay: cached worker + synthesizer sessions return without model call
//
// The module under test is imported from './council-runner.js'.

import { describe, expect, it, mock } from 'bun:test';

import type { AgentProfile, Task } from '../../core/types.js';
import { SessionGate } from '../session-gate.js';
import type { RunSessionContext, SessionResult } from '../session.js';
import { councilRunner } from './council-runner.js';
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
  profiles.set('synthesizer', makeProfile('synthesizer'));
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

/** Build a worker SessionSpec for councilRunner tests. */
function makeWorkerSpec(index: number, overrides?: Record<string, unknown>) {
  return {
    id: `task-abc/worker[${index}]#1`,
    profile: 'worker',
    prompt: `Worker ${index}`,
    outputMode: 'text' as const,
    runnerRole: 'worker',
    attempt: 1,
    ...overrides,
  };
}

/** Build a synthesizer SessionSpec for councilRunner tests. */
function makeSynthesizerSpec(overrides?: Record<string, unknown>) {
  return {
    id: 'task-abc/synthesizer#1',
    profile: 'synthesizer',
    prompt: 'Synthesize the results',
    outputMode: 'text' as const,
    runnerRole: 'synthesizer',
    attempt: 1,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('councilRunner', () => {
  // ── Basic flow: 3 workers → synthesizer → completed ─────────────────────

  it('1a. 3 workers + synthesizer all succeed → returns completed', async () => {
    const gateRunCalls: string[] = [];
    const gate = {
      run: mock(
        async (profile: { provider: string; model: string }, fn: (h: { signal: AbortSignal }) => Promise<unknown>) => {
          gateRunCalls.push(`${profile.provider}:${profile.model}`);
          return fn({ signal: new AbortController().signal });
        },
      ),
    } as unknown as RunnerContext['gate'];

    const sessionCalls: string[] = [];
    const runSession = mock(async (rsctx: RunSessionContext) => {
      sessionCalls.push(rsctx.spec.id);
      if (rsctx.spec.id.includes('worker')) {
        return { mode: 'text', text: `result from ${rsctx.spec.id}` } satisfies SessionResult;
      }
      // synthesizer
      return { mode: 'text', text: 'synthesized output' } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });
    const workers = [makeWorkerSpec(0), makeWorkerSpec(1), makeWorkerSpec(2)];
    const synth = makeSynthesizerSpec();
    const runner = councilRunner(workers, synth);

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // 3 workers + 1 synthesizer = 4 gate.run calls
    expect(gateRunCalls).toHaveLength(4);
    // All 4 sessions called
    expect(sessionCalls).toContain('task-abc/worker[0]#1');
    expect(sessionCalls).toContain('task-abc/worker[1]#1');
    expect(sessionCalls).toContain('task-abc/worker[2]#1');
    expect(sessionCalls).toContain('task-abc/synthesizer#1');
  });

  it('1b. synthesizer prompt includes concatenated worker results', async () => {
    const synthPrompts: string[] = [];
    const runSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('synthesizer')) {
        synthPrompts.push(rsctx.spec.prompt);
        return { mode: 'text', text: 'synthesized' } satisfies SessionResult;
      }
      return { mode: 'text', text: `result ${rsctx.spec.id}` } satisfies SessionResult;
    });

    const ctx = makeCtx({ runSession });
    const workers = [
      makeWorkerSpec(0, { prompt: 'Worker 0 prompt' }),
      makeWorkerSpec(1, { prompt: 'Worker 1 prompt' }),
    ];
    const synth = makeSynthesizerSpec({ prompt: 'Original synth prompt' });

    await councilRunner(workers, synth)(ctx);

    expect(synthPrompts).toHaveLength(1);
    const prompt = synthPrompts[0];
    // Should contain each worker's result
    expect(prompt).toContain('result task-abc/worker[0]#1');
    expect(prompt).toContain('result task-abc/worker[1]#1');
    // Should still contain the original synthesizer prompt
    expect(prompt).toContain('Original synth prompt');
  });

  // ── Partial failure: 1 worker fails → continue with remaining ───────────

  it('2a. 1 of 3 workers fails → continues with remaining, synthesizer runs', async () => {
    const gate = {
      run: mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
        fn({ signal: new AbortController().signal }),
      ),
    } as unknown as RunnerContext['gate'];

    let callCount = 0;
    const runSession = mock(async (rsctx: RunSessionContext) => {
      callCount++;
      if (callCount === 2) {
        // worker[1] fails
        throw new Error('worker crashed');
      }
      return { mode: 'text', text: `result ${callCount}` } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });
    const workers = [makeWorkerSpec(0), makeWorkerSpec(1), makeWorkerSpec(2)];
    const synth = makeSynthesizerSpec();
    const runner = councilRunner(workers, synth);

    const outcome: TaskOutcome = await runner(ctx);

    // Even though one worker failed, overall outcome is completed
    expect(outcome).toEqual({ status: 'completed' });
    // Synthesizer was still called (worker[0] + worker[2] results fed in)
    expect(runSession).toHaveBeenCalled();
    const synthCalls = (runSession as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
      (c[0] as RunSessionContext).spec.id.includes('synthesizer'),
    );
    expect(synthCalls.length).toBeGreaterThanOrEqual(1);
    // Worker[1]'s error was caught, other workers completed
    expect(gate.run).toHaveBeenCalledTimes(4); // 3 workers + 1 synth
  });

  it('2b. failing worker result is omitted from synthesizer prompt', async () => {
    let callIndex = 0;
    const runSession = mock(async (rsctx: RunSessionContext) => {
      const idx = callIndex++;
      // Worker 0 succeeds, worker 1 fails, worker 2 succeeds
      if (rsctx.spec.id.includes('worker')) {
        if (idx === 1) {
          throw new Error('worker 1 crashed');
        }
        return { mode: 'text', text: `worker ${idx} result` } satisfies SessionResult;
      }
      // synthesizer
      return { mode: 'text', text: 'synth' } satisfies SessionResult;
    });

    let synthPrompt = '';
    const capturingRunSession = mock(async (rsctx: RunSessionContext) => {
      if (rsctx.spec.id.includes('synthesizer')) {
        synthPrompt = rsctx.spec.prompt;
      }
      return runSession(rsctx);
    });

    const ctx = makeCtx({ runSession: capturingRunSession });
    const workers = [makeWorkerSpec(0), makeWorkerSpec(1), makeWorkerSpec(2)];
    await councilRunner(workers, makeSynthesizerSpec())(ctx);

    // The failed worker's result should NOT appear in the synthesizer prompt
    // Only worker 0 and worker 2 results should be concatenated
    const successfulResults = ['worker 0 result', 'worker 2 result'];
    for (const r of successfulResults) {
      expect(synthPrompt).toContain(r);
    }
    expect(synthPrompt).not.toContain('worker 1 result');
  });

  // ── All workers fail → {status:'failed'} ────────────────────────────────

  it('3. all workers fail → returns {status:"failed"}, synthesizer NOT called', async () => {
    const gate = {
      run: mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
        fn({ signal: new AbortController().signal }),
      ),
    } as unknown as RunnerContext['gate'];

    const runSession = mock(async () => {
      throw new Error('all workers crash');
    });

    const ctx = makeCtx({ gate, runSession });
    const workers = [makeWorkerSpec(0), makeWorkerSpec(1)];
    const synth = makeSynthesizerSpec();
    const runner = councilRunner(workers, synth);

    const outcome: TaskOutcome = await runner(ctx);

    expect(outcome.status).toBe('failed');
    // Synthesizer should NOT have been called since all workers failed
    const synthCalls = (runSession as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
      (c[0] as RunSessionContext).spec.id.includes('synthesizer'),
    );
    expect(synthCalls).toHaveLength(0);
  });

  // ── Deadlock-freedom under total cap 1 ──────────────────────────────────

  it('4. deadlock-freedom: real SessionGate total=1 completes within timeout', async () => {
    const gate = new SessionGate({ total: 1, perModel: {} });

    // Track execution order to verify serialization
    const order: number[] = [];
    let synthRan = false;
    let idx = 0;

    const runSession = mock(async (rsctx: RunSessionContext) => {
      const n = idx++;
      order.push(n);
      if (rsctx.spec.id.includes('synthesizer')) {
        synthRan = true;
      }
      // Simulate real work
      await new Promise((r) => setTimeout(r, 5));
      return { mode: 'text', text: `result ${n}` } satisfies SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });
    const workers = [makeWorkerSpec(0), makeWorkerSpec(1), makeWorkerSpec(2)];
    const runner = councilRunner(workers, makeSynthesizerSpec());

    const result = await Promise.race([
      runner(ctx).then((o) => ({ type: 'completed' as const, outcome: o })),
      new Promise<{ type: 'timeout' }>((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 5000)),
    ]);

    expect(result.type).toBe('completed');
    if (result.type === 'completed') {
      expect(result.outcome).toEqual({ status: 'completed' });
    }
    expect(synthRan).toBe(true);
    // All 3 workers + 1 synth ran in some order (serialized, so order is deterministic)
    expect(order).toHaveLength(4);
  }, 10000);

  // ── Resume/replay: cached sessions ──────────────────────────────────────

  it('5. resume/replay: cached worker + synthesizer sessions work', async () => {
    const gate = {
      run: mock(async (_p: unknown, fn: (h: { signal: AbortSignal }) => Promise<unknown>) =>
        fn({ signal: new AbortController().signal }),
      ),
    } as unknown as RunnerContext['gate'];

    const runSessionCalls: string[] = [];
    const runSession = mock(async (rsctx: RunSessionContext) => {
      runSessionCalls.push(rsctx.spec.id);
      if (rsctx.spec.id.includes('worker')) {
        return { mode: 'text', text: `cached-worker-${rsctx.spec.id}`, cached: true } as SessionResult;
      }
      return { mode: 'text', text: 'cached-synth', cached: true } as SessionResult;
    });

    const ctx = makeCtx({ gate, runSession });
    const workers = [makeWorkerSpec(0), makeWorkerSpec(1)];
    const runner = councilRunner(workers, makeSynthesizerSpec());

    const outcome = await runner(ctx);

    expect(outcome).toEqual({ status: 'completed' });
    // All sessions were called (cached = no model call, but runSession still invoked)
    expect(runSessionCalls).toContain('task-abc/worker[0]#1');
    expect(runSessionCalls).toContain('task-abc/worker[1]#1');
    expect(runSessionCalls).toContain('task-abc/synthesizer#1');
    expect(runSessionCalls).toHaveLength(3);
  });
});
