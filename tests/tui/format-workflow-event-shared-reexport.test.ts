// ─── Move verification: format-workflow-event → @engin/shared/format-workflow-event ─
//
// After the refactor, `format-workflow-event.ts` physically lives in
// packages/shared/src/format-workflow-event.ts and is consumed via the bare
// specifier `@engin/shared/format-workflow-event`. The OLD path
// src/tui/format-workflow-event.ts is kept as a backward-compat shim that
// re-exports `formatWorkflowEventLine` from the shared package, so all
// existing consumers (src/tui/status-callbacks.ts,
// tests/tui/format-workflow-event.test.ts) keep working unchanged.
//
// CRITICAL constraint of this move: the shared package MUST NOT import from the
// TUI package. The original file imported `stripAnsi` from `./theme.js`; that
// dependency is broken by the move into the shared package. The `stripAnsi`
// helper is therefore INLINED as a private function inside the shared module
// (two regex replacements for ANSI CSI + OSC sequences, gated on the presence
// of the escape character), and the `../tracking/event-types.js` import is
// switched to `./event-types.js` (sibling within the shared package).
//
// This suite proves the move is behaviour-preserving by:
//
//   1. Importing formatWorkflowEventLine directly from
//      @engin/shared/format-workflow-event and asserting it is a function that
//      still formats events correctly (the "new canonical home"), INCLUDING
//      ANSI stripping — which proves stripAnsi was successfully inlined
//      (the shared package cannot resolve ./theme.js, so a working stripAnsi
//      can only exist as an inlined private helper).
//   2. Importing the same export from the OLD shim path and asserting it is the
//      IDENTICAL runtime binding (===) — proving the shim is a true re-export,
//      not a re-declaration.
//   3. Confirming stripAnsi is NOT exported by either the shared module or the
//      shim (it must stay private/inlined) and that no TUI symbols leak.
//   4. Type-level: the EventRecord parameter type of formatWorkflowEventLine is
//      structurally identical to the canonical @engin/shared/event-types
//      EventRecord — i.e. the import was switched from
//      ../tracking/event-types.js to ./event-types.js inside the moved file.

import { describe, expect, it } from 'bun:test';

// ── NEW canonical home: shared package ──────────────────────────────────────
import type { EventRecord } from '@engin/shared/event-types';
import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';

// ── OLD backward-compat shim path ───────────────────────────────────────────
import { formatWorkflowEventLine as shimFormatWorkflowEventLine } from '../../packages/tui/src/format-workflow-event.js';

