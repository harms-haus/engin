// ─── wildcard host guard ────────────────────────────────────────────────────
//
// A single chokepoint that refuses to bind a daemon to a wildcard host.
//
// Wildcard hosts (0.0.0.0, ::, etc.) bind to ALL network interfaces, which
// exposes the server to the local network. Authentication is not yet
// implemented, so binding anything other than a specific interface (e.g.
// 127.0.0.1) is unsafe and must be rejected. See server-refactor.prompt.md §13.
//
// The guard lives here (in src/server/) rather than in the CLI layer so that
// EVERY caller of `startDaemon` — `server up`, `engin run` auto-start, and
// `engin resume` auto-start — is covered by the same check. The CLI
// `serverUpCommand` also keeps a redundant fast-fail (defense in depth).

/** Hosts that bind to all network interfaces. Module-level (not per call). */
export const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '::0', '*']);

/**
 * Returns `true` when `host` is a wildcard host that would bind to all
 * network interfaces.
 *
 * `undefined` and empty string resolve to `false` (they are not wildcard
 * hosts — `startDaemon` substitutes its own `127.0.0.1` default).
 */
export function isWildcardHost(host: string | undefined): boolean {
  return host !== undefined && WILDCARD_HOSTS.has(host);
}
