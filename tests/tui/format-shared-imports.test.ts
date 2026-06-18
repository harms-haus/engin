/**
 * Migration verification: the TUI package no longer ships backward-compat
 * re-export shims for the shared format utilities.
 *
 * `formatToolCall` and `formatWorkflowEventLine` now live canonically in
 * `@engin/shared` (consumed via the bare subpath specifiers
 * `@engin/shared/format-tool-call` and `@engin/shared/format-workflow-event`).
 * The TUI package previously kept two backward-compat shim files
 * (`src/format-tool-call.ts`, `src/format-workflow-event.ts`) and re-exported
 * `formatToolCall` through its barrel (`src/index.ts`).
 *
 * This refactor DELETES those shims and removes the barrel re-exports so the
 * TUI package no longer leaks shared-package format utilities; consumers must
 * import them from `@engin/shared` directly.
 *
 * The behavioural suites (`format-tool-call.test.ts`,
 * `format-workflow-event.test.ts`) prove the shared functions still work. But
 * because the shims re-exported the shared bindings *unchanged*, those suites
 * cannot detect a "shim still present" / "barrel still leaking" regression.
 *
 * This file pins the deletion directly. These assertions are intentionally RED
 * until the source deletion lands and GREEN thereafter, giving a clear go/no-go
 * signal for the refactor step.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tuiSrc = join(here, '..', '..', 'packages', 'tui', 'src');

/** Read a TUI source file located relative to packages/tui/src. */
function readSrc(rel: string): string {
  return readFileSync(join(tuiSrc, rel), 'utf8');
}

/** True when a TUI source file exists (relative to packages/tui/src). */
function srcExists(rel: string): boolean {
  return existsSync(join(tuiSrc, rel));
}

// ─── Shim files are deleted ──────────────────────────────────────────────────

describe('TUI format shims — deleted', () => {
  it('src/format-tool-call.ts no longer exists', () => {
    expect(srcExists('format-tool-call.ts')).toBe(false);
  });

  it('src/format-workflow-event.ts no longer exists', () => {
    expect(srcExists('format-workflow-event.ts')).toBe(false);
  });
});

// ─── Barrel (src/index.ts) no longer re-exports the format utilities ─────────

describe('TUI barrel (src/index.ts) — does not leak shared format utilities', () => {
  const barrel = () => readSrc('index.ts');

  it('does not re-export ./format-tool-call.js', () => {
    expect(barrel()).not.toContain("from './format-tool-call.js'");
  });

  it('does not re-export ./format-workflow-event.js', () => {
    expect(barrel()).not.toContain("from './format-workflow-event.js'");
  });

  it('does not mention formatToolCall at all (no named/wildcard re-export)', () => {
    expect(barrel()).not.toContain('formatToolCall');
  });

  it('does not mention formatWorkflowEventLine at all (no named/wildcard re-export)', () => {
    expect(barrel()).not.toContain('formatWorkflowEventLine');
  });

  it('still re-exports its own public surface (components, theme, WorkflowTUI, createWsBackedTui)', () => {
    const src = barrel();
    expect(src).toContain("from './components/index.js'");
    expect(src).toContain("from './theme.js'");
    expect(src).toContain('WorkflowTUI');
    expect(src).toContain('createWsBackedTui');
  });
});

// ─── Runtime leak check: importing the TUI barrel must not expose them ───────

describe('TUI barrel runtime namespace — does not expose shared format utilities', () => {
  it('does not export formatToolCall at runtime', async () => {
    const tui = (await import('../../packages/tui/src/index.js')) as Record<string, unknown>;
    expect(tui.formatToolCall).toBeUndefined();
  });

  it('does not export formatWorkflowEventLine at runtime', async () => {
    const tui = (await import('../../packages/tui/src/index.js')) as Record<string, unknown>;
    expect(tui.formatWorkflowEventLine).toBeUndefined();
  });
});

// ─── Consumers source the format utilities from @engin/shared directly ───────

describe('TUI components — source format utilities from @engin/shared directly', () => {
  const agentLogWidget = () => readSrc('components/agent-log-widget.ts');

  it('agent-log-widget imports formatToolCall from @engin/shared/format-tool-call', () => {
    expect(agentLogWidget()).toContain("from '@engin/shared/format-tool-call'");
  });

  it('agent-log-widget no longer imports from the deleted ../format-tool-call.js shim', () => {
    expect(agentLogWidget()).not.toContain("from '../format-tool-call.js'");
  });
});
