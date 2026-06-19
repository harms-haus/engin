// ─── Tests for runTooledFixup (core/worktree-fixup.ts) ──────────────────────
//
// `runTooledFixup` is a shared, self-verifying, tooled agent fix-up primitive
// reused for BOTH the hardened conflict resolver and the commit/lint-failure
// safety net.
//
// Contract under test (per the worktree-fixup.ts spec):
//
//   export interface FixupOptions {
//     profilesDirs: string[];
//     worktreePath: string;
//     taskPrompt: string;
//     errorContext: string;
//     additionalContext?: string;
//     apiKeys?: Record<string, string>;
//     profileId?: string;       // default 'implementer'
//     maxAttempts?: number;     // default 3
//   }
//
//   export interface FixupResult {
//     success: boolean;
//     attempts: number;
//     lastError?: string;
//   }
//
//   export async function runTooledFixup(opts: FixupOptions): Promise<FixupResult>
//
// Behaviour:
//   - Loads profiles via loadProfilesFromDirs(opts.profilesDirs).
//   - Spawns a tool-using agent via spawnAgent with cwd=worktreePath,
//     isReadOnly=false, allowedWriteDirs=[worktreePath], agentId='worktree-fixup',
//     phaseId='worktree-fixup', taskId='fixup', stepIndex=0, stepName='fixup',
//     profileId = opts.profileId ?? 'implementer', and apiKeys forwarded.
//   - Retry loop (up to opts.maxAttempts ?? 3):
//       a. First attempt sends a prompt describing the error/task context.
//       b. Subsequent attempts append the previous verification error.
//       c. Calls session.prompt(text) — free-form, NOT promptForStructured.
//       d. Self-verifies: `bunx tsc --noEmit` then `bunx eslint` (only if tsc
//          passed). Captures stderr on non-zero exit as the verification error.
//       e. Both pass → return { success: true, attempts: attempt + 1 }.
//       f. Either fails → record error, continue.
//   - After all attempts exhausted → { success: false, attempts, lastError }.
//   - Always disposes the session in a `finally` block.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile } from '../../packages/engine/src/core/types.js';
import { makeProfile } from '../helpers/make-profile.js';

// ─── Capture real modules before mocking ──────────────────────────────────
// Without the restore, these relative-path mock.module() registrations leak
// into sibling test files under CI's parallel scheduling (mirrors the pattern
// in tests/core/worktree-lifecycle.test.ts and agent-lifecycle.test.ts).
const realAgentLifecycle = Object.assign({}, await import('../../packages/engine/src/core/agent-lifecycle.js'));
const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.js'));
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.js'));

// Capture the real Bun.spawnSync so we can restore it after each test. The
// verification step calls `Bun.spawnSync(['bunx', 'tsc', ...], { cwd })` and
// `Bun.spawnSync(['bunx', 'eslint', ...], { cwd })` directly against the global
// `Bun`, so we replace the property (it is writable but non-configurable).
const realBunSpawnSync = Bun.spawnSync;

// ─── Mock session / handle helpers ──────────────────────────────────────────

interface MockSession {
  prompt: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
  getLastAssistantText: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
  sessionId: string;
}

function makeMockSession(overrides?: Partial<MockSession>): MockSession {
  return {
    prompt: mock(async () => {}),
    dispose: mock(() => {}),
    getLastAssistantText: mock(() => ''),
    subscribe: mock(() => () => {}),
    sessionId: 'fixup-session-id',
    ...overrides,
  };
}

interface MockHandle {
  session: MockSession;
  dispose: ReturnType<typeof mock>;
  sessionId: string;
  sessionPath: string;
  complete: ReturnType<typeof mock>;
}

// ─── Mock state (module-level so mock fns can read/write) ───────────────────

/** Factory for the session returned by mockSpawnAgent. Tests override this to
 *  inject a session whose prompt rejects, or to assert on prompt calls. */
let sessionFactory: () => MockSession;
let disposeFactory: () => ReturnType<typeof mock>;

/** The most recently created handle, exposed so tests can assert on dispose. */
let lastHandle: MockHandle | undefined;

/** Profiles returned by mockLoadProfilesFromDirs. */
let profilesToReturn: Map<string, AgentProfile>;

