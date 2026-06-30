/**
 * createWsBackedTui — thin compat wrapper tests.
 *
 * The old `ws-backed-tui.ts` was a full adapter that subscribed to a ClientStore,
 * drained event/runLog entries, and synced the dashboard. That logic now lives
 * in `TuiStore` (which subscribes to ClientStore in its constructor).
 *
 * The new `createWsBackedTui` is a thin compatibility wrapper:
 *
 *   export function createWsBackedTui(deps: {
 *     clientStore: ClientStore;
 *     tuiStore: TuiStore;
 *   }): { dispose: () => void }
 *
 * It simply forwards `dispose()` to the TuiStore. All event-draining, runLog
 * processing, and dashboard syncing is handled by TuiStore itself.
 *
 * This test verifies:
 *   1. The wrapper returns a `{ dispose }` handle.
 *   2. Calling dispose() calls through to TuiStore.dispose().
 *   3. TuiStore still drains ClientStore events/runLog into eventLogLines.
 *   4. After dispose, the TuiStore no longer processes events.
 */

import { describe, expect, it } from 'bun:test';

import { ClientStore } from '@engin/shared/client-store';
import { TuiStore } from '../../packages/tui/src/tui-store.js';
import { createWsBackedTui } from '../../packages/tui/src/ws-backed-tui.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const ISO_NOW = '2026-06-15T00:00:00.000Z';

let eventSeq = 0;

