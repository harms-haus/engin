import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as sessionSelector from '../../packages/cli/src/cli/session-selector.js';
import type { RunSummary } from '../../packages/shared/src/protocol-types.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Shared helpers ────────────────────────────────────────────────────────

/**
 * Create a past run directory under <cwd>/.engin/work/<dirName>.
 * Optionally writes a .engin-state.json file.
 */
function createPastRun(cwd: string, dirName: string, hasStateFile = false) {
  const runDir = join(cwd, '.engin', 'work', dirName);
  mkdirSync(runDir, { recursive: true });
  if (hasStateFile) {
    writeFileSync(join(runDir, '.engin-state.json'), JSON.stringify({ taskPrompt: 'test prompt' }));
  }
}

/**
 * Create a mock RunSummary for testing the active-run section of the picker.
 * Each call produces a unique runId based on the current timestamp.
 */
function createMockRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}-test-wf`,
    cwd: '/tmp/test',
    workflowName: 'test-workflow',
    taskPrompt: 'test task',
    status: 'running',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Module exports ────────────────────────────────────────────────────────

describe('session-selector module exports', () => {
  it('exports all four expected functions', async () => {
    const mod = await import('../../packages/cli/src/cli/session-selector.js');
    expect(typeof mod.formatRelativeTime).toBe('function');
    expect(typeof mod.readLineFromStdin).toBe('function');
    expect(typeof mod.interactiveSelectRun).toBe('function');
    expect(typeof mod.resolveSessionName).toBe('function');
  });
});

// ─── formatRelativeTime ────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  it('returns seconds ago for recent timestamps', () => {
    const now = Date.now();
    const result = sessionSelector.formatRelativeTime(now - 30_000); // 30 seconds ago
    expect(result).toBe('30s ago');
  });

  it('returns "0s ago" for current timestamp', () => {
    const now = Date.now();
    const result = sessionSelector.formatRelativeTime(now);
    expect(result).toBe('0s ago');
  });

  it('returns minutes ago for timestamps within an hour', () => {
    const now = Date.now();
    const result = sessionSelector.formatRelativeTime(now - 5 * 60 * 1000); // 5 minutes ago
    expect(result).toBe('5m ago');
  });

  it('returns hours ago for timestamps within a day', () => {
    const now = Date.now();
    const result = sessionSelector.formatRelativeTime(now - 3 * 60 * 60 * 1000); // 3 hours ago
    expect(result).toBe('3h ago');
  });

  it('returns days ago for timestamps older than a day', () => {
    const now = Date.now();
    const result = sessionSelector.formatRelativeTime(now - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    expect(result).toBe('2d ago');
  });

  it('returns 59s ago for just under a minute', () => {
    const now = Date.now();
    const result = sessionSelector.formatRelativeTime(now - 59_000);
    expect(result).toBe('59s ago');
  });

  it('returns 59m ago for just under an hour', () => {
    const now = Date.now();
    const result = sessionSelector.formatRelativeTime(now - 59 * 60 * 1000);
    expect(result).toBe('59m ago');
  });

  it('returns 23h ago for just under a day', () => {
    const now = Date.now();
    const result = sessionSelector.formatRelativeTime(now - 23 * 60 * 60 * 1000);
    expect(result).toBe('23h ago');
  });

  it('returns 1s ago', () => {
    const now = Date.now();
    expect(sessionSelector.formatRelativeTime(now - 1_000)).toBe('1s ago');
  });

  it('returns 1m ago', () => {
    const now = Date.now();
    expect(sessionSelector.formatRelativeTime(now - 60_000)).toBe('1m ago');
  });

  it('returns 1h ago', () => {
    const now = Date.now();
    expect(sessionSelector.formatRelativeTime(now - 60 * 60 * 1000)).toBe('1h ago');
  });

  it('returns 1d ago', () => {
    const now = Date.now();
    expect(sessionSelector.formatRelativeTime(now - 24 * 60 * 60 * 1000)).toBe('1d ago');
  });
});

// ─── resolveSessionName ────────────────────────────────────────────────────

describe('resolveSessionName', () => {
  const { getDir } = useTempDir();

  it('resolves by exact dirName', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    const result = await sessionSelector.resolveSessionName(`${ts}-develop`, dir);
    expect(result.dirName).toBe(`${ts}-develop`);
    expect(result.workflowName).toBe('develop');
    expect(result.hasStateFile).toBe(true);
    expect(result.fullPath).toBe(join(dir, '.engin', 'work', `${ts}-develop`));
  });

  it('resolves by prefix match when unique', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    // Use just the timestamp portion as prefix
    const result = await sessionSelector.resolveSessionName(String(ts), dir);
    expect(result.dirName).toBe(`${ts}-develop`);
  });

  it('throws on ambiguous prefix match', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts}-review`, true);

    await expect(sessionSelector.resolveSessionName(String(ts), dir)).rejects.toThrow(/Ambiguous session name/);
  });

  it('includes matched names in ambiguous error message', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts}-review`, true);

    try {
      await sessionSelector.resolveSessionName(String(ts), dir);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain(`${ts}-develop`);
      expect(message).toContain(`${ts}-review`);
    }
  });

  it('throws when no run matches', async () => {
    const dir = getDir();
    createPastRun(dir, `${Date.now()}-develop`, true);

    await expect(sessionSelector.resolveSessionName('nonexistent', dir)).rejects.toThrow(/No past run found/);
  });

  it('error message suggests using resume without arguments', async () => {
    const dir = getDir();
    await expect(sessionSelector.resolveSessionName('nothing', dir)).rejects.toThrow(/engin resume.*without arguments/);
  });

  it('resolves exact match even when prefix would match multiple', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts}-review`, false);

    // Exact match should work despite prefix ambiguity
    const result = await sessionSelector.resolveSessionName(`${ts}-develop`, dir);
    expect(result.dirName).toBe(`${ts}-develop`);
    expect(result.workflowName).toBe('develop');
  });

  it('returns entry with correct timestamp', async () => {
    const dir = getDir();
    const ts = 1700000000000; // fixed timestamp
    createPastRun(dir, `${ts}-develop`, true);

    const result = await sessionSelector.resolveSessionName(`${ts}-develop`, dir);
    expect(result.timestamp).toBe(ts);
  });

  it('returns entry with hasStateFile false when no state file exists', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, false);

    const result = await sessionSelector.resolveSessionName(`${ts}-develop`, dir);
    expect(result.hasStateFile).toBe(false);
  });

  it('resolves by partial workflow name prefix', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-my-workflow`, true);

    const result = await sessionSelector.resolveSessionName(`${ts}-my`, dir);
    expect(result.dirName).toBe(`${ts}-my-workflow`);
  });

  it('throws when work directory does not exist', async () => {
    const dir = getDir();
    // No .engin/work directory created
    await expect(sessionSelector.resolveSessionName('anything', dir)).rejects.toThrow(/No past run found/);
  });
});

// ─── readLineFromStdin ─────────────────────────────────────────────────────

describe('readLineFromStdin', () => {
  let originalStdin: typeof process.stdin;
  let mockStdin: PassThrough;

  beforeEach(() => {
    originalStdin = process.stdin;
    mockStdin = new PassThrough();
    // Provide isTTY as undefined (non-TTY) to avoid setRawMode call
    (mockStdin as any).isTTY = false;
    Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true, writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true, writable: true });
  });

  it('returns trimmed line when newline is received', async () => {
    const promise = sessionSelector.readLineFromStdin();
    mockStdin.write('hello world\n');
    const result = await promise;
    expect(result).toBe('hello world');
  });

  it('trims whitespace from input', async () => {
    const promise = sessionSelector.readLineFromStdin();
    mockStdin.write('  hello  \n');
    const result = await promise;
    expect(result).toBe('hello');
  });

  it('returns undefined for whitespace-only input', async () => {
    const promise = sessionSelector.readLineFromStdin();
    mockStdin.write('   \n');
    const result = await promise;
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty input', async () => {
    const promise = sessionSelector.readLineFromStdin();
    mockStdin.write('\n');
    const result = await promise;
    expect(result).toBeUndefined();
  });

  it('handles \\r\\n line endings', async () => {
    const promise = sessionSelector.readLineFromStdin();
    mockStdin.write('test\r\n');
    const result = await promise;
    expect(result).toBe('test');
  });

  it('returns undefined on EOF with no data', async () => {
    const promise = sessionSelector.readLineFromStdin();
    mockStdin.end();
    const result = await promise;
    expect(result).toBeUndefined();
  });

  it('returns remaining data on EOF without trailing newline', async () => {
    const promise = sessionSelector.readLineFromStdin();
    mockStdin.end('partial input');
    const result = await promise;
    expect(result).toBe('partial input');
  });

  it('handles chunked input across multiple writes', async () => {
    const promise = sessionSelector.readLineFromStdin();
    mockStdin.write('hel');
    mockStdin.write('lo ');
    mockStdin.write('world\n');
    const result = await promise;
    expect(result).toBe('hello world');
  });

  it('is a function', () => {
    expect(typeof sessionSelector.readLineFromStdin).toBe('function');
  });
});

// ─── interactiveSelectRun (existing — updated for PickerSelection) ──────────

describe('interactiveSelectRun', () => {
  const { getDir } = useTempDir();

  let logSpy: ReturnType<typeof spyOn>;
  let writeSpy: ReturnType<typeof spyOn>;
  let readLineSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    readLineSpy = spyOn(sessionSelector, 'readLineFromStdin');
  });

  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
    readLineSpy.mockRestore();
  });

  it('returns undefined when no past runs exist', async () => {
    const dir = getDir();
    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('No past workflow runs found.');
  });

  // ── Updated: return type is now PickerSelection ────────────────────────

  it('returns historical selection when user enters valid number', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts - 1000}-review`, false);

    readLineSpy.mockResolvedValueOnce('1');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
    // TDD RED: New return type is PickerSelection with discriminated union.
    // Current impl returns PastRunEntry directly (no `type` field) → assertion fails.
    expect(result).toHaveProperty('type', 'historical');
    expect((result as any).pastRun).toEqual(
      expect.objectContaining({
        dirName: `${ts}-develop`,
        workflowName: 'develop',
        hasStateFile: true,
      }),
    );
  });

  it('returns historical selection for second run when user enters 2', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts - 1000}-review`, false);

    readLineSpy.mockResolvedValueOnce('2');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
    // TDD RED: Same return type update needed.
    expect(result).toHaveProperty('type', 'historical');
    expect((result as any).pastRun).toEqual(
      expect.objectContaining({
        dirName: `${ts - 1000}-review`,
        workflowName: 'review',
        hasStateFile: false,
      }),
    );
  });

  it('returns undefined when user presses Enter to cancel', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    readLineSpy.mockResolvedValueOnce(undefined);

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('Cancelled.');
  });

  it('returns undefined when user enters empty string', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    // Empty string is treated as cancel (readLineFromStdin returns undefined for empty)
    readLineSpy.mockResolvedValueOnce(undefined);

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeUndefined();
  });

  it('retries on invalid input then accepts valid input', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    // First call returns invalid, second returns valid
    readLineSpy.mockResolvedValueOnce('abc');
    readLineSpy.mockResolvedValueOnce('1');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
    // TDD RED: Updated return type assertion.
    expect(result).toHaveProperty('type', 'historical');
    expect((result as any).pastRun).toEqual(
      expect.objectContaining({
        dirName: `${ts}-develop`,
      }),
    );
    expect(readLineSpy).toHaveBeenCalledTimes(2);

    // Check that invalid selection message was logged
    const invalidCall = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('Invalid selection'));
    expect(invalidCall).toBeDefined();
  });

  it('retries on out-of-range number', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    readLineSpy.mockResolvedValueOnce('99');
    readLineSpy.mockResolvedValueOnce('1');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
    expect(readLineSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on zero input', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    readLineSpy.mockResolvedValueOnce('0');
    readLineSpy.mockResolvedValueOnce('1');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
    expect(readLineSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on negative number', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    readLineSpy.mockResolvedValueOnce('-1');
    readLineSpy.mockResolvedValueOnce('1');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
  });

  it('retries on float input', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    readLineSpy.mockResolvedValueOnce('1.5');
    readLineSpy.mockResolvedValueOnce('1');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
  });

  it('displays state file indicator for runs with state', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    readLineSpy.mockResolvedValueOnce(undefined);

    await sessionSelector.interactiveSelectRun(dir);

    // Find the log call that shows the run with state file indicator
    const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes(`${ts}-develop`));
    expect(runLine).toBeDefined();
    expect(runLine![0]).toContain('💾');
  });

  it('displays blank indicator for runs without state file', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, false);

    readLineSpy.mockResolvedValueOnce(undefined);

    await sessionSelector.interactiveSelectRun(dir);

    const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes(`${ts}-develop`));
    expect(runLine).toBeDefined();
    // Should NOT contain the state file icon
    const line = runLine![0] as string;
    // Extract just the state indicator portion (between the number and the dirName)
    expect(line).not.toContain('💾');
  });

  it('shows header text for past runs', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    readLineSpy.mockResolvedValueOnce(undefined);

    await sessionSelector.interactiveSelectRun(dir);

    expect(logSpy).toHaveBeenCalledWith('\nPast workflow runs (newest first):\n');
  });

  it('shows resumable state legend', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    readLineSpy.mockResolvedValueOnce(undefined);

    await sessionSelector.interactiveSelectRun(dir);

    expect(logSpy).toHaveBeenCalledWith('  💾 = has resumable state');
  });

  it('shows selection prompt with correct range', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts - 1000}-review`, true);

    readLineSpy.mockResolvedValueOnce('1');

    await sessionSelector.interactiveSelectRun(dir);

    expect(writeSpy).toHaveBeenCalledWith('Select a run (1-2) or press Enter to cancel: ');
  });

  it('truncates display to 20 runs and shows overflow message', async () => {
    const dir = getDir();
    const baseTs = Date.now();

    // Create 25 runs
    for (let i = 0; i < 25; i++) {
      createPastRun(dir, `${baseTs - i * 1000}-workflow-${String(i).padStart(2, '0')}`, true);
    }

    readLineSpy.mockResolvedValueOnce('1');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();

    // Check for truncation message
    expect(logSpy).toHaveBeenCalledWith('     ... and 5 more');
  });

  it('limits valid selection to displayLimit of 20 even with more runs', async () => {
    const dir = getDir();
    const baseTs = Date.now();

    // Create 25 runs
    for (let i = 0; i < 25; i++) {
      createPastRun(dir, `${baseTs - i * 1000}-workflow-${String(i).padStart(2, '0')}`, true);
    }

    // 21 should be out of range (only 20 displayed)
    readLineSpy.mockResolvedValueOnce('21');
    readLineSpy.mockResolvedValueOnce('1');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
    expect(readLineSpy).toHaveBeenCalledTimes(2);
  });

  it('displays runs sorted newest first', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts - 5000}-older`, true);
    createPastRun(dir, `${ts}-newer`, true);

    readLineSpy.mockResolvedValueOnce(undefined);

    await sessionSelector.interactiveSelectRun(dir);

    // Find the log calls that contain run dirNames
    const runLines = logSpy.mock.calls
      .filter((c) => typeof c[0] === 'string' && (c[0].includes('newer') || c[0].includes('older')))
      .map((c) => c[0] as string);

    // The newer run should appear first (logged before the older run)
    const newerIdx = runLines.findIndex((l) => l.includes('newer'));
    const olderIdx = runLines.findIndex((l) => l.includes('older'));
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('displays relative time for each run', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    readLineSpy.mockResolvedValueOnce(undefined);

    await sessionSelector.interactiveSelectRun(dir);

    const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes(`${ts}-develop`));
    expect(runLine).toBeDefined();
    // Should contain a relative time pattern like "0s ago" or similar
    expect(runLine![0]).toMatch(/\d+[smhd] ago\)/);
  });
});

// ─── interactiveSelectRun — Two-source picker (active + historical) ────────
//
// Tests for the NEW behavior: the picker draws from TWO sources:
//   1. ACTIVE RUNS (top) — queried from the server via EngineClient
//   2. HISTORICAL RUNS (below) — disk scan of .engin/work/
//
// These tests mock `queryActiveRuns` (a new export that the implement phase
// will add) to control what the server returns. When the function doesn't
// exist yet, the spyOn setup will throw — that IS the RED failure signal.
//
// The second parameter to interactiveSelectRun is the EngineClient (or null
// when the server is down). The return type changes from PastRunEntry to:
//   PickerSelection =
//     | { type: 'active';  runSummary: RunSummary }
//     | { type: 'historical'; pastRun: PastRunEntry }

describe('interactiveSelectRun — two-source picker', () => {
  const { getDir } = useTempDir();

  let logSpy: ReturnType<typeof spyOn>;
  let writeSpy: ReturnType<typeof spyOn>;
  let readLineSpy: ReturnType<typeof spyOn>;
  let queryActiveRunsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    readLineSpy = spyOn(sessionSelector, 'readLineFromStdin');
    // TDD RED: queryActiveRuns does not exist yet on the module.
    // This spyOn will throw, causing all tests in this block to fail at setup.
    // That is the expected RED signal — the implement phase will add the export.
    queryActiveRunsSpy = spyOn(sessionSelector as any, 'queryActiveRuns').mockResolvedValue([]);
  });

  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
    readLineSpy.mockRestore();
    queryActiveRunsSpy.mockRestore();
  });

  // ─── 1. Active runs shown first ──────────────────────────────────────

  describe('active runs shown first', () => {
    it('displays active runs above historical runs in the list', async () => {
      const dir = getDir();
      const ts = Date.now();
      const activeRun = createMockRunSummary({
        runId: `${ts}-active-wf`,
        workflowName: 'active-wf',
        status: 'running',
      });
      // Disk run with a newer timestamp than the active run's simulated time
      createPastRun(dir, `${ts - 5000}-disk-wf`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([activeRun]);
      readLineSpy.mockResolvedValueOnce(undefined); // display then cancel

      await sessionSelector.interactiveSelectRun(dir, null);

      // Collect all logged lines that mention either run
      const allLogs = logSpy.mock.calls.map((c) => c[0]).filter(Boolean);
      const activeLineIdx = allLogs.findIndex((l) => typeof l === 'string' && l.includes('active-wf'));
      const diskLineIdx = allLogs.findIndex((l) => typeof l === 'string' && l.includes('disk-wf'));

      expect(activeLineIdx).toBeGreaterThanOrEqual(0);
      expect(diskLineIdx).toBeGreaterThanOrEqual(0);
      // Active run must appear BEFORE the disk run
      expect(activeLineIdx).toBeLessThan(diskLineIdx);
    });

    it('shows green marker (🟢) for every active run', async () => {
      const dir = getDir();
      const activeRun = createMockRunSummary({ status: 'running', workflowName: 'green-wf' });
      queryActiveRunsSpy.mockResolvedValueOnce([activeRun]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('green-wf'));
      expect(runLine).toBeDefined();
      expect(runLine![0]).toContain('🟢');
    });

    it('shows RUNNING label for active runs with status "running"', async () => {
      const dir = getDir();
      const activeRun = createMockRunSummary({ status: 'running', workflowName: 'run-wf' });
      queryActiveRunsSpy.mockResolvedValueOnce([activeRun]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('run-wf'));
      expect(runLine).toBeDefined();
      expect(runLine![0]).toContain('RUNNING');
    });

    it('shows COMPLETE label for active runs with status "complete"', async () => {
      const dir = getDir();
      const completeRun = createMockRunSummary({ status: 'complete', workflowName: 'done-wf' });
      queryActiveRunsSpy.mockResolvedValueOnce([completeRun]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('done-wf'));
      expect(runLine).toBeDefined();
      expect(runLine![0]).toContain('COMPLETE');
    });

    it('shows FAILED label for active runs with status "failed"', async () => {
      const dir = getDir();
      const failedRun = createMockRunSummary({ status: 'failed', workflowName: 'fail-wf' });
      queryActiveRunsSpy.mockResolvedValueOnce([failedRun]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('fail-wf'));
      expect(runLine).toBeDefined();
      expect(runLine![0]).toContain('FAILED');
    });

    it('numbers active runs starting from 1', async () => {
      const dir = getDir();
      const activeRun1 = createMockRunSummary({ workflowName: 'first-wf' });
      const activeRun2 = createMockRunSummary({ workflowName: 'second-wf' });
      queryActiveRunsSpy.mockResolvedValueOnce([activeRun1, activeRun2]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      // Check that "  1" appears before "first-wf" and "  2" before "second-wf"
      const allLogs = logSpy.mock.calls.map((c) => c[0]).filter(Boolean);
      const firstLine = allLogs.find((l) => typeof l === 'string' && l.includes('first-wf'));
      const secondLine = allLogs.find((l) => typeof l === 'string' && l.includes('second-wf'));
      expect(firstLine).toBeDefined();
      expect(secondLine).toBeDefined();
      expect(firstLine).toMatch(/^\s+1\s/);
      expect(secondLine).toMatch(/^\s+2\s/);
    });
  });

  // ─── 2. Historical runs below active ─────────────────────────────────

  describe('historical runs below active', () => {
    it('shows disk runs that are not active on the server', async () => {
      const dir = getDir();
      const ts = Date.now();
      const activeRun = createMockRunSummary({ runId: `${ts}-active-wf` });
      createPastRun(dir, `${ts - 1000}-disk-only-wf`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([activeRun]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      // Disk-only run should appear in the output
      const diskLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('disk-only-wf'));
      expect(diskLine).toBeDefined();
    });

    it('shows historical runs with 💾 indicator for resumable state', async () => {
      const dir = getDir();
      createPastRun(dir, `${Date.now()}-disk-wf`, true);
      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('disk-wf'));
      expect(runLine).toBeDefined();
      expect(runLine![0]).toContain('💾');
    });

    it('numbers historical runs continuing after active run numbers', async () => {
      const dir = getDir();
      const ts = Date.now();
      const activeRun = createMockRunSummary({ runId: `${ts}-a-wf`, workflowName: 'a-wf' });
      createPastRun(dir, `${ts - 1000}-h-wf`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([activeRun]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      // Active run = item 1, historical run = item 2
      const allLogs = logSpy.mock.calls.map((c) => c[0]).filter(Boolean);
      const hLine = allLogs.find((l) => typeof l === 'string' && l.includes('h-wf'));
      expect(hLine).toBeDefined();
      expect(hLine).toMatch(/^\s+2\s/);
    });

    it('shows selection prompt range covering all items', async () => {
      const dir = getDir();
      const ts = Date.now();
      const activeRun1 = createMockRunSummary({ workflowName: 'a1' });
      const activeRun2 = createMockRunSummary({ workflowName: 'a2' });
      createPastRun(dir, `${ts - 1000}-h1`, true);
      createPastRun(dir, `${ts - 2000}-h2`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([activeRun1, activeRun2]);
      readLineSpy.mockResolvedValueOnce('1');

      await sessionSelector.interactiveSelectRun(dir, null);

      // 2 active + 2 historical = 4 items total
      expect(writeSpy).toHaveBeenCalledWith('Select a run (1-4) or press Enter to cancel: ');
    });
  });

  // ─── 3. Dedup ────────────────────────────────────────────────────────

  describe('dedup', () => {
    it('shows active run ONLY in the active section when also on disk', async () => {
      const dir = getDir();
      const ts = Date.now();
      const sharedDirName = `${ts}-shared-wf`;

      // Create the same run on disk AND have it active on server
      createPastRun(dir, sharedDirName, true);
      const activeRun = createMockRunSummary({
        runId: sharedDirName,
        workflowName: 'shared-wf',
      });
      queryActiveRunsSpy.mockResolvedValueOnce([activeRun]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      // The run dirName should appear exactly once in the output
      const runLines = logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes(sharedDirName));
      expect(runLines).toHaveLength(1);
      // And it should be in the active section (has 🟢 marker)
      expect(runLines[0][0]).toContain('🟢');
    });

    it('does NOT dedup when a disk run is NOT active on the server', async () => {
      const dir = getDir();
      const ts = Date.now();
      const diskDirName = `${ts}-disk-only-wf`;
      createPastRun(dir, diskDirName, true);

      // No active runs on server
      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      // Disk run should appear once (in historical section, no 🟢)
      const runLines = logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes(diskDirName));
      expect(runLines).toHaveLength(1);
      expect(runLines[0][0]).not.toContain('🟢');
    });

    it('dedup multiple overlapping runs correctly', async () => {
      const dir = getDir();
      const ts = Date.now();
      const shared1 = `${ts}-shared1`;
      const shared2 = `${ts - 100}-shared2`;

      // Both on disk AND active on server
      createPastRun(dir, shared1, true);
      createPastRun(dir, shared2, true);
      const activeRun1 = createMockRunSummary({ runId: shared1, workflowName: 'shared1' });
      const activeRun2 = createMockRunSummary({ runId: shared2, workflowName: 'shared2' });
      // Plus one disk-only run
      createPastRun(dir, `${ts - 200}-disk-only`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([activeRun1, activeRun2]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      // shared1 and shared2 should each appear exactly once (in active section)
      const s1Lines = logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes(shared1));
      const s2Lines = logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes(shared2));
      expect(s1Lines).toHaveLength(1);
      expect(s2Lines).toHaveLength(1);
      expect(s1Lines[0][0]).toContain('🟢');
      expect(s2Lines[0][0]).toContain('🟢');
    });
  });

  // ─── 4. Server down fallback ─────────────────────────────────────────

  describe('server down fallback', () => {
    it('shows only historical runs when client is null', async () => {
      const dir = getDir();
      const ts = Date.now();
      createPastRun(dir, `${ts}-disk-wf`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('disk-wf'));
      expect(runLine).toBeDefined();
      // No 🟢 marker — purely historical
      expect(runLine![0]).not.toContain('🟢');
    });

    it('shows only historical runs when client is not connected', async () => {
      const dir = getDir();
      const ts = Date.now();
      createPastRun(dir, `${ts}-disk-wf`, true);

      // Simulate a client that is not connected — queryActiveRuns returns []
      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, {} as any);

      const runLine = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('disk-wf'));
      expect(runLine).toBeDefined();
    });

    it('returns undefined with "No past workflow runs found" when server down and no disk runs', async () => {
      const dir = getDir();
      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce(undefined);

      const result = await sessionSelector.interactiveSelectRun(dir, null);
      expect(result).toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith('No past workflow runs found.');
    });

    it('shows only historical header when server down (no active section)', async () => {
      const dir = getDir();
      const ts = Date.now();
      createPastRun(dir, `${ts}-disk-wf`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir, null);

      // Should show the historical header, NOT an active section header
      expect(logSpy).toHaveBeenCalledWith('\nPast workflow runs (newest first):\n');
      // Should NOT contain an "Active" or "Server" section header
      const activeHeader = logSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0].includes('Active runs') || c[0].includes('Server runs')),
      );
      expect(activeHeader).toBeUndefined();
    });
  });

  // ─── 5. Selection behavior (return types) ────────────────────────────

  describe('selection behavior', () => {
    it('returns { type: "active", runSummary } when user selects an active run', async () => {
      const dir = getDir();
      const ts = Date.now();
      const activeRun = createMockRunSummary({
        runId: `${ts}-active-wf`,
        workflowName: 'active-wf',
        status: 'running',
      });
      createPastRun(dir, `${ts - 1000}-disk-wf`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([activeRun]);
      readLineSpy.mockResolvedValueOnce('1'); // Select first item (active)

      const result = await sessionSelector.interactiveSelectRun(dir, null);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('type', 'active');
      expect((result as any).runSummary).toEqual(
        expect.objectContaining({
          runId: `${ts}-active-wf`,
          workflowName: 'active-wf',
          status: 'running',
        }),
      );
    });

    it('returns { type: "historical", pastRun } when user selects a historical run', async () => {
      const dir = getDir();
      const ts = Date.now();
      const activeRun = createMockRunSummary({ runId: `${ts}-active-wf` });
      createPastRun(dir, `${ts - 1000}-disk-wf`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([activeRun]);
      // '2' selects the historical item (item 2: active=1, historical=2)
      // Fallback: if current impl only shows 1 item, '2' is out-of-range;
      // provide undefined as retry fallback so the test doesn't hang.
      readLineSpy.mockResolvedValueOnce('2');
      readLineSpy.mockResolvedValueOnce(undefined); // fallback cancel

      const result = await sessionSelector.interactiveSelectRun(dir, null);

      // TDD RED: Current impl returns PastRunEntry (no `type`), so this fails.
      expect(result).toBeDefined();
      expect(result).toHaveProperty('type', 'historical');
      expect((result as any).pastRun).toEqual(
        expect.objectContaining({
          dirName: `${ts - 1000}-disk-wf`,
          workflowName: 'disk-wf',
        }),
      );
    });

    it('returns { type: "historical" } when there are no active runs and user selects', async () => {
      const dir = getDir();
      const ts = Date.now();
      createPastRun(dir, `${ts}-disk-wf`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce('1');

      const result = await sessionSelector.interactiveSelectRun(dir, null);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('type', 'historical');
      expect((result as any).pastRun).toEqual(expect.objectContaining({ dirName: `${ts}-disk-wf` }));
    });

    it('returns undefined when user cancels with Enter (no selection)', async () => {
      const dir = getDir();
      const activeRun = createMockRunSummary();
      queryActiveRunsSpy.mockResolvedValueOnce([activeRun]);
      readLineSpy.mockResolvedValueOnce(undefined); // Enter = cancel

      const result = await sessionSelector.interactiveSelectRun(dir, null);
      expect(result).toBeUndefined();
    });

    it('active selection for correct item when active runs are listed first', async () => {
      const dir = getDir();
      const ts = Date.now();
      const activeRun1 = createMockRunSummary({ runId: `${ts}-a1`, workflowName: 'a1' });
      const activeRun2 = createMockRunSummary({ runId: `${ts}-a2`, workflowName: 'a2' });
      createPastRun(dir, `${ts - 1000}-h1`, true);

      queryActiveRunsSpy.mockResolvedValueOnce([activeRun1, activeRun2]);
      // '2' selects the second active run (items: 1=a1, 2=a2, 3=h1)
      // Fallback: if current impl only shows 1 item, '2' is out-of-range;
      // provide undefined as retry fallback so the test doesn't hang.
      readLineSpy.mockResolvedValueOnce('2');
      readLineSpy.mockResolvedValueOnce(undefined); // fallback cancel

      const result = await sessionSelector.interactiveSelectRun(dir, null);

      // TDD RED: Current impl returns PastRunEntry for the disk run (not active).
      expect(result).toBeDefined();
      expect(result).toHaveProperty('type', 'active');
      expect((result as any).runSummary).toEqual(expect.objectContaining({ runId: `${ts}-a2` }));
    });
  });

  // ─── 6. EngineClient parameter ───────────────────────────────────────

  describe('EngineClient parameter', () => {
    it('accepts a mock EngineClient as second parameter', async () => {
      const dir = getDir();
      const mockClient = { isConnected: () => true } as any;
      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce(undefined);

      // Should not throw — just display historical runs
      const result = await sessionSelector.interactiveSelectRun(dir, mockClient);
      expect(result).toBeUndefined();
      // queryActiveRuns should have been called with the client
      expect(queryActiveRunsSpy).toHaveBeenCalledWith(mockClient);
    });

    it('works without client parameter (backward compatible)', async () => {
      const dir = getDir();
      const ts = Date.now();
      createPastRun(dir, `${ts}-disk-wf`, true);
      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce(undefined);

      // Call with only cwd (no client) — backward compatible
      const result = await sessionSelector.interactiveSelectRun(dir);
      expect(result).toBeUndefined(); // User cancelled
    });

    it('passes null client to queryActiveRuns when omitted', async () => {
      const dir = getDir();
      queryActiveRunsSpy.mockResolvedValueOnce([]);
      readLineSpy.mockResolvedValueOnce(undefined);

      await sessionSelector.interactiveSelectRun(dir);

      // When no client is passed, queryActiveRuns should be called with null/undefined
      expect(queryActiveRunsSpy).toHaveBeenCalledTimes(1);
      const arg = queryActiveRunsSpy.mock.calls[0][0];
      expect(arg === null || arg === undefined).toBe(true);
    });
  });
});
