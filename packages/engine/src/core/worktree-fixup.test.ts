// ─── Tests for core/worktree-fixup.ts — async verifyWorktree ───────────────
//
// RED-team specification tests for the conversion of `verifyWorktree` from
// blocking `Bun.spawnSync` calls to non-blocking async `Bun.spawn` calls with
// awaited `.exited` and piped stdout/stderr drained via
// `new Response(proc.stdout).text()` / `new Response(proc.stderr).text()`.
//
// `verifyWorktree` is a PRIVATE (non-exported) function, so it is exercised
// through the exported `runTooledFixup` primitive. To make that primitive
// deterministic and network-free:
//   - `./agent-lifecycle.js` (`spawnAgent`) is mocked to return a handle whose
//     `session.prompt` is a no-op async mock and whose `dispose` is a no-op.
//   - `./profile.js` (`loadProfilesFromDirs`) is mocked to return a single
//     'implementer' profile.
//   - `Bun.spawn` and `Bun.spawnSync` are replaced with tracked mocks (saved
//     and restored around each test) so we can BOTH control the tsc/eslint
//     outcomes AND assert which API the implementation uses.
//
// The KEY discriminator tests (the ones that FAIL on the current blocking
// implementation and thus drive the green-team conversion):
//   • `verifyWorktree` MUST call `Bun.spawn` (async) and MUST NOT call
//     `Bun.spawnSync`.
//   • Each spawn MUST be invoked with `stdout: 'pipe'` and `stderr: 'pipe'`
//     (the streams are drained via `new Response(...).text()`).
//   • The caller inside `runTooledFixup` MUST `await` the now-async result —
//     otherwise a passing verification (undefined) is misread as a truthy
//     Promise and every attempt reports failure.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile } from './types.js';

// ─── Capture real modules BEFORE mocking ───────────────────────────────────

const realAgentLifecycle = Object.assign({}, await import('./agent-lifecycle.js'));
const realProfile = Object.assign({}, await import('./profile.js'));

// ─── Mock: agent lifecycle (spawnAgent) ────────────────────────────────────

const mockSessionPrompt = mock(async (_text: string): Promise<void> => {});
const mockDispose = mock((): void => {});

interface FakeHandle {
  session: { prompt: typeof mockSessionPrompt };
  dispose: typeof mockDispose;
  sessionId: string;
  sessionPath: string;
  complete: () => void;
}

const mockSpawnAgent = mock(
  async (): Promise<FakeHandle> => ({
    session: { prompt: mockSessionPrompt },
    dispose: mockDispose,
    sessionId: 'fixup-session',
    sessionPath: '/tmp/fixup-session',
    complete: () => {},
  }),
);

mock.module('./agent-lifecycle.js', () => ({
  ...realAgentLifecycle,
  spawnAgent: mockSpawnAgent,
}));

// ─── Mock: profile loader ──────────────────────────────────────────────────

const implementerProfile: AgentProfile = {
  id: 'implementer',
  name: 'Implementer',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium',
  systemPrompt: 'You implement.',
  excludeTools: [],
  includeTools: [],
};

const mockLoadProfiles = mock(async (): Promise<Map<string, AgentProfile>> => {
  return new Map([['implementer', implementerProfile]]);
});

mock.module('./profile.js', () => ({
  ...realProfile,
  loadProfilesFromDirs: mockLoadProfiles,
}));

// ─── Mock: Bun.spawn / Bun.spawnSync ────────────────────────────────────────
//
// Saved at module load; replaced in beforeEach and restored in afterEach so
// the real APIs are active BETWEEN tests (and after the file finishes). This
// avoids leaking a stubbed Bun.spawn into test-runner internals.

const realBunSpawn = Bun.spawn;
const realBunSpawnSync = Bun.spawnSync;

/** Per-test outcome config for each tool. Defaults = exit 0, empty stdio (pass). */
interface SpawnOutcome {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

let tscOutcome: SpawnOutcome;
let eslintOutcome: SpawnOutcome;

/** Build a ReadableStream<Uint8Array> that emits `str` then closes. This is
 *  exactly what the converted code drains via `new Response(stream).text()`. */
function streamFromString(str: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(str));
      controller.close();
    },
  });
}

/** A fake async `Bun.spawn` proc: `.exited` is a Promise<number> and
 *  `.stdout` / `.stderr` are ReadableStreams. There is NO synchronous
 *  `.exitCode` property — the exit code is ONLY reachable via `await
 *  proc.exited`, matching the target contract. */
function makeSpawnProc(o: SpawnOutcome): {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
} {
  return {
    exited: Promise.resolve(o.exitCode ?? 0),
    stdout: streamFromString(o.stdout ?? ''),
    stderr: streamFromString(o.stderr ?? ''),
  };
}

