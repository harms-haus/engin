// Backward-compat shim. The canonical home for these types is now
// packages/shared/src/event-types.ts, consumed via the bare specifier
// `@engin/shared/event-types`. This file re-exports EVERYTHING from the shared
// package so that all existing consumers (src/index.ts barrel, TUI components,
// web/status-bridge, etc.) keep compiling unchanged.
export * from '@engin/shared/event-types';
