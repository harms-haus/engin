// ─── auth module — test-first specification ─────────────────────────────────
//
// Test-first specification for `src/server/auth.ts`, the capability-token
// generation and authorize interceptor.
//
// Contract under test (see server-refactor.prompt.md §13):
//
//   generateToken()          → random 32-byte hex string (64 hex chars)
//   writeServerToken(token)  → writes token to <globalConfigDir>/server.token
//                               with mode 0600 (owner read/write only)
//   readServerToken()        → reads the stored token string; null if absent
//   validateToken(supplied)  → constant-time compare of supplied vs stored;
//                               false on length mismatch or mismatch
//   authorize(msg, ws)       → ALWAYS returns { authorized: true } (auth
//                               attach point — real validation deferred)
//
// `getServerTokenPath()` already exists in `src/server/daemon.ts` and is
// reused by auth.ts (NOT reimplemented). Tests redirect it via XDG_CONFIG_HOME.
//
// The global config dir is redirected into a per-test temp dir via
// XDG_CONFIG_HOME (mirrors tests/server/daemon.test.ts).

import { beforeEach, describe, expect, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  authorize,
  generateToken,
  readServerToken,
  validateToken,
  writeServerToken,
} from '../../packages/engine/src/server/auth.js';
import { getServerTokenPath } from '../../packages/engine/src/server/daemon.js';
import type { ClientMessage } from '../../packages/shared/src/protocol-types.js';
import { useEnvSandbox } from '../helpers/env-sandbox.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('auth', () => {
  const { getDir } = useTempDir();
  useEnvSandbox();

  /** Points the global config dir at <temp>/xdg/engin. */
  function useTempXdg(): string {
    const xdg = join(getDir(), 'xdg');
    process.env.XDG_CONFIG_HOME = xdg;
    return xdg;
  }

  // ─── generateToken ────────────────────────────────────────────────────────

  describe('generateToken', () => {
    it('returns a string', () => {
      const token = generateToken();
      expect(typeof token).toBe('string');
    });

    it('returns a 64-character hex string (32 bytes)', () => {
      const token = generateToken();
      expect(token).toHaveLength(64);
    });

    it('returns only hex characters [0-9a-f]', () => {
      const token = generateToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns different values on successive calls', () => {
      const a = generateToken();
      const b = generateToken();
      expect(a).not.toBe(b);
    });
  });

  // ─── writeServerToken ─────────────────────────────────────────────────────

  describe('writeServerToken', () => {
    beforeEach(() => {
      useTempXdg();
    });

    it('creates the token file at the canonical path', async () => {
      const token = generateToken();
      await writeServerToken(token);

      const content = await Bun.file(getServerTokenPath()).text();
      expect(content).toBe(token);
    });

    it('file has mode 0600 (owner read/write only)', async () => {
      const token = generateToken();
      await writeServerToken(token);

      const fileInfo = await stat(getServerTokenPath());
      // stat mode includes the file-type bits; mask with 0o777 to get perms.
      const perms = fileInfo.mode & 0o777;
      expect(perms).toBe(0o600);
    });

    it('overwrites an existing token file', async () => {
      const first = generateToken();
      const second = generateToken();
      await writeServerToken(first);
      await writeServerToken(second);

      const stored = await readServerToken();
      expect(stored).toBe(second);
    });

    it('creates the parent config dir if it does not exist yet', async () => {
      // <xdg>/engin does not exist yet — writeServerToken should mkdir -p it.
      const token = generateToken();
      await writeServerToken(token);

      const stored = await readServerToken();
      expect(stored).toBe(token);
    });
  });

  // ─── readServerToken ──────────────────────────────────────────────────────

  describe('readServerToken', () => {
    beforeEach(() => {
      useTempXdg();
    });

    it('returns null when no token file exists', async () => {
      expect(await readServerToken()).toBeNull();
    });

    it('round-trips a written token', async () => {
      const token = generateToken();
      await writeServerToken(token);
      expect(await readServerToken()).toBe(token);
    });

    it('returns null (soft failure) when the token dir is missing entirely', async () => {
      // The XDG dir is set but <xdg>/engin/ does not exist → ENOENT on read.
      expect(await readServerToken()).toBeNull();
    });
  });

  // ─── validateToken ────────────────────────────────────────────────────────

  describe('validateToken', () => {
    beforeEach(() => {
      useTempXdg();
    });

    it('returns true when the supplied token matches the stored token', async () => {
      const token = generateToken();
      await writeServerToken(token);
      expect(await validateToken(token)).toBe(true);
    });

    it('returns false when the supplied token does not match', async () => {
      const token = generateToken();
      await writeServerToken(token);
      const different = generateToken();
      expect(await validateToken(different)).toBe(false);
    });

    it('returns false when no token file exists (no stored token)', async () => {
      const token = generateToken();
      expect(await validateToken(token)).toBe(false);
    });

    it('returns false on an empty supplied token', async () => {
      const token = generateToken();
      await writeServerToken(token);
      expect(await validateToken('')).toBe(false);
    });

    it('returns false when the supplied token is shorter than the stored token', async () => {
      const token = generateToken();
      await writeServerToken(token);
      // 32 chars — half the length of a valid 64-char token.
      expect(await validateToken(token.slice(0, 32))).toBe(false);
    });

    it('returns false when the supplied token is longer than the stored token', async () => {
      const token = generateToken();
      await writeServerToken(token);
      // 96 chars — 1.5× the length of a valid 64-char token.
      expect(await validateToken(token + 'abcdef')).toBe(false);
    });
  });

  // ─── authorize ────────────────────────────────────────────────────────────

  describe('authorize', () => {
    /** Every ClientMessage type from the protocol union. */
    const clientMessages: ClientMessage[] = [
      { type: 'auth', token: 'some-token' },
      { type: 'list_runs' },
      {
        type: 'start_run',
        workflowName: 'dev',
        taskPrompt: 'do the thing',
        cwd: '/tmp/project',
      },
      { type: 'subscribe', runId: 'run-1' },
      { type: 'unsubscribe', runId: 'run-1' },
      { type: 'resync', runId: 'run-1', lastSeq: 42 },
      { type: 'cancel_run', runId: 'run-1' },
      { type: 'worktree_action', runId: 'run-1', action: 'merge' },
      { type: 'worktree_action', runId: 'run-1', action: 'pr' },
      { type: 'worktree_action', runId: 'run-1', action: 'discard' },
      { type: 'worktree_action', runId: 'run-1', action: 'keep' },
    ];

    for (const msg of clientMessages) {
      it(`always returns { authorized: true } for { type: '${msg.type}' }`, () => {
        // `ws` is unused for now — pass a dummy object.
        const result = authorize(msg, {} as unknown);
        expect(result).toEqual({ authorized: true });
      });
    }

    it('returns { authorized: true } for an auth message without a token', () => {
      const result = authorize({ type: 'auth' }, {} as unknown);
      expect(result).toEqual({ authorized: true });
    });

    it('returns { authorized: true } regardless of whether a token file exists', () => {
      useTempXdg();
      // No token file written — authorize still returns authorized: true.
      const result = authorize({ type: 'list_runs' }, {} as unknown);
      expect(result).toEqual({ authorized: true });
    });
  });
});
