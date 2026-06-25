// ─── ws-origin-guard — Origin header validation for WebSocket upgrades ───────
//
// Extracted from control-server.ts so the server module contains only the
// Bun.serve wiring. This is a pure function: it reads ONLY the `origin` and
// `host` headers from a Request and decides whether the WebSocket upgrade
// should be allowed. No server state, no side effects.

/**
 * Validate the Origin header for a WebSocket upgrade request.
 *
 * Non-browser clients such as curl or custom scripts that connect via WebSocket
 * do not send an Origin header, so they bypass this check. The default binding is
 * localhost (127.0.0.1); bind to 0.0.0.0 only when the user explicitly opts in
 * via --host or --lan.
 *
 * @returns true if the request should be allowed, false to reject with 403.
 */
export function validateWebSocketOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host') || '';

  // This is a CSRF defense for BROWSER WebSocket upgrades — NOT an
  // authentication layer (see server-refactor.prompt.md §13 for the auth
  // attach-point). Browsers always send an Origin header on ws upgrades, so a
  // blanket `if (origin) return false` here would reject every browser client
  // and the web UI could never connect. Instead we ALLOW same-origin browser
  // upgrades (localhost bypass + hostname/port matching) and only reject
  // genuinely cross-origin ones. Non-browser clients (CLI/TUI via Bun's
  // WebSocket) send no Origin header and pass through unconditionally.

  // Determine if the connection is from localhost
  const isLocalhost =
    host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('::1') || host.startsWith('[::1]');

  // If an Origin header is present AND the connection is NOT from localhost,
  // parse the Origin URL and validate it.
  if (origin && !isLocalhost) {
    try {
      const originUrl = new URL(origin);

      // Non-HTTP scheme Origins (e.g. capacitor://, file://, ionic://) are
      // allowed because mobile browsers and Capacitor apps send origins with
      // app-specific schemes. These are safe same-app connections.
      if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
        return true;
      }

      // Use only the actual Host header — do not trust client-controlled
      // X-Forwarded-Host, which an attacker can spoof to bypass Origin checks.
      const targetHost = host;

      // Extract hostname and port from the target host string.
      const targetParts = targetHost.split(':');
      const targetHostname = targetParts[0]?.toLowerCase() || '';
      const targetPort = targetParts.length > 1 ? targetParts.slice(1).join(':') : '';

      // Hostnames are compared case-insensitively per RFC 3986. The URL
      // constructor already lowercases `originUrl.hostname`.
      if (originUrl.hostname.toLowerCase() !== targetHostname) {
        return false;
      }

      // Ports are only compared when both Origin and Host explicitly carry
      // one. If either side omits the port (defaulting to the scheme's
      // well-known port), the check is skipped to avoid false negatives.
      const originPort = originUrl.port;
      if (originPort && targetPort && originPort !== targetPort) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  return true;
}
