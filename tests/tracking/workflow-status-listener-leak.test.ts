/**
 * @fileoverview Tests for the listener-leak safety net in WorkflowStatusTracker.
 *
 * WorkflowStatusTracker registers three EventEmitter listeners on its
 * TaskTracker (TaskSettled, TaskReady, TaskClaimed) via attachAutoPersist().
 * They are removed in dispose(), but if a caller forgets to dispose() — or an
 * exception short-circuits cleanup — the listeners leak.
 *
 * The safety net under test:
 *  - dispose() is fully idempotent: it must be safe to invoke from any context
 *    (manual call, abort handler, beforeExit hook, or a FinalizationRegistry
 *    callback) which may fire zero, one, or many times and possibly late.
 *  - A process-level / GC safety net ensures cleanup even without an explicit
 *    dispose(), and must not itself leak process listeners or pin the tracker
 *    in memory.
 *  - setMaxListeners is raised on the TaskTracker so the tracker's own
 *    listeners plus downstream consumers (e.g. the lane pool) do not trip a
 *    Node MaxListenersExceededWarning.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { TaskTracker } from '../../packages/engine/src/tracking/task-status.js';
import { WorkflowStatusTracker } from '../../packages/engine/src/tracking/workflow-status.js';
import { makeTask } from '../helpers/make-task.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

const TRACKED_EVENTS = [
  TaskTracker.Events.TaskSettled,
  TaskTracker.Events.TaskReady,
  TaskTracker.Events.TaskClaimed,
] as const;

/** Sum of listenerCount across the three tracked TaskTracker events. */
function totalTrackedListeners(tt: TaskTracker): number {
  return TRACKED_EVENTS.reduce((sum, ev) => sum + tt.listenerCount(ev), 0);
}

/** Installs a process.emitWarning spy that records warnings, returns cleanup. */
function spyOnWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = process.emitWarning;
  process.emitWarning = ((...args: unknown[]) => {
    warnings.push(String(args[0]));
  }) as typeof process.emitWarning;
  return {
    warnings,
    restore: () => {
      process.emitWarning = original;
    },
  };
}

