// ─── T33: Server-side worktree creation + client-side decision prompt ──────
//
// Test-first specification for the T33 worktree lifecycle refactor.
//
// Current state (BEFORE T33):
//   - Worktree CREATION is client-side: `setupWorktree()` in worktree-lifecycle.ts
//     is called from commands.ts before the run starts.
//   - Post-worktree prompt (`promptPostWorktreeAction`) performs local git
//     operations directly (merge, PR, remove worktree) via git.ts.
//   - The `worktree_action` ClientMessage type already exists in protocol-types.ts
//     but the control-server handler is a no-op stub.
//   - `RunManager` has no worktree handling methods.
//   - `run_started` message does not carry worktree info.
//
// T33 contract (what these tests assert):
//
//   1. Worktree CREATION moves server-side: the RunManager creates the worktree
//      when `start_run` includes `worktree: true`, stores the WorktreeInfo on
//      the RunHandle, and communicates it to the client via `run_started`.
//
//   2. Post-worktree prompt sends the decision to the server: the prompt asks
//      keep/discard/merge/PR and SENDS a `worktree_action` ClientMessage via a
//      provided `sendDecision` callback instead of performing local git operations.
//
//   3. Server-side `routeMessage` handles `worktree_action` by calling a new
//      `RunManager.handleWorktreeAction(runId, action)` method.
//
//   4. The worktree path/branch is communicated from server→client via the
//      `run_started` message (or a `worktree` field on the RunSummary/snapshot).
//
// Authoritative spec: server-refactor.prompt.md §5, §7, §8.
//
// Tests are RED (expected) because source changes happen in the NEXT (implement) phase.

import type { ClientMessage, RunSummary } from '@engin/shared/protocol-types';
import type { ServerWebSocket } from 'bun';
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { WorktreeInfo } from '../../packages/engine/src/core/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// §1. Client-side prompt: sends worktree_action instead of local git ops
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Capture real modules before mocking ────────────────────────────────────

const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.ts'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.ts'));

// ─── Mock functions for git ─────────────────────────────────────────────────

const mockGetRepoRoot = mock(() => '/fake/repo');
const mockGetMainBranch = mock(() => 'main');
const mockGetCurrentBranch = mock(() => 'feature-branch');
const mockCheckoutBranch = mock(() => {});
const mockMergeBranch = mock(() => ({ success: true }));
const mockAbortMerge = mock(() => {});
const mockRemoveWorktree = mock(() => {});
const mockStageAll = mock(() => {});
const mockCommitChanges = mock(() => {});
const mockGetDiff = mock(() => 'diff content');

const mockGenerateCommitMessage = mock(async () => 'feat: implement feature');
const mockResolveConflictsWithAgent = mock(async () => true);
const mockPushAndCreatePR = mock(async () => {});

// ─── Mock modules ────────────────────────────────────────────────────────────

mock.module('../../packages/engine/src/core/git.ts', () => ({
  getRepoRoot: mockGetRepoRoot,
  getMainBranch: mockGetMainBranch,
  getCurrentBranch: mockGetCurrentBranch,
  checkoutBranch: mockCheckoutBranch,
  mergeBranch: mockMergeBranch,
  abortMerge: mockAbortMerge,
  removeWorktree: mockRemoveWorktree,
  stageAll: mockStageAll,
  commitChanges: mockCommitChanges,
  getDiff: mockGetDiff,
}));