function ev(
  type: string,
  data: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
  seqOverride?: number,
) {
  const s = seqOverride ?? ++eventSeq;
  return { seq: s, type, data, metadata: { timestamp: ISO_NOW, ...meta } };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createWsBackedTui', () => {
  // ── Wrapper lifecycle ────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('returns a { dispose } handle', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      const handle = createWsBackedTui({ clientStore, tuiStore });
      expect(handle).toBeDefined();
      expect(typeof handle.dispose).toBe('function');
    });

    it('calling dispose() disposes the TuiStore (unsubscribes from ClientStore)', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);

      // Before dispose: events are processed.
      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'test', resumed: false }, {}, 1)]);
      expect(tuiStore.eventLogLines.length).toBeGreaterThan(0);

      const handle = createWsBackedTui({ clientStore, tuiStore });

      // After dispose: new events must NOT be processed.
      handle.dispose();
      const before = tuiStore.eventLogLines.length;
      clientStore.applyEvents([ev('phase_started', { phase: 'build', round: 1 }, {}, 2)]);
      expect(tuiStore.eventLogLines.length).toBe(before);
    });

    it('dispose can be called multiple times without throwing', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      const handle = createWsBackedTui({ clientStore, tuiStore });

      expect(() => {
        handle.dispose();
        handle.dispose();
      }).not.toThrow();
    });
  });

  // ── Event log draining (via TuiStore, not the wrapper) ────────────────────
  //
  // These tests verify that TuiStore (which createWsBackedTui wraps) correctly
  // drains ClientStore events. They validate the integration even though the
  // wrapper itself is trivial.

  describe('event log draining (via TuiStore)', () => {
    it('drains workflow_event_log entries into eventLogLines on construction', () => {
      const clientStore = new ClientStore();
      // Seed events BEFORE creating TuiStore (replay scenario).
      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'replay', resumed: false }, {}, 1)]);

      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      expect(tuiStore.eventLogLines.length).toBeGreaterThan(0);
      expect(tuiStore.eventLogLines.some((l) => l.includes('replay'))).toBe(true);
    });

    it('drains workflow_event_log entries applied after construction', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      clientStore.applyEvents([ev('phase_started', { phase: 'scouting', round: 1 }, {}, 1)]);

      expect(tuiStore.eventLogLines.some((l) => l.includes('scouting'))).toBe(true);
    });

    it('does not duplicate event-log lines across multiple applyEvents batches', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'a', resumed: false }, {}, 1)]);
      const count1 = tuiStore.eventLogLines.length;

      clientStore.applyEvents([ev('phase_started', { phase: 'build', round: 1 }, {}, 2)]);
      const count2 = tuiStore.eventLogLines.length;

      // Second batch adds exactly one new line (no duplication).
      expect(count2).toBe(count1 + 1);
    });
  });

  // ── runLog handling ──────────────────────────────────────────────────────

  describe('runLog handling', () => {
    it('appends a "⚠️ "-prefixed line for warn entries', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      clientStore.appendRunLog('warn', 'low memory', ISO_NOW);

      expect(tuiStore.eventLogLines.some((l) => l.includes('⚠️ low memory'))).toBe(true);
    });

    it('appends a "❌ "-prefixed line for error entries', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      clientStore.appendRunLog('error', 'kaboom', ISO_NOW);

      expect(tuiStore.eventLogLines.some((l) => l.includes('❌ kaboom'))).toBe(true);
    });

    it('does NOT append a line for info entries', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      clientStore.appendRunLog('info', 'starting build', ISO_NOW);

      expect(tuiStore.eventLogLines.every((l) => !l.includes('starting build'))).toBe(true);
    });

    it('preserves order across mixed-level runLog entries', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      clientStore.appendRunLog('warn', 'first', ISO_NOW);
      clientStore.appendRunLog('info', 'middle', ISO_NOW);
      clientStore.appendRunLog('error', 'last', ISO_NOW);

      const warnIdx = tuiStore.eventLogLines.findIndex((l) => l.includes('⚠️ first'));
      const errorIdx = tuiStore.eventLogLines.findIndex((l) => l.includes('❌ last'));
      expect(warnIdx).toBeLessThan(errorIdx);
    });

    it('coexists with workflow event-log lines', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'test', resumed: false }, {}, 1)]);
      clientStore.appendRunLog('warn', 'careful', ISO_NOW);

      expect(tuiStore.eventLogLines.some((l) => l.includes('workflow started: "test"'))).toBe(true);
      expect(tuiStore.eventLogLines.some((l) => l.includes('⚠️ careful'))).toBe(true);
    });

    it('drains pre-existing runLog entries on TuiStore construction', () => {
      const clientStore = new ClientStore();
      // Append a warn BEFORE creating TuiStore.
      clientStore.appendRunLog('warn', 'preexisting', ISO_NOW);

      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      expect(tuiStore.eventLogLines.some((l) => l.includes('⚠️ preexisting'))).toBe(true);

      // A subsequent append must add a new line without duplication.
      clientStore.appendRunLog('error', 'new', ISO_NOW);
      expect(tuiStore.eventLogLines.some((l) => l.includes('❌ new'))).toBe(true);
    });
  });

  // ── Event log capping ────────────────────────────────────────────────────

  describe('event log capping (TuiStore MAX_EVENT_LOG_LINES)', () => {
    it('caps event log lines at 10 000', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      createWsBackedTui({ clientStore, tuiStore });

      // Push 10 001 lines via custom addEventLogLine (which TuiStore also caps).
      for (let i = 0; i < 10_001; i++) {
        tuiStore.addEventLogLine(`line ${i}`);
      }

      expect(tuiStore.eventLogLines.length).toBe(10_000);
      // The oldest line should be dropped.
      expect(tuiStore.eventLogLines[0]).toBe('line 1');
    });
  });

  // ── Dashboard sync is NOT done by the wrapper ────────────────────────────
  //
  // The old createWsBackedTui synced the dashboard on every notification.
  // The new TuiStore does NOT sync a Dashboard component — it only holds
  // event-log lines and UI state. Dashboard syncing is handled by the Ink
  // App component reading from TuiStore. There is no `syncFromProjection`
  // call in the new TuiStore.

  describe('no dashboard sync (responsibility moved to App/React)', () => {
    it('does not require a Dashboard dependency (the wrapper takes only ClientStore + TuiStore)', () => {
      const clientStore = new ClientStore();
      const tuiStore = new TuiStore(clientStore);
      // No Dashboard or EventLog or requestRender parameters needed.
      const handle = createWsBackedTui({ clientStore, tuiStore });
      expect(handle).toBeDefined();
      expect(typeof handle.dispose).toBe('function');
    });
  });
});
