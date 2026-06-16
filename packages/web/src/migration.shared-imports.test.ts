/**
 * Migration verification: web app sources shared modules from `@engin/shared`.
 *
 * This task migrates four web source files off the legacy bare specifiers
 * (`@engin/tui/*`, `@engin/web/*`, `@engin/tracking/*`) — which now resolve to
 * backward-compat shims — onto the canonical `@engin/shared/*` package. The
 * shared package is the new single source of truth; the shims are scheduled for
 * removal in a later phase of the package split.
 *
 * The behavioural / identity suites (`*.shared-reexport.test.ts`,
 * `format-entry.test.ts`, `workflow-store.format-workflow-event.test.ts`) prove
 * the move is behaviour-preserving. However, because the engine-side shims
 * re-export the shared bindings *unchanged*, those suites also PASS before the
 * migration lands — they cannot detect a "forgot to migrate" regression.
 *
 * This file pins the migration directly: it reads each source module's text and
 * asserts the import specifier resolves to `@engin/shared/*` AND that the legacy
 * specifier is gone. These assertions are intentionally RED until the source
 * migration lands and GREEN thereafter, giving a clear go/no-go signal for the
 * migration step.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** Read a web source file located relative to this test file (web/src). */
function readSrc(rel: string): string {
  return readFileSync(join(here, rel), 'utf8');
}

// ─── workflow-store.ts: formatWorkflowEventLine ──────────────────────────────

describe('migration — workflow-store sources formatWorkflowEventLine from @engin/shared', () => {
  const src = () => readSrc('store/workflow-store.ts');

  it("imports formatWorkflowEventLine from '@engin/shared/format-workflow-event'", () => {
    expect(src()).toContain("from '@engin/shared/format-workflow-event'");
  });

  it("no longer imports from the legacy '@engin/tui/format-workflow-event' shim", () => {
    expect(src()).not.toContain("from '@engin/tui/format-workflow-event'");
  });
});

// ─── evolve-client.ts: evolve ─────────────────────────────────────────────────

describe('migration — evolve-client re-exports evolve from @engin/shared', () => {
  const src = () => readSrc('store/evolve-client.ts');

  it("re-exports evolve from '@engin/shared/evolve'", () => {
    expect(src()).toContain("from '@engin/shared/evolve'");
  });

  it("no longer re-exports from the legacy '@engin/tracking/evolve' shim", () => {
    expect(src()).not.toContain("from '@engin/tracking/evolve'");
  });
});

// ─── protocol-types.ts ────────────────────────────────────────────────────────

describe('migration — protocol-types re-exports from @engin/shared', () => {
  const src = () => readSrc('protocol-types.ts');

  it("re-exports from '@engin/shared/protocol-types'", () => {
    expect(src()).toContain("from '@engin/shared/protocol-types'");
  });

  it("no longer re-exports from the legacy '@engin/web/protocol-types' shim", () => {
    expect(src()).not.toContain("from '@engin/web/protocol-types'");
  });
});

// ─── format-entry.ts: formatToolCall ──────────────────────────────────────────

describe('migration — format-entry sources formatToolCall from @engin/shared', () => {
  const src = () => readSrc('utils/format-entry.ts');

  it("imports formatToolCall from '@engin/shared/format-tool-call'", () => {
    expect(src()).toContain("from '@engin/shared/format-tool-call'");
  });

  it("no longer imports from the legacy '@engin/tui/format-tool-call' shim", () => {
    expect(src()).not.toContain("from '@engin/tui/format-tool-call'");
  });
});
