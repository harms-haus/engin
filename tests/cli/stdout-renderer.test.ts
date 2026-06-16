// ────────────────────────────────────────────────────────────────────────────
// stdout-renderer tests — non-TTY event renderer for the CLI.
//
// These tests define the contract for `createStdoutRenderer(deps)` which
// replaces the current `createStatusCallbacks(verbose)` pattern. The renderer
// subscribes to a `ClientStore`, tracks deltas in `workflowEventLog`,
// agent log entries, and `runLog`, and prints formatted lines to stdout.
//
// ── ASSUMED SIGNATURE (implement phase must satisfy) ───────────────────────
//
//   interface StdoutRendererDeps {
//     clientStore: ClientStore;
//     verbose: boolean;
//     formatTime: (date?: Date) => string;
//   }
//
//   function createStdoutRenderer(deps: StdoutRendererDeps): { dispose: () => void };
//
// ── DATA SOURCES ───────────────────────────────────────────────────────────
//
//   1. state.workflowEventLog (WorkflowEventLogEntry[]): lifecycle lines
//      already formatted by `formatWorkflowEventLine`. The renderer prints
//      new entries (delta from last-seen length) with a timestamp prefix.
//
//   2. Agent log deltas (state.agents[key].log): new LogEntry items since
//      last notification. In verbose mode, these are formatted to match the
//      current console-status.ts verbose output (💬/🧠/🔧/✅/❌/📊).
//      In non-verbose mode, agent log entries are IGNORED.
//
//   3. state.runLog (RunLogEntry[]): runtime console output. warn → ⚠️,
//      error → ❌, info → silent.
//
// ── VERBOSE FORMATTING CONTRACT (ported from console-status.ts) ────────────
//
//   Agent log entry type → stdout line:
//     text          → 💬 {content}
//     thinking      → 🧠 {content}
//     tool_call_start → 🔧 {toolName}({JSON args}) (agent: {agentId})
//     tool_call_end   → ✅ Tool result: {toolName} (agent: {agentId})
//                       ❌ Tool error:   {toolName} (agent: {agentId})  [when isError]
//     decision      → 🤝 Decision by {agentId}: {content}  (optional)
//
//   Token delta (agent inputTokens/outputTokens changed):
//     → 📊 Tokens: {deltaIn} in / {deltaOut} out
//
// ── CLIENTSTORE STATE FACTS ────────────────────────────────────────────────
//
//   - ClientStore.subscribe(listener) does NOT call the listener on attach;
//     only on subsequent state mutations (applyEvents, appendRunLog, etc.).
//   - workflowEventLog is a seq-keyed { seq, line }[] array; entries are
//     immutable once added.
//   - Agent log entries are appended by evolve() for: turn_ended (text,
//     thinking), tool_call_started, tool_call_ended, decision, error.
//   - turn_started produces NO log entry (evolve just bumps seq).
//   - runLog entries are { level, message, timestamp }.
//
// ── NOTE: `tests/` is excluded from root tsconfig — must use `bun test`. ──
// ────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

// ── Unit under test (will be RED — module not found) ───────────────────────
import { createStdoutRenderer } from '../../packages/cli/src/cli/stdout-renderer.js';

// ── Dependencies ───────────────────────────────────────────────────────────
import { ClientStore } from '@engin/shared/client-store';
import type { EventRecord, EventType } from '@engin/shared/event-types';
import { MAX_AGENT_LOG } from '@engin/shared/evolve';

// ── Constants ──────────────────────────────────────────────────────────────

const ISO_NOW = '2026-06-15T00:00:00.000Z';
const FIXED_TIMESTAMP = '10:30:45';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Deterministic formatTime for testing — always returns the fixed timestamp. */
function fixedFormatTime(_date?: Date): string {
  return `[${FIXED_TIMESTAMP}]`;
}

let eventSeq = 0;

function resetSeq(): void {
  eventSeq = 0;
}

