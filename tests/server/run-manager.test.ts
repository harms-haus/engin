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

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { clearWorkflowCache } from '../../packages/engine/src/core/workflow-loader.js';
import { RunManager } from '../../packages/engine/src/server/run-manager.js';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';
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

// ─── handleWorktreeAction test helpers ──────────────────────────────────────
//
// handleWorktreeAction operates on a registered RunHandle that carries a
// WorktreeManager (set asynchronously by RunExecutor). To exercise it in
// isolation we register a hand-built handle whose `bridge` is a forwarding
// stand-in: any broadcast the RunManager triggers (via whatever bridge method)
// is fanned out to the handle's subscribers through the manager's real
// SubscriptionManager — so a subscribed mock WebSocket observes the emitted
// `worktree_merge_result` messages exactly as a real client would.

/** Minimal EventStore stand-in (handleWorktreeAction does not touch the store). */
function makeMockStore(): any {
  return {
    flush: () => Promise.resolve(),
    getProjection: () => ({ currentPhaseId: undefined }),
    getSnapshot: () => ({ seq: 0, state: {} }),
    getEventsSince: () => [],
    subscribe: () => () => {},
    dispose: () => {},
  };
}

/**
 * A method-agnostic StatusBridge stand-in. Any method invoked with a
 * ServerMessage-like first argument is forwarded to the run's subscribers via
 * the manager's SubscriptionManager — mirroring how a real StatusBridge routes
 * every broadcast through its constructor-provided callback. This lets the
 * tests assert a `worktree_merge_result` reaches subscribers regardless of
 * which bridge method `handleWorktreeAction` ultimately calls.
 */
