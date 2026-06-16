// ─── wildcard host guard — test-first specification ─────────────────────────
//
// Tests for `src/server/bind-guard.ts`, the single chokepoint that refuses
// to bind a daemon to a wildcard host (0.0.0.0, ::, etc.).
//
// Wildcard hosts bind to ALL network interfaces, which exposes the server to
// the local network. Authentication is not yet implemented, so binding
// anything other than a specific interface (e.g. 127.0.0.1) is unsafe.
//
// This guard lives in `src/server/` so that EVERY caller of `startDaemon`
// (CLI `server up`, `engin run` auto-start, `engin resume` auto-start) is
// covered by the same check — closing the bypass where `run`/`resume` passed
// `--host` straight to `startDaemon` without the gate the CLI layer enforces.

import { describe, expect, it } from 'bun:test';

import { isWildcardHost, WILDCARD_HOSTS } from '../../packages/engine/src/server/bind-guard.js';
import { startDaemon } from '../../packages/engine/src/server/daemon.js';

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('bind-guard', () => {
  // ─── isWildcardHost: wildcard hosts ───────────────────────────────────────

  describe('isWildcardHost — wildcard hosts', () => {
    for (const host of WILDCARD_HOSTS) {
      it(`returns true for '${host}'`, () => {
        expect(isWildcardHost(host)).toBe(true);
      });
    }
  });

  // ─── isWildcardHost: non-wildcard hosts ───────────────────────────────────

  describe('isWildcardHost — non-wildcard hosts', () => {
    const safeHosts: [string, string | undefined][] = [
      ['127.0.0.1', '127.0.0.1'],
      ['192.168.1.50', '192.168.1.50'],
      ['10.0.0.1', '10.0.0.1'],
      ['localhost', 'localhost'],
      ['undefined', undefined],
      ['empty string', ''],
    ];

    for (const [label, host] of safeHosts) {
      it(`returns false for ${label}`, () => {
        expect(isWildcardHost(host)).toBe(false);
      });
    }
  });

  // ─── startDaemon integration: refuses wildcard host ───────────────────────

  describe('startDaemon — wildcard host gate', () => {
    // The guard is the very first statement in startDaemon (before any network
    // probe or spawn), so these calls never reach isServerAlive / Bun.spawn —
    // they throw synchronously after the first await-free check, making the
    // test fully hermetic (no network, no temp dir, no spawned process).
    for (const host of WILDCARD_HOSTS) {
      it(`throws when called with host '${host}'`, async () => {
        expect(startDaemon({ port: 1, host })).rejects.toThrow(/Refusing to bind wildcard host/);
      });
    }

    it('error message names the offending host and suggests 127.0.0.1', async () => {
      try {
        await startDaemon({ port: 1, host: '0.0.0.0' });
        // Should have thrown — fail loudly if it did not.
        throw new Error('startDaemon did not throw for 0.0.0.0');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toContain('0.0.0.0');
        expect(message).toContain('127.0.0.1');
      }
    });
  });
});