// ── Type-level exact-equality utility (mirrors tests/core/types.test.ts) ────

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// Compile-time: the shared module's formatWorkflowEventLine parameter type must
// be structurally identical (bidirectionally) to the canonical EventRecord
// exported by @engin/shared/event-types. This guards the import-path switch
// from ../tracking/event-types.js → ./event-types.js inside the moved file.
type EventRecordParam = Parameters<typeof formatWorkflowEventLine>[0];
assertEqual<Equal<EventRecordParam, EventRecord>>(
  'formatWorkflowEventLine param === @engin/shared/event-types EventRecord',
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function ev(
  type: EventRecord['type'],
  data: Record<string, unknown> = {},
  metadata: EventRecord['metadata'] = { timestamp: '2026-06-15T00:00:00Z' },
): EventRecord {
  return { seq: 1, type, data, metadata };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('@engin/shared/format-workflow-event — canonical exports', () => {
  it('exports formatWorkflowEventLine as a function', () => {
    expect(typeof formatWorkflowEventLine).toBe('function');
  });

  it('formats a workflow_started event', () => {
    expect(formatWorkflowEventLine(ev('workflow_started', { taskPrompt: 'ship it', resumed: false }))).toBe(
      '🚀 Workflow started: "ship it" (resumed: false)',
    );
  });

  it('returns null for verbose/silent event types', () => {
    expect(formatWorkflowEventLine(ev('decision', { decision: 'go' }))).toBeNull();
    expect(formatWorkflowEventLine(ev('turn_started', { turn: 1 }))).toBeNull();
    expect(formatWorkflowEventLine(ev('tool_call_ended', { toolName: 'read' }))).toBeNull();
  });

  // ── ANSI stripping proves stripAnsi was successfully inlined ──────────────
  // The shared package cannot resolve ./theme.js, so a working stripAnsi here
  // can ONLY exist as an inlined private helper. These cases mirror the two
  // regex replacements the original theme.stripAnsi performs: CSI sequences
  // (ESC [ ... letter) and OSC sequences (ESC ] ... BEL / ESC \).

  it('strips ANSI CSI escape codes from task_started title', () => {
    const line = formatWorkflowEventLine(ev('task_started', { taskId: 't1', title: '\x1b[1;32mGreen Title\x1b[0m' }));
    expect(line).toBe('📋 Task t1: "Green Title"');
    expect(line).not.toContain('\x1b');
  });

  it('strips ANSI OSC escape codes from error message', () => {
    // OSC sequence terminated by BEL: ESC ] 0 ; bad \x07
    const line = formatWorkflowEventLine(
      ev('error', { error: '\x1b]0;bad\x07broken' }, { timestamp: 't', agentId: 'a1', phaseId: 'p' }),
    );
    expect(line).toBe('⚠️ Error in a1: broken (p)');
    expect(line).not.toContain('\x1b');
  });

  it('strips ANSI OSC escape codes terminated by ESC backslash (ST)', () => {
    // OSC sequence terminated by ST (ESC \): ESC ] 0 ; x \x1b\\
    const line = formatWorkflowEventLine(
      ev('error', { error: '\x1b]0;x\x1b\\fail' }, { timestamp: 't', agentId: 'a1', phaseId: 'p' }),
    );
    expect(line).toBe('⚠️ Error in a1: fail (p)');
    expect(line).not.toContain('\x1b');
  });

  it('strips both CSI and OSC sequences when mixed in one string', () => {
    const line = formatWorkflowEventLine(ev('task_started', { taskId: 't1', title: '\x1b[31mR\x1b[0m\x1b]0;t\x07E' }));
    expect(line).toBe('📋 Task t1: "RE"');
    expect(line).not.toContain('\x1b');
  });

  it('passes through strings without escape char unchanged (fast path)', () => {
    const line = formatWorkflowEventLine(ev('task_started', { taskId: 't1', title: 'plain title' }));
    expect(line).toBe('📋 Task t1: "plain title"');
  });
});

describe('src/tui/format-workflow-event shim — re-exports from @engin/shared/format-workflow-event', () => {
  it('re-exports the SAME formatWorkflowEventLine binding (identity)', () => {
    // === proves the shim does `export ... from '@engin/shared/format-workflow-event'`
    // rather than re-declaring its own copy.
    expect(shimFormatWorkflowEventLine).toBe(formatWorkflowEventLine);
  });

  it('shim behaves identically to the shared module', () => {
    const viaShim = shimFormatWorkflowEventLine(ev('workflow_completed', { totalDurationMs: 2500, agentCount: 2 }));
    const viaShared = formatWorkflowEventLine(ev('workflow_completed', { totalDurationMs: 2500, agentCount: 2 }));
    expect(viaShim).toEqual(viaShared);
    expect(viaShim).toBe('🎉 Complete in 2.5s (2 agents)');
  });

  it('shim preserves ANSI stripping behaviour (inlined helper reachable through shim)', () => {
    const line = shimFormatWorkflowEventLine(ev('task_started', { taskId: 't1', title: '\x1b[32mG\x1b[0m' }));
    expect(line).toBe('📋 Task t1: "G"');
    expect(line).not.toContain('\x1b');
  });
});

describe('export surface — stripAnsi stays private/inlined', () => {
  it('the shared module exports only formatWorkflowEventLine (stripAnsi is NOT exported)', async () => {
    const mod = (await import('@engin/shared/format-workflow-event')) as Record<string, unknown>;
    expect(mod.formatWorkflowEventLine).toBe(formatWorkflowEventLine);
    // stripAnsi must be inlined as a private helper, NOT re-exported.
    expect(mod.stripAnsi).toBeUndefined();
    // No theme/TUI symbols should leak into the shared package module.
    expect(mod.theme).toBeUndefined();
  });

  it('the shim exports only formatWorkflowEventLine (stripAnsi is NOT re-exported)', async () => {
    const mod = (await import('../../packages/tui/src/format-workflow-event.js')) as Record<string, unknown>;
    expect(mod.formatWorkflowEventLine).toBe(formatWorkflowEventLine);
    expect(mod.stripAnsi).toBeUndefined();
  });
});
