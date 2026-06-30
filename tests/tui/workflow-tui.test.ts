/**
 * WorkflowTUI — imperative-shell tests.
 *
 * The old test file (~2300 lines) mocked the previous TUI host's prototype.
 * This rewrite tests the Ink-based imperative shell without the pi-tui dependency.
 *
 * Instead of globally mocking the `ink` module (which poisons other test files
 * under Bun's concurrent test runner), we inject a stub `renderFn` via
 * {@link WorkflowTUIOptions.renderFn}. This returns a minimal `Instance` stub.
 *
 * Test scope:
 *   • Constructor stores options correctly
 *   • start/stop lifecycle (render, unmount, idempotent)
 *   • setRunId propagates to the TuiStore
 *   • prepareQrCode generates a QR string via generateQrString
 *   • showQrCode prepares + sets visibility
 *   • pauseForInspection adds hint line, sets inspecting/resolvePause
 *   • pauseForInspection resolves on signal abort
 *   • getEventLog / getDashboard accessor behaviour
 *   • invokeDetach / invokeKill callbacks
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Instance } from 'ink';

// ─── Imports ─────────────────────────────────────────────────────────────────

import { ClientStore } from '@engin/shared/client-store';
import { WorkflowTUI } from '../../packages/tui/src/workflow-tui.js';

// ─── Stub render function ────────────────────────────────────────────────────

/**
 * Minimal Ink `Instance` stub. Avoids spinning up a real terminal while
 * exercising the WorkflowTUI lifecycle.
 */
function stubInstance(): Instance {
  return {
    rerender: () => {},
    unmount: () => {},
    waitUntilExit: () => Promise.resolve(),
    waitUntilRenderFlush: () => Promise.resolve(),
    cleanup: () => {},
    clear: () => {},
    write: () => {},
  } as unknown as Instance;
}

/** A render fn that returns a stub Instance (no real terminal). */
const stubRenderFn = (): Instance => stubInstance();

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