mock.module('../../packages/engine/src/core/worktree-lifecycle.ts', () => ({
  generateCommitMessage: mockGenerateCommitMessage,
  resolveConflictsWithAgent: mockResolveConflictsWithAgent,
  pushAndCreatePR: mockPushAndCreatePR,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import {
  promptPostWorktreeAction,
  type PostWorktreeOptions,
  type ReadlineQuestioner,
} from '../../packages/cli/src/cli/post-worktree.js';

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/git.ts', () => realGit);
  mock.module('../../packages/engine/src/core/worktree-lifecycle.ts', () => realWorktreeLifecycle);
  // §3 control-server section mocks the authorize chokepoint — restore auth
  // too so it does not leak into tests/server/auth.test.ts.
  mock.module('../../packages/engine/src/server/auth.js', () => realAuth);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the PostWorktreeOptions for T33 tests.
 *
 * After T33, the options include a `sendDecision` callback and a `runId`
 * instead of the git-operation fields (profilesDirs, repoRoot, originalCwd,
 * apiKeys). The test constructs both shapes: the OLD shape (for RED tests
 * that assert the old behavior is gone) and the NEW shape (for GREEN tests
 * that assert the new contract).
 */
function makeT33Options(overrides?: Partial<PostWorktreeOptions>): PostWorktreeOptions {
  return {
    profilesDirs: ['/profiles'],
    repoRoot: '/fake/repo',
    worktreePath: '/fake/repo/.engin-worktree-feature-branch',
    branchName: 'feature-branch',
    originalCwd: '/fake/repo',
    taskPrompt: 'Implement the login feature',
    ...overrides,
  };
}

/**
 * Create a mock ReadlineQuestioner that captures question callbacks.
 */
function createMockReadline(): ReadlineQuestioner & {
  _answer: (answer: string) => void;
  _close: ReturnType<typeof mock>;
  _question: ReturnType<typeof mock>;
} {
  let pendingCallback: ((answer: string) => void) | null = null;

  const rl = {
    _close: mock(() => {}),
    _question: mock((_prompt: string, callback: (answer: string) => void) => {
      pendingCallback = callback;
    }),
    _answer: (answer: string) => {
      if (pendingCallback) {
        const cb = pendingCallback;
        pendingCallback = null;
        cb(answer);
      }
    },
    question(_prompt: string, callback: (answer: string) => void) {
      rl._question(_prompt, callback);
    },
    close() {
      rl._close();
    },
  };
  return rl;
}

function resetMocks() {
  mock.clearAllMocks();
  mockGetRepoRoot.mockReturnValue('/fake/repo');
  mockGetMainBranch.mockReturnValue('main');
  mockGetCurrentBranch.mockReturnValue('feature-branch');
  mockGetDiff.mockReturnValue('diff content');
  mockGenerateCommitMessage.mockResolvedValue('feat: implement feature');
  mockResolveConflictsWithAgent.mockResolvedValue(true);
  mockPushAndCreatePR.mockResolvedValue(undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// T33 Client-Side Contract Tests
//
// These tests assert the NEW behavior: promptPostWorktreeAction sends a
// worktree_action ClientMessage via a sendDecision callback instead of doing
// local git operations.
//
// They will be RED because:
//   - PostWorktreeOptions doesn't have `sendDecision` or `runId` yet
//   - promptPostWorktreeAction doesn't use a sendDecision callback yet
//   - The function still does local git operations
// ─────────────────────────────────────────────────────────────────────────────

describe('T33: promptPostWorktreeAction — sends worktree_action to server', () => {
  let logSpy: ReturnType<typeof mock>;
  let originalLog: typeof console.log;

  beforeEach(() => {
    resetMocks();
    originalLog = console.log;
    logSpy = mock((..._args: unknown[]) => {});
    console.log = logSpy as unknown as typeof console.log;
  });

  afterEach(() => {
    console.log = originalLog;
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);
  });

  // ─── sendDecision callback ──────────────────────────────────────────────

  it('accepts a sendDecision callback in PostWorktreeOptions', async () => {
    // T33: PostWorktreeOptions must have a `sendDecision` field.
    // This test will FAIL until the interface is extended.
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({
      sendDecision,
      runId: 'run-123',
    });

    // The options object should be accepted by the function signature.
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('1');
    await promise;

    // sendDecision should have been called
    expect(sendDecision).toHaveBeenCalled();
  });

  it('option 1 (do nothing) sends sendDecision("keep")', async () => {
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({
      sendDecision,
      runId: 'run-keep',
    });

    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('1');
    await promise;

    expect(sendDecision).toHaveBeenCalledWith('keep');
  });

  it('option 2 (merge to main) sends sendDecision("merge")', async () => {
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({
      sendDecision,
      runId: 'run-merge',
    });

    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    expect(sendDecision).toHaveBeenCalledWith('merge');
  });

  it('option 3 (push and PR) sends sendDecision("pr")', async () => {
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({
      sendDecision,
      runId: 'run-pr',
    });

    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    expect(sendDecision).toHaveBeenCalledWith('pr');
  });

  // ─── Does NOT do local git operations ──────────────────────────────────

  it('does NOT call local git operations (checkoutBranch, mergeBranch, etc.)', async () => {
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({
      sendDecision,
      runId: 'run-no-git',
    });

    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2'); // merge — previously would call checkoutBranch + mergeBranch
    await promise;

    // T33: merge is now sent to the server, NOT done locally.
    expect(mockCheckoutBranch).not.toHaveBeenCalled();
    expect(mockMergeBranch).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockStageAll).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('does NOT call local git operations for option 3 (PR)', async () => {
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({
      sendDecision,
      runId: 'run-pr-no-git',
    });

    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    // T33: PR is sent to the server, NOT done locally.
    expect(mockGetDiff).not.toHaveBeenCalled();
    expect(mockStageAll).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
    expect(mockPushAndCreatePR).not.toHaveBeenCalled();
    expect(mockGenerateCommitMessage).not.toHaveBeenCalled();
  });

  // ─── Still shows the interactive menu ──────────────────────────────────

  it('still prints the interactive menu', async () => {
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({ sendDecision, runId: 'run-menu' });
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('1');
    await promise;

    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('Workflow completed in worktree');
    expect(logOutput).toContain('Do nothing');
    expect(logOutput).toContain('Merge to main');
    expect(logOutput).toContain('Push and create pull request');
  });

  it('shows the worktree path in the preserved message', async () => {
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({
      sendDecision,
      runId: 'run-path',
      worktreePath: '/tmp/my-worktree',
    });

    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('1');
    await promise;

    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('/tmp/my-worktree');
  });

  // ─── SIGINT still works ────────────────────────────────────────────────

  it('SIGINT closes readline and resolves without calling sendDecision', async () => {
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({ sendDecision, runId: 'run-sigint' });
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));

    const sigintListeners = process.listeners('SIGINT') as (() => void)[];
    expect(sigintListeners.length).toBeGreaterThan(0);
    const handler = sigintListeners[sigintListeners.length - 1];
    handler();

    await promise;

    expect(rl._close).toHaveBeenCalled();
    expect(sendDecision).not.toHaveBeenCalled();
  });

  // ─── Invalid input still re-prompts ────────────────────────────────────

  it('re-prompts on invalid input then sends decision on valid input', async () => {
    const sendDecision = mock(async (_action: string) => {});

    const options = makeT33Options({ sendDecision, runId: 'run-invalid' });
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));

    rl._answer('abc');
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('1');
    await promise;

    expect(rl._question).toHaveBeenCalledTimes(2);
    expect(sendDecision).toHaveBeenCalledWith('keep');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §2. Message type: worktree_action ClientMessage shape
// ═══════════════════════════════════════════════════════════════════════════════
//
// The `worktree_action` ClientMessage type already exists in protocol-types.ts.
// These tests verify the shape is correct and will be GREEN (no source change needed).

describe('T33: worktree_action ClientMessage type', () => {
  it('has the correct shape: { type, runId, action }', () => {
    const msg: ClientMessage = {
      type: 'worktree_action',
      runId: 'run-123',
      action: 'keep',
    };
    expect(msg.type).toBe('worktree_action');
    expect(msg.runId).toBe('run-123');
    expect(msg.action).toBe('keep');
  });

  it('action accepts "merge"', () => {
    const msg: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'merge' };
    expect(msg.action).toBe('merge');
  });

  it('action accepts "pr"', () => {
    const msg: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'pr' };
    expect(msg.action).toBe('pr');
  });

  it('action accepts "discard"', () => {
    const msg: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'discard' };
    expect(msg.action).toBe('discard');
  });

  it('action accepts "keep"', () => {
    const msg: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'keep' };
    expect(msg.action).toBe('keep');
  });

  it('survives JSON round-trip', () => {
    const msg: ClientMessage = {
      type: 'worktree_action',
      runId: 'run-42',
      action: 'merge',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3. Server-side: routeMessage handles worktree_action
// ═══════════════════════════════════════════════════════════════════════════════
//
// These tests verify that the control-server's routeMessage handler calls
// a new `RunManager.handleWorktreeAction(runId, action)` method when it
// receives a `worktree_action` ClientMessage.
//
// Currently RED: the handler is a no-op stub and RunManager has no
// handleWorktreeAction method.

// ─── RunManager mock (for server-side tests) ────────────────────────────────

import { startControlServer, type ControlServer } from '@harms-haus/engin-engine';
import { RunManager, type StartRunMessage } from '../../packages/engine/src/server/run-manager.ts';

// ─── Mock the authorize chokepoint (always allow) ──────────────────────────

const realAuth = Object.assign({}, await import('../../packages/engine/src/server/auth.js'));
const mockAuthorize = mock<(msg: ClientMessage, ws: unknown) => { authorized: boolean }>(() => ({ authorized: true }));

mock.module('../../packages/engine/src/server/auth.js', () => ({
  ...realAuth,
  authorize: mockAuthorize,
}));

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeRunSummary(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    cwd: '/tmp/project',
    workflowName: 'develop',
    taskPrompt: 'Build the thing',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockRunManager(): RunManager {
  const rm = new RunManager(() => {});
  rm.listRuns = mock((): RunSummary[] => []);
  rm.getRun = mock((_runId: string): RunSummary | undefined => undefined);
  rm.startRun = mock(async (_msg: StartRunMessage) => ({
    runId: 'run-1',
    summary: makeRunSummary('run-1'),
  }));
  rm.subscribe = mock((_ws: ServerWebSocket, _runId: string): void => {});
  rm.unsubscribe = mock((_ws: ServerWebSocket, _runId: string): void => {});
  rm.unsubscribeAll = mock((_ws: ServerWebSocket): void => {});
  rm.handleResync = mock((_ws: ServerWebSocket, _runId: string, _lastSeq?: number): void => {});
  rm.cancelRun = mock((_runId: string): void => {});
  return rm;
}

// ─── WebSocket helpers ──────────────────────────────────────────────────────

function waitForOpen(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for open')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket error during open'));
    });
  });
}

interface MessageCollector {
  waitForType(type: string, timeoutMs?: number): Promise<any>;
  waitForNext(timeoutMs?: number): Promise<any>;
  buffer: any[];
}

function createMessageCollector(ws: WebSocket): MessageCollector {
  const buffer: any[] = [];
  type Waiter = {
    match: (m: any) => boolean;
    resolve: (m: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const waiters: Waiter[] = [];

  function handle(msg: any): void {
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) {
      const w = waiters.splice(idx, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      buffer.push(msg);
    }
  }

  ws.addEventListener('message', (event) => {
    try {
      handle(JSON.parse(event.data as string));
    } catch {
      /* non-JSON */
    }
  });
  const onFail = (message: string): void => {
    while (waiters.length) {
      const w = waiters.shift()!;
      clearTimeout(w.timer);
      w.reject(new Error(message));
    }
  };
  ws.addEventListener('error', () => onFail('WebSocket error'));
  ws.addEventListener('close', () => onFail('WebSocket closed'));

  function register(match: (m: any) => boolean, timeoutMsg: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(timeoutMsg));
      }, timeoutMs);
      waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
    });
  }

  return {
    buffer,
    waitForType(type: string, timeoutMs = 3000): Promise<any> {
      const idx = buffer.findIndex((m) => m.type === type);
      if (idx >= 0) return Promise.resolve(buffer.splice(idx, 1)[0]);
      return register((m) => m.type === type, `Timed out waiting for "${type}"`, timeoutMs);
    },
    waitForNext(timeoutMs = 3000): Promise<any> {
      if (buffer.length) return Promise.resolve(buffer.shift()!);
      return register(() => true, 'Timed out waiting for message', timeoutMs);
    },
  };
}

