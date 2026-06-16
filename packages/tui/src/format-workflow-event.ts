// Backward-compat shim. The canonical home for `formatWorkflowEventLine` is now
// packages/shared/src/format-workflow-event.ts, consumed via the bare specifier
// `@engin/shared/format-workflow-event`. This file re-exports the public export
// so that all existing consumers keep working unchanged.
export { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';
