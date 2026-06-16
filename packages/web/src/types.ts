/**
 * Backward-compat re-exports.
 * Canonical types live in protocol-types.ts.
 * This file will be deleted once all importers migrate (kb-17).
 */

// ─── Re-export protocol types for existing importers ────────────────────────

export { isServerMessage } from './protocol-types';
export type { ClientMessage, ServerMessage } from './protocol-types';
