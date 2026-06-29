// ─── auth — capability-token generation & the single authorize chokepoint ──
//
// Daemon-side authentication primitives.
//
// `generateToken`/`writeServerToken`/`readServerToken`/`validateToken` manage
// the capability token persisted at `<globalConfigDir>/server.token` (path
// sourced from daemon.ts). `authorize` is the single chokepoint through which
// every inbound `ClientMessage` passes on the WebSocket router.
//
// The token path getter (`getServerTokenPath`) already lives in `./daemon.ts`
// and is reused here — NOT reimplemented.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ClientMessage } from '@engin/shared/protocol-types';
import { isEnoentError } from '../core/utils.js';
import { getServerTokenPath } from './daemon.js';

// ─── Token generation ───────────────────────────────────────────────────────

/**
 * Returns a random 32-byte hex string (64 hex characters, lowercase).
 *
 * Uses `crypto.randomBytes(32)`, the cryptographic-strength CSPRNG, so the
 * token is suitable as a bearer capability. Successive calls return distinct
 * values (the entropy pool is 256 bits, collision probability is negligible).
 */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// ─── Token persistence ──────────────────────────────────────────────────────

/**
 * Writes `token` to `<globalConfigDir>/server.token` with mode `0600`
 * (owner read/write only) and creates the parent config directory if it does
 * not yet exist (`mkdir -p`).
 *
 * The token is written verbatim with no trailing newline so that
 * {@link readServerToken} round-trips it exactly.
 */
export async function writeServerToken(token: string): Promise<void> {
  const tokenPath = getServerTokenPath();
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, token, { mode: 0o600 });
}

/**
 * Reads and returns the stored token string, or `null` when the token file is
 * absent (`ENOENT`) or otherwise unreadable. Never throws on a missing file.
 */
export async function readServerToken(): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(getServerTokenPath(), 'utf-8');
  } catch (err: unknown) {
    if (isEnoentError(err)) {
      return null;
    }
    // Unexpected read error (EACCES, EISDIR, etc.) — warn so the user has a
    // local hint, then treat as unreadable rather than surfacing it.
    console.warn(`Warning: server token file exists but is unreadable: ${err instanceof Error ? err.message : err}`);
    return null;
  }
  return content;
}

// ─── Token validation ───────────────────────────────────────────────────────

/**
 * Compares `supplied` against the stored token using a constant-time
 * comparison (`crypto.timingSafeEqual`).
 *
 * @returns `true` iff a token is stored and `supplied` matches it byte-for-byte.
 *   Returns `false` when:
 *     - no token file exists (nothing stored),
 *     - `supplied` differs in length from the stored token (checked before
 *       `timingSafeEqual`, which throws on unequal-length buffers),
 *     - the bytes differ.
 */
export async function validateToken(supplied: string): Promise<boolean> {
  const stored = await readServerToken();
  if (stored === null) {
    return false;
  }

  const suppliedBuf = Buffer.from(supplied, 'utf-8');
  const storedBuf = Buffer.from(stored, 'utf-8');

  // timingSafeEqual throws on unequal lengths; guard up front (length
  // disclosure is acceptable here, content is not).
  if (suppliedBuf.length !== storedBuf.length) {
    return false;
  }

  return timingSafeEqual(suppliedBuf, storedBuf);
}

// ─── Authorize chokepoint ───────────────────────────────────────────────────

/** The result of {@link authorize}. */
export type AuthorizeResult = { authorized: true } | { authorized: false; reason?: string };

/**
 * The single auth chokepoint through which every inbound `ClientMessage`
 * passes on the WebSocket router.
 *
 * Currently a permissive no-op: it ALWAYS returns `{ authorized: true }` for
 * every message variant (with or without a token file present). Real
 * enforcement is deferred.
 *
 * // AUTH ATTACH POINT: real validation goes here. The intended check is a
 * constant-time compare of the client-supplied token (from the `auth` message
 * or a connection header) against the stored server token via
 * `validateToken(supplied)`. Until the server startup path writes a token
 * and clients are updated to send it, every message is authorized.
 */
export function authorize(_msg: ClientMessage, _ws: unknown): AuthorizeResult {
  return { authorized: true };
}
