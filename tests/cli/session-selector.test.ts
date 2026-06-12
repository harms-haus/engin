import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as sessionSelector from '../../src/cli/session-selector.js';
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

// ─── Module exports ────────────────────────────────────────────────────────

describe('session-selector module exports', () => {
  it('exports all four expected functions', async () => {
    const mod = await import('../../src/cli/session-selector.js');
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

// ─── interactiveSelectRun ──────────────────────────────────────────────────

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

  it('returns selected run when user enters valid number', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts - 1000}-review`, false);

    readLineSpy.mockResolvedValueOnce('1');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
    expect(result!.dirName).toBe(`${ts}-develop`);
    expect(result!.workflowName).toBe('develop');
    expect(result!.hasStateFile).toBe(true);
  });

  it('returns second run when user enters 2', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts - 1000}-review`, false);

    readLineSpy.mockResolvedValueOnce('2');

    const result = await sessionSelector.interactiveSelectRun(dir);
    expect(result).toBeDefined();
    expect(result!.dirName).toBe(`${ts - 1000}-review`);
    expect(result!.workflowName).toBe('review');
    expect(result!.hasStateFile).toBe(false);
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
    expect(result!.dirName).toBe(`${ts}-develop`);
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