/** A fake `Bun.spawnSync` result, for the (current) blocking implementation
 *  and as a sentinel: if the code STILL uses spawnSync it will hit this mock,
 *  which is asserted against via `spawnSyncMock`. */
function makeSpawnSyncResult(o: SpawnOutcome): { exitCode: number; stdout: Buffer; stderr: Buffer } {
  return {
    exitCode: o.exitCode ?? 0,
    stdout: Buffer.from(o.stdout ?? ''),
    stderr: Buffer.from(o.stderr ?? ''),
  };
}

/** Extract the joined cmd string from Bun.spawn / Bun.spawnSync arguments.
 *  Handles both the object form `{ cmd: [...] }` (used by the async path) and
 *  the array form `[...]` (used by the legacy spawnSync path). */
function cmdFromArgs(args: unknown[]): string {
  const first = args[0];
  if (Array.isArray(first)) return (first as string[]).join(' ');
  if (first && typeof first === 'object' && Array.isArray((first as { cmd?: unknown }).cmd)) {
    return (first as { cmd: string[] }).cmd.join(' ');
  }
  return '';
}

const spawnMock = mock((...args: unknown[]): unknown => {
  const joined = cmdFromArgs(args);
  if (joined.includes('tsc')) return makeSpawnProc(tscOutcome);
  if (joined.includes('eslint')) return makeSpawnProc(eslintOutcome);
  return makeSpawnProc({});
});

const spawnSyncMock = mock((...args: unknown[]): unknown => {
  const joined = cmdFromArgs(args);
  if (joined.includes('tsc')) return makeSpawnSyncResult(tscOutcome);
  if (joined.includes('eslint')) return makeSpawnSyncResult(eslintOutcome);
  return makeSpawnSyncResult({});
});

// ─── Import SUT AFTER mocks ────────────────────────────────────────────────

import { runTooledFixup } from './worktree-fixup.js';

// ─── Restore real modules ──────────────────────────────────────────────────

afterAll(() => {
  Bun.spawn = realBunSpawn;
  Bun.spawnSync = realBunSpawnSync;
  mock.module('./agent-lifecycle.js', () => realAgentLifecycle);
  mock.module('./profile.js', () => realProfile);
});

// ─── Per-test setup / teardown ─────────────────────────────────────────────

beforeEach(() => {
  // Reset call history but KEEP implementations (mockClear) for the spawn
  // mocks; reset + rewire the agent/profile mocks.
  mockSessionPrompt.mockClear();
  mockDispose.mockClear();
  mockSpawnAgent.mockClear();
  mockLoadProfiles.mockClear();
  spawnMock.mockClear();
  spawnSyncMock.mockClear();

  // Re-install the global stubs ONLY for the duration of each test.
  // The casts are necessary because Bun.spawn's real type is far stricter
  // than our test stub.

  (Bun as any).spawn = spawnMock;

  (Bun as any).spawnSync = spawnSyncMock;

  // Default outcomes: both tools pass cleanly.
  tscOutcome = {};
  eslintOutcome = {};
});

afterEach(() => {
  // Restore the real globals between tests so test-runner internals are
  // never affected by our stubs.
  Bun.spawn = realBunSpawn;
  Bun.spawnSync = realBunSpawnSync;
});

/** Standard options for runTooledFixup; maxAttempts is overridable per-test. */
function makeOpts(maxAttempts = 3) {
  return {
    profilesDirs: ['/profiles'],
    worktreePath: '/worktree',
    taskPrompt: 'Do the thing',
    errorContext: 'something broke',
    apiKeys: { openai: 'k' },
    maxAttempts,
  };
}