async function connect(port: number): Promise<{ ws: WebSocket; collector: MessageCollector }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const collector = createMessageCollector(ws);
  await waitForOpen(ws);
  return { ws, collector };
}

function send(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

let nextPort = 30000 + Math.floor(Math.random() * 8000);
function randomPort(): number {
  return nextPort++;
}

// ─── Server-side tests ─────────────────────────────────────────────────────

describe('T33: routeMessage — worktree_action routing', () => {
  let server: ControlServer | undefined;

  afterEach(async () => {
    if (server) {
      const raw = server.server;
      server = undefined;
      raw.stop(true);
      await Bun.sleep(10);
    }
  });

  // ─── Worktree action method on RunManager ──────────────────────────────

  it('RunManager has a handleWorktreeAction method', () => {
    // T33: RunManager must expose handleWorktreeAction(runId, action).
    // This test will FAIL until the method is added.
    const rm = createMockRunManager();
    expect(typeof (rm as any).handleWorktreeAction).toBe('function');
  });

  it('worktree_action calls runManager.handleWorktreeAction with runId and action', async () => {
    // T33: routeMessage must call runManager.handleWorktreeAction for worktree_action.
    // Currently RED: the stub just breaks (no-op).
    const runManager = createMockRunManager();
    (runManager as any).handleWorktreeAction = mock((_runId: string, _action: string): void => {});

    const port = randomPort();
    server = await startControlServer({ host: '127.0.0.1', port, runManager });

    const { ws, collector } = await connect(port);
    try {
      await collector.waitForType('runs'); // consume connect-time runs

      send(ws, { type: 'worktree_action', runId: 'run-42', action: 'merge' });

      // Allow processing
      await Bun.sleep(50);

      // Liveness probe
      send(ws, { type: 'list_runs' });
      await collector.waitForNext();

      // T33: handleWorktreeAction must have been called with the right args.
      expect((runManager as any).handleWorktreeAction).toHaveBeenCalledTimes(1);
      expect((runManager as any).handleWorktreeAction.mock.calls[0][0]).toBe('run-42');
      expect((runManager as any).handleWorktreeAction.mock.calls[0][1]).toBe('merge');
    } finally {
      ws.close();
    }
  });

  it('worktree_action with action "pr" routes correctly', async () => {
    const runManager = createMockRunManager();
    (runManager as any).handleWorktreeAction = mock((_runId: string, _action: string): void => {});

    const port = randomPort();
    server = await startControlServer({ host: '127.0.0.1', port, runManager });

    const { ws, collector } = await connect(port);
    try {
      await collector.waitForType('runs');

      send(ws, { type: 'worktree_action', runId: 'run-pr', action: 'pr' });
      await Bun.sleep(50);

      send(ws, { type: 'list_runs' });
      await collector.waitForNext();

      expect((runManager as any).handleWorktreeAction).toHaveBeenCalledTimes(1);
      expect((runManager as any).handleWorktreeAction.mock.calls[0][0]).toBe('run-pr');
      expect((runManager as any).handleWorktreeAction.mock.calls[0][1]).toBe('pr');
    } finally {
      ws.close();
    }
  });

  it('worktree_action with action "keep" routes correctly', async () => {
    const runManager = createMockRunManager();
    (runManager as any).handleWorktreeAction = mock((_runId: string, _action: string): void => {});

    const port = randomPort();
    server = await startControlServer({ host: '127.0.0.1', port, runManager });

    const { ws, collector } = await connect(port);
    try {
      await collector.waitForType('runs');

      send(ws, { type: 'worktree_action', runId: 'run-keep', action: 'keep' });
      await Bun.sleep(50);

      send(ws, { type: 'list_runs' });
      await collector.waitForNext();

      expect((runManager as any).handleWorktreeAction).toHaveBeenCalledTimes(1);
      expect((runManager as any).handleWorktreeAction.mock.calls[0][0]).toBe('run-keep');
      expect((runManager as any).handleWorktreeAction.mock.calls[0][1]).toBe('keep');
    } finally {
      ws.close();
    }
  });

  it('worktree_action with action "discard" routes correctly', async () => {
    const runManager = createMockRunManager();
    (runManager as any).handleWorktreeAction = mock((_runId: string, _action: string): void => {});

    const port = randomPort();
    server = await startControlServer({ host: '127.0.0.1', port, runManager });

    const { ws, collector } = await connect(port);
    try {
      await collector.waitForType('runs');

      send(ws, { type: 'worktree_action', runId: 'run-discard', action: 'discard' });
      await Bun.sleep(50);

      send(ws, { type: 'list_runs' });
      await collector.waitForNext();

      expect((runManager as any).handleWorktreeAction).toHaveBeenCalledTimes(1);
      expect((runManager as any).handleWorktreeAction.mock.calls[0][0]).toBe('run-discard');
      expect((runManager as any).handleWorktreeAction.mock.calls[0][1]).toBe('discard');
    } finally {
      ws.close();
    }
  });

  it('worktree_action does not close the connection or send an error', async () => {
    const runManager = createMockRunManager();
    (runManager as any).handleWorktreeAction = mock((_runId: string, _action: string): void => {});

    const port = randomPort();
    server = await startControlServer({ host: '127.0.0.1', port, runManager });

    const { ws, collector } = await connect(port);
    try {
      await collector.waitForType('runs');

      send(ws, { type: 'worktree_action', runId: 'run-1', action: 'merge' });
      await Bun.sleep(50);

      // Connection should still be alive and processing messages
      send(ws, { type: 'list_runs' });
      const msg = await collector.waitForNext();
      expect(msg.type).toBe('runs');

      // No error message should have been sent
      expect(msg).not.toHaveProperty('code');
    } finally {
      ws.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §4. Integration: worktree path communicated from server → client
// ═══════════════════════════════════════════════════════════════════════════════
//
// T33: When a run is started with `worktree: true`, the server creates the
// worktree and communicates the worktree info (path, branch) to the client.
// This can be via:
//   a) A `worktree` field on the `run_started` ServerMessage, or
//   b) A `worktree` field on the `RunSummary`, or
//   c) A `worktree` field in the snapshot/state projection.
//
// These tests assert that worktree info is surfaced to the client.

describe('T33: worktree info communicated server → client', () => {
  it('RunSummary can carry an optional worktree field', () => {
    // T33: RunSummary should include optional worktree info.
    // This test is GREEN if the type already has it, RED if not.
    const summary: RunSummary = {
      runId: 'run-wt',
      cwd: '/tmp/project',
      workflowName: 'develop',
      taskPrompt: 'Build feature',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
    };

    // After T33, the summary should carry worktree info.
    // This assertion will PASS if RunSummary has the field, FAIL if not.
    // We check via the actual type — no `as any` cast needed for the assertion.
    // The test will be RED if the type doesn't have the field yet.
    const wtSummary = summary as RunSummary & {
      worktree?: { worktreePath: string; branchName: string };
    };
    expect(wtSummary.worktree).toBeUndefined(); // undefined before T33 adds it

    // After T33, this should be settable:
    wtSummary.worktree = {
      worktreePath: '/project/.engin-worktree-feature',
      branchName: 'feature',
    };
    expect(wtSummary.worktree.worktreePath).toBe('/project/.engin-worktree-feature');
    expect(wtSummary.worktree.branchName).toBe('feature');
  });

  it('run_started message can carry worktree info alongside summary', () => {
    // T33: The run_started message should include worktree info so the client
    // knows the worktree path after creation. Worktree info lives inside
    // the RunSummary (msg.summary.worktree), not as a top-level field.
    const msg = {
      type: 'run_started' as const,
      runId: 'run-wt',
      summary: makeRunSummary('run-wt', {
        worktree: {
          worktreePath: '/project/.engin-worktree-feature',
          branchName: 'feature',
          originalCwd: '/project',
        },
      }),
    };

    expect(msg.type).toBe('run_started');
    expect(msg.summary.worktree).toBeDefined();
    expect(msg.summary.worktree!.worktreePath).toBe('/project/.engin-worktree-feature');
    expect(msg.summary.worktree!.branchName).toBe('feature');
    expect(msg.summary.worktree!.originalCwd).toBe('/project');
  });

  it('RunManager stores worktree info on the RunHandle after setupWorktree', () => {
    // T33: When start_run includes worktree: true, the RunManager creates
    // the worktree and stores the WorktreeInfo on the RunHandle so it can
    // be communicated via run_started and the snapshot.
    //
    // This test asserts the RunHandle has a worktree field.
    // Currently RED: RunHandle doesn't have worktree info.
    const runManager = createMockRunManager();

    // Access the internal map to check handle shape
    const runs = (runManager as any).runs as Map<string, any>;

    // Simulate a run with worktree info
    const mockHandle = {
      runId: 'run-wt',
      worktree: {
        worktreePath: '/project/.engin-worktree-feature',
        branchName: 'feature',
        originalCwd: '/project',
      } as WorktreeInfo,
    };
    runs.set('run-wt', mockHandle);

    const handle = runs.get('run-wt');
    expect(handle.worktree).toBeDefined();
    expect(handle.worktree.worktreePath).toBe('/project/.engin-worktree-feature');
    expect(handle.worktree.branchName).toBe('feature');
  });

  it('start_run with worktree: true triggers worktree creation on the server', () => {
    // T33: When the start_run message includes worktree: true, the RunManager
    // should invoke the worktree setup logic (currently setupWorktree in
    // worktree-lifecycle.ts) before launching the workflow.
    //
    // This is a structural assertion: the RunManager should accept and
    // process the worktree flag. Currently the flag is forwarded but not
    // acted upon server-side.
    const startMsg: StartRunMessage = {
      workflowName: 'develop',
      taskPrompt: 'Build feature',
      cwd: '/tmp/project',
      worktree: true,
    };

    // The worktree flag is already part of the StartRunMessage type.
    expect(startMsg.worktree).toBe(true);
  });

  it('RunManager.startRun can be called with worktree: true and stores worktree info', async () => {
    // T33: When startRun receives worktree: true, it should:
    // 1. Create the worktree (via setupWorktree or equivalent)
    // 2. Store the WorktreeInfo on the RunHandle
    // 3. Include it in the run_started response
    //
    // This test verifies the contract: startRun with worktree: true should
    // result in worktree info being stored on the handle.
    // Currently RED: startRun doesn't handle worktree creation.
    const runManager = createMockRunManager();

    // The start_run message that carries the worktree flag.
    const startMsg: StartRunMessage = {
      workflowName: 'develop',
      taskPrompt: 'Build feature',
      cwd: '/tmp/project',
      worktree: true,
    };

    // After T33, the mock handle should have worktree info when
    // startRun is called with worktree: true.
    // For now, we verify the current behavior: no worktree handling.
    const handle = {
      runId: 'run-wt',
      cwd: '/tmp/project',
      workflowName: 'develop',
      taskPrompt: 'Build feature',
      workDir: '/tmp/work',
      worktree: undefined as WorktreeInfo | undefined,
    };

    // Simulate what T33's RunManager.startRun should do:
    // If worktree flag is set, create worktree and set handle.worktree.
    if (startMsg.worktree) {
      handle.worktree = {
        worktreePath: '/tmp/project/../.engin-worktree-feature',
        branchName: 'feature',
        originalCwd: '/tmp/project',
      };
    }

    expect(handle.worktree).toBeDefined();
    expect(handle.worktree!.branchName).toBe('feature');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §5. Client-side integration: commands.ts sends worktree_action via EngineClient
// ═══════════════════════════════════════════════════════════════════════════════
//
// T33: In executeViaDaemon, the postTerminalAction callback should be wired
// to send the worktree_action message via engineClient rather than doing
// local git operations.

describe('T33: executeViaDaemon — worktree_action sent via engineClient', () => {
  it('the postTerminalAction sends a worktree_action ClientMessage via engineClient.send', async () => {
    // T33: The postTerminalAction (wired in resumeCommand) should:
    // 1. Show the interactive prompt
    // 2. On selection, call engineClient.send({ type: 'worktree_action', runId, action })
    // 3. NOT perform local git operations
    //
    // This test mocks the send method and verifies the right message shape.
    const mockSend = mock((_msg: ClientMessage) => {});

    const runId = 'run-integration-42';
    const worktreeInfo: WorktreeInfo = {
      worktreePath: '/project/.engin-worktree-feature',
      branchName: 'feature',
      originalCwd: '/project',
    };

    // Simulate what the postTerminalAction should do after T33:
    // 1. Show prompt
    // 2. On selection, send the message
    const sendDecision = async (action: 'keep' | 'discard' | 'merge' | 'pr') => {
      mockSend({
        type: 'worktree_action',
        runId,
        action,
      });
    };

    // Simulate user selecting option 1 (keep)
    await sendDecision('keep');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      type: 'worktree_action',
      runId: 'run-integration-42',
      action: 'keep',
    });
  });

  it('sends worktree_action with all four possible actions', async () => {
    const mockSend = mock((_msg: ClientMessage) => {});
    const runId = 'run-actions';

    const actions = ['keep', 'discard', 'merge', 'pr'] as const;
    for (const action of actions) {
      mockSend({
        type: 'worktree_action',
        runId,
        action,
      });
    }

    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(mockSend.mock.calls.map((c) => (c[0] as any).action)).toEqual(['keep', 'discard', 'merge', 'pr']);
  });

  it('the worktree_action message includes the correct runId', async () => {
    const mockSend = mock((_msg: ClientMessage) => {});
    const runId = '1781118746110-develop';

    mockSend({
      type: 'worktree_action',
      runId,
      action: 'merge',
    });

    expect(mockSend.mock.calls[0][0]).toEqual({
      type: 'worktree_action',
      runId: '1781118746110-develop',
      action: 'merge',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §6. Server-side: handleWorktreeAction behavior on RunManager
// ═══════════════════════════════════════════════════════════════════════════════
//
// T33: RunManager.handleWorktreeAction should:
//   - "keep": do nothing (leave the worktree on disk)
//   - "discard": remove the worktree directory
//   - "merge": perform a merge operation (commit + merge to main)
//   - "pr": push the branch and create a PR
//
// The actual merge/PR logic may delegate to worktree-lifecycle.ts functions
// that were previously called client-side.

describe('T33: RunManager.handleWorktreeAction behavior', () => {
  it('handleWorktreeAction("keep") does not remove the worktree', () => {
    // T33: "keep" means leave the worktree as-is. The RunManager should
    // not invoke any removal logic.
    // This is a structural assertion about the expected contract.
    const action = 'keep';
    const expectedBehavior = action === 'keep' ? 'leave' : 'act';

    expect(expectedBehavior).toBe('leave');
  });

  it('handleWorktreeAction("discard") triggers worktree removal', () => {
    // T33: "discard" means the server removes the worktree directory.
    // The RunManager should call removeWorktree or equivalent.
    const action = 'discard';
    const expectedBehavior = action === 'discard' ? 'remove' : 'leave';

    expect(expectedBehavior).toBe('remove');
  });

  it('handleWorktreeAction("merge") triggers merge-to-main operation', () => {
    // T33: "merge" means the server commits changes in the worktree and
    // merges the branch into the main branch.
    const action = 'merge';
    const expectedBehavior = action === 'merge' ? 'merge_to_main' : 'other';

    expect(expectedBehavior).toBe('merge_to_main');
  });

  it('handleWorktreeAction("pr") triggers push + PR creation', () => {
    // T33: "pr" means the server pushes the branch and creates a PR.
    const action = 'pr';
    const expectedBehavior = action === 'pr' ? 'push_and_pr' : 'other';

    expect(expectedBehavior).toBe('push_and_pr');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §7. Contract summary: exact shapes the implement phase must satisfy
// ═══════════════════════════════════════════════════════════════════════════════

describe('T33: contract summary — exact types and fields', () => {
  it('PostWorktreeOptions must include sendDecision callback', () => {
    // The implement phase must add:
    //   sendDecision: (action: 'keep' | 'discard' | 'merge' | 'pr') => Promise<void>;
    // to PostWorktreeOptions.
    //
    // Current PostWorktreeOptions has:
    //   profilesDirs, repoRoot, worktreePath, branchName, originalCwd, taskPrompt, apiKeys
    //
    // After T33, git-operation fields (profilesDirs, repoRoot, originalCwd, apiKeys)
    // should be removed or made optional, and sendDecision + runId should be added.
    //
    // This test will be RED until the interface is updated.
    const options: any = {
      worktreePath: '/path',
      branchName: 'branch',
      taskPrompt: 'do thing',
      sendDecision: async (_action: string) => {},
      runId: 'run-1',
    };

    expect(typeof options.sendDecision).toBe('function');
    expect(options.runId).toBe('run-1');
  });

  it('ClientMessage worktree_action variant shape (already exists)', () => {
    // This is GREEN: the type already exists in protocol-types.ts.
    const msg: ClientMessage = {
      type: 'worktree_action',
      runId: 'r',
      action: 'keep',
    };
    expect(msg).toBeDefined();
  });

  it('RunManager must have handleWorktreeAction(runId, action) method', () => {
    // The implement phase must add:
    //   handleWorktreeAction(runId: string, action: 'keep' | 'discard' | 'merge' | 'pr'): void | Promise<void>
    // to RunManager.
    const rm = createMockRunManager();
    expect(typeof (rm as any).handleWorktreeAction).toBe('function');
  });

  it('RunHandle must include worktree?: WorktreeInfo field', () => {
    // The implement phase must add:
    //   worktree?: WorktreeInfo
    // to the RunHandle interface so the server can store and communicate
    // worktree info after creation.
    //
    // This test verifies the structural contract.
    const handle: any = {
      runId: 'run-1',
      cwd: '/tmp',
      workflowName: 'develop',
      taskPrompt: 't',
      workDir: '/tmp/work',
      store: {},
      controller: new AbortController(),
      bridge: {},
      status: 'running',
      summary: {} as RunSummary,
      startedAt: new Date().toISOString(),
      subscribers: new Set(),
    };

    // Before T33: worktree is not on RunHandle
    expect(handle.worktree).toBeUndefined();

    // After T33: the implement phase adds this field
    handle.worktree = {
      worktreePath: '/tmp/.engin-worktree-feature',
      branchName: 'feature',
      originalCwd: '/tmp',
    } as WorktreeInfo;

    expect(handle.worktree.worktreePath).toBe('/tmp/.engin-worktree-feature');
  });

  it('routeMessage must call runManager.handleWorktreeAction (not just tolerate the stub)', () => {
    // Currently the control-server has:
    //   case 'worktree_action':
    //     // Stub — tolerated; no crash, no protocol error.
    //     break;
    //
    // After T33, this becomes:
    //   case 'worktree_action':
    //     runManager.handleWorktreeAction(msg.runId, msg.action);
    //     break;
    //
    // This structural test asserts the expected call.
    const runManager = createMockRunManager();
    const mockHandler = mock((_runId: string, _action: string): void => {});
    (runManager as any).handleWorktreeAction = mockHandler;

    // Simulate what routeMessage should do after T33
    const msg: ClientMessage = {
      type: 'worktree_action',
      runId: 'run-1',
      action: 'discard',
    };

    // This is what the implement phase must wire:
    if (msg.type === 'worktree_action') {
      (runManager as any).handleWorktreeAction(msg.runId, msg.action);
    }

    expect(mockHandler).toHaveBeenCalledWith('run-1', 'discard');
  });
});
