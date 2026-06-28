// ─── Tests for runners/council-runner.ts (SessionPlan contract) ─────────
//
// Tests verify:
//   1. plan() yields Phase1 (workers) then Phase2 (synthesizer)
//   2. Worker results are concatenated into the synthesizer prompt
//   3. Worker output formatting: text → text, structured → JSON, filesystem → "(...)"
//   4. execute() calls runScheduledSession and returns its result
//   5. Factory creates a fresh runner instance each call
//
// Mock strategy:
//   - Shared mock via `test-fixtures.ts` → `mockRunScheduledSession`
//   - We construct a real SessionPlanRunner via the factory and test its
//     plan()/execute() methods directly, driving the plan generator
//     step by step.

import { describe, expect, it } from 'bun:test';
import type { SessionResult, SessionSpec } from '../session.js';
import {
  CANNED_RESULT,
  makePlanContext,
  mockRunScheduledSession,
  setupRunScheduledSessionMock,
} from './test-fixtures.js';

// ─── Import module under test ────────────────────────────────────────────

import { councilRunner } from './council-runner.js';

// ─── Mock wiring ─────────────────────────────────────────────────────────

setupRunScheduledSessionMock();

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeWorkerSpec(index: number, overrides?: Partial<SessionSpec>): SessionSpec {
  return {
    id: `task-abc/worker[${index}]#1`,
    profile: 'executor',
    prompt: `Worker ${index}`,
    outputMode: 'text',
    runnerRole: 'worker',
    attempt: 1,
    ...overrides,
  };
}