/** Count spawn calls whose cmd mentions `needle` (e.g. 'tsc' / 'eslint'). */
function countSpawnCallsFor(needle: string): number {
  return spawnMock.mock.calls.filter((call) => cmdFromArgs(call as unknown[]).includes(needle)).length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Discriminator: verifyWorktree MUST use async Bun.spawn (not spawnSync).
// These FAIL on the current blocking implementation.
// ═══════════════════════════════════════════════════════════════════════════════

describe('verifyWorktree — async spawn conversion (RED discriminators)', () => {
  it('uses async Bun.spawn to run verification commands', async () => {
    // Both tools pass, so the fixup succeeds on the first attempt.
    await runTooledFixup(makeOpts());

    // The conversion target: Bun.spawn MUST be called.
    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT use the blocking Bun.spawnSync API', async () => {
    await runTooledFixup(makeOpts());

    // The blocking API MUST be gone entirely from this code path.
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('pipes stdout and stderr on every spawn (for draining via new Response)', async () => {
    await runTooledFixup(makeOpts());

    // The converted code must request piped streams so it can drain them
    // with `new Response(proc.stdout).text()` / `new Response(proc.stderr).text()`.
    expect(spawnMock).toHaveBeenCalledWith(expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' }));
  });

  it('passes the worktree cwd to each spawn', async () => {
    await runTooledFixup(makeOpts());

    expect(spawnMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/worktree' }));
  });

  it('spawns `bunx tsc --noEmit`', async () => {
    await runTooledFixup(makeOpts());

    const tscCalls = spawnMock.mock.calls.filter((c) => cmdFromArgs(c as unknown[]).includes('tsc'));
    expect(tscCalls.length).toBeGreaterThanOrEqual(1);
    const cmd = cmdFromArgs(tscCalls[0] as unknown[]);
    expect(cmd).toContain('bunx');
    expect(cmd).toContain('tsc');
    expect(cmd).toContain('--noEmit');
  });

  it('spawns `bunx eslint --no-error-on-unmatched-pattern .` when tsc passes', async () => {
    await runTooledFixup(makeOpts());

    const eslintCalls = spawnMock.mock.calls.filter((c) => cmdFromArgs(c as unknown[]).includes('eslint'));
    expect(eslintCalls.length).toBe(1);
    const cmd = cmdFromArgs(eslintCalls[0] as unknown[]);
    expect(cmd).toContain('bunx');
    expect(cmd).toContain('eslint');
    expect(cmd).toContain('--no-error-on-unmatched-pattern');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Await contract: the caller inside runTooledFixup MUST await verifyWorktree.
// If it forgets to await, a passing verification (undefined) is misread as a
// truthy Promise and EVERY attempt reports failure.
// ═══════════════════════════════════════════════════════════════════════════════

describe('verifyWorktree — caller awaits the async result', () => {
  it('reports success when both tsc and eslint pass (does not misread a Promise as failure)', async () => {
    // Both tools pass → verifyWorktree resolves to undefined.
    const result = await runTooledFixup(makeOpts());

    // Success on the FIRST attempt. If the caller forgot to `await`, the
    // truthy Promise would be treated as a verification error and the loop
    // would exhaust all attempts, returning success:false.
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.lastError).toBeUndefined();
  });

  it('the agent is prompted exactly once on a clean verification', async () => {
    await runTooledFixup(makeOpts());

    // One agent turn, one verification pass → exactly one prompt.
    expect(mockSessionPrompt).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Behavior preservation: stderr of the FIRST failing command is surfaced
// (trimmed), and eslint is short-circuited when tsc fails.
// ═══════════════════════════════════════════════════════════════════════════════

describe('verifyWorktree — behavior preservation (async)', () => {
  it('surfaces the trimmed tsc stderr and never runs eslint when tsc fails', async () => {
    tscOutcome = { exitCode: 1, stderr: '  TS9999: type error here  \n' };

    const result = await runTooledFixup(makeOpts(2));

    // Failed after exhausting attempts.
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    // The stderr is trimmed and surfaced as the last verification error.
    expect(result.lastError).toBe('TS9999: type error here');

    // tsc was run once per attempt (2 attempts)...
    expect(countSpawnCallsFor('tsc')).toBe(2);
    // ...and eslint was NEVER spawned because tsc short-circuits.
    expect(countSpawnCallsFor('eslint')).toBe(0);
  });

  it('surfaces the eslint stderr when tsc passes but eslint fails', async () => {
    eslintOutcome = { exitCode: 1, stderr: '  no-unused-vars on line 42  ' };

    const result = await runTooledFixup(makeOpts(2));

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.lastError).toBe('no-unused-vars on line 42');

    // Both tools run on each attempt (tsc passes, eslint fails).
    expect(countSpawnCallsFor('tsc')).toBe(2);
    expect(countSpawnCallsFor('eslint')).toBe(2);
  });

  it('reads the exit code from the awaited proc.exited (non-zero → failure)', async () => {
    // exitCode is ONLY exposed via `.exited` (the fake proc has no sync
    // `.exitCode`). A correct async implementation must await `.exited`.
    tscOutcome = { exitCode: 2, stderr: 'tsc exited 2' };

    const result = await runTooledFixup(makeOpts(1));

    expect(result.success).toBe(false);
    expect(result.lastError).toBe('tsc exited 2');
  });

  it('returns undefined (success) when both tools exit 0 with empty stderr', async () => {
    tscOutcome = { exitCode: 0, stdout: '', stderr: '' };
    eslintOutcome = { exitCode: 0, stdout: '', stderr: '' };

    const result = await runTooledFixup(makeOpts(3));

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
  });
});
