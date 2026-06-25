// ─── Tests for server-entry.ts keepalive interval cleanup ───────────────────
//
// `server-entry.ts` is a daemon entrypoint: none of its functions
// (`parseEntrypointArgs`, `main`, `shutdown`) are exported, and the keepalive
// `setInterval` is `unref()`'d so it never blocks the event loop on its own.
// That makes a black-box runtime test of "the interval is cleared" both flaky
// (the process exits regardless) and brittle.
//
// The bug under test is structural: the keepalive interval created at the end
// of `main()` was NEVER cleared during graceful shutdown. The fix moves the
// `keepalive` declaration above the `shutdown` closure and adds
// `clearInterval(keepalive)` at the top of `shutdown`.
//
// These tests pin that structural contract by reading the source file directly.
// They FAIL against the buggy version (no clearInterval, wrong ordering) and
// PASS once the fix lands. This guards against regressions that would
// reintroduce the leak (e.g. reordering declarations or dropping the clear).

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(import.meta.dir, 'server-entry.ts'), 'utf8');

/**
 * Slices the source down to the body of `async function main()`. The main
 * function spans from its signature to the matching closing brace that
 * precedes the module-level `isDirectRun` block.
 */
function mainBody(): string {
  const mainStart = SOURCE.indexOf('async function main()');
  expect(mainStart).toBeGreaterThan(-1);

  const isDirectRunIndex = SOURCE.indexOf('const isDirectRun', mainStart);
  expect(isDirectRunIndex).toBeGreaterThan(mainStart);

  return SOURCE.slice(mainStart, isDirectRunIndex);
}

describe('server-entry.ts — keepalive interval cleanup on shutdown', () => {
  it('creates a keepalive interval in main()', () => {
    expect(mainBody()).toMatch(/const\s+keepalive\s*=\s*setInterval\s*\(/);
  });

  it('unref()s the keepalive interval so it never blocks exit', () => {
    expect(mainBody()).toMatch(/keepalive\.unref\s*\(\s*\)/);
  });

  it('clears the keepalive interval inside the shutdown function', () => {
    const body = mainBody();

    // Locate the shutdown closure.
    const shutdownIndex = body.indexOf('const shutdown = async');
    expect(shutdownIndex).toBeGreaterThan(-1);

    // Grab the shutdown function body — up to the next top-level statement
    // (the first `process.on('SIGTERM'` handler registration).
    const sigtermIndex = body.indexOf("process.on('SIGTERM'", shutdownIndex);
    expect(sigtermIndex).toBeGreaterThan(shutdownIndex);

    const shutdownBody = body.slice(shutdownIndex, sigtermIndex);

    // The fix: clearInterval(keepalive) must appear within shutdown.
    expect(shutdownBody).toMatch(/clearInterval\s*\(\s*keepalive\s*\)/);
  });

  it('declares keepalive BEFORE the shutdown function is defined', () => {
    const body = mainBody();

    const keepaliveIndex = body.indexOf('const keepalive');
    const shutdownIndex = body.indexOf('const shutdown = async');

    expect(keepaliveIndex).toBeGreaterThan(-1);
    expect(shutdownIndex).toBeGreaterThan(-1);
    // keepalive must precede shutdown so the closure can reference it.
    expect(keepaliveIndex).toBeLessThan(shutdownIndex);
  });

  it('clears keepalive before stopping the control server', () => {
    const body = mainBody();

    const shutdownIndex = body.indexOf('const shutdown = async');
    const sigtermIndex = body.indexOf("process.on('SIGTERM'", shutdownIndex);
    const shutdownBody = body.slice(shutdownIndex, sigtermIndex);

    const clearIntervalIndex = shutdownBody.indexOf('clearInterval');
    const stopIndex = shutdownBody.indexOf('controlServer.stop');

    expect(clearIntervalIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(-1);
    // Per the fix spec, clearInterval runs before controlServer.stop().
    expect(clearIntervalIndex).toBeLessThan(stopIndex);
  });
});