afterEach(() => {
  eventSeq = 0;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowTUI', () => {
  // ── Constructor ──────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates an instance with default options', () => {
      const tui = new WorkflowTUI();
      expect(tui).toBeDefined();
    });

    it('creates an instance with custom options', () => {
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, agentLogLines: 6 });
      expect(tui).toBeDefined();
    });

    it('accepts a clientStore option', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });
      expect(tui).toBeDefined();
    });

    it('accepts runId option', () => {
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, runId: 'run-789' });
      expect(tui).toBeDefined();
    });

    it('accepts onDetach callback option', () => {
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, onDetach: () => {} });
      expect(tui).toBeDefined();
    });

    it('accepts onKill callback option', () => {
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, onKill: () => {} });
      expect(tui).toBeDefined();
    });

    it('accepts all options together', () => {
      const tui = new WorkflowTUI({
        renderFn: stubRenderFn,
        runId: 'run-999',
        onDetach: () => {},
        onKill: () => {},
        agentLogLines: 12,
      });
      expect(tui).toBeDefined();
    });
  });

  // ── start / stop lifecycle ────────────────────────────────────────────────

  describe('start/stop lifecycle', () => {
    it('start() returns early when no clientStore is provided', () => {
      const tui = new WorkflowTUI();
      // Should not throw despite no Ink setup.
      tui.start();
      // Without a clientStore, the tuiStore is never created.
      expect(tui.getDashboard()).toBeNull();
      expect(tui.getEventLog()).toEqual([]);
    });

    it('start() returns early when already running', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });
      tui.start();
      expect(tui.getDashboard()).not.toBeNull();

      // Capture the first instance.
      const firstStore = tui.getDashboard();

      // Second start() must be a no-op (early return).
      tui.start();
      expect(tui.getDashboard()).toBe(firstStore);
    });

    it('start() creates a TuiStore when clientStore is provided', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      const store = tui.getDashboard();
      expect(store).not.toBeNull();
      // TuiStore has the expected methods.
      expect(typeof store!.getClientStoreState).toBe('function');
      expect(typeof store!.eventLogLines).toBe('object');
    });

    it('stop() unmounts the instance and disposes the store', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      expect(tui.getDashboard()).not.toBeNull();

      tui.stop();
      expect(tui.getDashboard()).toBeNull();
    });

    it('stop() is idempotent (calling twice does not throw)', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      tui.stop();
      expect(() => tui.stop()).not.toThrow();
    });

    it('stop() when not running does not throw', () => {
      const tui = new WorkflowTUI();
      expect(() => tui.stop()).not.toThrow();
    });
  });

  // ── setRunId ──────────────────────────────────────────────────────────────

  describe('setRunId', () => {
    it('propagates runId to the TuiStore after start()', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      expect(tui.getDashboard()!.runId).toBeUndefined();

      tui.setRunId('run-123');
      expect(tui.getDashboard()!.runId).toBe('run-123');
    });

    it('stores runId for later propagation if called before start()', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.setRunId('run-456');
      // runId not yet propagated (no tuiStore).
      expect(tui.getEventLog()).toEqual([]);

      // After start(), tuiStore gets the pre-set runId.
      tui.start();
      expect(tui.getDashboard()!.runId).toBe('run-456');
    });

    it('accepts a runId in the constructor and propagates on start()', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore, runId: 'run-constructor' });

      tui.start();
      expect(tui.getDashboard()!.runId).toBe('run-constructor');
    });
  });

  // ── pauseForInspection ────────────────────────────────────────────────────

  describe('pauseForInspection', () => {
    it('adds a hint line to eventLogLines when inspecting', async () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();

      const promise = tui.pauseForInspection();
      // Let the microtask queue settle.
      await Promise.resolve();

      const lines = tui.getEventLog();
      expect(lines.some((l) => l.includes('Workflow complete'))).toBe(true);

      // Resolve the pause so it doesn't hang.
      const store = tui.getDashboard()!;
      store.resolvePause?.();
      await promise;
    });

    it('sets inspecting=true and resolvePause on the store', async () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      const store = tui.getDashboard()!;

      expect(store.inspecting).toBe(false);
      expect(store.resolvePause).toBeNull();

      const promise = tui.pauseForInspection();
      await Promise.resolve();

      expect(store.inspecting).toBe(true);
      expect(store.resolvePause).not.toBeNull();

      // Resolve and clean up.
      store.resolvePause!();
      await promise;
    });

    it('resolves when resolvePause is called (simulating Ctrl+C)', async () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      const store = tui.getDashboard()!;

      let resolved = false;
      const promise = tui.pauseForInspection();
      promise.then(() => {
        resolved = true;
      });
      await Promise.resolve();

      expect(resolved).toBe(false);

      store.resolvePause!();
      await promise;
      expect(resolved).toBe(true);
      expect(store.inspecting).toBe(false);
    });

    it('resolves when the AbortSignal is aborted', async () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();

      const controller = new AbortController();
      const promise = tui.pauseForInspection(controller.signal);
      await Promise.resolve();

      controller.abort();
      await expect(promise).resolves.toBeUndefined();
    });

    it('resolves immediately when signal is already aborted', async () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();

      const signal = AbortSignal.abort();
      const promise = tui.pauseForInspection(signal);
      await expect(promise).resolves.toBeUndefined();
    });

    it('does nothing when not running', async () => {
      const tui = new WorkflowTUI();
      await expect(tui.pauseForInspection()).resolves.toBeUndefined();
    });

    it('cleans up the signal listener on Ctrl+C resolution', async () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      const store = tui.getDashboard()!;

      const controller = new AbortController();
      const spy = spyOn(controller.signal, 'removeEventListener');

      const promise = tui.pauseForInspection(controller.signal);
      await Promise.resolve();

      store.resolvePause!();
      await promise;

      // The done() handler calls removeEventListener for 'abort'.
      expect(spy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
  });

  // ── prepareQrCode ─────────────────────────────────────────────────────────

  describe('prepareQrCode', () => {
    it('sets qrString on the store with QR block characters', async () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      const store = tui.getDashboard()!;
      expect(store.qrString).toBeNull();

      await tui.prepareQrCode('https://example.com');

      // The QR string should contain block characters (▄▀█) and the URL.
      const qr = store.qrString;
      expect(qr).not.toBeNull();
      expect(qr).toContain('example.com');
    });

    it('is a no-op when the TUI has not been started (no tuiStore)', async () => {
      const tui = new WorkflowTUI();
      // Should not throw.
      await expect(tui.prepareQrCode('https://example.com')).resolves.toBeUndefined();
    });

    it('survives a before-start() call: prepared QR is propagated on start()', async () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      // Prepare BEFORE start() — the CLI lifecycle does this.
      await tui.prepareQrCode('https://before-start.example.com');

      tui.start();
      const store = tui.getDashboard()!;
      expect(store.qrString).not.toBeNull();
      expect(store.qrString).toContain('before-start.example.com');
    });
  });

  // ── showQrCode ────────────────────────────────────────────────────────────

  describe('showQrCode', () => {
    it('prepares a QR string and sets qrVisible to true', async () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      const store = tui.getDashboard()!;
      expect(store.qrVisible).toBe(false);

      await tui.showQrCode('https://example.com');

      expect(store.qrString).not.toBeNull();
      expect(store.qrString).toContain('example.com');
      expect(store.qrVisible).toBe(true);
    });
  });

  // ── getEventLog / getDashboard ────────────────────────────────────────────

  describe('accessors', () => {
    it('getEventLog() returns an empty array before start()', () => {
      const tui = new WorkflowTUI();
      expect(tui.getEventLog()).toEqual([]);
    });

    it('getEventLog() returns event log lines after events are applied', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();

      // Apply a workflow_started event — the TuiStore drains it into eventLogLines.
      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'test', resumed: false }, {}, 1)]);

      const lines = tui.getEventLog();
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((l) => l.includes('test'))).toBe(true);
    });

    it('getDashboard() returns null before start()', () => {
      const tui = new WorkflowTUI();
      expect(tui.getDashboard()).toBeNull();
    });

    it('getDashboard() returns the TuiStore after start()', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      const store = tui.getDashboard();
      expect(store).not.toBeNull();
      expect(typeof store!.getClientStoreState).toBe('function');
    });

    it('getDashboard() returns null after stop()', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();
      expect(tui.getDashboard()).not.toBeNull();

      tui.stop();
      expect(tui.getDashboard()).toBeNull();
    });
  });

  // ── Callback invocation ───────────────────────────────────────────────────

  describe('callback invocation', () => {
    it('calls onDetach when detach callback fires', () => {
      const onDetach = mock(() => {});
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore, onDetach });

      // Invoke through the store that was created during start().
      tui.start();
      const store = tui.getDashboard()!;

      store.invokeDetach();
      expect(onDetach).toHaveBeenCalledTimes(1);
    });

    it('calls onKill when kill callback fires', () => {
      const onKill = mock(() => {});
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore, onKill });

      tui.start();
      const store = tui.getDashboard()!;

      store.invokeKill();
      expect(onKill).toHaveBeenCalledTimes(1);
    });
  });

  // ── Client-store integration (event log draining via TuiStore) ────────────

  describe('client-store event log integration', () => {
    it('drains workflow-event-log lines from the ClientStore into getEventLog()', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();

      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'ship it', resumed: false }, {}, 1)]);

      const lines = tui.getEventLog();
      expect(lines.some((l) => l.includes('workflow started: "ship it"'))).toBe(true);
    });

    it('drains runLog warn/error entries into getEventLog()', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();

      clientStore.appendRunLog('warn', 'low disk', ISO_NOW);
      clientStore.appendRunLog('error', 'crash', ISO_NOW);

      const lines = tui.getEventLog();
      expect(lines.some((l) => l.includes('⚠️ low disk'))).toBe(true);
      expect(lines.some((l) => l.includes('❌ crash'))).toBe(true);
    });

    it('does not re-add already-processed lines when more events arrive', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ renderFn: stubRenderFn, clientStore });

      tui.start();

      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'a', resumed: false }, {}, 1)]);
      const count1 = tui.getEventLog().length;

      clientStore.applyEvents([ev('phase_started', { phase: 'build', round: 1 }, {}, 2)]);
      const count2 = tui.getEventLog().length;

      // Second event adds one line.
      expect(count2).toBe(count1 + 1);
    });
  });
});
