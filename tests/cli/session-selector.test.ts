import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatRelativeTime,
  interactiveSelectRun,
  readLineFromStdin,
  resolveSessionName,
} from '../../src/cli/session-selector.ts';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── formatRelativeTime ────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  it('returns seconds ago for recent timestamps', () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 30_000); // 30 seconds ago
    expect(result).toBe('30s ago');
  });

  it('returns "0s ago" for current timestamp', () => {
    const now = Date.now();
    const result = formatRelativeTime(now);
    expect(result).toBe('0s ago');
  });

  it('returns minutes ago for timestamps within an hour', () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 5 * 60 * 1000); // 5 minutes ago
    expect(result).toBe('5m ago');
  });

  it('returns hours ago for timestamps within a day', () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 3 * 60 * 60 * 1000); // 3 hours ago
    expect(result).toBe('3h ago');
  });

  it('returns days ago for timestamps older than a day', () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    expect(result).toBe('2d ago');
  });

  it('returns 59s ago for just under a minute', () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 59_000);
    expect(result).toBe('59s ago');
  });

  it('returns 59m ago for just under an hour', () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 59 * 60 * 1000);
    expect(result).toBe('59m ago');
  });

  it('returns 23h ago for just under a day', () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 23 * 60 * 60 * 1000);
    expect(result).toBe('23h ago');
  });

  it('returns 1s ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 1_000)).toBe('1s ago');
  });

  it('returns 1m ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60_000)).toBe('1m ago');
  });

  it('returns 1h ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60 * 60 * 1000)).toBe('1h ago');
  });

  it('returns 1d ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 24 * 60 * 60 * 1000)).toBe('1d ago');
  });
});

// ─── resolveSessionName ────────────────────────────────────────────────────

describe('resolveSessionName', () => {
  const { getDir } = useTempDir();

  function createPastRun(cwd: string, dirName: string, hasStateFile = false) {
    const runDir = join(cwd, '.engin', 'work', dirName);
    mkdirSync(runDir, { recursive: true });
    if (hasStateFile) {
      writeFileSync(join(runDir, '.engin-state.json'), JSON.stringify({ taskPrompt: 'test prompt' }));
    }
  }

  it('resolves by exact dirName', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);

    const result = await resolveSessionName(`${ts}-develop`, dir);
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
    const result = await resolveSessionName(String(ts), dir);
    expect(result.dirName).toBe(`${ts}-develop`);
  });

  it('throws on ambiguous prefix match', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts}-review`, true);

    await expect(resolveSessionName(String(ts), dir)).rejects.toThrow(/Ambiguous session name/);
  });

  it('includes matched names in ambiguous error message', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts}-review`, true);

    try {
      await resolveSessionName(String(ts), dir);
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

    await expect(resolveSessionName('nonexistent', dir)).rejects.toThrow(/No past run found/);
  });

  it('error message suggests using resume without arguments', async () => {
    const dir = getDir();
    await expect(resolveSessionName('nothing', dir)).rejects.toThrow(/engin resume.*without arguments/);
  });

  it('resolves exact match even when prefix would match multiple', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, true);
    createPastRun(dir, `${ts}-review`, false);

    // Exact match should work despite prefix ambiguity
    const result = await resolveSessionName(`${ts}-develop`, dir);
    expect(result.dirName).toBe(`${ts}-develop`);
    expect(result.workflowName).toBe('develop');
  });

  it('returns entry with correct timestamp', async () => {
    const dir = getDir();
    const ts = 1700000000000; // fixed timestamp
    createPastRun(dir, `${ts}-develop`, true);

    const result = await resolveSessionName(`${ts}-develop`, dir);
    expect(result.timestamp).toBe(ts);
  });

  it('returns entry with hasStateFile false when no state file exists', async () => {
    const dir = getDir();
    const ts = Date.now();
    createPastRun(dir, `${ts}-develop`, false);

    const result = await resolveSessionName(`${ts}-develop`, dir);
    expect(result.hasStateFile).toBe(false);
  });
});

// ─── interactiveSelectRun ──────────────────────────────────────────────────

describe('interactiveSelectRun', () => {
  const { getDir } = useTempDir();

  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns undefined when no past runs exist', async () => {
    const dir = getDir();
    const result = await interactiveSelectRun(dir);
    expect(result).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('No past workflow runs found.');
  });
});

// ─── readLineFromStdin ─────────────────────────────────────────────────────

describe('readLineFromStdin', () => {
  it('is exported as a function', () => {
    expect(typeof readLineFromStdin).toBe('function');
  });
});

// ─── Module exports ────────────────────────────────────────────────────────

describe('session-selector module exports', () => {
  it('exports all four expected functions', async () => {
    const mod = await import('../../src/cli/session-selector.ts');
    expect(typeof mod.formatRelativeTime).toBe('function');
    expect(typeof mod.readLineFromStdin).toBe('function');
    expect(typeof mod.interactiveSelectRun).toBe('function');
    expect(typeof mod.resolveSessionName).toBe('function');
  });
});