describe('WorkflowStatusTracker listener-leak safety net', () => {
  const { getDir } = useTempDir();
  let dir: string;

  beforeEach(() => {
    dir = getDir();
  });

  // ── dispose() idempotency ──────────────────────────────────────────

  describe('dispose() idempotency', () => {
    it('can be called many times without throwing (no signal)', () => {
      const tracker = new WorkflowStatusTracker(dir);
      expect(() => {
        tracker.dispose();
        tracker.dispose();
        tracker.dispose();
        tracker.dispose();
        tracker.dispose();
      }).not.toThrow();
    });

    it('leaves zero listeners on every tracked event after dispose()', () => {
      const tracker = new WorkflowStatusTracker(dir);
      expect(totalTrackedListeners(tracker.taskTracker)).toBe(3);
      tracker.dispose();
      expect(totalTrackedListeners(tracker.taskTracker)).toBe(0);
      for (const ev of TRACKED_EVENTS) {
        expect(tracker.taskTracker.listenerCount(ev)).toBe(0);
      }
    });

    it('is safe to call dispose() after the abort signal already disposed', () => {
      const ac = new AbortController();
      const tracker = new WorkflowStatusTracker(dir, ac.signal);
      ac.abort();
      expect(() => tracker.dispose()).not.toThrow();
      expect(totalTrackedListeners(tracker.taskTracker)).toBe(0);
    });

    it('is safe to dispose() before the signal aborts (no double-free on abort)', () => {
      const ac = new AbortController();
      const tracker = new WorkflowStatusTracker(dir, ac.signal);
      tracker.dispose();
      expect(() => ac.abort()).not.toThrow();
      expect(totalTrackedListeners(tracker.taskTracker)).toBe(0);
    });

    it('tolerates interleaved dispose() and abort() calls', () => {
      const ac = new AbortController();
      const tracker = new WorkflowStatusTracker(dir, ac.signal);
      tracker.dispose();
      ac.abort();
      tracker.dispose();
      ac.abort(); // already aborted — must remain a no-op
      tracker.dispose();
      expect(totalTrackedListeners(tracker.taskTracker)).toBe(0);
    });
  });

  // ── listener registration accounting ───────────────────────────────

  describe('listener registration accounting', () => {
    it('registers exactly one listener per tracked event (3 total)', () => {
      const tracker = new WorkflowStatusTracker(dir);
      for (const ev of TRACKED_EVENTS) {
        expect(tracker.taskTracker.listenerCount(ev)).toBe(1);
      }
      expect(totalTrackedListeners(tracker.taskTracker)).toBe(3);
      tracker.dispose();
    });

    it('after load(), registers exactly one listener per tracked event on the live tracker', async () => {
      const tracker = new WorkflowStatusTracker(dir);
      tracker.setTaskPrompt('resume');
      tracker.taskTracker.addTask(makeTask({ id: 'a' }));
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      for (const ev of TRACKED_EVENTS) {
        expect(restored.taskTracker.listenerCount(ev)).toBe(1);
      }
      expect(totalTrackedListeners(restored.taskTracker)).toBe(3);
      restored.dispose();
    });

    it('dispose() disables auto-persist so task changes no longer reach disk', async () => {
      const tracker = new WorkflowStatusTracker(dir);
      tracker.taskTracker.addTask(makeTask({ id: 'a' }));
      await tracker.save();

      tracker.dispose();
      tracker.taskTracker.claimTasks(1, 'agent-1');
      tracker.taskTracker.completeTask('a');

      const restored = await WorkflowStatusTracker.load(dir);
      // Listeners were removed, so the completion was never persisted.
      expect(restored.taskTracker.getTask('a')!.status).toBe('ready');
    });
  });

  // ── process-level cleanup hook hygiene ────────────────────────────

  describe('process-level cleanup hook hygiene', () => {
    // Whichever process-level mechanism the safety net uses (beforeExit, exit,
    // or none if it relies solely on FinalizationRegistry), repeatedly creating
    // and disposing trackers must not leak process listeners.
    const PROCESS_HOOKS = ['beforeExit', 'exit'] as const;

    function processHookTotal(): number {
      return PROCESS_HOOKS.reduce((sum, h) => sum + process.listenerCount(h), 0);
    }

    it('dispose() restores beforeExit/exit listener counts to baseline', () => {
      const baseline = processHookTotal();
      const tracker = new WorkflowStatusTracker(dir);
      tracker.dispose();
      expect(processHookTotal()).toBe(baseline);
    });

    it('a create+dispose cycle does not accumulate process listeners', () => {
      const baseline = processHookTotal();
      for (let i = 0; i < 25; i++) {
        const tracker = new WorkflowStatusTracker(dir);
        tracker.dispose();
      }
      expect(processHookTotal()).toBe(baseline);
    });

    it('abort + dispose on a signalled tracker restores process listener baseline', () => {
      const baseline = processHookTotal();
      const ac = new AbortController();
      const tracker = new WorkflowStatusTracker(dir, ac.signal);
      ac.abort();
      tracker.dispose();
      expect(processHookTotal()).toBe(baseline);
    });
  });

  // ── TaskTracker maxListeners safety net ────────────────────────────

  describe('TaskTracker maxListeners safety net', () => {
    it('raises the TaskTracker maxListeners above the Node default', () => {
      const tracker = new WorkflowStatusTracker(dir);
      // EventEmitter.defaultMaxListeners is 10. The safety net should raise the
      // per-instance limit so the tracker's own 3 listeners plus downstream
      // consumers (e.g. lane pool) do not trip MaxListenersExceededWarning.
      expect(EventEmitter.defaultMaxListeners).toBe(10);
      expect(tracker.taskTracker.getMaxListeners()).toBeGreaterThan(EventEmitter.defaultMaxListeners);
      tracker.dispose();
    });

    it('does not emit MaxListenersExceededWarning when exceeding Node default within the raised limit', () => {
      const tracker = new WorkflowStatusTracker(dir);
      const max = tracker.taskTracker.getMaxListeners();
      // Exceed the Node default (10) but stay within the configured limit.
      // Cap the count so the test stays fast even if the limit is large.
      const target = Math.min(max, EventEmitter.defaultMaxListeners + 5);
      expect(target).toBeGreaterThan(EventEmitter.defaultMaxListeners);

      const noop = () => {};
      const spy = spyOnWarnings();
      try {
        const current = tracker.taskTracker.listenerCount(TaskTracker.Events.TaskSettled);
        for (let i = current; i < target; i++) {
          tracker.taskTracker.on(TaskTracker.Events.TaskSettled, noop);
        }
        expect(spy.warnings.some((m) => m.includes('MaxListenersExceededWarning'))).toBe(false);
      } finally {
        spy.restore();
      }
      tracker.dispose();
    });

    it('adding listeners up to the configured max never warns', () => {
      const tracker = new WorkflowStatusTracker(dir);
      const max = tracker.taskTracker.getMaxListeners();
      const noop = () => {};
      const spy = spyOnWarnings();
      try {
        const current = tracker.taskTracker.listenerCount(TaskTracker.Events.TaskReady);
        for (let i = current; i < max; i++) {
          tracker.taskTracker.on(TaskTracker.Events.TaskReady, noop);
        }
        // At exactly `max` listeners Node does not warn (warning fires at max+1).
        expect(spy.warnings.some((m) => m.includes('MaxListenersExceededWarning'))).toBe(false);
      } finally {
        spy.restore();
      }
      tracker.dispose();
    });
  });

  // ── garbage-collection safety net (best-effort) ───────────────────

  describe('garbage-collection safety net (best-effort)', () => {
    // FinalizationRegistry callbacks are non-deterministic: they may fire late
    // or never. These tests verify the safety net does not ACCIDENTALLY pin
    // the tracker in memory — e.g. by capturing `this` strongly inside a
    // registry callback, which is the classic FinalizationRegistry leak.
    //
    // GC is forced with Bun.gc(); when it is unavailable the suite skips
    // rather than fails.

    function gcAvailable(): boolean {
      return typeof (Bun as { gc?: unknown }).gc === 'function';
    }

    async function forceGcUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        // Allocation pressure + synchronous GC to nudge finalization.
        for (let i = 0; i < 5; i++) {
          Array.from({ length: 10000 }, (_, j) => ({ j }));
        }
        (Bun as { gc: (sync?: boolean) => unknown }).gc(true);
        await new Promise((r) => setTimeout(r, 0));
      }
      return predicate();
    }

    it('a dropped tracker (no signal, no dispose) is collectible — safety net does not pin it', async () => {
      if (!gcAvailable()) return;
      const ref = (() => {
        const tracker = new WorkflowStatusTracker(dir);
        return new WeakRef(tracker);
      })();
      const collected = await forceGcUntil(() => ref.deref() === undefined);
      expect(collected).toBe(true);
      expect(ref.deref()).toBeUndefined();
    });

    it('many dropped trackers are all collectible (no strong retention via safety net)', async () => {
      if (!gcAvailable()) return;
      const refs = (() => {
        const trackers = Array.from({ length: 20 }, () => new WorkflowStatusTracker(dir));
        return trackers.map((t) => new WeakRef(t));
      })();
      const allCollected = await forceGcUntil(() => refs.every((r) => r.deref() === undefined));
      expect(allCollected).toBe(true);
    });
  });
});
