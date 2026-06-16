// ─── RunManager — test-first specification ───────────────────────────────────
//
// Test-first specification for `src/server/run-manager.ts`, the orchestrator
// that owns the lifecycle of concurrent workflow runs in the control server.
//
// Contract under test (see server-refactor.prompt.md):
//
//   interface RunHandle {
//     runId: string;
//     cwd: string;
//     workflowName: string;
//     taskPrompt: string;
//     workDir: string;
//     store: EventStore;
//     controller: AbortController;
//     bridge: StatusBridge;
//     status: 'running' | 'complete' | 'failed';
//     summary: RunSummary;
//     startedAt: string;            // ISO 8601
//     subscribers: Set<ServerWebSocket>;
//   }
//
//   class RunManager {
//     constructor(onRunsChanged: () => void);
//     startRun(msg): Promise<{ runId: string; summary: RunSummary }>;
//     cancelRun(runId: string): void;
//     listRuns(): RunSummary[];
//     getRun(runId: string): RunSummary | undefined;
//     subscribe(ws, runId): void;
//     unsubscribe(ws, runId): void;
//     unsubscribeAll(ws): void;
//     handleResync(ws, runId, lastSeq?): void;
//     shutdownAll(): Promise<void>;
//   }
//
// Key invariants verified here:
//   - startRun is FIRE-AND-FORGET: it returns { runId, summary } immediately,
//     WITHOUT awaiting the workflow. Workflow execution happens inside an
//     async IIFE.
//   - runId is derived from the basename of the resolved workDir.
//   - A collision (runId already registered AND status === 'running') throws,
//     pointing the caller at `engin resume`.
//   - On success: store.flush() is awaited BEFORE flipping status, then the
//     status becomes 'complete' and a run-scoped `run_complete` is broadcast.
//   - On failure: store.flush() is awaited first (partial events stay durable),
//     status becomes 'failed', and a run-scoped `run_failed` is broadcast.
//     AbortError (from controller.abort()) yields the message "Run cancelled".
//   - A ~60s reaper disposes the bridge and removes the handle from the map
//     once the run is no longer 'running'.
//
// The fixture workflows live on disk (created per-test under a temp dir) and
// are loaded through the real loadWorkflow() machinery, mirroring
// workflow-loader.test.ts. A file-marker handshake lets the test control when
// the controllable workflow resolves, and the AbortSignal drives cancellation.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { clearWorkflowCache } from '../../packages/engine/src/core/workflow-loader.js';
import { RunManager } from '../../packages/engine/src/server/run-manager.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Fixture workflow sources ───────────────────────────────────────────────
//
// `develop` — the controllable workflow. It:
//   1. appends a `workflow_started` event via the wired onStatus callbacks
//      (proves storeCallbacks are passed to the workflow and seeds the store),
//   2. writes a `started.marker` so the test knows the IIFE has begun,
//   3. blocks until a `release.marker` appears (cooperative completion) OR the
//      AbortSignal fires (cooperative cancellation, rejecting with AbortError).
//
// `failing` — throws a genuine (non-abort) error immediately after starting,
// so the RunManager's catch path can be exercised with a real error message.

const DEVELOP_SOURCE = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function run(taskPrompt, options) {
  const workDir = options.workDir;
  try { mkdirSync(workDir, { recursive: true }); } catch (e) {}
  if (options.onStatus && options.onStatus.onWorkflowStart) {
    options.onStatus.onWorkflowStart({ taskPrompt: taskPrompt, resumed: false, workDir: workDir });
  }
  try { writeFileSync(join(workDir, 'started.marker'), '1'); } catch (e) {}
  const releasePath = join(workDir, 'release.marker');
  const signal = options.signal;
  await new Promise(function (resolve, reject) {
    function check() {
      if (existsSync(releasePath)) { resolve(undefined); return true; }
      if (signal && signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return true; }
      return false;
    }
    if (check()) return;
    const iv = setInterval(function () { if (check()) clearInterval(iv); }, 5);
  });
}
`;

const FAILING_SOURCE = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function run(taskPrompt, options) {
  const workDir = options.workDir;
  try { mkdirSync(workDir, { recursive: true }); } catch (e) {}
  if (options.onStatus && options.onStatus.onWorkflowStart) {
    options.onStatus.onWorkflowStart({ taskPrompt: taskPrompt, resumed: false, workDir: workDir });
  }
  try { writeFileSync(join(workDir, 'started.marker'), '1'); } catch (e) {}
  throw new Error('kaboom: workflow exploded');
}
`;

// ─── Generic async helpers ──────────────────────────────────────────────────

