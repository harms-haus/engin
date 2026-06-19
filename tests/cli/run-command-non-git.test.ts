// ─── runCommand: non-git fallback confirmation prompt ──────────────────────
//
// With the `--worktree` flag gone, worktrees are automatic for git repos. When
// the cwd is NOT a git repository, runCommand must prompt the user before
// proceeding (the run will execute in-place, with no worktree). The prompt is a
// yes/No question defaulting to No:
//
//   "Warning: '<cwd>' is not a git repository. Continue without git and
//    worktrees?"
//
//   • cwd IS a git repo      → no prompt; proceed immediately.
//   • cwd NOT a git repo + y → proceed (server runs in-place).
//   • cwd NOT a git repo + n → abort: print "Aborted..." and exit non-zero.
//   • cwd NOT a git repo + ⏎ → default No → abort.
//
// STATUS: RED until the implement phase adds the isGitRepo probe + promptYesNo
// helper to runCommand.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { PassThrough } from 'node:stream';

// ─── Capture real modules before mocking ────────────────────────────────────

const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realUtils = Object.assign({}, await import('../../packages/engine/src/core/utils.js'));
const realRunSessionClient = Object.assign({}, await import('../../packages/cli/src/cli/run-session-client.js'));
const realPostWorktree = Object.assign({}, await import('../../packages/cli/src/cli/post-worktree.js'));

// ─── Mock functions ─────────────────────────────────────────────────────────

const mockIsGitRepo = mock<(dir: string) => boolean>(() => true);
const mockPromptFinalMerge = mock<(opts: Record<string, unknown>) => Promise<void>>(async () => {});

// Capturing RunSessionClient stand-in: records construction so a test can tell
// whether runCommand PROCEEDED past the prompt (vs. aborted before it).
let capturedSessionOpts: unknown = null;

class CapturingRunSessionClient {
  constructor(opts: unknown) {
    capturedSessionOpts = opts;
  }
  async run(): Promise<void> {
    // no-op
  }
}

// ─── Mock modules ───────────────────────────────────────────────────────────

mock.module('../../packages/engine/src/core/git.js', () => ({
  ...realGit,
  isGitRepo: mockIsGitRepo,
}));

mock.module('../../packages/engine/src/core/utils.js', () => ({
  ...realUtils,
  validateWorkflowName: () => {},
}));

mock.module('../../packages/cli/src/cli/run-session-client.js', () => ({
  ...realRunSessionClient,
  RunSessionClient: CapturingRunSessionClient,
}));

mock.module('../../packages/cli/src/cli/post-worktree.js', () => ({
  ...realPostWorktree,
  promptFinalMerge: mockPromptFinalMerge,
}));

// ─── Import SUT after mocks ─────────────────────────────────────────────────

import { runCommand } from '../../packages/cli/src/cli.js';

afterAll(() => {
  mock.module('../../packages/engine/src/core/git.js', () => realGit);
  mock.module('../../packages/engine/src/core/utils.js', () => realUtils);
  mock.module('../../packages/cli/src/cli/run-session-client.js', () => realRunSessionClient);
  mock.module('../../packages/cli/src/cli/post-worktree.js', () => realPostWorktree);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Sentinel thrown by the process.exit spy so the run aborts without dying. */
class ExitSentinel extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
    this.name = 'ExitSentinel';
  }
}

function makeOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'run' as const,
    workflowName: 'develop',
    taskPrompt: 'Build the thing',
    cwd: '/tmp/project',
    maxConcurrent: 3,
    verbose: false,
    apiKeys: {},
    warnings: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// runCommand — non-git fallback prompt
// ═══════════════════════════════════════════════════════════════════════════════

