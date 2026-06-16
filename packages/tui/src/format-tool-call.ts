// Backward-compat shim. The canonical home for `formatToolCall` is now
// packages/shared/src/format-tool-call.ts, consumed via the bare specifier
// `@engin/shared/format-tool-call`. This file re-exports the public export so
// that all existing consumers (TUI components, web app, tests) keep working
// unchanged.
export { formatToolCall } from '@engin/shared/format-tool-call';
