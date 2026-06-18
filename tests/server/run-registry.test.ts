// ─── RunRegistry — test-first specification ───────────────────────────────
//
// Test-first specification for `packages/engine/src/server/run-registry.ts`,
// the in-memory run-handle registry extracted from RunManager (decomposition
// step). It owns the `Map<string, RunHandle>`: adding, removing, looking up,
// listing runs, supporting collision detection, and the reaper timer.
//
// CONTRACT UNDER TEST (the new module must export a class `RunRegistry`):
//
//   class RunRegistry {
//     register(handle: RunHandle): void;                  // map.set(runId, handle)
//     get(runId: string): RunHandle | undefined;          // map lookup
//     listRuns(): RunSummary[];                            // summaries of all runs
//     remove(runId: string): void;                        // map.delete(runId)
//     scheduleReap(runId: string, delayMs: number,
//                 onReap: () => void): void;              // status-gated reaper timer
//   }
//
// `register` overwrites any previous handle for the same runId (resume). The
// facade performs collision detection by inspecting `get(runId)?.status ===
// 'running'` BEFORE calling register — so the registry must faithfully
// reflect the registered status.
//
// `scheduleReap` wraps a `setTimeout(delayMs)` that fires `onReap` ONLY when
// the run is still registered AND no longer `'running'`. This encapsulates
// the reaper guard currently inlined in RunManager.executeWorkflow's finally
// block (`if (handle.status !== 'running') { ... }`).
//
// Tests are RED (expected) because the source module is created in the
// NEXT (implement) phase.

import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import type { RunSummary } from '@engin/shared/protocol-types';
import type { RunHandle, RunStatus } from '../../packages/engine/src/server/run-manager.js';
import { RunRegistry } from '../../packages/engine/src/server/run-registry.js';
import { StatusBridge } from '../../packages/engine/src/server/status-bridge.js';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Handle factory ─────────────────────────────────────────────────────────
//
// RunHandle carries many fields, but RunRegistry only consumes `runId`,
// `status`, and `summary`. We build a fully-typed handle backed by a real
// (cheap) EventStore and StatusBridge so the type system is satisfied; the
// bridges are disposed in afterEach to avoid leaking store subscriptions.

