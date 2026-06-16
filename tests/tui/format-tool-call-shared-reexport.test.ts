// ─── Move verification: format-tool-call → @engin/shared/format-tool-call ────
//
// After the refactor, `format-tool-call.ts` physically lives in
// packages/shared/src/format-tool-call.ts and is consumed via the bare specifier
// `@engin/shared/format-tool-call`. The OLD path src/tui/format-tool-call.ts is
// kept as a backward-compat shim that re-exports `formatToolCall` from the
// shared package. All existing consumers (src/tui/components/agent-log-widget,
// src/tui/status-callbacks, web/src/utils/format-entry, plus the existing
// tests/tui/format-tool-call.test.ts) keep working unchanged via the shim.
//
// This file has ZERO imports — it is a pure function — so the move is a literal
// relocation with no import-path rewiring inside the module itself.
//
// This suite proves the move is behaviour-preserving by:
//
//   1. Importing formatToolCall directly from @engin/shared/format-tool-call and
//      asserting it is present and well-shaped (the "new canonical home").
//   2. Importing formatToolCall from the OLD shim path and asserting it is the
//      IDENTICAL runtime binding (===) — proving the shim is a true re-export,
//      not a re-declaration.
//   3. A behaviour smoke-test: feeding representative tool calls through the
//      shared-package formatToolCall and asserting the formatted output.
//   4. Confirming the module-private helpers (truncateWithEllipsis,
//      MAX_COMMAND_DISPLAY, MAX_ARGS_DISPLAY) remain unexported by both the
//      shared module and the shim.

import { describe, expect, it } from 'bun:test';

// ── NEW canonical home: shared package ──────────────────────────────────────
import { formatToolCall } from '@engin/shared/format-tool-call';

// ── OLD backward-compat shim path ───────────────────────────────────────────
import { formatToolCall as shimFormatToolCall } from '../../packages/tui/src/format-tool-call.js';

// ── Type-level exact-equality utility (mirrors tests/tracking/evolve-shared-reexport.test.ts)

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// The shim's formatToolCall signature must match the shared module's.
assertEqual<Equal<typeof shimFormatToolCall, typeof formatToolCall>>(
  'shim formatToolCall signature === shared formatToolCall signature',
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('@engin/shared/format-tool-call — canonical exports', () => {
  it('exports formatToolCall as a function', () => {
    expect(typeof formatToolCall).toBe('function');
  });

  it('formats a basic read tool call', () => {
    expect(formatToolCall('read', { path: 'src/index.ts' })).toBe('📖 read → src/index.ts');
  });

  it('formats read with offset and limit', () => {
    expect(formatToolCall('read', { path: 'src/index.ts', offset: 10, limit: 50 })).toBe(
      '📖 read → src/index.ts:10+50',
    );
  });

  it('formats write with a line count', () => {
    expect(formatToolCall('write', { path: 'a.ts', content: 'line1\nline2\nline3' })).toBe('📝 write → a.ts +3');
  });

  it('truncates long bash commands to 60 chars + ellipsis', () => {
    const result = formatToolCall('bash', { command: 'a'.repeat(70) });
    expect(result).toBe('💻 bash → ' + 'a'.repeat(60) + '…');
  });

  it('falls back to a generic shape for unknown tools with args', () => {
    const result = formatToolCall('mystery', { key: 'value' });
    expect(result).toContain('🔧 mystery →');
  });
});

describe('src/tui/format-tool-call shim — re-exports from @engin/shared/format-tool-call', () => {
  it('re-exports the SAME formatToolCall binding (identity)', () => {
    // === proves the shim does `export { formatToolCall } from '@engin/shared/format-tool-call'`
    // rather than re-declaring its own copy.
    expect(shimFormatToolCall).toBe(formatToolCall);
  });

  it('shim formatToolCall produces the same output as shared formatToolCall', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['read', { path: 'src/foo.ts', offset: 5, limit: 10 }],
      ['write', { path: 'b.ts', content: 'x\ny' }],
      ['bash', { command: 'echo hi' }],
      ['grep', { pattern: 'TODO', path: 'src/' }],
      ['ls', { path: '.' }],
      ['unknown-tool', { a: 1 }],
    ];
    for (const [name, args] of cases) {
      expect(shimFormatToolCall(name, args)).toBe(formatToolCall(name, args));
    }
  });
});

describe('export surface — only public symbols are exported', () => {
  it('the shared module exports only formatToolCall (internal helpers stay private)', async () => {
    // truncateWithEllipsis, MAX_COMMAND_DISPLAY, MAX_ARGS_DISPLAY are
    // module-private and must remain so.
    const mod = (await import('@engin/shared/format-tool-call')) as Record<string, unknown>;
    expect(mod.formatToolCall).toBe(formatToolCall);
    expect(mod.truncateWithEllipsis).toBeUndefined();
    expect(mod.MAX_COMMAND_DISPLAY).toBeUndefined();
    expect(mod.MAX_ARGS_DISPLAY).toBeUndefined();
  });

  it('the shim exports only formatToolCall (internal helpers stay private)', async () => {
    const mod = (await import('../../packages/tui/src/format-tool-call.js')) as Record<string, unknown>;
    expect(mod.formatToolCall).toBe(formatToolCall);
    expect(mod.truncateWithEllipsis).toBeUndefined();
    expect(mod.MAX_COMMAND_DISPLAY).toBeUndefined();
    expect(mod.MAX_ARGS_DISPLAY).toBeUndefined();
  });
});
