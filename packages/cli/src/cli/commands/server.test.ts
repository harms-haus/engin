// ─── Tests for cli/commands/server.ts — server command extraction ───────────
//
// Drives the extraction of `serverUpCommand`, `serverDownCommand`, and
// `serverStatusCommand` into a focused `commands/server.ts` module, and pins
// the observable behavior of the LAN/wildcard authentication guard (the one
// code path that completes without a live daemon).
//
// The auth guard runs BEFORE `startDaemon`/`stopDaemon`, so these tests never
// spawn a real daemon process. They assert: (a) the three commands are
// exported, (b) the guard writes its auth message to stderr and sets a
// non-zero exit code for every disallowed binding, and (c) no "Server running"
// success line is printed.
//
// Module under test: ./server.js

import { describe, expect, it } from 'bun:test';

import type { CliOptions } from '../parse-args.js';
import { serverDownCommand, serverStatusCommand, serverUpCommand } from './server.js';

/** Build a server-command CliOptions, overriding selected fields. */
function serverOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    command: 'server',
    cwd: process.cwd(),
    verbose: false,
    apiKeys: {},
    warnings: [],
    ...overrides,
  };
}

/** Captures stderr writes and stdout (console.log) lines for the duration of `fn`. */
async function withCapturedOutput<T>(fn: () => Promise<T>): Promise<{ stderr: string; stdout: string; result: T }> {
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log;

  process.stderr.write = ((chunk: unknown): boolean => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    stdoutChunks.push(args.map(String).join(' '));
  };

  try {
    const result = await fn();
    return { stderr: stderrChunks.join(''), stdout: stdoutChunks.join('\n'), result };
  } finally {
    process.stderr.write = origStderrWrite;
    console.log = origLog;
  }
}

describe('server commands — structural contract', () => {
  it('exports serverUpCommand, serverDownCommand, serverStatusCommand as functions', () => {
    expect(typeof serverUpCommand).toBe('function');
    expect(typeof serverDownCommand).toBe('function');
    expect(typeof serverStatusCommand).toBe('function');
  });
});

describe('serverUpCommand — LAN/wildcard authentication guard', () => {
  // Every case here must be REFUSED (no auth yet) and never reach startDaemon.
  const disallowedBindings: Array<{ label: string; options: Partial<CliOptions> }> = [
    { label: '--lan flag', options: { serverAction: 'up', lan: true } },
    { label: 'host 0.0.0.0', options: { serverAction: 'up', host: '0.0.0.0' } },
    { label: 'host ::', options: { serverAction: 'up', host: '::' } },
    { label: 'host [::]', options: { serverAction: 'up', host: '[::]' } },
    { label: 'host ::0', options: { serverAction: 'up', host: '::0' } },
    { label: 'host *', options: { serverAction: 'up', host: '*' } },
  ];

  for (const { label, options } of disallowedBindings) {
    it(`refuses ${label} without spawning a daemon`, async () => {
      const prevExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        const { stderr, stdout } = await withCapturedOutput(() => serverUpCommand(serverOptions(options)));

        // Non-zero exit code signals refusal to the shell. The `unknown`
        // cast bypasses TS narrowing of `process.exitCode` to `undefined`
        // (set just above); at runtime the guard writes the numeric value.
        const exitCode = process.exitCode as unknown as number;
        expect(exitCode).toBe(1);
        // A clear, single auth message on stderr naming localhost binding.
        expect(stderr).toContain('authentication');
        expect(stderr.toLowerCase()).toContain('localhost');
        // The success line must NOT appear — startDaemon was never called.
        expect(stdout).not.toContain('Server running');
      } finally {
        process.exitCode = prevExitCode;
      }
    });
  }

  it('does not throw — it writes to stderr and returns (so main() does not duplicate the message)', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await expect(
        withCapturedOutput(() => serverUpCommand(serverOptions({ serverAction: 'up', lan: true }))),
      ).resolves.toBeDefined();
      const exitCode = process.exitCode as unknown as number;
      expect(exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });
});
