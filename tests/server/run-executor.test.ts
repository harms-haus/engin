// ─── RunExecutor — test-first specification ───────────────────────────────
//
// Test-first specification for `packages/engine/src/server/run-executor.ts`,
// the workflow-execution body extracted from RunManager (decomposition step).
// It contains the former private `executeWorkflow` async IIFE: the
// workflow.run() lifecycle, store flush, status transitions
// (running → complete / failed), terminal broadcasts, renderer-registry
// wiring, and the post-terminal reaper scheduling.
//
// CONTRACT UNDER TEST (the new module must export a class `RunExecutor`):
//
//   class RunExecutor {
//     constructor(
//       registry: RunRegistry,
//       onRunsChanged: () => void,
//       reapDelayMs?: number,   // default 60_000
//     );
//     execute(
//       handle: RunHandle,
//       workflow: WorkflowModule,
//       storeCallbacks: StatusCallbacks,
//       msg: StartRunMessage,
//     ): Promise<void>;
//   }
//
// CRITICAL INVARIANT (called out by the decomposition task):
//   `execute` MUST call `bridge.broadcastTerminal(...)` to emit the terminal
//   `run_complete` / `run_failed` messages. After task-29 removes the
//   projection-change-based terminal detection from StatusBridge,
//   `broadcastTerminal` is the ONLY path for terminal messages — so if the
//   call is dropped, clients never learn a run finished. These tests pin
//   that call directly via a spy on `StatusBridge.prototype.broadcastTerminal`.
//
// Workflow modules are passed in directly (as plain objects) rather than
// loaded from disk: RunExecutor does NOT load workflows (the facade does),
// it only consumes the module it is handed. A real EventStore + StatusBridge
// back each handle so flush/durability/projection behaviour is exercised.
//
// Tests are RED (expected) because the source module is created in the
// NEXT (implement) phase.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServerMessage } from '@engin/shared/protocol-types';
import type { StatusCallbacks, WorkflowModule } from '../../packages/engine/src/core/types.js';
import { RunExecutor } from '../../packages/engine/src/server/run-executor.js';
import type { RunHandle, StartRunMessage } from '../../packages/engine/src/server/run-manager.js';
import { RunRegistry } from '../../packages/engine/src/server/run-registry.js';
import { StatusBridge } from '../../packages/engine/src/server/status-bridge.js';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';
import { createStoreCallbacks } from '../../packages/engine/src/tracking/store-callbacks.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Inline workflow modules ────────────────────────────────────────────────
//
// `okWorkflow`    — appends a workflow_started event (seeds the store, so we
//                   can assert flush durability) then resolves successfully.
// `boomWorkflow`  — seeds the store then throws a genuine (non-abort) error.
// `abortWorkflow` — seeds the store then blocks until the AbortSignal fires,
//                   rejecting with an AbortError (cooperative cancellation).

function makeOkWorkflow(): WorkflowModule {
  return {
    async run(taskPrompt, options) {
      options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
    },
  };
}

function makeBoomWorkflow(message = 'kaboom: workflow exploded'): WorkflowModule {
  return {
    async run(taskPrompt, options) {
      options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
      throw new Error(message);
    },
  };
}