/** Poll `fn` until it returns a truthy value (or throw after `timeout` ms). */
async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeout?: number; interval?: number } = {}): Promise<T> {
  const timeout = opts.timeout ?? 8000;
  const interval = opts.interval ?? 10;
  const start = Date.now();
  for (;;) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      // keep polling until timeout
    }
    if (Date.now() - start >= timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Flush the microtask + macrotask queue a couple of times. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Minimal mock of a Bun ServerWebSocket that records every sent payload. */
function makeMockWs(): { ws: any; sent: any[] } {
  const sent: any[] = [];
  const ws = {
    // 1 === OPEN
    readyState: 1,
    send: (data: string | ArrayBuffer | Uint8Array) => {
      const str = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
      try {
        sent.push(JSON.parse(str));
      } catch {
        sent.push(str);
      }
    },
    close: () => {
      /* no-op */
    },
  };
  return { ws, sent };
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('RunManager', () => {
  const { getDir } = useTempDir();

  let savedXdg: string | undefined;
  let cwd: string;
  let globalWorkflowDir: string;
  // Every manager created during a test, so afterEach can tear them down.
  const managers: RunManager[] = [];

  beforeEach(async () => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    const base = getDir();

    // Point the global config dir at our temp tree so the global workflow
    // directory resolves under it (mirrors workflow-loader.test.ts).
    process.env.XDG_CONFIG_HOME = join(base, 'global');
    cwd = join(base, 'local');
    await mkdir(cwd, { recursive: true });

    globalWorkflowDir = join(base, 'global', 'engin', 'workflows');
    await mkdir(join(globalWorkflowDir, 'develop'), { recursive: true });
    await writeFile(join(globalWorkflowDir, 'develop', 'main.ts'), DEVELOP_SOURCE);
    await mkdir(join(globalWorkflowDir, 'failing'), { recursive: true });
    await writeFile(join(globalWorkflowDir, 'failing', 'main.ts'), FAILING_SOURCE);

    clearWorkflowCache();
    managers.length = 0;
  });

  afterEach(async () => {
    // Abort any still-running fixtures so their polling intervals clear and
    // nothing leaks across tests. shutdownAll() is idempotent.
    for (const m of managers) {
      try {
        await m.shutdownAll();
      } catch {
        // best-effort teardown
      }
    }
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  // ─── shared helpers bound to this describe's state ───────────────────────

  function createManager(): { manager: RunManager; calls: number[] } {
    const calls: number[] = [];
    const manager = new RunManager(() => calls.push(Date.now()));
    managers.push(manager);
    return { manager, calls };
  }

  function makeWorkDir(label: string): string {
    return join(getDir(), 'work', label);
  }

  // ─── startRun: immediate return ──────────────────────────────────────────

  describe('startRun — fire-and-forget', () => {
    it('returns immediately with runId and summary before the workflow finishes', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('1234567890-develop');
      await mkdir(workDir, { recursive: true });

      const result = await manager.startRun({
        workflowName: 'develop',
        taskPrompt: 'implement the thing',
        cwd,
        workDir,
      } as any);

      // The handle-like result is populated synchronously with setup state.
      expect(result.runId).toBe('1234567890-develop');
      expect(result.summary).toBeDefined();
      expect(result.summary.runId).toBe('1234567890-develop');
      expect(result.summary.workflowName).toBe('develop');
      expect(result.summary.taskPrompt).toBe('implement the thing');
      expect(result.summary.cwd).toBe(cwd);
      expect(result.summary.status).toBe('running');
      expect(typeof result.summary.startedAt).toBe('string');
      expect(Number.isNaN(new Date(result.summary.startedAt).getTime())).toBe(false);

      // The workflow has STARTED (marker written) but has NOT completed —
      // release.marker is still absent. This proves startRun did not await
      // the workflow: the run is registered and 'running' while the workflow
      // is blocked.
      await waitFor(() => existsSync(join(workDir, 'started.marker')));
      expect(existsSync(join(workDir, 'release.marker'))).toBe(false);
      const runs = manager.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('running');

      // Release + await completion (cleanup).
      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
    });

    it('derives runId from the workDir basename', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('9876543210-myflow');
      await mkdir(workDir, { recursive: true });

      const result = await manager.startRun({
        workflowName: 'develop',
        taskPrompt: 't',
        cwd,
        workDir,
      } as any);

      expect(result.runId).toBe('9876543210-myflow');
      expect(result.summary.runId).toBe('9876543210-myflow');

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
    });

    it('invokes onRunsChanged when a run is registered', async () => {
      const { manager, calls } = createManager();
      const workDir = makeWorkDir('111-onchanged');
      await mkdir(workDir, { recursive: true });

      expect(calls).toHaveLength(0);
      await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any);
      // onRunsChanged is called during registration (before the IIFE launch).
      expect(calls.length).toBeGreaterThanOrEqual(1);

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
    });
  });

  // ─── collision / resume ──────────────────────────────────────────────────

  describe('collision handling', () => {
    it('throws when startRun targets a runId that is already running', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('222-collision');
      await mkdir(workDir, { recursive: true });

      await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any);
      await waitFor(() => existsSync(join(workDir, 'started.marker')));

      // A second start for the SAME workDir while the first is running must
      // be rejected, pointing the caller at `engin resume`.
      await expect(manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any)).rejects.toThrow(
        /resume/i,
      );

      // The original run is unaffected.
      expect(manager.listRuns()).toHaveLength(1);

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
    });

    it('allows starting a run whose previous status is not running (resume)', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('333-resume');
      await mkdir(workDir, { recursive: true });

      // Complete the first run immediately by pre-placing the release marker.
      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      // Resuming the same workDir must NOT throw (status is 'complete').
      await expect(
        manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any),
      ).resolves.toBeDefined();

      // The resumed run also completes quickly (release marker still present).
      await waitFor(() => manager.listRuns().every((r) => r.status === 'complete'));
    });
  });

  // ─── success path ────────────────────────────────────────────────────────

  describe('workflow success', () => {
    it('marks the run complete, broadcasts run_complete, and flushes the store', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('444-success');
      await mkdir(workDir, { recursive: true });
      const { ws, sent } = makeMockWs();

      const result = await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any);
      manager.subscribe(ws, result.runId);

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      // Summary reflects the terminal status.
      expect(manager.getRun(result.runId)?.status).toBe('complete');

      // A run-scoped run_complete reached the subscribed socket.
      const completes = sent.filter((m) => m.type === 'run_complete');
      expect(completes).toHaveLength(1);
      expect(completes[0].runId).toBe(result.runId);

      // Durability: store.flush() wrote events.jsonl containing the seeded
      // workflow_started record (flush happens BEFORE the status flip).
      const logPath = join(workDir, 'events.jsonl');
      expect(existsSync(logPath)).toBe(true);
      const log = await readFile(logPath, 'utf-8');
      expect(log).toContain('workflow_started');
    });
  });

  // ─── failure path ────────────────────────────────────────────────────────

  describe('workflow failure', () => {
    it('marks the run failed and broadcasts run_failed with the genuine error message', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('555-fail');
      await mkdir(workDir, { recursive: true });
      const { ws, sent } = makeMockWs();

      const result = await manager.startRun({ workflowName: 'failing', taskPrompt: 't', cwd, workDir } as any);
      manager.subscribe(ws, result.runId);

      await waitFor(() => manager.listRuns()[0]?.status === 'failed');

      expect(manager.getRun(result.runId)?.status).toBe('failed');

      const failed = sent.filter((m) => m.type === 'run_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].runId).toBe(result.runId);
      // Genuine error → the raw err.message is surfaced (NOT "Run cancelled").
      expect(failed[0].error).toBe('kaboom: workflow exploded');

      // Flush-even-on-error: partial events are durable.
      const log = await readFile(join(workDir, 'events.jsonl'), 'utf-8');
      expect(log).toContain('workflow_started');
    });
  });

  // ─── cancellation / abort ────────────────────────────────────────────────

  describe('cancelRun', () => {
    it('aborts the run and surfaces "Run cancelled" as run_failed', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('666-cancel');
      await mkdir(workDir, { recursive: true });
      const { ws, sent } = makeMockWs();

      const result = await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any);
      manager.subscribe(ws, result.runId);
      await waitFor(() => existsSync(join(workDir, 'started.marker')));

      manager.cancelRun(result.runId);

      await waitFor(() => manager.listRuns()[0]?.status === 'failed');

      const failed = sent.filter((m) => m.type === 'run_failed');
      expect(failed).toHaveLength(1);
      // AbortError → the canonical "Run cancelled" message.
      expect(failed[0].error).toBe('Run cancelled');
      expect(failed[0].runId).toBe(result.runId);
    });

    it('does not throw when cancelling an unknown runId', () => {
      const { manager } = createManager();
      expect(() => manager.cancelRun('does-not-exist')).not.toThrow();
    });
  });

  // ─── listRuns / getRun ───────────────────────────────────────────────────

  describe('listRuns / getRun', () => {
    it('returns a summary per registered run', async () => {
      const { manager } = createManager();
      const wd1 = makeWorkDir('aaa-1');
      const wd2 = makeWorkDir('bbb-2');
      await mkdir(wd1, { recursive: true });
      await mkdir(wd2, { recursive: true });

      await manager.startRun({ workflowName: 'develop', taskPrompt: 'one', cwd, workDir: wd1 } as any);
      await manager.startRun({ workflowName: 'develop', taskPrompt: 'two', cwd, workDir: wd2 } as any);

      const runs = manager.listRuns();
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.runId).sort()).toEqual(['aaa-1', 'bbb-2']);
      expect(manager.getRun('aaa-1')?.taskPrompt).toBe('one');
      expect(manager.getRun('bbb-1')).toBeUndefined();

      await writeFile(join(wd1, 'release.marker'), '1');
      await writeFile(join(wd2, 'release.marker'), '1');
      await waitFor(() => manager.listRuns().every((r) => r.status === 'complete'));
    });
  });

  // ─── subscribe / unsubscribe / unsubscribeAll ────────────────────────────

  describe('subscription fan-out', () => {
    it('subscribe wires a websocket to receive run broadcasts', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('sub-1');
      await mkdir(workDir, { recursive: true });
      const { ws, sent } = makeMockWs();

      const result = await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any);
      manager.subscribe(ws, result.runId);

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      expect(sent.some((m) => m.type === 'run_complete' && m.runId === result.runId)).toBe(true);
    });

    it('unsubscribe stops a websocket from receiving further broadcasts', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('unsub-1');
      await mkdir(workDir, { recursive: true });
      const { ws, sent } = makeMockWs();

      const result = await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any);
      manager.subscribe(ws, result.runId);
      manager.unsubscribe(ws, result.runId);
      sent.length = 0;

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
      await settle();

      expect(sent.some((m) => m.type === 'run_complete')).toBe(false);
    });

    it('unsubscribeAll removes the websocket from every run', async () => {
      const { manager } = createManager();
      const wd1 = makeWorkDir('ua-1');
      const wd2 = makeWorkDir('ua-2');
      await mkdir(wd1, { recursive: true });
      await mkdir(wd2, { recursive: true });
      const { ws, sent } = makeMockWs();

      const r1 = await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir: wd1 } as any);
      const r2 = await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir: wd2 } as any);
      manager.subscribe(ws, r1.runId);
      manager.subscribe(ws, r2.runId);
      manager.unsubscribeAll(ws);
      sent.length = 0;

      await writeFile(join(wd1, 'release.marker'), '1');
      await writeFile(join(wd2, 'release.marker'), '1');
      await waitFor(() => manager.listRuns().every((r) => r.status === 'complete'));
      await settle();

      expect(sent.some((m) => m.type === 'run_complete')).toBe(false);
    });
  });

  // ─── handleResync ────────────────────────────────────────────────────────

  describe('handleResync', () => {
    it('sends a run-scoped snapshot when no lastSeq is provided', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('rs-snap');
      await mkdir(workDir, { recursive: true });
      const { ws, sent } = makeMockWs();

      const result = await manager.startRun({
        workflowName: 'develop',
        taskPrompt: 'snapshot prompt',
        cwd,
        workDir,
      } as any);
      await waitFor(() => existsSync(join(workDir, 'started.marker')));

      manager.handleResync(ws, result.runId);

      const snaps = sent.filter((m) => m.type === 'snapshot');
      expect(snaps).toHaveLength(1);
      expect(snaps[0].runId).toBe(result.runId);
      // The seeded workflow_started event populated the projection.
      expect(snaps[0].state.taskPrompt).toBe('snapshot prompt');

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
    });

    it('sends an events catch-up when lastSeq is within the ring buffer', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('rs-evt');
      await mkdir(workDir, { recursive: true });
      const { ws, sent } = makeMockWs();

      const result = await manager.startRun({
        workflowName: 'develop',
        taskPrompt: 'events prompt',
        cwd,
        workDir,
      } as any);
      await waitFor(() => existsSync(join(workDir, 'started.marker')));

      // Client is at seq 0; the store has seq 1 (workflow_started).
      manager.handleResync(ws, result.runId, 0);

      const evts = sent.filter((m) => m.type === 'events');
      expect(evts).toHaveLength(1);
      expect(evts[0].runId).toBe(result.runId);
      expect(evts[0].events.length).toBeGreaterThanOrEqual(1);
      expect(evts[0].events.some((e: any) => e.type === 'workflow_started')).toBe(true);

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
    });
  });

  // ─── shutdownAll ─────────────────────────────────────────────────────────

  describe('shutdownAll', () => {
    it('cancels every run and flushes every store', async () => {
      const { manager } = createManager();
      const wd1 = makeWorkDir('sd-1');
      const wd2 = makeWorkDir('sd-2');
      await mkdir(wd1, { recursive: true });
      await mkdir(wd2, { recursive: true });

      await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir: wd1 } as any);
      await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir: wd2 } as any);
      await waitFor(() => existsSync(join(wd1, 'started.marker')) && existsSync(join(wd2, 'started.marker')));

      await manager.shutdownAll();

      // Both controllers were aborted → each IIFE catch flips status to
      // 'failed' (abort path). shutdownAll does not delete from the map.
      await waitFor(() => manager.listRuns().length === 2 && manager.listRuns().every((r) => r.status === 'failed'));
      expect(manager.listRuns().map((r) => r.status)).toEqual(['failed', 'failed']);

      // Stores were flushed (durable partial events).
      expect(existsSync(join(wd1, 'events.jsonl'))).toBe(true);
      expect(existsSync(join(wd2, 'events.jsonl'))).toBe(true);
    });

    it('is idempotent when there are no runs', async () => {
      const { manager } = createManager();
      await expect(manager.shutdownAll()).resolves.toBeUndefined();
    });
  });

  // ─── reaper ──────────────────────────────────────────────────────────────

  describe('reaper', () => {
    it('removes a non-running handle from the registry ~60s after completion', async () => {
      // The reaper uses a real 60s setTimeout. We intercept ONLY 60000ms
      // timers so the rest of the runtime (test polling, fixture setInterval)
      // continues to use the real scheduler.
      const realSetTimeout = globalThis.setTimeout;
      const reapers: Array<() => void> = [];
      globalThis.setTimeout = ((cb: any, delay?: number, ...args: any[]) => {
        if (delay === 60000) {
          reapers.push(cb as () => void);
          return 0 as any;
        }
        return realSetTimeout(cb as any, delay, ...args);
      }) as any;

      try {
        const { manager, calls } = createManager();
        const workDir = makeWorkDir('rp-1');
        await mkdir(workDir, { recursive: true });

        // Pre-place the release marker so the workflow completes immediately.
        await writeFile(join(workDir, 'release.marker'), '1');
        await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any);

        await waitFor(() => manager.listRuns()[0]?.status === 'complete');

        // The completed run is still present before the reaper fires.
        expect(manager.getRun('rp-1')).toBeDefined();

        // The IIFE's finally block scheduled exactly one 60s reaper.
        expect(reapers.length).toBeGreaterThanOrEqual(1);
        const callsBefore = calls.length;
        for (const fire of reapers) fire();

        // After reaping, the handle is gone and onRunsChanged was called again.
        expect(manager.getRun('rp-1')).toBeUndefined();
        expect(manager.listRuns().find((r) => r.runId === 'rp-1')).toBeUndefined();
        expect(calls.length).toBeGreaterThan(callsBefore);
      } finally {
        globalThis.setTimeout = realSetTimeout as any;
      }
    });
  });

  // ─── isolation between runs ──────────────────────────────────────────────

  describe('isolation', () => {
    it('keeps separate subscribers and summaries for concurrent runs', async () => {
      const { manager } = createManager();
      const wd1 = makeWorkDir('iso-1');
      const wd2 = makeWorkDir('iso-2');
      await mkdir(wd1, { recursive: true });
      await mkdir(wd2, { recursive: true });
      const { ws: ws1, sent: sent1 } = makeMockWs();
      const { ws: ws2, sent: sent2 } = makeMockWs();

      const r1 = await manager.startRun({ workflowName: 'develop', taskPrompt: 'first', cwd, workDir: wd1 } as any);
      const r2 = await manager.startRun({ workflowName: 'develop', taskPrompt: 'second', cwd, workDir: wd2 } as any);
      manager.subscribe(ws1, r1.runId);
      manager.subscribe(ws2, r2.runId);

      // Complete only the first run; the second must remain running.
      await writeFile(join(wd1, 'release.marker'), '1');
      await waitFor(() => manager.getRun(r1.runId)?.status === 'complete');
      expect(manager.getRun(r2.runId)?.status).toBe('running');

      // run_complete for r1 reached ws1 only; ws2 has not seen a terminal yet.
      await settle();
      expect(sent1.some((m) => m.type === 'run_complete' && m.runId === r1.runId)).toBe(true);
      expect(sent2.some((m) => m.type === 'run_complete')).toBe(false);

      // Now complete the second run.
      await writeFile(join(wd2, 'release.marker'), '1');
      await waitFor(() => manager.getRun(r2.runId)?.status === 'complete');
      await settle();
      expect(sent2.some((m) => m.type === 'run_complete' && m.runId === r2.runId)).toBe(true);
    });
  });
});
