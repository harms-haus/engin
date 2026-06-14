/**
 * WebSocket protocol types for the engin web interface.
 *
 * Single source of truth lives in the engine (`src/web/protocol-types.ts`).
 * This file re-exports it so the web app imports protocol types the same way
 * the engine does, with no manual mirror to keep in sync.
 *
 * The `@engin` alias is configured in vite.config.ts / vitest.config.ts /
 * tsconfig.json (resolves to the repo's `src/` directory).
 */

export * from '@engin/web/protocol-types';