function ev(
  type: EventType,
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
  seqOverride?: number,
): EventRecord {
  const s = seqOverride ?? ++eventSeq;
  return { seq: s, type, data, metadata: { timestamp: ISO_NOW, ...meta } };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('createStdoutRenderer', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let store: ClientStore;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    store = new ClientStore();
    resetSeq();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ─── Construction ────────────────────────────────────────────────────────

  it('returns an object with a dispose function', () => {
    const { dispose } = createStdoutRenderer({
      clientStore: store,
      verbose: false,
      formatTime: fixedFormatTime,
    });
    expect(typeof dispose).toBe('function');
  });

  // ─── Non-verbose mode ────────────────────────────────────────────────────

  describe('non-verbose mode', () => {
    it('prints lifecycle event lines from workflowEventLog with a timestamp prefix', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([ev('workflow_started', { taskPrompt: 'build feature', resumed: false }, {}, 1)]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toBe(
        `[${FIXED_TIMESTAMP}] 🚀 Workflow started: "build feature" (resumed: false)`,
      );
      dispose();
    });

    it('prints multiple lifecycle events in order', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('phase_started', { phase: 'exec', round: 1 }, {}, 2),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1' }, 3),
        ev('task_started', { taskId: 't1', title: 'Do thing' }, {}, 4),
      ]);

      expect(logSpy).toHaveBeenCalledTimes(4);
      expect(logSpy.mock.calls[0][0]).toContain('🚀');
      expect(logSpy.mock.calls[1][0]).toContain('📦');
      expect(logSpy.mock.calls[2][0]).toContain('⏳');
      expect(logSpy.mock.calls[3][0]).toContain('📋');
      dispose();
    });

    it('suppresses turn/tool_call/decision events (formatWorkflowEventLine returns null)', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      // Seed: spawn an agent so evolve can process tool_call / turn events.
      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      logSpy.mockClear();

      // Push verbose-only events
      store.applyEvents([
        ev('tool_call_started', { toolName: 'read', arguments: { path: '/foo' } }, { agentId: 'a1', taskId: 't1' }, 3),
        ev('tool_call_ended', { toolName: 'read', isError: false }, { agentId: 'a1', taskId: 't1' }, 4),
        ev(
          'turn_ended',
          {
            contentBlocks: [{ type: 'text', text: 'Hello' }],
            tokens: { input: 10, output: 5 },
          },
          { agentId: 'a1', taskId: 't1' },
          5,
        ),
        ev('decision', { decision: 'proceed' }, { agentId: 'a1', taskId: 't1' }, 6),
      ]);

      // None of these produce workflowEventLog lines → no stdout output
      expect(logSpy).not.toHaveBeenCalled();
      dispose();
    });

    it('does not print runLog info entries', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.appendRunLog('info', 'build starting', ISO_NOW);
      expect(logSpy).not.toHaveBeenCalled();
      dispose();
    });
  });

  // ─── Verbose mode ────────────────────────────────────────────────────────

  describe('verbose mode', () => {
    it('still prints lifecycle event lines from workflowEventLog', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([ev('workflow_started', { taskPrompt: 'x' }, {}, 1)]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toContain('🚀');
      dispose();
    });

    it('prints text content from turn_ended as a 💬 line', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      // Seed: workflow + agent spawn
      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      logSpy.mockClear();

      store.applyEvents([
        ev(
          'turn_ended',
          {
            contentBlocks: [{ type: 'text', text: 'Hello world' }],
          },
          { agentId: 'a1', taskId: 't1' },
          3,
        ),
      ]);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const textLine = calls.find((l: string) => l.includes('💬'));
      expect(textLine).toBeDefined();
      expect(textLine).toContain('Hello world');
      expect(textLine).toContain(`[${FIXED_TIMESTAMP}]`);
      dispose();
    });

    it('prints thinking content from turn_ended as a 🧠 line', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      logSpy.mockClear();

      store.applyEvents([
        ev(
          'turn_ended',
          {
            contentBlocks: [{ type: 'thinking', thinking: 'Let me think...' }],
          },
          { agentId: 'a1', taskId: 't1' },
          3,
        ),
      ]);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const thinkLine = calls.find((l: string) => l.includes('🧠'));
      expect(thinkLine).toBeDefined();
      expect(thinkLine).toContain('Let me think...');
      dispose();
    });

    it('prints tool_call_started as a 🔧 line with tool name and arguments', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      logSpy.mockClear();

      store.applyEvents([
        ev(
          'tool_call_started',
          {
            toolName: 'read_file',
            arguments: { path: '/foo.ts' },
          },
          { agentId: 'a1', taskId: 't1' },
          3,
        ),
      ]);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const toolLine = calls.find((l: string) => l.includes('🔧'));
      expect(toolLine).toBeDefined();
      expect(toolLine).toContain('read_file');
      expect(toolLine).toContain('/foo.ts');
      expect(toolLine).toContain('a1');
      dispose();
    });

    it('prints tool_call_ended (success) as ✅ Tool result line', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      logSpy.mockClear();

      store.applyEvents([
        ev('tool_call_ended', { toolName: 'read_file', isError: false }, { agentId: 'a1', taskId: 't1' }, 3),
      ]);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const toolLine = calls.find((l: string) => l.includes('Tool result'));
      expect(toolLine).toBeDefined();
      expect(toolLine).toContain('✅');
      expect(toolLine).toContain('read_file');
      expect(toolLine).toContain('a1');
      dispose();
    });

    it('prints tool_call_ended (error) as ❌ Tool error line', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      logSpy.mockClear();

      store.applyEvents([
        ev('tool_call_ended', { toolName: 'write_file', isError: true }, { agentId: 'a1', taskId: 't1' }, 3),
      ]);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const toolLine = calls.find((l: string) => l.includes('Tool error'));
      expect(toolLine).toBeDefined();
      expect(toolLine).toContain('❌');
      expect(toolLine).toContain('write_file');
      expect(toolLine).toContain('a1');
      dispose();
    });

    it('prints token summary (📊) when agent tokens change', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      logSpy.mockClear();

      store.applyEvents([
        ev(
          'turn_ended',
          {
            tokens: { input: 100, output: 50 },
          },
          { agentId: 'a1', taskId: 't1' },
          3,
        ),
      ]);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const tokenLine = calls.find((l: string) => l.includes('📊'));
      expect(tokenLine).toBeDefined();
      expect(tokenLine).toContain('100 in');
      expect(tokenLine).toContain('50 out');
      dispose();
    });

    it('prints decision events as a 🤝 Decision line', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      logSpy.mockClear();

      store.applyEvents([ev('decision', { decision: 'proceed' }, { agentId: 'a1', taskId: 't1' }, 3)]);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const decisionLine = calls.find((l: string) => l.includes('🤝 Decision'));
      expect(decisionLine).toBeDefined();
      expect(decisionLine).toContain('Decision by a1');
      expect(decisionLine).toContain('proceed');
      dispose();
    });
  });

  // ─── runLog ──────────────────────────────────────────────────────────────

  describe('runLog', () => {
    it('warn entries produce a ⚠️ prefixed line', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.appendRunLog('warn', 'disk space low', ISO_NOW);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const warnLine = calls.find((l: string) => l.includes('⚠️'));
      expect(warnLine).toBeDefined();
      expect(warnLine).toContain('disk space low');
      dispose();
    });

    it('error entries produce a ❌ prefixed line', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.appendRunLog('error', 'connection failed', ISO_NOW);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const errorLine = calls.find((l: string) => l.includes('❌'));
      expect(errorLine).toBeDefined();
      expect(errorLine).toContain('connection failed');
      dispose();
    });

    it('info entries are silent (no output)', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.appendRunLog('info', 'starting build', ISO_NOW);
      expect(logSpy).not.toHaveBeenCalled();
      dispose();
    });

    it('multiple runLog entries are printed in order', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.appendRunLog('warn', 'first', ISO_NOW);
      store.appendRunLog('error', 'second', ISO_NOW);
      store.appendRunLog('info', 'third', ISO_NOW); // silent
      store.appendRunLog('warn', 'fourth', ISO_NOW);

      expect(logSpy).toHaveBeenCalledTimes(3);
      expect(logSpy.mock.calls[0][0]).toContain('first');
      expect(logSpy.mock.calls[1][0]).toContain('second');
      expect(logSpy.mock.calls[2][0]).toContain('fourth');
      dispose();
    });
  });

  // ─── formatTime usage ────────────────────────────────────────────────────

  describe('formatTime', () => {
    it('uses the injected formatTime for the timestamp prefix on lifecycle events', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([ev('workflow_started', { taskPrompt: 'x' }, {}, 1)]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toBe(`[${FIXED_TIMESTAMP}] 🚀 Workflow started: "x" (resumed: false)`);
      dispose();
    });

    it('calls formatTime on each printed line', () => {
      let callCount = 0;
      function countingFormatTime(): string {
        callCount++;
        return `[C${callCount}]`;
      }

      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: countingFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('phase_started', { phase: 'p', round: 1 }, {}, 2),
      ]);

      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(logSpy.mock.calls[0][0]).toBe('[C1] 🚀 Workflow started: "x" (resumed: false)');
      expect(logSpy.mock.calls[1][0]).toBe('[C2] 📦 Phase: p (round 1)');
      dispose();
    });

    it('uses formatTime for runLog warn/error lines', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.appendRunLog('warn', 'check this', ISO_NOW);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toContain(`[${FIXED_TIMESTAMP}]`);
      dispose();
    });
  });

  // ─── dispose ─────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('stops printing lifecycle events after dispose', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([ev('workflow_started', { taskPrompt: 'x' }, {}, 1)]);
      expect(logSpy).toHaveBeenCalledTimes(1);

      dispose();

      // Second event — should NOT produce output
      store.applyEvents([ev('phase_started', { phase: 'exec', round: 1 }, {}, 2)]);
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('stops printing runLog entries after dispose', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.appendRunLog('warn', 'before', ISO_NOW);
      expect(logSpy).toHaveBeenCalledTimes(1);

      dispose();

      store.appendRunLog('error', 'after', ISO_NOW);
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('stops printing verbose agent log entries after dispose', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);
      logSpy.mockClear();

      dispose();

      // Turn event after dispose — should NOT produce verbose output
      store.applyEvents([
        ev(
          'turn_ended',
          {
            contentBlocks: [{ type: 'text', text: 'silenced' }],
          },
          { agentId: 'a1', taskId: 't1' },
          3,
        ),
      ]);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Idempotency / no double-print ──────────────────────────────────────

  describe('no double-printing', () => {
    it('does not re-print already-seen workflowEventLog entries on subsequent notifications', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: false,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([ev('workflow_started', { taskPrompt: 'x' }, {}, 1)]);
      expect(logSpy).toHaveBeenCalledTimes(1);

      // Second unrelated event — only the NEW entry should be printed
      store.applyEvents([ev('phase_started', { phase: 'exec', round: 1 }, {}, 2)]);

      expect(logSpy).toHaveBeenCalledTimes(2);
      // First call is still the workflow_started line (not re-printed)
      expect(logSpy.mock.calls[0][0]).toContain('🚀');
      expect(logSpy.mock.calls[1][0]).toContain('📦');
      dispose();
    });

    it('does not re-print agent log entries on subsequent notifications', () => {
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });

      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
        ev(
          'turn_ended',
          {
            contentBlocks: [{ type: 'text', text: 'first' }],
          },
          { agentId: 'a1', taskId: 't1' },
          3,
        ),
      ]);

      const countAfterFirstBatch = logSpy.mock.calls.length;
      expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('first'))).toBe(true);

      // Second batch — only new content should be printed
      store.applyEvents([
        ev(
          'turn_ended',
          {
            contentBlocks: [{ type: 'text', text: 'second' }],
          },
          { agentId: 'a1', taskId: 't1' },
          4,
        ),
      ]);

      expect(logSpy.mock.calls.length).toBeGreaterThan(countAfterFirstBatch);
      // 'first' should NOT appear in any NEW call
      const newCalls = logSpy.mock.calls.slice(countAfterFirstBatch).map((c: unknown[]) => String(c[0]));
      expect(newCalls.every((l: string) => !l.includes('first'))).toBe(true);
      expect(newCalls.some((l: string) => l.includes('second'))).toBe(true);
      dispose();
    });
  });

  // ─── Agent log cap resync ─────────────────────────────────────────────

  describe('agent log cap resync', () => {
    it('continues printing verbose entries after the MAX_AGENT_LOG cap is hit (id-based resync)', () => {
      // Seed workflow + agent.
      store.applyEvents([
        ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 2),
      ]);

      // Fill the agent's log up to MAX_AGENT_LOG (500) BEFORE creating the
      // renderer, so the renderer snapshots the already-capped state. Each
      // turn_ended with a single text block appends one LogEntry.
      const fillEvents: EventRecord[] = [];
      let seq = 3;
      for (let i = 0; i < MAX_AGENT_LOG; i++) {
        fillEvents.push(
          ev(
            'turn_ended',
            { contentBlocks: [{ type: 'text', text: `fill-${i}` }] },
            { agentId: 'a1', taskId: 't1' },
            seq++,
          ),
        );
      }
      store.applyEvents(fillEvents);

      // Create the renderer AFTER the cap — it records the last-seen log id.
      const { dispose } = createStdoutRenderer({
        clientStore: store,
        verbose: true,
        formatTime: fixedFormatTime,
      });
      logSpy.mockClear();

      // Sanity: the agent log is exactly at the cap.
      const agentKey = Object.keys(store.getState().agents)[0];
      expect(store.getState().agents[agentKey]!.log.length).toBe(MAX_AGENT_LOG);

      // Append one more entry. evolve caps the log (oldest evicted) so
      // log.length stays 500 while content shifts. A length-based watermark
      // would compute Math.min(500, 500) = 500 and skip the new entry entirely
      // (silent output loss). The id-based resync must still surface it.
      store.applyEvents([
        ev('turn_ended', { contentBlocks: [{ type: 'text', text: 'post-cap' }] }, { agentId: 'a1', taskId: 't1' }, seq),
      ]);

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const postCapLine = calls.find((l: string) => l.includes('post-cap'));
      expect(postCapLine).toBeDefined();
      expect(postCapLine).toContain('💬');
      dispose();
    });
  });
});
