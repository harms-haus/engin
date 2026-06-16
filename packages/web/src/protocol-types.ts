/**
 * WebSocket protocol types for the engin web interface.
 *
 * Single source of truth lives in the shared package (`packages/shared/src/protocol-types.ts`).
 * This file re-exports it so the web app imports protocol types from the
 * shared package, with no manual mirror to keep in sync.
 */

export * from '@engin/shared/protocol-types';
