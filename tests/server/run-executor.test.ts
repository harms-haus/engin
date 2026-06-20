// ─── RunExecutor — test-first specification ───────────────────────────────
//
// Test-first specification for `packages/engine/src/server/run-executor.ts`,
// the workflow-execution body extracted from RunManager (decomposition step).
// It contains the former private `executeWorkflow` async IIFE: the
// workflow.run() lifecycle, store flush, status transitions
// (running → complete / failed), terminal broadcasts, renderer-registry
// wiring, the post-terminal reaper scheduling, AND the worktree lifecycle:
//
//   - When git is available, RunExecutor creates a {@link WorktreeManager},
//     calls `setupMainWorktree()`, wires it onto the handle + WorkflowRunOptions
//     (options.cwd becomes the MAIN WORKTREE PATH — the transparency
//     mechanism by which the workflow sees the worktree as its cwd), and
//     derives the main-wt branch via `generateTitleAndBranch` +
//     `sanitizeBranchSlug`.
//   - When the cwd is NOT a git repo, it warns and runs in-place (no
//     worktree), leaving options.cwd = handle.cwd.
//   - On failure, the worktree is PRESERVED (no cleanup) so the user can
//     inspect or retry.
//
// CONTRACT UNDER TEST (the module must export a class `RunExecutor`):
//
//   class RunExecutor {
//     constructor(
//       registry: RunRegistry,
//       onRunsChanged: () => void,
//       reapDelayMs?: number,   // default 60_000
//     );
//     execute(
//       handle: RunHandle,
//       workflow: WorkflowModule,
//       storeCallbacks: StatusCallbacks,
//       msg: StartRunMessage,
//     ): Promise<void>;
//   }
//
// CRITICAL INVARIANT (called out by the decomposition task):
//   `execute` MUST call `bridge.broadcastTerminal(...)` to emit the terminal
//   `run_complete` / `run_failed` messages. After task-29 removes the
//   projection-change-based terminal detection from StatusBridge,
//   `broadcastTerminal` is the ONLY path for terminal messages — so if the
//   call is dropped, clients never learn a run finished. These tests pin
//   that call directly via a spy on `StatusBridge.prototype.broadcastTerminal`.
//
// The git / title-generator / config / worktree-manager modules are mocked
// (via `mock.module`) so the worktree path is exercised WITHOUT real `git`
// commands or LLM calls. A real EventStore + StatusBridge back each handle so
// flush/durability/projection behaviour is exercised.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServerMessage } from '@engin/shared/protocol-types';
import type { StatusCallbacks, WorkflowModule, WorktreeInfo } from '../../packages/engine/src/core/types.js';
import type { WorktreeManagerOptions } from '../../packages/engine/src/core/worktree-manager.js';
import type { RunHandle, StartRunMessage } from '../../packages/engine/src/server/run-manager.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Capture real modules before mocking ────────────────────────────────────
// Without the restore, these relative-path mock.module() registrations leak
// into sibling test files under CI's parallel scheduling (mirrors the pattern
// in tests/core/worktree-manager.test.ts).
const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realTitleGenerator = Object.assign({}, await import('../../packages/engine/src/core/title-generator.js'));
const realWorktreeManager = Object.assign({}, await import('../../packages/engine/src/core/worktree-manager.js'));
const realConfig = Object.assign({}, await import('../../packages/engine/src/core/config.js'));

// ─── Mock functions ─────────────────────────────────────────────────────────

interface GenTitleArgs {
  profilesDirs: string[];
  taskPrompt: string;
  cwd: string;
  apiKeys?: Record<string, string>;
}

const mockIsGitRepo = mock((_dir: string): boolean => false);
const mockGetRepoRoot = mock((dir: string): string => dir);
const mockSanitizeBranchSlug = mock((text: string): string => text);
const mockGenerateTitleAndBranch = mock(
  async (_opts: GenTitleArgs): Promise<{ title: string; branchName: string }> => ({
    title: 'Test Title',
    branchName: 'test-branch',
  }),
);
const mockResolveProfilesDirs = mock((_cwd: string, _workflowName?: string): string[] => [
  '/profiles/local',
  '/profiles/global',
]);