/** Records the options passed to each spawnAgent call. */
const spawnAgentCalls: Array<{ opts: Record<string, unknown>; profiles: Map<string, AgentProfile> }> = [];

/** Records the directories passed to each loadProfilesFromDirs call. */
const loadProfilesCalls: string[][] = [];

// ─── Mock spawnAgent (mirrors real profile-not-found behaviour) ─────────────

const mockSpawnAgent = mock(
  async (opts: Record<string, unknown>, profiles: Map<string, AgentProfile>): Promise<MockHandle> => {
    spawnAgentCalls.push({ opts, profiles });
    const profileId = opts.profileId as string;
    if (!profiles.has(profileId)) {
      throw new Error(`Profile "${profileId}" not found`);
    }
    const session = sessionFactory();
    const dispose = disposeFactory();
    const handle: MockHandle = {
      session,
      dispose,
      sessionId: session.sessionId,
      sessionPath: '/base/worktree-fixup/session.jsonl',
      complete: mock(() => {}),
    };
    lastHandle = handle;
    return handle;
  },
);

// ─── Mock loadProfilesFromDirs ──────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock(async (dirs: string[]): Promise<Map<string, AgentProfile>> => {
  loadProfilesCalls.push(dirs);
  return profilesToReturn;
});

// ─── Mock promptForStructured (must NOT be called by runTooledFixup) ─────────

const mockPromptForStructured = mock(async (_session: unknown, _prompt: string, _schema: unknown) => ({
  result: {},
  attempts: 1,
}));

// ─── Mock module registration ───────────────────────────────────────────────

mock.module('../../packages/engine/src/core/agent-lifecycle.js', () => ({
  spawnAgent: mockSpawnAgent,
}));

mock.module('../../packages/engine/src/core/profile.js', () => ({
  loadProfilesFromDirs: mockLoadProfilesFromDirs,
  // Preserve the other named exports so any transitive imports still resolve.
  loadProfiles: mock(async () => new Map()),
  loadProfile: mock(async () => makeProfile()),
  parseProfile: mock(() => makeProfile()),
  clearProfileCache: mock(() => {}),
}));

mock.module('../../packages/engine/src/core/structured-output.js', () => ({
  promptForStructured: mockPromptForStructured,
}));

// ─── Import the module under test (after mocks are registered) ──────────────

import { runTooledFixup, type FixupOptions, type FixupResult } from '../../packages/engine/src/core/worktree-fixup.js';

// ─── Bun.spawnSync verification mock ────────────────────────────────────────
//
// The verification step runs `bunx tsc --noEmit` and (only if tsc passes)
// `bunx eslint --no-error-on-unmatched-pattern .` in the worktree. We feed
// results from per-tool queues so each test can script a sequence of
// pass/fail outcomes across attempts.

interface FakeSpawnResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  success: boolean;
}

function spawnResult(exitCode: number | null, stderr = '', stdout = ''): FakeSpawnResult {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    success: exitCode === 0,
  };
}

interface ToolCall {
  cmd: string[];
  cwd?: string;
}

/** Queues of results consumed left-to-right on each tsc / eslint invocation. */
let tscQueue: FakeSpawnResult[];
let eslintQueue: FakeSpawnResult[];

/** Every spawnSync invocation, in order, for assertions. */
const spawnSyncCalls: ToolCall[] = [];

function normalizeCmd(first: unknown, options: unknown): { cmd: string[]; cwd?: string } {
  // Bun.spawnSync supports both `spawnSync(cmdArr, opts)` and
  // `spawnSync({ cmd, cwd, ... })`. Handle either form.
  if (Array.isArray(first)) {
    const opts = (options ?? {}) as { cwd?: string };
    return { cmd: first as string[], cwd: opts.cwd };
  }
  const obj = (first ?? {}) as { cmd?: string[]; cwd?: string };
  return { cmd: obj.cmd ?? [], cwd: obj.cwd };
}