describe('runCommand — non-git fallback prompt', () => {
  let originalStdin: typeof process.stdin;
  let mockStdin: PassThrough;
  let stdoutWriteSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Replace stdin with a PassThrough so promptYesNo's readline can be fed
    // answers programmatically.
    originalStdin = process.stdin;
    mockStdin = new PassThrough();
    (mockStdin as { isTTY?: boolean }).isTTY = false;
    Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true, writable: true });

    stdoutWriteSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    // process.exit must NOT kill the test runner — throw a sentinel instead.
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSentinel(code);
    }) as never);

    mockIsGitRepo.mockImplementation(() => true);
    capturedSessionOpts = null;
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true, writable: true });
    stdoutWriteSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
    mockStdin.destroy();
  });

  /** Wait until runCommand has printed the non-git warning prompt to stdout. */
  async function waitForPrompt(timeoutMs = 500): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const out = stdoutWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      if (/not a git repository/i.test(out)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('non-git prompt was not shown on stdout');
  }

  // ─── isGitRepo probe ─────────────────────────────────────────────────────

  it('probes isGitRepo with options.cwd', async () => {
    mockIsGitRepo.mockImplementation(() => true);
    await runCommand(makeOptions({ cwd: '/tmp/some-repo' }) as never);
    expect(mockIsGitRepo).toHaveBeenCalledWith('/tmp/some-repo');
  });

  // ─── cwd IS a git repo → no prompt ───────────────────────────────────────

  it('proceeds without prompting when cwd IS a git repository', async () => {
    mockIsGitRepo.mockImplementation(() => true);
    await runCommand(makeOptions() as never);

    const out = stdoutWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(out).not.toMatch(/not a git repository/i);
    // Proceeded all the way to constructing the session client.
    expect(capturedSessionOpts).not.toBeNull();
    // Never aborted.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ─── cwd NOT a git repo + "y" → proceed ──────────────────────────────────

  it('prompts and proceeds when cwd is not a git repo and the user answers "y"', async () => {
    mockIsGitRepo.mockImplementation(() => false);

    const cmd = runCommand(makeOptions() as never);
    await waitForPrompt();
    mockStdin.write('y\n');
    await cmd;

    const out = stdoutWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(out).toMatch(/not a git repository/i);
    expect(out).toMatch(/continue without git/i);
    // Proceeded to construct the session client.
    expect(capturedSessionOpts).not.toBeNull();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts "yes" (case-insensitive) as confirmation', async () => {
    mockIsGitRepo.mockImplementation(() => false);

    const cmd = runCommand(makeOptions() as never);
    await waitForPrompt();
    mockStdin.write('YES\n');
    await cmd;

    expect(capturedSessionOpts).not.toBeNull();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ─── cwd NOT a git repo + "n" → abort ────────────────────────────────────

  it('aborts when cwd is not a git repo and the user answers "n"', async () => {
    mockIsGitRepo.mockImplementation(() => false);

    const cmd = runCommand(makeOptions() as never);
    await waitForPrompt();
    mockStdin.write('n\n');
    await expect(cmd).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);

    const logText = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logText).toMatch(/aborted/i);
    expect(logText).toMatch(/git init/i);
    // Did NOT proceed to construct the session client.
    expect(capturedSessionOpts).toBeNull();
  });

  it('aborts on empty input (default No)', async () => {
    mockIsGitRepo.mockImplementation(() => false);

    const cmd = runCommand(makeOptions() as never);
    await waitForPrompt();
    mockStdin.write('\n');
    await expect(cmd).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(capturedSessionOpts).toBeNull();
  });

  it('aborts on "no" / "n" (case-insensitive)', async () => {
    for (const answer of ['no', 'N', 'NO']) {
      mockIsGitRepo.mockClear();
      capturedSessionOpts = null;
      exitSpy.mockClear();
      logSpy.mockClear();
      stdoutWriteSpy.mockClear();
      mockIsGitRepo.mockImplementation(() => false);

      const cmd = runCommand(makeOptions() as never);
      await waitForPrompt();
      mockStdin.write(answer + '\n');
      await expect(cmd).rejects.toThrow(ExitSentinel);
      expect(exitSpy).toHaveBeenCalledWith(1);
    }
  });
});
