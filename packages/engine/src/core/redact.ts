// ─── Secret Redaction ────────────────────────────────────────────────────────
//
// Provides `redactSecrets`, a pure function that scrubs common API-key and
// secret patterns from free-text strings before they are emitted into
// events, logs, or broadcasts.

/**
 * Redact common API-key / secret patterns from `text`.
 *
 * Patterns removed or masked:
 * - `Bearer <token>`
 * - `sk-ant-…` (Anthropic)
 * - `sk-…` (generic secret-key)
 * - Key-value assignments where the key name suggests a secret
 *   (`api_key`, `api-key`, `apikey`, `token`, `secret`, `password`,
 *   `authorization`) — the value is replaced with `[REDACTED]` but the
 *   key name is preserved.
 *
 * When the input contains none of these patterns it is returned unchanged.
 */
export function redactSecrets(text: string): string {
  let result = text;

  // Bearer tokens (e.g. "Bearer eyJ...")
  result = result.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');

  // Anthropic key prefix
  result = result.replace(/sk-ant-[A-Za-z0-9-]+/g, 'sk-ant-[REDACTED]');

  // Generic secret-key prefix (10+ hex/alnum chars to avoid over-matching short tokens)
  result = result.replace(/sk-[A-Za-z0-9]{10,}/g, 'sk-[REDACTED]');

  // Key-value assignments with secret-suggesting key names
  result = result.replace(/(api[_-]?key|token|secret|password|authorization)(["\s:=]+)[^\s,"']+/gi, '$1$2[REDACTED]');

  return result;
}