const mockSpawnSync = mock((first: unknown, options?: unknown) => {
  const { cmd, cwd } = normalizeCmd(first, options);
  spawnSyncCalls.push({ cmd, cwd });
  if (cmd.includes('tsc')) {
    return tscQueue.shift() ?? spawnResult(0);
  }
  if (cmd.includes('eslint')) {
    return eslintQueue.shift() ?? spawnResult(0);
  }
  return spawnResult(0);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const IMPLEMENTER_PROFILE = makeProfile({ id: 'implementer', name: 'Implementer' });
const CUSTOM_PROFILE = makeProfile({ id: 'custom-fixer', name: 'Custom Fixer' });

function baseOpts(overrides?: Partial<FixupOptions>): FixupOptions {
  return {
    profilesDirs: ['/profiles/local', '/profiles/global'],
    worktreePath: '/worktrees/feature-x',
    taskPrompt: 'Implement the login page',
    errorContext: 'error TS2304: Cannot find name "foo"',
    ...overrides,
  };
}

/** The options that spawnAgent must be called with per the spec. */
function expectedSpawnOpts(opts: FixupOptions): Record<string, unknown> {
  return {
    profileId: opts.profileId ?? 'implementer',
    agentId: 'worktree-fixup',
    cwd: opts.worktreePath,
    isReadOnly: false,
    allowedWriteDirs: [opts.worktreePath],
    phaseId: 'worktree-fixup',
    taskId: 'fixup',
    stepIndex: 0,
    stepName: 'fixup',
    apiKeys: opts.apiKeys,
  };
}

function resetMockState() {
  mock.clearAllMocks();
  spawnAgentCalls.length = 0;
  loadProfilesCalls.length = 0;
  spawnSyncCalls.length = 0;
  lastHandle = undefined;
  sessionFactory = () => makeMockSession();
  disposeFactory = () => mock(() => {});
  profilesToReturn = new Map<string, AgentProfile>([['implementer', IMPLEMENTER_PROFILE]]);
  tscQueue = [spawnResult(0)];
  eslintQueue = [spawnResult(0)];
}

// ─── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  resetMockState();
  // Install the spawnSync mock.
  Bun.spawnSync = mockSpawnSync as unknown as typeof Bun.spawnSync;
});

afterEach(() => {
  // Restore the real Bun.spawnSync so the mock never leaks to other suites.
  Bun.spawnSync = realBunSpawnSync;
});