// ─── WorktreeManager mock ───────────────────────────────────────────────────
//
// A constructable stand-in for the real WorktreeManager. Instances record the
// constructor opts and track setupMainWorktree / cleanup / getWorktreeInfo
// calls so tests can assert wiring WITHOUT real git operations. Every instance
// is pushed into `wtmInstances` for inspection.

const wtmInstances: MockWorktreeManager[] = [];

class MockWorktreeManager {
  readonly repoRoot: string;
  readonly sourceCwd: string;
  readonly workDir: string;
  readonly mainBranch: string;
  readonly mainWorktreePath: string;
  readonly profilesDirs: string[];
  readonly apiKeys?: Record<string, string>;

  setupMainWorktreeCalls = 0;
  cleanupCalls = 0;
  getWorktreeInfoCalls = 0;

  constructor(opts: WorktreeManagerOptions) {
    this.repoRoot = opts.repoRoot;
    this.sourceCwd = opts.sourceCwd;
    this.workDir = opts.workDir;
    this.mainBranch = opts.mainBranch;
    this.mainWorktreePath = opts.mainWorktreePath;
    this.profilesDirs = opts.profilesDirs;
    this.apiKeys = opts.apiKeys;
    wtmInstances.push(this);
  }

  async setupMainWorktree(): Promise<void> {
    this.setupMainWorktreeCalls++;
  }

  getWorktreeInfo(): WorktreeInfo {
    this.getWorktreeInfoCalls++;
    return {
      worktreePath: this.mainWorktreePath,
      branchName: this.mainBranch,
      originalCwd: this.sourceCwd,
    };
  }

  async cleanup(): Promise<{ cleanupError?: string }> {
    this.cleanupCalls++;
    return {};
  }
}

// ─── Mock modules ───────────────────────────────────────────────────────────
// Spread the real exports so only the symbols RunExecutor consumes are
// overridden; everything else stays the real implementation.

mock.module('../../packages/engine/src/core/git.js', () => ({
  ...realGit,
  isGitRepo: mockIsGitRepo,
  getRepoRoot: mockGetRepoRoot,
  sanitizeBranchSlug: mockSanitizeBranchSlug,
}));

mock.module('../../packages/engine/src/core/title-generator.js', () => ({
  ...realTitleGenerator,
  generateTitleAndBranch: mockGenerateTitleAndBranch,
}));

mock.module('../../packages/engine/src/core/config.js', () => ({
  ...realConfig,
  resolveProfilesDirs: mockResolveProfilesDirs,
}));

mock.module('../../packages/engine/src/core/worktree-manager.js', () => ({
  WorktreeManager: MockWorktreeManager,
}));

// ─── Import SUT + real dependencies AFTER mocks ─────────────────────────────

import { RunExecutor } from '../../packages/engine/src/server/run-executor.js';
import { RunRegistry } from '../../packages/engine/src/server/run-registry.js';
import { StatusBridge } from '../../packages/engine/src/server/status-bridge.js';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';
import { createStoreCallbacks } from '../../packages/engine/src/tracking/store-callbacks.js';

// ─── Inline workflow modules ────────────────────────────────────────────────
//
// `okWorkflow`    — appends a workflow_started event (seeds the store, so we
//                   can assert flush durability) then resolves successfully.
// `boomWorkflow`  — seeds the store then throws a genuine (non-abort) error.
// `abortWorkflow` — seeds the store then blocks until the AbortSignal fires,
//                   rejecting with an AbortError (cooperative cancellation).
// `capturingWorkflow` — seeds the store then stashes the WorkflowRunOptions it
//                   received, so a test can assert on cwd / worktreeManager /
//                   worktree wiring.

function makeOkWorkflow(): WorkflowModule {
  return {
    async run(taskPrompt, options) {
      options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
    },
  };
}

function makeBoomWorkflow(message = 'kaboom: workflow exploded'): WorkflowModule {
  return {
    async run(taskPrompt, options) {
      options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
      throw new Error(message);
    },
  };
}