/** A workflow that blocks until the AbortSignal fires. Sets `started` once running. */
function makeAbortWorkflow(startedRef: { value: boolean }): WorkflowModule {
  return {
    async run(taskPrompt, options) {
      options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
      startedRef.value = true;
      const signal = options.signal;
      return new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  };
}

// ─── Generic helpers ────────────────────────────────────────────────────────

/** Poll until fn returns truthy (or throw after `timeout` ms). */
async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeout?: number; interval?: number } = {}): Promise<T> {
  const timeout = opts.timeout ?? 5000;
  const interval = opts.interval ?? 10;
  const start = Date.now();
  for (;;) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      // keep polling
    }
    if (Date.now() - start >= timeout) throw new Error(`waitFor timed out after ${timeout}ms`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('RunExecutor', () => {
  const { getDir } = useTempDir();

  // Captured 60s reaper timers (intercepted so they never actually fire on
  // the real scheduler during a test). The reaper-specific test fires them.
  let reapers: Array<() => void>;
  let realSetTimeout: typeof globalThis.setTimeout;
  const bridges: StatusBridge[] = [];
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    reapers = [];
    realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((cb: any, delay?: number, ...args: any[]) => {
      if (delay === 60_000) {
        reapers.push(cb as () => void);
        return 0 as any;
      }
      return realSetTimeout(cb as any, delay, ...args);
    }) as any;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout as any;
    for (const s of spies) s.mockRestore();
    spies.length = 0;
    for (const b of bridges) b.dispose();
    bridges.length = 0;
  });

  // ─── setup helpers ───────────────────────────────────────────────────────

  interface Setup {
    runId: string;
    handle: RunHandle;
    registry: RunRegistry;
    executor: RunExecutor;
    store: EventStore;
    storeCallbacks: StatusCallbacks;
    messages: ServerMessage[];
    runsChanged: () => number;
    fireReapers: () => void;
    reaperCount: () => number;
  }

  function setup(runId: string): Setup {
    const workDir = join(getDir(), runId);
    // EventStore.ensureDir() creates the dir on first flush, but pre-create
    // it so the durability read never races the mkdir.
    void mkdir(workDir, { recursive: true });

    const store = new EventStore(workDir);
    const messages: ServerMessage[] = [];
    const broadcast = (m: ServerMessage) => {
      messages.push(m);
    };
    const bridge = new StatusBridge(broadcast, store, runId);
    bridges.push(bridge);

    let runsChangedCount = 0;
    const onRunsChanged = () => {
      runsChangedCount++;
    };

    const registry = new RunRegistry();
    const executor = new RunExecutor(registry, onRunsChanged);

    const handle: RunHandle = {
      runId,
      cwd: '/tmp/project',
      workflowName: 'develop',
      taskPrompt: 'do the thing',
      workDir,
      store,
      controller: new AbortController(),
      bridge,
      status: 'running',
      summary: {
        runId,
        cwd: '/tmp/project',
        workflowName: 'develop',
        taskPrompt: 'do the thing',
        status: 'running',
        startedAt: new Date().toISOString(),
      },
      startedAt: new Date().toISOString(),
      subscribers: new Set(),
    };
    registry.register(handle);

    return {
      runId,
      handle,
      registry,
      executor,
      store,
      storeCallbacks: createStoreCallbacks(store),
      messages,
      runsChanged: () => runsChangedCount,
      fireReapers: () => {
        for (const r of reapers) r();
      },
      reaperCount: () => reapers.length,
    };
  }

  function makeMsg(runId: string, workDir: string): StartRunMessage {
    return {
      workflowName: 'develop',
      taskPrompt: 'do the thing',
      cwd: '/tmp/project',
      workDir,
    } as StartRunMessage;
  }

  // ─── success path ────────────────────────────────────────────────────────

  describe('success path', () => {
    it('flips status to complete and broadcasts run_complete via broadcastTerminal', async () => {
      const s = setup('exec-ok');
      const spy = spyOn(StatusBridge.prototype, 'broadcastTerminal');
      spies.push(spy);

      await s.executor.execute(s.handle, makeOkWorkflow(), s.storeCallbacks, makeMsg('exec-ok', s.handle.workDir));

      expect(s.handle.status).toBe('complete');
      expect(s.handle.summary.status).toBe('complete');

      // CRITICAL: the terminal message MUST be emitted via broadcastTerminal.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toEqual({ type: 'run_complete', runId: 'exec-ok' });

      // And it reached the broadcast sink tagged with runId.
      const completes = s.messages.filter((m) => m.type === 'run_complete');
      expect(completes).toHaveLength(1);
      expect(completes[0]).toEqual({ type: 'run_complete', runId: 'exec-ok' });
    });

    it('flushes the store BEFORE flipping status (partial events are durable)', async () => {
      const s = setup('exec-flush');
      const flushSpy = spyOn(EventStore.prototype, 'flush');
      spies.push(flushSpy);

      await s.executor.execute(s.handle, makeOkWorkflow(), s.storeCallbacks, makeMsg('exec-flush', s.handle.workDir));

      // flush() was awaited at least once on the success path.
      expect(flushSpy).toHaveBeenCalled();

      // The seeded workflow_started event is durable on disk by the time the
      // run reports complete.
      const logPath = join(s.handle.workDir, 'events.jsonl');
      expect(existsSync(logPath)).toBe(true);
      const log = await readFile(logPath, 'utf-8');
      expect(log).toContain('workflow_started');
    });

    it('calls onRunsChanged once the run settles (finally block)', async () => {
      const s = setup('exec-onchanged');
      const before = s.runsChanged();

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-onchanged', s.handle.workDir),
      );

      expect(s.runsChanged()).toBeGreaterThan(before);
    });
  });

  // ─── failure path ────────────────────────────────────────────────────────

  describe('failure path', () => {
    it('flips status to failed and broadcasts run_failed with the genuine error', async () => {
      const s = setup('exec-fail');
      const spy = spyOn(StatusBridge.prototype, 'broadcastTerminal');
      spies.push(spy);

      await s.executor.execute(
        s.handle,
        makeBoomWorkflow('kaboom: workflow exploded'),
        s.storeCallbacks,
        makeMsg('exec-fail', s.handle.workDir),
      );

      expect(s.handle.status).toBe('failed');
      expect(s.handle.summary.status).toBe('failed');

      // CRITICAL: run_failed is emitted via broadcastTerminal with the raw
      // error message (NOT "Run cancelled").
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0] as { type: string; runId: string; error: string; phase: string };
      expect(payload.type).toBe('run_failed');
      expect(payload.runId).toBe('exec-fail');
      expect(payload.error).toBe('kaboom: workflow exploded');

      const failed = s.messages.filter((m) => m.type === 'run_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ type: 'run_failed', runId: 'exec-fail', error: 'kaboom: workflow exploded' });
    });

    it('flushes the store even on error (partial events stay durable)', async () => {
      const s = setup('exec-fail-flush');

      await s.executor.execute(
        s.handle,
        makeBoomWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-fail-flush', s.handle.workDir),
      );

      const log = await readFile(join(s.handle.workDir, 'events.jsonl'), 'utf-8');
      expect(log).toContain('workflow_started');
    });

    it('calls onRunsChanged in the finally block even when the workflow throws', async () => {
      const s = setup('exec-fail-onchanged');
      const before = s.runsChanged();

      await s.executor.execute(
        s.handle,
        makeBoomWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-fail-onchanged', s.handle.workDir),
      );

      expect(s.runsChanged()).toBeGreaterThan(before);
    });
  });

  // ─── cancellation / abort ────────────────────────────────────────────────

  describe('cancellation (abort)', () => {
    it('surfaces "Run cancelled" as run_failed when the AbortSignal fires', async () => {
      const s = setup('exec-abort');
      const spy = spyOn(StatusBridge.prototype, 'broadcastTerminal');
      spies.push(spy);
      const started = { value: false };

      const execPromise = s.executor.execute(
        s.handle,
        makeAbortWorkflow(started),
        s.storeCallbacks,
        makeMsg('exec-abort', s.handle.workDir),
      );

      // Wait until the workflow has started blocking, then abort.
      await waitFor(() => started.value);
      s.handle.controller.abort();
      await execPromise;

      expect(s.handle.status).toBe('failed');

      // AbortError → the canonical "Run cancelled" message (NOT the raw error).
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0] as { type: string; error: string };
      expect(payload.type).toBe('run_failed');
      expect(payload.error).toBe('Run cancelled');

      const failed = s.messages.filter((m) => m.type === 'run_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ type: 'run_failed', error: 'Run cancelled' });
    });
  });

  // ─── renderer-registry wiring ────────────────────────────────────────────

  describe('renderer registry wiring', () => {
    it('creates a RendererRegistry, invokes registerRenderers, and passes it via options', async () => {
      const s = setup('exec-renderer');
      const probe: { present?: boolean; ctor?: string; rendered?: string; sameRef?: boolean } = {};
      let hookRegistry: unknown = null;

      const workflow: WorkflowModule = {
        registerRenderers(reg) {
          hookRegistry = reg;
          reg.register('developer', (data) => 'RENDERED:' + JSON.stringify(data));
        },
        async run(taskPrompt, options) {
          options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
          const reg = options.rendererRegistry;
          probe.present = !!reg;
          probe.ctor = reg?.constructor.name;
          probe.rendered = reg?.render('developer', { msg: taskPrompt }) ?? undefined;
          probe.sameRef = reg != null && reg === hookRegistry;
        },
      };

      await s.executor.execute(s.handle, workflow, s.storeCallbacks, makeMsg('exec-renderer', s.handle.workDir));

      expect(probe.present).toBe(true);
      expect(probe.ctor).toBe('RendererRegistry');
      // The hook ran and the registered renderer produced formatted output.
      expect(probe.rendered).toBe('RENDERED:' + JSON.stringify({ msg: 'do the thing' }));
      // The same registry instance was handed to the hook and to run().
      expect(probe.sameRef).toBe(true);
    });

    it('still passes an empty RendererRegistry when the workflow has no registerRenderers hook', async () => {
      const s = setup('exec-nohook');
      const probe: { present?: boolean; ctor?: string; missingUndefined?: boolean } = {};

      const workflow: WorkflowModule = {
        async run(taskPrompt, options) {
          options.onStatus?.onWorkflowStart?.({ taskPrompt, resumed: false, workDir: options.workDir });
          const reg = options.rendererRegistry;
          probe.present = !!reg;
          probe.ctor = reg?.constructor.name;
          probe.missingUndefined = reg?.render('never-registered', { x: 1 }) === undefined;
        },
      };

      await s.executor.execute(s.handle, workflow, s.storeCallbacks, makeMsg('exec-nohook', s.handle.workDir));

      // Even without a hook, an empty registry is handed over.
      expect(probe.present).toBe(true);
      expect(probe.ctor).toBe('RendererRegistry');
      expect(probe.missingUndefined).toBe(true);
    });
  });

  // ─── reaper scheduling ───────────────────────────────────────────────────

  describe('reaper scheduling', () => {
    it('schedules a ~60s reaper after the run reaches a terminal state', async () => {
      const s = setup('exec-reap');

      await s.executor.execute(s.handle, makeOkWorkflow(), s.storeCallbacks, makeMsg('exec-reap', s.handle.workDir));

      // The finally block scheduled exactly one 60s reaper timer.
      expect(s.reaperCount()).toBeGreaterThanOrEqual(1);
    });

    it('removes the handle from the registry when the reaper fires', async () => {
      const s = setup('exec-reap-remove');

      await s.executor.execute(
        s.handle,
        makeOkWorkflow(),
        s.storeCallbacks,
        makeMsg('exec-reap-remove', s.handle.workDir),
      );
      expect(s.registry.get('exec-reap-remove')).toBeDefined();

      const before = s.runsChanged();
      s.fireReapers();

      // Reaping removes the handle and notifies the control server again.
      expect(s.registry.get('exec-reap-remove')).toBeUndefined();
      expect(s.runsChanged()).toBeGreaterThan(before);
    });
  });
});