afterAll(() => {
  // Restore the real modules so relative-path mocks don't leak.
  mock.module('../../packages/engine/src/core/agent-lifecycle.js', () => realAgentLifecycle);
  mock.module('../../packages/engine/src/core/profile.js', () => realProfile);
  mock.module('../../packages/engine/src/core/structured-output.js', () => realStructuredOutput);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runTooledFixup', () => {
  // ─── Happy path ─────────────────────────────────────────────────────

  describe('happy path', () => {
    it('returns success when the agent fixes issues and verification passes', async () => {
      const result = await runTooledFixup(baseOpts());

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.lastError).toBeUndefined();
    });

    it('runs exactly one attempt when verification passes immediately', async () => {
      const result = await runTooledFixup(baseOpts());

      expect(result.attempts).toBe(1);
      // One tsc + one eslint invocation.
      const tscCalls = spawnSyncCalls.filter((c) => c.cmd.includes('tsc'));
      const eslintCalls = spawnSyncCalls.filter((c) => c.cmd.includes('eslint'));
      expect(tscCalls).toHaveLength(1);
      expect(eslintCalls).toHaveLength(1);
    });

    it('calls session.prompt exactly once on a passing first attempt', async () => {
      await runTooledFixup(baseOpts());

      expect(lastHandle?.session.prompt).toHaveBeenCalledTimes(1);
    });

    it('uses session.prompt and never promptForStructured', async () => {
      await runTooledFixup(baseOpts());

      expect(lastHandle?.session.prompt).toHaveBeenCalled();
      expect(mockPromptForStructured).not.toHaveBeenCalled();
    });
  });

  // ─── Retry / verification behaviour ──────────────────────────────────

  describe('retry on verification failure', () => {
    it('retries up to maxAttempts when tsc keeps failing then succeeds', async () => {
      // Attempts 1 & 2: tsc fails. Attempt 3: tsc + eslint pass.
      tscQueue = [spawnResult(2, 'tsc error 1'), spawnResult(2, 'tsc error 2'), spawnResult(0)];
      eslintQueue = [spawnResult(0)];

      const result = await runTooledFixup(baseOpts({ maxAttempts: 3 }));

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
      expect(lastHandle?.session.prompt).toHaveBeenCalledTimes(3);
    });

    it('appends the previous verification error to subsequent retry prompts', async () => {
      tscQueue = [spawnResult(2, 'TS1234: first failure'), spawnResult(0)];

      await runTooledFixup(baseOpts({ maxAttempts: 3 }));

      const prompts = (lastHandle!.session.prompt.mock.calls as unknown[][]).map((c) => c[0] as string);
      expect(prompts).toHaveLength(2);
      // The retry prompt must surface the previous verification error.
      expect(prompts[1]).toContain('TS1234: first failure');
    });

    it('keeps the task and error context in every retry prompt', async () => {
      tscQueue = [spawnResult(2, 'boom'), spawnResult(0)];

      await runTooledFixup(baseOpts({ taskPrompt: 'Build the dashboard', errorContext: 'TypeError: x' }));

      const prompts = (lastHandle!.session.prompt.mock.calls as unknown[][]).map((c) => c[0] as string);
      for (const p of prompts) {
        expect(p).toContain('Build the dashboard');
        expect(p).toContain('TypeError: x');
      }
    });

    it('does not run eslint when tsc fails (short-circuits on tsc)', async () => {
      tscQueue = [spawnResult(2, 'tsc fail'), spawnResult(0)];

      await runTooledFixup(baseOpts({ maxAttempts: 3 }));

      // Two tsc runs (attempt 1 failed, attempt 2 passed)…
      const tscCalls = spawnSyncCalls.filter((c) => c.cmd.includes('tsc'));
      expect(tscCalls).toHaveLength(2);
      // …but eslint must only run on the attempt where tsc passed (once).
      const eslintCalls = spawnSyncCalls.filter((c) => c.cmd.includes('eslint'));
      expect(eslintCalls).toHaveLength(1);
    });

    it('treats an eslint failure as a verification error and retries', async () => {
      // tsc always passes; eslint fails once then passes.
      tscQueue = [spawnResult(0), spawnResult(0)];
      eslintQueue = [spawnResult(1, 'eslint: no-unused-vars'), spawnResult(0)];

      const result = await runTooledFixup(baseOpts({ maxAttempts: 3 }));

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      // The retry prompt must surface the eslint error.
      const prompts = (lastHandle!.session.prompt.mock.calls as unknown[][]).map((c) => c[0] as string);
      expect(prompts[1]).toContain('eslint: no-unused-vars');
    });

    it('retries the default 3 times when maxAttempts is omitted and verification always fails', async () => {
      tscQueue = [spawnResult(2, 'err1'), spawnResult(2, 'err2'), spawnResult(2, 'err3')];

      const result = await runTooledFixup(baseOpts());

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(lastHandle?.session.prompt).toHaveBeenCalledTimes(3);
    });
  });

  // ─── Exhaustion / failure ────────────────────────────────────────────

  describe('failure after exhausting attempts', () => {
    it('returns failure after exhausting attempts', async () => {
      tscQueue = [spawnResult(1, 'persistent tsc error'), spawnResult(1, 'persistent tsc error')];

      const result = await runTooledFixup(baseOpts({ maxAttempts: 2 }));

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
    });

    it('surfaces the last verification error as lastError', async () => {
      tscQueue = [spawnResult(1, 'first error'), spawnResult(1, 'second error'), spawnResult(1, 'third error')];

      const result = await runTooledFixup(baseOpts({ maxAttempts: 3 }));

      expect(result.lastError).toBe('third error');
      expect(result.lastError).not.toContain('first');
    });

    it('respects a custom maxAttempts', async () => {
      tscQueue = [spawnResult(1, 'a'), spawnResult(1, 'b')];

      const result = await runTooledFixup(baseOpts({ maxAttempts: 2 }));

      expect(result.attempts).toBe(2);
      expect(lastHandle?.session.prompt).toHaveBeenCalledTimes(2);
    });

    it('runs exactly one attempt when maxAttempts is 1', async () => {
      tscQueue = [spawnResult(1, 'only try')];

      const result = await runTooledFixup(baseOpts({ maxAttempts: 1 }));

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
      expect(lastHandle?.session.prompt).toHaveBeenCalledTimes(1);
    });

    it('returns a FixupResult-typed object', async () => {
      const result: FixupResult = await runTooledFixup(baseOpts());

      expect(typeof result.success).toBe('boolean');
      expect(typeof result.attempts).toBe('number');
    });
  });

  // ─── spawnAgent wiring ───────────────────────────────────────────────

  describe('spawnAgent wiring', () => {
    it('passes the correct profileId, cwd, and allowedWriteDirs to spawnAgent', async () => {
      const opts = baseOpts({ worktreePath: '/wt/abc', profileId: 'custom-fixer' });
      profilesToReturn = new Map([['custom-fixer', CUSTOM_PROFILE]]);

      await runTooledFixup(opts);

      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      const passedOpts = spawnAgentCalls[0]!.opts;
      expect(passedOpts.profileId).toBe('custom-fixer');
      expect(passedOpts.cwd).toBe('/wt/abc');
      expect(passedOpts.allowedWriteDirs).toEqual(['/wt/abc']);
    });

    it('defaults profileId to "implementer" when not provided', async () => {
      await runTooledFixup(baseOpts());

      expect(spawnAgentCalls[0]!.opts.profileId).toBe('implementer');
    });

    it('spawns with isReadOnly: false so write/edit/bash tools remain', async () => {
      await runTooledFixup(baseOpts());

      expect(spawnAgentCalls[0]!.opts.isReadOnly).toBe(false);
    });

    it('passes the fixed agent lifecycle identifiers', async () => {
      await runTooledFixup(baseOpts());

      const o = spawnAgentCalls[0]!.opts;
      expect(o.agentId).toBe('worktree-fixup');
      expect(o.phaseId).toBe('worktree-fixup');
      expect(o.taskId).toBe('fixup');
      expect(o.stepIndex).toBe(0);
      expect(o.stepName).toBe('fixup');
    });

    it('passes allowedWriteDirs as a single-element array of the worktree path', async () => {
      await runTooledFixup(baseOpts({ worktreePath: '/wt/solo' }));

      expect(spawnAgentCalls[0]!.opts.allowedWriteDirs).toEqual(['/wt/solo']);
    });

    it('forwards apiKeys to spawnAgent', async () => {
      const apiKeys = { openai: 'sk-abc', anthropic: 'sk-xyz' };
      await runTooledFixup(baseOpts({ apiKeys }));

      expect(spawnAgentCalls[0]!.opts.apiKeys).toEqual(apiKeys);
    });

    it('passes undefined apiKeys when not supplied', async () => {
      await runTooledFixup(baseOpts());

      expect(spawnAgentCalls[0]!.opts.apiKeys).toBeUndefined();
    });

    it('matches all expected spawn options at once', async () => {
      const opts = baseOpts({ worktreePath: '/wt/x', apiKeys: { openai: 'k' } });
      await runTooledFixup(opts);

      expect(spawnAgentCalls[0]!.opts).toEqual(expectedSpawnOpts(opts));
    });
  });

  // ─── Profile loading ─────────────────────────────────────────────────

  describe('profile loading', () => {
    it('loads profiles via loadProfilesFromDirs with the provided directories', async () => {
      await runTooledFixup(baseOpts({ profilesDirs: ['/a', '/b'] }));

      expect(mockLoadProfilesFromDirs).toHaveBeenCalledTimes(1);
      expect(loadProfilesCalls[0]).toEqual(['/a', '/b']);
    });

    it('passes the loaded profile map to spawnAgent', async () => {
      const map = new Map<string, AgentProfile>([['implementer', IMPLEMENTER_PROFILE]]);
      profilesToReturn = map;

      await runTooledFixup(baseOpts());

      expect(spawnAgentCalls[0]!.profiles).toBe(map);
    });
  });

  // ─── Verification command shape ──────────────────────────────────────

  describe('verification commands', () => {
    it('runs `bunx tsc --noEmit` with cwd set to the worktree path', async () => {
      await runTooledFixup(baseOpts({ worktreePath: '/wt/verify' }));

      const tscCall = spawnSyncCalls.find((c) => c.cmd.includes('tsc'));
      expect(tscCall).toBeDefined();
      expect(tscCall!.cmd).toEqual(['bunx', 'tsc', '--noEmit']);
      expect(tscCall!.cwd).toBe('/wt/verify');
    });

    it('runs eslint with --no-error-on-unmatched-pattern and "." target when tsc passes', async () => {
      await runTooledFixup(baseOpts({ worktreePath: '/wt/lint' }));

      const eslintCall = spawnSyncCalls.find((c) => c.cmd.includes('eslint'));
      expect(eslintCall).toBeDefined();
      expect(eslintCall!.cmd).toEqual(['bunx', 'eslint', '--no-error-on-unmatched-pattern', '.']);
      expect(eslintCall!.cwd).toBe('/wt/lint');
    });

    it('does not run bun test as part of verification', async () => {
      await runTooledFixup(baseOpts());

      const testCalls = spawnSyncCalls.filter((c) => c.cmd.includes('test') || c.cmd.includes('bun') === false);
      // No invocation should reference a test runner. (bunx appears for tsc/eslint.)
      const testRunnerCalls = spawnSyncCalls.filter((c) => c.cmd.includes('test') && !c.cmd.includes('eslint'));
      expect(testRunnerCalls).toHaveLength(0);
      // Sanity: the `testCalls` filter above should still only contain tsc/eslint.
      expect(testCalls.length).toBeGreaterThan(0);
    });
  });

  // ─── Prompt content ──────────────────────────────────────────────────

  describe('prompt content', () => {
    it('includes the task prompt and error context in the first prompt', async () => {
      await runTooledFixup(
        baseOpts({ taskPrompt: 'Refactor the auth module', errorContext: 'SyntaxError: unexpected token' }),
      );

      const firstPrompt = lastHandle!.session.prompt.mock.calls[0]![0] as unknown as string;
      expect(firstPrompt).toContain('Refactor the auth module');
      expect(firstPrompt).toContain('SyntaxError: unexpected token');
    });

    it('includes the additional context when provided', async () => {
      await runTooledFixup(baseOpts({ additionalContext: 'Other side prompt: implement logout' }));

      const firstPrompt = lastHandle!.session.prompt.mock.calls[0]![0] as unknown as string;
      expect(firstPrompt).toContain('Other side prompt: implement logout');
    });

    it('instructs the agent to use its tools and verify the fix', async () => {
      await runTooledFixup(baseOpts());

      const firstPrompt = lastHandle!.session.prompt.mock.calls[0]![0] as unknown as string;
      // The prompt must direct the agent to act with tools and self-verify.
      expect(firstPrompt.toLowerCase()).toMatch(/tool|edit|run/);
      expect(firstPrompt.toLowerCase()).toMatch(/verif|compile|lint/);
    });
  });

  // ─── Session disposal ───────────────────────────────────────────────

  describe('session disposal', () => {
    it('disposes the session on success', async () => {
      await runTooledFixup(baseOpts());

      expect(lastHandle?.dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes the session after exhausting all attempts (failure)', async () => {
      tscQueue = [spawnResult(1, 'e1'), spawnResult(1, 'e2')];

      await runTooledFixup(baseOpts({ maxAttempts: 2 }));

      expect(lastHandle?.dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes the session exactly once even across multiple retries', async () => {
      tscQueue = [spawnResult(1, 'a'), spawnResult(1, 'b'), spawnResult(0)];

      await runTooledFixup(baseOpts({ maxAttempts: 3 }));

      expect(lastHandle?.dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes the session when session.prompt throws (finally block)', async () => {
      sessionFactory = () =>
        makeMockSession({
          prompt: mock(async () => {
            throw new Error('agent crashed');
          }),
        });

      await expect(runTooledFixup(baseOpts())).rejects.toThrow('agent crashed');

      // The finally block must still have disposed the session.
      expect(lastHandle?.dispose).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Error propagation ──────────────────────────────────────────────

  describe('error propagation', () => {
    it('propagates a spawnAgent failure (e.g. profile not found)', async () => {
      profilesToReturn = new Map(); // no profiles

      await expect(runTooledFixup(baseOpts({ profileId: 'missing' }))).rejects.toThrow(/Profile "missing" not found/);

      // No session was ever created, so nothing to dispose.
      expect(lastHandle).toBeUndefined();
    });
  });
});