/** A workflow that blocks until the AbortSignal fires. Sets `started` once running. */
function makeAbortWorkflow(startedRef: { value: boolean }): WorkflowModule {
  return {
    async run(taskPrompt, options) {
      options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
      startedRef.value = true;
      const signal = options.signal;
      return new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  };
}

/** Captures the WorkflowRunOptions handed to run() into `probe`. */
function makeCapturingWorkflow(probe: {
  cwd?: string;
  workDir?: string;
  worktreeManager?: unknown;
  worktree?: WorktreeInfo;
  signal?: AbortSignal;
  apiKeys?: Record<string, string>;
}): WorkflowModule {
  return {
    async run(taskPrompt, options) {
      options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
      probe.cwd = options.cwd;
      probe.workDir = options.workDir;
      probe.worktreeManager = options.worktreeManager;
      probe.worktree = options.worktree;
      probe.signal = options.signal;
      probe.apiKeys = options.apiKeys;
    },
  };
}

// ─── Generic helpers ────────────────────────────────────────────────────────

/** Poll until fn returns truthy (or throw after `timeout` ms). */
async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeout?: number; interval?: number } = {}): Promise<T> {
  const timeout = opts.timeout ?? 5000;
  const interval = opts.interval ?? 10;
  const start = Date.now();
  for (;;) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      // keep polling
    }
    if (Date.now() - start >= timeout) throw new Error(`waitFor timed out after ${timeout}ms`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('RunExecutor', () => {
  const { getDir } = useTempDir();

  // Captured 60s reaper timers (intercepted so they never actually fire on
  // the real scheduler during a test). The reaper-specific test fires them.
  let reapers: Array<() => void>;
  let realSetTimeout: typeof globalThis.setTimeout;
  const bridges: StatusBridge[] = [];
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    reapers = [];
    realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((cb: any, delay?: number, ...args: any[]) => {
      if (delay === 60_000) {
        reapers.push(cb as () => void);
        return 0 as any;
      }
      return realSetTimeout(cb as any, delay, ...args);
    }) as any;

    // Reset worktree-path mocks to the non-git default so the pre-existing
    // tests (which do not configure git) take the in-place path. Each git
    // test overrides the relevant mock locally.
    mock.clearAllMocks();
    mockIsGitRepo.mockReturnValue(false);
    mockGetRepoRoot.mockImplementation((dir: string) => dir);
    mockSanitizeBranchSlug.mockImplementation((text: string) => text);
    mockGenerateTitleAndBranch.mockResolvedValue({ title: 'Test Title', branchName: 'test-branch' });
    mockResolveProfilesDirs.mockReturnValue(['/profiles/local', '/profiles/global']);
    wtmInstances.length = 0;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout as any;
    for (const s of spies) s.mockRestore();
    spies.length = 0;
    for (const b of bridges) b.dispose();
    bridges.length = 0;
  });

  // Restore the real modules so the mock.module() registrations do not leak
  // into sibling test files under CI's parallel scheduling.
  afterAll(() => {
    mock.module('../../packages/engine/src/core/git.js', () => realGit);
    mock.module('../../packages/engine/src/core/title-generator.js', () => realTitleGenerator);
    mock.module('../../packages/engine/src/core/config.js', () => realConfig);
    mock.module('../../packages/engine/src/core/worktree-manager.js', () => realWorktreeManager);
  });

  // ─── setup helpers ───────────────────────────────────────────────────────

  interface Setup {
    runId: string;
    handle: RunHandle;
    registry: RunRegistry;
    executor: RunExecutor;
    store: EventStore;
    storeCallbacks: StatusCallbacks;
    messages: ServerMessage[];
    runsChanged: () => number;
    fireReapers: () => void;
    reaperCount: () => number;
  }

  function setup(runId: string): Setup {
    const workDir = join(getDir(), runId);
    // EventStore.ensureDir() creates the dir on first flush, but pre-create
    // it so the durability read never races the mkdir.
    void mkdir(workDir, { recursive: true });

    const store = new EventStore(workDir);
    const messages: ServerMessage[] = [];
    const broadcast = (m: ServerMessage) => {
      messages.push(m);
    };
    const bridge = new StatusBridge(broadcast, store, runId);
    bridges.push(bridge);

    let runsChangedCount = 0;
    const onRunsChanged = () => {
      runsChangedCount++;
    };

    const registry = new RunRegistry();
    const executor = new RunExecutor(registry, onRunsChanged);

    const handle: RunHandle = {
      runId,
      cwd: '/tmp/project',
      workflowName: 'develop',
      taskPrompt: 'do the thing',
      workDir,
      store,
      controller: new AbortController(),
      bridge,
      status: 'running',
      summary: {
        runId,
        cwd: '/tmp/project',
        workflowName: 'develop',
        taskPrompt: 'do the thing',
        status: 'running',
        startedAt: new Date().toISOString(),
      },
      startedAt: new Date().toISOString(),
      subscribers: new Set(),
    };
    registry.register(handle);

    return {
      runId,
      handle,
      registry,
      executor,
      store,
      storeCallbacks: createStoreCallbacks(store),
      messages,
      runsChanged: () => runsChangedCount,
      fireReapers: () => {
        for (const r of reapers) r();
      },
      reaperCount: () => reapers.length,
    };
  }

  function makeMsg(runId: string, workDir: string): StartRunMessage {
    return {
      workflowName: 'develop',
      taskPrompt: 'do the thing',
      cwd: '/tmp/project',
      workDir,
    } as StartRunMessage;
  }

  /** Like makeMsg but with explicit apiKeys (used to verify apiKey propagation). */
  function makeMsgWithKeys(runId: string, workDir: string, apiKeys?: Record<string, string>): StartRunMessage {
    return {
      workflowName: 'develop',
      taskPrompt: 'do the thing',
      cwd: '/tmp/project',
      workDir,
      ...(apiKeys ? { apiKeys } : {}),
    } as StartRunMessage;
  }

  // ─── success path ────────────────────────────────────────────────────────

  describe('success path', () => {
    it('flips status to complete and broadcasts run_complete via broadcastTerminal', async () => {
      const s = setup('exec-ok');
      const spy = spyOn(StatusBridge.prototype, 'broadcastTerminal');
      spies.push(spy);

      await s.executor.execute(s.handle, makeOkWorkflow(), s.storeCallbacks, makeMsg('exec-ok', s.handle.workDir));

      expect(s.handle.status).toBe('complete');
      expect(s.handle.summary.status).toBe('complete');

      // CRITICAL: the terminal message MUST be emitted via broadcastTerminal.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toEqual({ type: 'run_complete', runId: 'exec-ok' });

      // And it reached the broadcast sink tagged with runId.
      const completes = s.messages.filter((m) => m.type === 'run_complete');
      expect(completes).toHaveLength(1);
      expect(completes[0]).toEqual({ type: 'run_complete', runId: 'exec-ok' });
    });

    it('flushes the store BEFORE flipping status (partial events are durable)', async () => {
      const s = setup('exec-flush');
      const flushSpy = spyOn(EventStore.prototype, 'flush');
      spies.push(flushSpy);

      await s.executor.execute(s.handle, makeOkWorkflow(), s.storeCallbacks, makeMsg('exec-flush', s.handle.workDir));

      // flush() was awaited at least once on the success path.
      expect(flushSpy).toHaveBeenCalled();

      // The seeded workflow_started event is durable on disk by the time the
      // run reports complete.
      const logPath = join(s.handle.workDir, 'events.jsonl');
      expect(existsSync(logPath)).toBe(true);
      const log = await readFile(logPath, 'utf-8');
      expect(log).toContain('workflow_started');
    });

    it('calls onRunsChanged once the run settles (finally block)', async () => {
      const s = setup('exec-onchanged');
      const before = s.runsChanged();

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-onchanged', s.handle.workDir),
      );

      expect(s.runsChanged()).toBeGreaterThan(before);
    });
  });

  // ─── failure path ────────────────────────────────────────────────────────

  describe('failure path', () => {
    it('flips status to failed and broadcasts run_failed with the genuine error', async () => {
      const s = setup('exec-fail');
      const spy = spyOn(StatusBridge.prototype, 'broadcastTerminal');
      spies.push(spy);

      await s.executor.execute(
        s.handle,
        makeBoomWorkflow('kaboom: workflow exploded'),
        s.storeCallbacks,
        makeMsg('exec-fail', s.handle.workDir),
      );

      expect(s.handle.status).toBe('failed');
      expect(s.handle.summary.status).toBe('failed');

      // CRITICAL: run_failed is emitted via broadcastTerminal with the raw
      // error message (NOT "Run cancelled").
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0] as { type: string; runId: string; error: string; phase: string };
      expect(payload.type).toBe('run_failed');
      expect(payload.runId).toBe('exec-fail');
      expect(payload.error).toBe('kaboom: workflow exploded');

      const failed = s.messages.filter((m) => m.type === 'run_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ type: 'run_failed', runId: 'exec-fail', error: 'kaboom: workflow exploded' });
    });

    it('flushes the store even on error (partial events stay durable)', async () => {
      const s = setup('exec-fail-flush');

      await s.executor.execute(
        s.handle,
        makeBoomWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-fail-flush', s.handle.workDir),
      );

      const log = await readFile(join(s.handle.workDir, 'events.jsonl'), 'utf-8');
      expect(log).toContain('workflow_started');
    });

    it('calls onRunsChanged in the finally block even when the workflow throws', async () => {
      const s = setup('exec-fail-onchanged');
      const before = s.runsChanged();

      await s.executor.execute(
        s.handle,
        makeBoomWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-fail-onchanged', s.handle.workDir),
      );

      expect(s.runsChanged()).toBeGreaterThan(before);
    });
  });

  // ─── cancellation / abort ────────────────────────────────────────────────

  describe('cancellation (abort)', () => {
    it('surfaces "Run cancelled" as run_failed when the AbortSignal fires', async () => {
      const s = setup('exec-abort');
      const spy = spyOn(StatusBridge.prototype, 'broadcastTerminal');
      spies.push(spy);
      const started = { value: false };

      const execPromise = s.executor.execute(
        s.handle,
        makeAbortWorkflow(started),
        s.storeCallbacks,
        makeMsg('exec-abort', s.handle.workDir),
      );

      // Wait until the workflow has started blocking, then abort.
      await waitFor(() => started.value);
      s.handle.controller.abort();
      await execPromise;

      expect(s.handle.status).toBe('failed');

      // AbortError → the canonical "Run cancelled" message (NOT the raw error).
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0] as { type: string; error: string };
      expect(payload.type).toBe('run_failed');
      expect(payload.error).toBe('Run cancelled');

      const failed = s.messages.filter((m) => m.type === 'run_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ type: 'run_failed', error: 'Run cancelled' });
    });
  });

  // ─── renderer-registry wiring ────────────────────────────────────────────

  describe('renderer registry wiring', () => {
    it('creates a RendererRegistry, invokes registerRenderers, and passes it via options', async () => {
      const s = setup('exec-renderer');
      const probe: { present?: boolean; ctor?: string; rendered?: string; sameRef?: boolean } = {};
      let hookRegistry: unknown = null;

      const workflow: WorkflowModule = {
        registerRenderers(reg) {
          hookRegistry = reg;
          reg.register('developer', (data) => 'RENDERED:' + JSON.stringify(data));
        },
        async run(taskPrompt, options) {
          options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
          const reg = options.rendererRegistry;
          probe.present = !!reg;
          probe.ctor = reg?.constructor.name;
          probe.rendered = reg?.render('developer', { msg: taskPrompt }) ?? undefined;
          probe.sameRef = reg != null && reg === hookRegistry;
        },
      };

      await s.executor.execute(s.handle, workflow, s.storeCallbacks, makeMsg('exec-renderer', s.handle.workDir));

      expect(probe.present).toBe(true);
      expect(probe.ctor).toBe('RendererRegistry');
      // The hook ran and the registered renderer produced formatted output.
      expect(probe.rendered).toBe('RENDERED:' + JSON.stringify({ msg: 'do the thing' }));
      // The same registry instance was handed to the hook and to run().
      expect(probe.sameRef).toBe(true);
    });

    it('still passes an empty RendererRegistry when the workflow has no registerRenderers hook', async () => {
      const s = setup('exec-nohook');
      const probe: { present?: boolean; ctor?: string; missingUndefined?: boolean } = {};

      const workflow: WorkflowModule = {
        async run(taskPrompt, options) {
          options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
          const reg = options.rendererRegistry;
          probe.present = !!reg;
          probe.ctor = reg?.constructor.name;
          probe.missingUndefined = reg?.render('never-registered', { x: 1 }) === undefined;
        },
      };

      await s.executor.execute(s.handle, workflow, s.storeCallbacks, makeMsg('exec-nohook', s.handle.workDir));

      // Even without a hook, an empty registry is handed over.
      expect(probe.present).toBe(true);
      expect(probe.ctor).toBe('RendererRegistry');
      expect(probe.missingUndefined).toBe(true);
    });
  });

  // ─── reaper scheduling ───────────────────────────────────────────────────

  describe('reaper scheduling', () => {
    it('schedules a ~60s reaper after the run reaches a terminal state', async () => {
      const s = setup('exec-reap');

      await s.executor.execute(s.handle, makeOkWorkflow(), s.storeCallbacks, makeMsg('exec-reap', s.handle.workDir));

      // The finally block scheduled exactly one 60s reaper timer.
      expect(s.reaperCount()).toBeGreaterThanOrEqual(1);
    });

    it('removes the handle from the registry when the reaper fires', async () => {
      const s = setup('exec-reap-remove');

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-reap-remove', s.handle.workDir),
      );
      expect(s.registry.get('exec-reap-remove')).toBeDefined();

      const before = s.runsChanged();
      s.fireReapers();

      // Reaping removes the handle and notifies the control server again.
      expect(s.registry.get('exec-reap-remove')).toBeUndefined();
      expect(s.runsChanged()).toBeGreaterThan(before);
    });
  });

  // ─── worktree setup (git available) ──────────────────────────────────────

  describe('worktree setup (git available)', () => {
    it('checks isGitRepo(handle.cwd) and, when true, creates a WorktreeManager + calls setupMainWorktree', async () => {
      const s = setup('exec-wt-setup');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/repo/root');

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-wt-setup', s.handle.workDir),
      );

      // isGitRepo was probed with the handle's cwd.
      expect(mockIsGitRepo).toHaveBeenCalledWith(s.handle.cwd);

      // Exactly one WorktreeManager was constructed and its main worktree set up.
      expect(wtmInstances).toHaveLength(1);
      expect(wtmInstances[0].setupMainWorktreeCalls).toBe(1);

      // The manager is wired onto the handle for handleWorktreeAction access.
      // (Cast to unknown: handle.worktreeManager is typed as the real
      // WorktreeManager, but at runtime it holds our MockWorktreeManager.)
      expect(s.handle.worktreeManager as unknown).toBe(wtmInstances[0]);
    });

    it('sets options.cwd to the MAIN WORKTREE PATH (not the original cwd) — the transparency mechanism', async () => {
      const s = setup('exec-wt-cwd');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/repo/root');
      const probe: { cwd?: string } = {};

      await s.executor.execute(
        s.handle,
        makeCapturingWorkflow(probe),
        s.storeCallbacks,
        makeMsg('exec-wt-cwd', s.handle.workDir),
      );

      const expectedWorktreePath = join(s.handle.workDir, 'worktree');
      // The workflow sees the worktree as its cwd.
      expect(probe.cwd).toBe(expectedWorktreePath);
      expect(probe.cwd).not.toBe(s.handle.cwd);
    });

    it('passes worktreeManager and worktree to the workflow via WorkflowRunOptions', async () => {
      const s = setup('exec-wt-opts');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/repo/root');
      const probe: { worktreeManager?: unknown; worktree?: WorktreeInfo } = {};

      await s.executor.execute(
        s.handle,
        makeCapturingWorkflow(probe),
        s.storeCallbacks,
        makeMsg('exec-wt-opts', s.handle.workDir),
      );

      expect(wtmInstances).toHaveLength(1);
      expect(probe.worktreeManager).toBe(wtmInstances[0]);
      expect(probe.worktree).toEqual({
        worktreePath: join(s.handle.workDir, 'worktree'),
        branchName: wtmInstances[0].mainBranch,
        originalCwd: s.handle.cwd,
      });
    });

    it('sets handle.worktree, handle.summary.worktree alongside handle.worktreeManager', async () => {
      const s = setup('exec-wt-handle');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/repo/root');
      // Drive the slug through the full pipeline: raw branch → sanitize → engin/<slug>.
      mockGenerateTitleAndBranch.mockResolvedValue({ title: 'My Title', branchName: 'raw branch NAME' });
      mockSanitizeBranchSlug.mockReturnValue('sanitized');

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-wt-handle', s.handle.workDir),
      );

      const expectedPath = join(s.handle.workDir, 'worktree');
      const expectedBranch = 'engin/sanitized';

      expect(s.handle.worktreeManager).toBeDefined();
      expect(s.handle.worktree).toEqual({
        worktreePath: expectedPath,
        branchName: expectedBranch,
        originalCwd: s.handle.cwd,
      });
      // summary.worktree carries the same info so clients can prompt for the
      // final merge after run_complete.
      expect(s.handle.summary.worktree).toEqual({
        worktreePath: expectedPath,
        branchName: expectedBranch,
        originalCwd: s.handle.cwd,
      });
    });

    it('constructs the WorktreeManager with repoRoot, sourceCwd=handle.cwd, workDir, mainWorktreePath, profilesDirs, and apiKeys', async () => {
      const s = setup('exec-wt-ctor');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/the/repo/root');
      mockGenerateTitleAndBranch.mockResolvedValue({ title: 'T', branchName: 'feature X' });
      mockSanitizeBranchSlug.mockReturnValue('feature-x');
      const apiKeys = { anthropic: 'sk-test' };

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsgWithKeys('exec-wt-ctor', s.handle.workDir, apiKeys),
      );

      expect(wtmInstances).toHaveLength(1);
      const wtm = wtmInstances[0];
      expect(wtm.repoRoot).toBe('/the/repo/root');
      expect(wtm.sourceCwd).toBe(s.handle.cwd);
      expect(wtm.workDir).toBe(s.handle.workDir);
      expect(wtm.mainBranch).toBe('engin/feature-x');
      expect(wtm.mainWorktreePath).toBe(join(s.handle.workDir, 'worktree'));
      expect(wtm.profilesDirs).toEqual(['/profiles/local', '/profiles/global']);
      expect(wtm.apiKeys).toEqual(apiKeys);
    });

    it('forms the main-wt branch as engin/<sanitized-slug>', async () => {
      const s = setup('exec-wt-branch');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/repo/root');
      mockGenerateTitleAndBranch.mockResolvedValue({ title: 'T', branchName: 'Some Weird Branch!' });
      mockSanitizeBranchSlug.mockReturnValue('some-weird-branch');

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-wt-branch', s.handle.workDir),
      );

      // The raw branchName is sanitized, then prefixed with engin/.
      expect(mockSanitizeBranchSlug).toHaveBeenCalledWith('Some Weird Branch!');
      expect(wtmInstances[0].mainBranch).toBe('engin/some-weird-branch');
    });

    it('calls generateTitleAndBranch with profilesDirs, taskPrompt, cwd, and apiKeys', async () => {
      const s = setup('exec-wt-gen');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/repo/root');
      const apiKeys = { anthropic: 'sk-abc' };

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsgWithKeys('exec-wt-gen', s.handle.workDir, apiKeys),
      );

      expect(mockGenerateTitleAndBranch).toHaveBeenCalledTimes(1);
      const callArg = mockGenerateTitleAndBranch.mock.calls[0][0] as GenTitleArgs;
      expect(callArg).toMatchObject({
        profilesDirs: ['/profiles/local', '/profiles/global'],
        taskPrompt: s.handle.taskPrompt,
        cwd: s.handle.cwd,
        apiKeys,
      });
    });

    it('still flips status to complete and broadcasts run_complete when git is available', async () => {
      const s = setup('exec-wt-complete');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/repo/root');
      const spy = spyOn(StatusBridge.prototype, 'broadcastTerminal');
      spies.push(spy);

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-wt-complete', s.handle.workDir),
      );

      expect(s.handle.status).toBe('complete');
      // The worktree is set up asynchronously AFTER run_started is sent, so the
      // terminal broadcast must CARRY it — this is the race-free source the
      // client reads to drive the post-run final-merge prompt.
      const payload = spy.mock.calls[0][0] as {
        type: string;
        runId: string;
        worktree?: { worktreePath: string; branchName: string; originalCwd?: string };
      };
      expect(payload.type).toBe('run_complete');
      expect(payload.runId).toBe('exec-wt-complete');
      expect(payload.worktree).toEqual({
        worktreePath: join(s.handle.workDir, 'worktree'),
        branchName: 'engin/test-branch',
        originalCwd: s.handle.cwd,
      });
    });
  });

  // ─── non-git fallback ────────────────────────────────────────────────────

  describe('non-git fallback', () => {
    it('warns and runs in-place (options.cwd = handle.cwd) when the cwd is not a git repo', async () => {
      const s = setup('exec-nogit');
      mockIsGitRepo.mockReturnValue(false);
      const warnSpy = spyOn(console, 'warn');
      spies.push(warnSpy);
      const probe: { cwd?: string } = {};

      await s.executor.execute(
        s.handle,
        makeCapturingWorkflow(probe),
        s.storeCallbacks,
        makeMsg('exec-nogit', s.handle.workDir),
      );

      // No worktree is created — the workflow runs against the original cwd.
      expect(probe.cwd).toBe(s.handle.cwd);
      expect(wtmInstances).toHaveLength(0);

      // The user is warned that no worktree will be used.
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).join(' ');
      expect(warnMsg).toContain('not a git repository');

      // The git / LLM plumbing was never invoked.
      expect(mockGetRepoRoot).not.toHaveBeenCalled();
      expect(mockGenerateTitleAndBranch).not.toHaveBeenCalled();
    });

    it('leaves worktreeManager / worktree unset on both the handle and the options', async () => {
      const s = setup('exec-nogit-opts');
      mockIsGitRepo.mockReturnValue(false);
      const probe: { worktreeManager?: unknown; worktree?: WorktreeInfo } = {};

      await s.executor.execute(
        s.handle,
        makeCapturingWorkflow(probe),
        s.storeCallbacks,
        makeMsg('exec-nogit-opts', s.handle.workDir),
      );

      expect(probe.worktreeManager).toBeUndefined();
      expect(probe.worktree).toBeUndefined();
      expect(s.handle.worktreeManager).toBeUndefined();
      expect(s.handle.worktree).toBeUndefined();
      expect(s.handle.summary.worktree).toBeUndefined();
    });
  });

  // ─── worktree on failure ─────────────────────────────────────────────────

  describe('worktree on failure', () => {
    it('PRESERVES the worktree — does NOT call cleanup — when the workflow throws', async () => {
      const s = setup('exec-wt-fail');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/repo/root');

      await s.executor.execute(
        s.handle,
        makeBoomWorkflow('kaboom: workflow exploded'),
        s.storeCallbacks,
        makeMsg('exec-wt-fail', s.handle.workDir),
      );

      expect(s.handle.status).toBe('failed');
      // The worktree was set up...
      expect(wtmInstances).toHaveLength(1);
      expect(wtmInstances[0].setupMainWorktreeCalls).toBe(1);
      // ...but cleanup is NEVER invoked on failure (the user may inspect / retry).
      expect(wtmInstances[0].cleanupCalls).toBe(0);
      // The manager remains wired onto the handle.
      expect(s.handle.worktreeManager as unknown).toBe(wtmInstances[0]);
    });

    it('broadcasts run_failed (not run_complete) when a git-available run fails', async () => {
      const s = setup('exec-wt-fail-bcast');
      mockIsGitRepo.mockReturnValue(true);
      mockGetRepoRoot.mockReturnValue('/repo/root');
      const spy = spyOn(StatusBridge.prototype, 'broadcastTerminal');
      spies.push(spy);

      await s.executor.execute(
        s.handle,
        makeBoomWorkflow('explode'),
        s.storeCallbacks,
        makeMsg('exec-wt-fail-bcast', s.handle.workDir),
      );

      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0] as {
        type: string;
        error: string;
        worktree?: { worktreePath: string; branchName: string; originalCwd?: string };
      };
      expect(payload.type).toBe('run_failed');
      expect(payload.error).toBe('explode');
      // The worktree is PRESERVED on failure by design; surfacing its path/branch
      // on the terminal broadcast lets the client (or `engin resume`) find it
      // for a manual merge / inspection.
      expect(payload.worktree).toEqual({
        worktreePath: join(s.handle.workDir, 'worktree'),
        branchName: 'engin/test-branch',
        originalCwd: s.handle.cwd,
      });
    });
  });
});