function makeForwardingBridge(runId: string, manager: RunManager, handle: any): any {
  return new Proxy(
    {
      dispose() {},
      getSnapshot() {
        return { type: 'snapshot', runId, seq: 0, state: {} };
      },
      handleResync() {
        return { type: 'snapshot', runId, seq: 0, state: {} };
      },
    },
    {
      get(target, prop, receiver) {
        if (typeof prop !== 'string' || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return (msg?: unknown) => {
          if (msg && typeof msg === 'object' && typeof (msg as any).type === 'string') {
            (manager as any).subscriptions.broadcast(runId, msg, handle);
          }
        };
      },
    },
  );
}

/** Build a controllable WorktreeManager mock for the two-prompt merge UX. */
function makeMockWorktreeManager(
  opts: {
    mainWorktreePath?: string;
    mainBranch?: string;
    finalMerge?: { success: boolean; conflicts: string[]; conflictsResolved: boolean; error?: string };
    resolveResult?: boolean;
    cleanupError?: string;
  } = {},
): any {
  const mainWorktreePath = opts.mainWorktreePath ?? '/wt/main';
  const mainBranch = opts.mainBranch ?? 'engin/my-branch';
  return {
    mainWorktreePath,
    mainBranch,
    repoRoot: '/tmp/project',
    sourceCwd: '/tmp/project',
    finalMergeToMain: mock(
      async (): Promise<{ success: boolean; conflicts: string[]; conflictsResolved: boolean; error?: string }> =>
        opts.finalMerge ?? { success: true, conflicts: [], conflictsResolved: false },
    ),
    resolveFinalMergeConflicts: mock(
      async (): Promise<{ resolved: boolean; error?: string }> => ({ resolved: opts.resolveResult ?? true }),
    ),
    abortFinalMerge: mock(async (): Promise<void> => {}),
    cleanup: mock(
      async (): Promise<{ cleanupError?: string }> => (opts.cleanupError ? { cleanupError: opts.cleanupError } : {}),
    ),
    getWorktreeInfo: mock(() => ({
      worktreePath: mainWorktreePath,
      branchName: mainBranch,
      originalCwd: '/tmp/project',
    })),
  };
}

/**
 * Register a hand-built handle (with a WorktreeManager and a subscribed mock
 * WebSocket) so `handleWorktreeAction` can be exercised without launching a
 * real workflow. Returns the handle, the mock ws, and the recorded `sent`
 * payloads broadcast to the subscriber.
 */
function registerWorktreeRun(
  manager: RunManager,
  opts: { runId: string; worktreeManager?: any; worktreePath?: string; branchName?: string },
): { handle: any; ws: any; sent: any[] } {
  const worktreePath = opts.worktreePath ?? '/wt/main';
  const branchName = opts.branchName ?? 'engin/my-branch';

  const sent: any[] = [];
  const ws = {
    // 1 === OPEN
    readyState: 1,
    send: (data: string) => {
      try {
        sent.push(JSON.parse(data));
      } catch {
        sent.push(data);
      }
    },
    close() {},
  };
  const subscribers = new Set<any>();
  subscribers.add(ws);

  const handle: any = {
    runId: opts.runId,
    cwd: '/tmp/project',
    workflowName: 'develop',
    taskPrompt: 'do the thing',
    workDir: '/tmp/work',
    store: makeMockStore(),
    controller: new AbortController(),
    status: 'running',
    summary: {
      runId: opts.runId,
      cwd: '/tmp/project',
      workflowName: 'develop',
      taskPrompt: 'do the thing',
      status: 'running',
      startedAt: new Date().toISOString(),
    },
    startedAt: new Date().toISOString(),
    subscribers,
    worktree: { worktreePath, branchName, originalCwd: '/tmp/project' },
  };
  if (opts.worktreeManager !== undefined) {
    handle.worktreeManager = opts.worktreeManager;
  }
  handle.bridge = makeForwardingBridge(opts.runId, manager, handle);

  (manager as any).registry.register(handle);
  return { handle, ws, sent };
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

    it('disposes the run store when the handle is reaped', async () => {
      // Intercept ONLY 60000ms timers (the reaper) so the rest of the runtime
      // keeps using the real scheduler.
      const realSetTimeout = globalThis.setTimeout;
      const reapers: Array<() => void> = [];
      globalThis.setTimeout = ((cb: any, delay?: number, ...args: any[]) => {
        if (delay === 60000) {
          reapers.push(cb as () => void);
          return 0 as any;
        }
        return realSetTimeout(cb as any, delay, ...args);
      }) as any;

      // Spy on the prototype method so the store created internally by
      // startRun (via EventStore.load) is covered. The spy calls through to
      // the real implementation by default, so disposal actually takes effect.
      const disposeSpy = spyOn(EventStore.prototype, 'dispose');

      try {
        const { manager } = createManager();
        const workDir = makeWorkDir('rp-dispose');
        await mkdir(workDir, { recursive: true });

        // Pre-place the release marker so the workflow completes immediately.
        await writeFile(join(workDir, 'release.marker'), '1');
        await manager.startRun({ workflowName: 'develop', taskPrompt: 't', cwd, workDir } as any);

        await waitFor(() => manager.listRuns()[0]?.status === 'complete');

        // Sanity: the store has not been disposed during the run itself.
        const callsBeforeReap = disposeSpy.mock.calls.length;

        // The IIFE's finally block scheduled exactly one 60s reaper.
        expect(reapers.length).toBeGreaterThanOrEqual(1);
        for (const fire of reapers) fire();

        // Reaping must dispose the run's store so subscribers are torn down
        // and pending writes do not fire into a dead store.
        expect(disposeSpy.mock.calls.length).toBeGreaterThan(callsBeforeReap);
      } finally {
        disposeSpy.mockRestore();
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

  // ─── startRun: worktree gating removed ───────────────────────────────────

  describe('startRun — worktree gating removed', () => {
    it('does not set up a worktree synchronously; worktree/worktreeManager start undefined', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('1234567890-nowt');
      await mkdir(workDir, { recursive: true });

      const result = await manager.startRun({
        workflowName: 'develop',
        taskPrompt: 't',
        cwd,
        workDir,
      } as any);

      // White-box: inspect the registered handle. The `msg.worktree` gate has
      // been removed — startRun no longer calls setupWorktree. The worktree
      // fields start undefined and are populated asynchronously by the
      // RunExecutor during workflow execution.
      const handle = (manager as any).registry.get(result.runId);
      expect(handle).toBeDefined();
      expect(handle.worktree).toBeUndefined();
      expect(handle.worktreeManager).toBeUndefined();
      expect(result.summary.worktree).toBeUndefined();

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
    });

    it('forwards apiKeys onto the handle without creating a worktree', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('1234567890-apikeys');
      await mkdir(workDir, { recursive: true });

      const result = await manager.startRun({
        workflowName: 'develop',
        taskPrompt: 't',
        cwd,
        workDir,
        apiKeys: { OPENAI_API_KEY: 'sk-test' },
      } as any);

      const handle = (manager as any).registry.get(result.runId);
      expect(handle.apiKeys).toEqual({ OPENAI_API_KEY: 'sk-test' });
      // apiKeys alone must not trigger synchronous worktree creation.
      expect(handle.worktree).toBeUndefined();
      expect(handle.worktreeManager).toBeUndefined();

      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
    });
  });

  // ─── handleWorktreeAction: two-prompt merge UX ───────────────────────────

  describe('handleWorktreeAction (two-prompt merge UX)', () => {
    it('is a no-op when the runId is unknown', async () => {
      const { manager } = createManager();
      const wtm = makeMockWorktreeManager();
      const { sent } = registerWorktreeRun(manager, { runId: 'wt-known', worktreeManager: wtm });

      await manager.handleWorktreeAction('does-not-exist', 'merge');

      expect(wtm.finalMergeToMain).not.toHaveBeenCalled();
      expect(sent.some((m) => m.type === 'worktree_merge_result')).toBe(false);
    });

    it('is a no-op when the handle has no worktreeManager (non-git fallback, run already terminal)', async () => {
      const { manager } = createManager();
      const { handle, sent } = registerWorktreeRun(manager, {
        runId: 'wt-nowtm',
        worktreeManager: undefined,
      });
      // Simulate the non-git fallback: the run completed without ever
      // creating a worktreeManager. Setting a terminal status ensures the
      // bounded wait bails immediately instead of polling for the full 5 s.
      handle.status = 'complete';

      await manager.handleWorktreeAction('wt-nowtm', 'merge');

      expect(sent.some((m) => m.type === 'worktree_merge_result')).toBe(false);
    });

    // ─── wait-for-worktreeManager guard (async-write vs sync-read race) ─────
    //
    // The executor populates `handle.worktreeManager` ASYNCHRONOUSLY (LLM
    // branch-slug generation). A `worktree_action` that arrives before setup
    // completes must NOT be silently dropped: handleWorktreeAction now polls
    // briefly for the manager, bails if the run fails first, and times out
    // gracefully if the manager never appears (non-git fallback / executor
    // crash).
    describe('wait-for-worktreeManager guard', () => {
      it('waits for worktreeManager to be populated asynchronously before proceeding', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager({
          finalMerge: { success: true, conflicts: [], conflictsResolved: false },
        });
        const { handle, sent } = registerWorktreeRun(manager, {
          runId: 'wt-wait',
          worktreeManager: undefined,
        });

        // Simulate the executor finishing worktree setup shortly after the
        // client's `worktree_action` is in flight.
        setTimeout(() => {
          handle.worktreeManager = wtm;
        }, 50);

        await manager.handleWorktreeAction('wt-wait', 'merge');

        // The action was NOT dropped: the merge proceeded once the manager
        // became available.
        expect(wtm.finalMergeToMain).toHaveBeenCalledTimes(1);
        expect(wtm.cleanup).toHaveBeenCalledTimes(1);
        const results = sent.filter((m) => m.type === 'worktree_merge_result');
        expect(results).toHaveLength(1);
        expect(results[0].outcome).toBe('clean');
      });

      it('stops waiting and drops the action if the run fails before worktreeManager is set', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager();
        const { handle, sent } = registerWorktreeRun(manager, {
          runId: 'wt-failwait',
          worktreeManager: undefined,
        });

        // The run fails (e.g. executor throws during worktree setup) before a
        // manager is ever attached. The wait must bail immediately rather than
        // spinning until the timeout.
        setTimeout(() => {
          handle.status = 'failed';
        }, 50);

        const start = Date.now();
        await manager.handleWorktreeAction('wt-failwait', 'merge');
        const elapsed = Date.now() - start;

        expect(wtm.finalMergeToMain).not.toHaveBeenCalled();
        expect(sent.some((m) => m.type === 'worktree_merge_result')).toBe(false);
        // Bailed well before the full 5s timeout window.
        expect(elapsed).toBeLessThan(2000);
      });

      it('stops waiting and drops the action if the run completes before worktreeManager is set', async () => {
        // A run can reach 'complete' without a worktreeManager in the non-git
        // fallback path. The bounded wait must bail on ANY terminal status
        // (not just 'failed') so it does not spin for the full 5 s after the
        // run has already settled.
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager();
        const { handle, sent } = registerWorktreeRun(manager, {
          runId: 'wt-completewait',
          worktreeManager: undefined,
        });

        setTimeout(() => {
          handle.status = 'complete';
        }, 50);

        const start = Date.now();
        await manager.handleWorktreeAction('wt-completewait', 'merge');
        const elapsed = Date.now() - start;

        expect(wtm.finalMergeToMain).not.toHaveBeenCalled();
        expect(sent.some((m) => m.type === 'worktree_merge_result')).toBe(false);
        // Bailed well before the full 5s timeout window.
        expect(elapsed).toBeLessThan(2000);
      });

      it('returns without action when worktreeManager is never set within the bounded timeout', async () => {
        // Use fake timers to avoid a real 5 s wall-clock delay: each 100 ms
        // poll advances a virtual clock so the deadline is reached in a few
        // microseconds of real time. Only 100 ms-poll timers are accelerated;
        // all other timers use the real scheduler.
        const realDateNow = Date.now;
        const realSetTimeout = globalThis.setTimeout;
        let virtualTime = realDateNow();
        Date.now = () => virtualTime;
        globalThis.setTimeout = ((cb: any, delay?: number, ...args: any[]) => {
          if (delay === 100) {
            // Fast-forward the virtual clock by the poll interval so the
            // deadline check in the polling loop trips after ~50 iterations.
            virtualTime += 100;
            return realSetTimeout(cb, 0, ...args);
          }
          return realSetTimeout(cb, delay, ...args);
        }) as any;

        try {
          const { manager } = createManager();
          const { sent } = registerWorktreeRun(manager, {
            runId: 'wt-timeout',
            // No worktreeManager is ever attached, and the run stays 'running'.
            worktreeManager: undefined,
          });

          const realStart = realDateNow();
          await manager.handleWorktreeAction('wt-timeout', 'merge');
          const realElapsed = realDateNow() - realStart;

          // No broadcast — the wait exhausted its bounded budget and gave up.
          expect(sent.some((m) => m.type === 'worktree_merge_result')).toBe(false);
          // The virtual deadline was reached without a real 5 s stall.
          expect(realElapsed).toBeLessThan(2000);
        } finally {
          Date.now = realDateNow;
          globalThis.setTimeout = realSetTimeout as any;
        }
      });
    });

    describe('merge', () => {
      it('on a clean merge: calls finalMergeToMain + cleanup and broadcasts outcome "clean"', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager({
          finalMerge: { success: true, conflicts: [], conflictsResolved: false },
        });
        const { sent } = registerWorktreeRun(manager, { runId: 'wt-clean', worktreeManager: wtm });

        await manager.handleWorktreeAction('wt-clean', 'merge');

        expect(wtm.finalMergeToMain).toHaveBeenCalledTimes(1);
        expect(wtm.cleanup).toHaveBeenCalledTimes(1);

        const results = sent.filter((m) => m.type === 'worktree_merge_result');
        expect(results).toHaveLength(1);
        expect(results[0].runId).toBe('wt-clean');
        expect(results[0].outcome).toBe('clean');
      });

      it('surfaces a cleanupError on a clean merge when cleanup reports one', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager({
          finalMerge: { success: true, conflicts: [], conflictsResolved: false },
          cleanupError: 'failed to remove worktree',
        });
        const { sent } = registerWorktreeRun(manager, { runId: 'wt-cleanerr', worktreeManager: wtm });

        await manager.handleWorktreeAction('wt-cleanerr', 'merge');

        expect(wtm.cleanup).toHaveBeenCalledTimes(1);
        const results = sent.filter((m) => m.type === 'worktree_merge_result');
        expect(results[0].outcome).toBe('clean');
        expect(results[0].cleanupError).toBe('failed to remove worktree');
      });

      it('on conflicts: broadcasts "conflicts" with worktreePath + branchName and does NOT clean up', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager({
          finalMerge: { success: false, conflicts: ['src/a.ts', 'src/b.ts'], conflictsResolved: false },
        });
        const { sent } = registerWorktreeRun(manager, {
          runId: 'wt-conflict',
          worktreeManager: wtm,
          worktreePath: '/wt/main',
          branchName: 'engin/feat',
        });

        await manager.handleWorktreeAction('wt-conflict', 'merge');

        expect(wtm.finalMergeToMain).toHaveBeenCalledTimes(1);
        expect(wtm.cleanup).not.toHaveBeenCalled();

        const results = sent.filter((m) => m.type === 'worktree_merge_result');
        expect(results).toHaveLength(1);
        expect(results[0].outcome).toBe('conflicts');
        expect(results[0].worktreePath).toBe('/wt/main');
        expect(results[0].branchName).toBe('engin/feat');
      });

      it('on a merge failure with no conflicts: broadcasts "failed" and does NOT clean up', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager({
          finalMerge: { success: false, conflicts: [], conflictsResolved: false },
        });
        const { sent } = registerWorktreeRun(manager, { runId: 'wt-fail', worktreeManager: wtm });

        await manager.handleWorktreeAction('wt-fail', 'merge');

        expect(wtm.finalMergeToMain).toHaveBeenCalledTimes(1);
        expect(wtm.cleanup).not.toHaveBeenCalled();

        const results = sent.filter((m) => m.type === 'worktree_merge_result');
        expect(results).toHaveLength(1);
        expect(results[0].outcome).toBe('failed');
      });

      it('forwards the failure reason in the error field on a merge failure', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager({
          finalMerge: {
            success: false,
            conflicts: [],
            conflictsResolved: false,
            error: 'git merge --squash failed: already up to date',
          },
        });
        const { sent } = registerWorktreeRun(manager, { runId: 'wt-fail-err', worktreeManager: wtm });

        await manager.handleWorktreeAction('wt-fail-err', 'merge');

        const results = sent.filter((m) => m.type === 'worktree_merge_result');
        expect(results[0].outcome).toBe('failed');
        expect(results[0].error).toBe('git merge --squash failed: already up to date');
      });
    });

    describe('resolve', () => {
      it('after a conflict merge, resolve succeeds: calls resolveFinalMergeConflicts + cleanup, broadcasts "resolved"', async () => {
        const { manager } = createManager();
        const conflicts = ['src/a.ts'];
        const wtm = makeMockWorktreeManager({
          finalMerge: { success: false, conflicts, conflictsResolved: false },
          resolveResult: true,
        });
        const { sent } = registerWorktreeRun(manager, { runId: 'wt-resolve', worktreeManager: wtm });

        // Two-prompt flow: (1) merge yields conflicts, (2) resolve succeeds.
        await manager.handleWorktreeAction('wt-resolve', 'merge');
        await manager.handleWorktreeAction('wt-resolve', 'resolve');

        expect(wtm.resolveFinalMergeConflicts).toHaveBeenCalledTimes(1);
        // The conflicts from the merge flow into the resolve call, and the
        // taskPrompt is forwarded as the second argument.
        expect(wtm.resolveFinalMergeConflicts.mock.calls[0][0]).toEqual(conflicts);
        expect(wtm.resolveFinalMergeConflicts.mock.calls[0][1]).toBe('do the thing');
        // cleanup runs exactly once (on the successful resolve), not on the
        // conflict merge.
        expect(wtm.cleanup).toHaveBeenCalledTimes(1);

        const outcomes = sent.filter((m) => m.type === 'worktree_merge_result').map((m) => m.outcome);
        expect(outcomes).toEqual(['conflicts', 'resolved']);
      });

      it('on a resolve failure: broadcasts "failed" and does NOT clean up', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager({
          finalMerge: { success: false, conflicts: ['src/a.ts'], conflictsResolved: false },
          resolveResult: false,
        });
        const { sent } = registerWorktreeRun(manager, { runId: 'wt-resolvefail', worktreeManager: wtm });

        await manager.handleWorktreeAction('wt-resolvefail', 'merge');
        await manager.handleWorktreeAction('wt-resolvefail', 'resolve');

        expect(wtm.resolveFinalMergeConflicts).toHaveBeenCalledTimes(1);
        expect(wtm.cleanup).not.toHaveBeenCalled();

        const outcomes = sent.filter((m) => m.type === 'worktree_merge_result').map((m) => m.outcome);
        expect(outcomes).toEqual(['conflicts', 'failed']);
      });

      it('forwards the resolution failure reason in the error field on a resolve failure', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager();
        // Override resolveFinalMergeConflicts to return a failure with a reason.
        wtm.resolveFinalMergeConflicts = mock(
          async (): Promise<{ resolved: boolean; error?: string }> => ({
            resolved: false,
            error: 'agent could not resolve conflicts after 3 attempts',
          }),
        );
        const { sent } = registerWorktreeRun(manager, { runId: 'wt-resolveerr', worktreeManager: wtm });

        await manager.handleWorktreeAction('wt-resolveerr', 'merge');
        await manager.handleWorktreeAction('wt-resolveerr', 'resolve');

        const results = sent.filter((m) => m.type === 'worktree_merge_result');
        const failed = results.find((m) => m.outcome === 'failed');
        expect(failed).toBeDefined();
        expect(failed!.error).toBe('agent could not resolve conflicts after 3 attempts');
      });
    });

    describe('decline', () => {
      it('calls abortFinalMerge, broadcasts "declined" with worktreePath + branchName, and does NOT clean up', async () => {
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager();
        const { sent } = registerWorktreeRun(manager, {
          runId: 'wt-decline',
          worktreeManager: wtm,
          worktreePath: '/wt/main',
          branchName: 'engin/feat',
        });

        await manager.handleWorktreeAction('wt-decline', 'decline');

        expect(wtm.abortFinalMerge).toHaveBeenCalledTimes(1);
        expect(wtm.cleanup).not.toHaveBeenCalled();

        const results = sent.filter((m) => m.type === 'worktree_merge_result');
        expect(results).toHaveLength(1);
        expect(results[0].outcome).toBe('declined');
        expect(results[0].worktreePath).toBe('/wt/main');
        expect(results[0].branchName).toBe('engin/feat');
      });

      it('still broadcasts "declined" when abortFinalMerge rejects (no merge in progress)', async () => {
        // Mirrors the common flow where the user answers 'No' to Prompt 1
        // before any merge was ever attempted: `git merge --abort` exits with
        // code 128 ('fatal: There is no merge to abort'). The abort is
        // best-effort, so the 'declined' broadcast must still fire.
        const { manager } = createManager();
        const wtm = makeMockWorktreeManager();
        wtm.abortFinalMerge = mock(async (): Promise<void> => {
          throw new Error('fatal: There is no merge to abort');
        });
        const { sent } = registerWorktreeRun(manager, {
          runId: 'wt-decline-nomerge',
          worktreeManager: wtm,
          worktreePath: '/wt/main',
          branchName: 'engin/feat',
        });

        await manager.handleWorktreeAction('wt-decline-nomerge', 'decline');

        expect(wtm.abortFinalMerge).toHaveBeenCalledTimes(1);
        expect(wtm.cleanup).not.toHaveBeenCalled();

        const results = sent.filter((m) => m.type === 'worktree_merge_result');
        expect(results).toHaveLength(1);
        expect(results[0].outcome).toBe('declined');
        expect(results[0].worktreePath).toBe('/wt/main');
        expect(results[0].branchName).toBe('engin/feat');
      });
    });
  });
});
