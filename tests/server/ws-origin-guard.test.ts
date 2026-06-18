// ─── ws-origin-guard — test-first specification ──────────────────────────────
//
// Tests for `src/server/ws-origin-guard.ts`, the pure function that validates
// the `Origin` header on a WebSocket upgrade request.
//
// This is a CSRF defense for BROWSER WebSocket upgrades — NOT an
// authentication layer. It is extracted verbatim from `control-server.ts` so
// the same rules continue to apply after the server decomposition.
//
// Contract under test (see server-refactor.prompt.md):
//
//   export function validateWebSocketOrigin(req: Request): boolean
//
// Rules:
//   • Non-browser clients (no Origin header) are allowed unconditionally.
//   • Localhost binds (Host starts with localhost / 127.0.0.1 / ::1 / [::1])
//     bypass the check — any Origin is allowed.
//   • Otherwise, the Origin URL is parsed and validated:
//       - Bug 1: non-HTTP schemes (capacitor://, file://, ionic://) are allowed.
//       - The Host header (NOT X-Forwarded-Host) is the comparison target.
//       - Bug 3: hostnames compare case-insensitively (RFC 3986).
//       - Bug 2: ports compare only when BOTH Origin and Host specify one.
//       - Malformed Origin URLs are rejected (false).
//
// The function reads ONLY `origin` and `host` from the request headers, so it
// can be unit-tested with plain `Request` objects (no live server needed).

import { describe, expect, it } from 'bun:test';

import { validateWebSocketOrigin } from '../../packages/engine/src/server/ws-origin-guard.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a Request with explicit `host` and optional `origin` headers.
 *
 * The request URL is irrelevant to the function (it only reads headers), so a
 * stable placeholder URL is used to avoid construction issues with exotic host
 * strings (e.g. IPv6 literals). Bun permits setting the `Host` header directly
 * via the constructor.
 */
function makeReq(host: string, origin?: string, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { host };
  if (origin !== undefined) headers['origin'] = origin;
  for (const [k, v] of Object.entries(extra)) headers[k] = v;
  return new Request('http://localhost/ws', { headers });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateWebSocketOrigin', () => {
  // ─── Non-browser clients (no Origin header) ──────────────────────────────

  describe('non-browser clients (no Origin header)', () => {
    it('allows a request with no Origin on a non-localhost host', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080'))).toBe(true);
    });

    it('allows a request with no Origin on localhost', () => {
      expect(validateWebSocketOrigin(makeReq('127.0.0.1:8080'))).toBe(true);
    });

    it('allows a request with no Origin on a wildcard host', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:443'))).toBe(true);
    });
  });

  // ─── Localhost bypass ────────────────────────────────────────────────────

  describe('localhost bypass (any Origin allowed when Host is local)', () => {
    it('allows any Origin when Host is 127.0.0.1', () => {
      expect(validateWebSocketOrigin(makeReq('127.0.0.1:8080', 'https://evil.com'))).toBe(true);
    });

    it('allows any Origin when Host is localhost', () => {
      expect(validateWebSocketOrigin(makeReq('localhost:8080', 'https://evil.com'))).toBe(true);
    });

    it('allows any Origin when Host is ::1', () => {
      expect(validateWebSocketOrigin(makeReq('::1:8080', 'https://evil.com'))).toBe(true);
    });

    it('allows any Origin when Host is [::1] (IPv6 literal with brackets)', () => {
      expect(validateWebSocketOrigin(makeReq('[::1]:8080', 'https://evil.com'))).toBe(true);
    });

    it('localhost bypass works regardless of port', () => {
      expect(validateWebSocketOrigin(makeReq('localhost:3000', 'http://attacker.example'))).toBe(true);
    });
  });

  // ─── Cross-origin rejection ──────────────────────────────────────────────

  describe('cross-origin rejection', () => {
    it('rejects a foreign hostname Origin on a non-localhost host', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'https://evil.com'))).toBe(false);
    });

    it('rejects an Origin whose hostname differs from the Host', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'http://1.2.3.4:8080'))).toBe(false);
    });

    it('does NOT trust a spoofed X-Forwarded-Host header', () => {
      // An attacker sets X-Forwarded-Host to match their Origin, but the real
      // Host header is the comparison target and must mismatch.
      const res = validateWebSocketOrigin(
        makeReq('0.0.0.0:8080', 'http://1.2.3.4:8080', { 'x-forwarded-host': '1.2.3.4:8080' }),
      );
      expect(res).toBe(false);
    });

    it('does NOT trust X-Forwarded-Host even when it would otherwise match the Origin', () => {
      // Host is localhost-ish? No — 0.0.0.0 is NOT localhost, so validation runs.
      // Origin hostname matches X-Forwarded-Host but NOT the real Host → reject.
      const res = validateWebSocketOrigin(
        makeReq('0.0.0.0:8080', 'http://spoofed.host:8080', { 'x-forwarded-host': 'spoofed.host:8080' }),
      );
      expect(res).toBe(false);
    });
  });

  // ─── Same-origin browser upgrades ─────────────────────────────────────────

  describe('same-origin browser upgrades', () => {
    it('allows an Origin matching both hostname and port', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'http://0.0.0.0:8080'))).toBe(true);
    });

    it('allows a same-origin https Origin', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8443', 'https://0.0.0.0:8443'))).toBe(true);
    });
  });

  // ─── Bug 1: non-HTTP scheme Origins ───────────────────────────────────────

  describe('non-HTTP scheme Origins (Bug 1)', () => {
    it('allows a capacitor:// scheme Origin', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'capacitor://localhost'))).toBe(true);
    });

    it('allows a file:// scheme Origin', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'file://'))).toBe(true);
    });

    it('allows an ionic:// scheme Origin', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'ionic://localhost'))).toBe(true);
    });
  });

  // ─── Bug 2: port omission ────────────────────────────────────────────────

  describe('port omission (Bug 2)', () => {
    it('allows an Origin that omits the port when Host has one', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'http://0.0.0.0'))).toBe(true);
    });

    it('allows a Host that omits the port when Origin has one', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0', 'http://0.0.0.0:8080'))).toBe(true);
    });

    it('rejects when both ports are present and differ', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'http://0.0.0.0:9000'))).toBe(false);
    });
  });

  // ─── Bug 3: case-insensitive hostname ─────────────────────────────────────

  describe('case-insensitive hostname comparison (Bug 3)', () => {
    it('matches when the Origin hostname differs in case from the Host', () => {
      expect(validateWebSocketOrigin(makeReq('Example.com:8080', 'http://example.com:8080'))).toBe(true);
    });

    it('matches when the Host hostname differs in case from the Origin', () => {
      expect(validateWebSocketOrigin(makeReq('example.com:8080', 'http://EXAMPLE.COM:8080'))).toBe(true);
    });

    it('still rejects a genuinely different hostname even when case differs', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'http://EVIL.com:8080'))).toBe(false);
    });
  });

  // ─── Malformed Origin ────────────────────────────────────────────────────

  describe('malformed Origin', () => {
    it('rejects an unparseable Origin URL', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'http://['))).toBe(false);
    });

    it('rejects a non-URL Origin string', () => {
      expect(validateWebSocketOrigin(makeReq('0.0.0.0:8080', 'not-a-url'))).toBe(false);
    });
  });
});