function makeSynthesizerSpec(overrides?: Partial<SessionSpec>): SessionSpec {
  return {
    id: 'task-abc/synthesizer#1',
    profile: 'executor',
    prompt: 'Synthesize the results',
    outputMode: 'text',
    runnerRole: 'synthesizer',
    attempt: 1,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('councilRunner (SessionPlan)', () => {
  // ── 1. plan yields Phase1 (workers) then Phase2 (synthesizer) ─────

  it('1a. plan yields workers batch first, then synthesizer batch', async () => {
    const workers = [makeWorkerSpec(0), makeWorkerSpec(1)];
    const synth = makeSynthesizerSpec();
    const factory = councilRunner(workers, synth);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Phase1: first yield should be the workers batch
    const phase1 = await gen.next([]);
    expect(phase1.done).toBe(false);
    const workerBatch = phase1.value as SessionSpec[];
    expect(workerBatch).toHaveLength(2);
    expect(workerBatch[0].id).toBe('task-abc/worker[0]#1');
    expect(workerBatch[1].id).toBe('task-abc/worker[1]#1');

    // Feed worker results back
    const workerResults: SessionResult[] = [
      { mode: 'text', text: 'worker0 result' },
      { mode: 'text', text: 'worker1 result' },
    ];

    // Phase2: second yield should be the synthesizer batch
    const phase2 = await gen.next(workerResults);
    expect(phase2.done).toBe(false);
    const synthBatch = phase2.value as SessionSpec[];
    expect(synthBatch).toHaveLength(1);
    expect(synthBatch[0].id).toBe('task-abc/synthesizer#1');

    // Feed synthesizer result back
    const synthResult: SessionResult[] = [{ mode: 'text', text: 'synth output' }];
    const done = await gen.next(synthResult);
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  it('1b. synthesizer prompt includes concatenated worker outputs', async () => {
    const workers = [makeWorkerSpec(0), makeWorkerSpec(1)];
    const synth = makeSynthesizerSpec({ prompt: 'Original prompt' });
    const factory = councilRunner(workers, synth);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    // Phase1: get workers
    await gen.next([]);

    // Feed worker results back
    const workerResults: SessionResult[] = [
      { mode: 'text', text: 'result from worker 0' },
      { mode: 'text', text: 'result from worker 1' },
    ];

    // Phase2: get synthesizer
    const phase2 = await gen.next(workerResults);
    const synthSpec = (phase2.value as SessionSpec[])[0];
    expect(synthSpec.prompt).toContain('Original prompt');
    expect(synthSpec.prompt).toContain('result from worker 0');
    expect(synthSpec.prompt).toContain('result from worker 1');
  });

  // ── 2. Worker result formatting ───────────────────────────────────

  it('2a. text-mode worker results are included as-is', async () => {
    const workers = [makeWorkerSpec(0)];
    const synth = makeSynthesizerSpec();
    const factory = councilRunner(workers, synth);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next([]);
    const phase2 = await gen.next([{ mode: 'text', text: 'hello world' }]);
    const prompt = (phase2.value as SessionSpec[])[0].prompt;
    expect(prompt).toContain('hello world');
  });

  it('2b. structured-mode worker results are JSON-stringified', async () => {
    const workers = [makeWorkerSpec(0)];
    const synth = makeSynthesizerSpec();
    const factory = councilRunner(workers, synth);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next([]);
    const data = { key: 'value', number: 42 };
    const phase2 = await gen.next([{ mode: 'structured', data }]);
    const prompt = (phase2.value as SessionSpec[])[0].prompt;
    expect(prompt).toContain(JSON.stringify(data));
  });

  it('2c. filesystem-mode worker results are described', async () => {
    const workers = [makeWorkerSpec(0)];
    const synth = makeSynthesizerSpec();
    const factory = councilRunner(workers, synth);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next([]);
    const phase2 = await gen.next([{ mode: 'filesystem', files: ['file1.txt'] }]);
    const prompt = (phase2.value as SessionSpec[])[0].prompt;
    expect(prompt).toContain('(filesystem session');
  });

  it('2d. worker results are joined with the WORKER_OUTPUT_PREFIX separator', async () => {
    const workers = [makeWorkerSpec(0), makeWorkerSpec(1)];
    const synth = makeSynthesizerSpec({ prompt: 'Original' });
    const factory = councilRunner(workers, synth);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next([]);
    const phase2 = await gen.next([
      { mode: 'text', text: 'A' },
      { mode: 'text', text: 'B' },
    ]);
    const prompt = (phase2.value as SessionSpec[])[0].prompt;
    // The pattern is: original prompt + "\n\n---\nWorker output:\n" + joined worker outputs
    // joined worker outputs = A + "\n\n---\nWorker output:\n" + B
    // So prompt should contain "---\nWorker output:\n" twice
    const separator = 'Worker output:';
    expect(prompt.split(separator)).toHaveLength(3); // Original before first, A between, B after
  });

  // ── 3. Synthesizer spec retains all original fields ───────────────

  it('3a. synthesizer spec keeps profile, outputMode, runnerRole, attempt', async () => {
    const workers = [makeWorkerSpec(0)];
    const synth = makeSynthesizerSpec({
      profile: 'synth-profile',
      outputMode: 'structured',
      runnerRole: 'synth-role',
      attempt: 2,
    });
    const factory = councilRunner(workers, synth);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next([]);
    const phase2 = await gen.next([{ mode: 'text', text: 'ok' }]);
    const spec = (phase2.value as SessionSpec[])[0];
    expect(spec.profile).toBe('synth-profile');
    expect(spec.outputMode).toBe('structured');
    expect(spec.runnerRole).toBe('synth-role');
    expect(spec.attempt).toBe(2);
    expect(spec.id).toBe('task-abc/synthesizer#1');
  });

  // ── 4. execute delegates to runScheduledSession ──────────────────

  it('4a. execute calls runScheduledSession with spec and ctx', async () => {
    mockRunScheduledSession.mockResolvedValue(CANNED_RESULT);

    const workers = [makeWorkerSpec(0)];
    const factory = councilRunner(workers, makeSynthesizerSpec());
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeWorkerSpec(0);
    const result = await runner.execute(ctx, spec);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunScheduledSession).toHaveBeenCalledTimes(1);
    expect(mockRunScheduledSession).toHaveBeenCalledWith(spec, ctx);
  });

  it('4b. execute propagates errors from runScheduledSession', async () => {
    const error = new Error('session failed');
    mockRunScheduledSession.mockRejectedValue(error);

    const workers = [makeWorkerSpec(0)];
    const factory = councilRunner(workers, makeSynthesizerSpec());
    const runner = factory();
    const ctx = makePlanContext();

    const spec: SessionSpec = makeWorkerSpec(0);
    await expect(runner.execute(ctx, spec)).rejects.toThrow(error);
  });

  // ── 5. Factory creates fresh instances ──────────────────────────

  it('5. factory returns a new runner instance each call', async () => {
    const workers = [makeWorkerSpec(0)];
    const factory = councilRunner(workers, makeSynthesizerSpec());

    const runnerA = factory();
    const runnerB = factory();

    expect(runnerA).not.toBe(runnerB);
    expect(runnerA.plan).toBeInstanceOf(Function);
    expect(runnerA.execute).toBeInstanceOf(Function);
  });

  // ── 6. Worker results with empty text are included (filtering only empty strings from join) ──

  it('6a. empty worker text results still appear in prompt', async () => {
    const workers = [makeWorkerSpec(0)];
    const synth = makeSynthesizerSpec({ prompt: 'Base' });
    const factory = councilRunner(workers, synth);
    const runner = factory();
    const ctx = makePlanContext();
    const gen = runner.plan(ctx);

    await gen.next([]);
    const phase2 = await gen.next([{ mode: 'text', text: '' }]);
    const prompt = (phase2.value as SessionSpec[])[0].prompt;
    // Empty text is filtered out by the filter, so prompt should just be the base
    expect(prompt).toBe('Base');
  });
});