describe('RunRegistry', () => {
  const { getDir } = useTempDir();

  const bridges: StatusBridge[] = [];

  function makeHandle(runId: string, opts: { status?: RunStatus; taskPrompt?: string } = {}): RunHandle {
    const workDir = join(getDir(), runId);
    const store = new EventStore(workDir);
    const bridge = new StatusBridge(() => {}, store, runId);
    bridges.push(bridge);
    const status: RunStatus = opts.status ?? 'running';
    const taskPrompt = opts.taskPrompt ?? 'do something';
    return {
      runId,
      cwd: '/tmp/project',
      workflowName: 'develop',
      taskPrompt,
      workDir,
      store,
      controller: new AbortController(),
      bridge,
      status,
      summary: {
        runId,
        cwd: '/tmp/project',
        workflowName: 'develop',
        taskPrompt,
        status,
        startedAt: new Date().toISOString(),
      },
      startedAt: new Date().toISOString(),
      subscribers: new Set(),
    };
  }

  afterEach(() => {
    for (const b of bridges) b.dispose();
    bridges.length = 0;
  });

  // ─── register / get ──────────────────────────────────────────────────────

  describe('register / get', () => {
    it('register stores a handle that get() returns by runId', () => {
      const registry = new RunRegistry();
      const handle = makeHandle('run-1');

      registry.register(handle);

      expect(registry.get('run-1')).toBe(handle);
    });

    it('get() returns undefined for an unknown runId', () => {
      const registry = new RunRegistry();
      expect(registry.get('nope')).toBeUndefined();
    });

    it('register overwrites a previous handle for the same runId (resume)', () => {
      const registry = new RunRegistry();
      const first = makeHandle('run-resume', { status: 'complete' });
      const second = makeHandle('run-resume', { status: 'running' });

      registry.register(first);
      registry.register(second);

      // The latest registration wins — this is what lets a resumed run
      // replace its completed predecessor.
      expect(registry.get('run-resume')).toBe(second);
      expect(registry.get('run-resume')?.status).toBe('running');
    });

    it('reflects the registered status so the facade can detect collisions', () => {
      const registry = new RunRegistry();

      // A running run is present with status 'running'.
      registry.register(makeHandle('run-collide', { status: 'running' }));
      const existing = registry.get('run-collide');
      expect(existing).toBeDefined();
      expect(existing?.status).toBe('running');

      // The facade's collision check (`existing && existing.status === 'running'`)
      // must therefore be truthy for a running run…
      expect(Boolean(existing && existing.status === 'running')).toBe(true);

      // …and falsy once the run has reached a terminal state.
      registry.register(makeHandle('run-collide', { status: 'complete' }));
      const terminal = registry.get('run-collide');
      expect(Boolean(terminal && terminal.status === 'running')).toBe(false);
    });
  });

  // ─── listRuns ────────────────────────────────────────────────────────────

  describe('listRuns', () => {
    it('returns an empty array when no runs are registered', () => {
      const registry = new RunRegistry();
      expect(registry.listRuns()).toEqual([]);
    });

    it('returns a RunSummary per registered run', () => {
      const registry = new RunRegistry();
      registry.register(makeHandle('aaa-1', { taskPrompt: 'one' }));
      registry.register(makeHandle('bbb-2', { taskPrompt: 'two' }));

      const runs = registry.listRuns();
      expect(runs).toHaveLength(2);
      expect(runs.map((r: RunSummary) => r.runId).sort()).toEqual(['aaa-1', 'bbb-2']);
    });

    it('returns summaries (not handles) reflecting current status', () => {
      const registry = new RunRegistry();
      const handle = makeHandle('stat-run', { status: 'running' });
      registry.register(handle);

      // Mutating the handle's summary/status is observable through listRuns()
      // because the registry holds the live handle reference.
      handle.status = 'failed';
      handle.summary.status = 'failed';

      const runs = registry.listRuns();
      expect(runs[0].status).toBe('failed');
    });

    it('reflects only the latest handle after a re-register', () => {
      const registry = new RunRegistry();
      registry.register(makeHandle('dup', { status: 'complete' }));
      registry.register(makeHandle('dup', { status: 'running' }));

      const runs = registry.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('running');
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('removes a handle so get() and listRuns() no longer see it', () => {
      const registry = new RunRegistry();
      registry.register(makeHandle('rm-1'));
      expect(registry.get('rm-1')).toBeDefined();

      registry.remove('rm-1');

      expect(registry.get('rm-1')).toBeUndefined();
      expect(registry.listRuns()).toEqual([]);
    });

    it('is a no-op for an unknown runId (does not throw)', () => {
      const registry = new RunRegistry();
      expect(() => registry.remove('never-existed')).not.toThrow();
    });
  });

  // ─── scheduleReap ────────────────────────────────────────────────────────
  //
  // The reaper fires `onReap` after `delayMs`, but ONLY when the run is still
  // registered AND no longer `'running'`. This guards against reaping a run
  // that resumed into a second execution.

  describe('scheduleReap', () => {
    /** Intercept setTimeout calls scheduled for exactly `delay` ms. */
    function captureTimersForDelay(delay: number): {
      timers: Array<() => void>;
      delays: number[];
      fire: () => void;
      restore: () => void;
    } {
      const real = globalThis.setTimeout;
      const timers: Array<() => void> = [];
      const delays: number[] = [];
      globalThis.setTimeout = ((cb: any, d?: number, ...rest: any[]) => {
        delays.push(d ?? 0);
        if (d === delay) {
          timers.push(cb as () => void);
          return 0 as any;
        }
        return real(cb as any, d, ...rest);
      }) as any;
      return {
        timers,
        delays,
        fire: () => {
          for (const t of timers) t();
        },
        restore: () => {
          globalThis.setTimeout = real as any;
        },
      };
    }

    it('invokes onReap after delayMs when the run is no longer running', () => {
      const cap = captureTimersForDelay(60_000);
      try {
        const registry = new RunRegistry();
        registry.register(makeHandle('reap-done', { status: 'complete' }));

        let reaped = 0;
        registry.scheduleReap('reap-done', 60_000, () => {
          reaped++;
        });

        expect(cap.timers).toHaveLength(1);
        expect(reaped).toBe(0);

        cap.fire();
        expect(reaped).toBe(1);
      } finally {
        cap.restore();
      }
    });

    it('passes delayMs through to setTimeout', () => {
      const cap = captureTimersForDelay(42_000);
      try {
        const registry = new RunRegistry();
        registry.register(makeHandle('reap-delay', { status: 'complete' }));

        registry.scheduleReap('reap-delay', 42_000, () => {});

        expect(cap.delays).toContain(42_000);
      } finally {
        cap.restore();
      }
    });

    it('does NOT invoke onReap when the run is still running', () => {
      const cap = captureTimersForDelay(60_000);
      try {
        const registry = new RunRegistry();
        registry.register(makeHandle('reap-live', { status: 'running' }));

        let reaped = 0;
        registry.scheduleReap('reap-live', 60_000, () => {
          reaped++;
        });

        cap.fire();
        // The run never left 'running', so the reaper must not fire.
        expect(reaped).toBe(0);
        expect(registry.get('reap-live')).toBeDefined();
      } finally {
        cap.restore();
      }
    });

    it('does NOT invoke onReap when the handle was removed before the timer fired', () => {
      const cap = captureTimersForDelay(60_000);
      try {
        const registry = new RunRegistry();
        registry.register(makeHandle('reap-gone', { status: 'complete' }));

        let reaped = 0;
        registry.scheduleReap('reap-gone', 60_000, () => {
          reaped++;
        });

        // The handle is removed (e.g. by an explicit shutdown) before the
        // reaper timer elapses.
        registry.remove('reap-gone');

        cap.fire();
        expect(reaped).toBe(0);
      } finally {
        cap.restore();
      }
    });

    it('is a no-op scheduling for an unknown runId (does not throw, never reaps)', () => {
      const cap = captureTimersForDelay(60_000);
      try {
        const registry = new RunRegistry();
        let reaped = 0;
        expect(() => registry.scheduleReap('ghost', 60_000, () => reaped++)).not.toThrow();

        cap.fire();
        expect(reaped).toBe(0);
      } finally {
        cap.restore();
      }
    });
  });
});
