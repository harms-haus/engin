// ─── RunManager — server-side console capture ───────────────────────────────
//
// Test-first specification for the scoped console.warn/error/info capture
// added to `RunManager.executeWorkflow` (the async IIFE body that wraps
// `workflow.run()`).
//
// Contract under test (see task spec):
//
//   Before the `try` block in executeWorkflow, the original console.warn,
//   console.error, and console.info are saved and replaced with wrappers
//   that:
//     1. ALWAYS call the original method (so the server log file still
//        captures them), AND
//     2. append a `log` event to the run's EventStore with the matching
//        level (`warn` / `error` / `info`).
//
//   console.log is intentionally NOT overridden (library noise like dotenv
//   is ignored).
//
//   In the `finally` block, the original console methods are ALWAYS restored
//   — even on error or abort.
//
//   The appended `log` events feed through the normal EventStore → evolve →
//   StatusBridge → subscriber pipeline; evolve's `log` case appends a
//   LogEntry to the projection `runLog`.
//
// The fixture workflows live on disk (created per-test under a temp dir) and
// are loaded through the real loadWorkflow() machinery, mirroring
// run-manager.test.ts. Each test lets the workflow reach a terminal state
// (complete / failed) BEFORE running assertions so the fire-and-forget IIFE
// has fully settled and there are no teardown races.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { clearWorkflowCache } from '../../packages/engine/src/core/workflow-loader.js';
import { RunManager } from '../../packages/engine/src/server/run-manager.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Fixture workflow sources ───────────────────────────────────────────────
//
// `logger` — the controllable workflow. It:
//   1. appends a `workflow_started` event (seeds the store),
//   2. calls console.warn / console.error / console.info / console.log,
//   3. writes a `started.marker` (signals the console calls have completed),
//   4. blocks until a `release.marker` appears OR the AbortSignal fires.
//
// `logger-fail` — calls the same console methods then throws a genuine error,
// so the catch/finally restoration path can be exercised.

const LOGGER_SOURCE = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function run(taskPrompt, options) {
  const workDir = options.workDir;
  try { mkdirSync(workDir, { recursive: true }); } catch (e) {}
  if (options.onStatus && options.onStatus.onWorkflowStart) {
    options.onStatus.onWorkflowStart({ taskPrompt: taskPrompt, resumed: false, workDir: workDir });
  }
  // Console messages that should be captured as log events.
  console.warn('WARN-MARKER');
  console.error('ERROR-MARKER');
  console.info('INFO-MARKER');
  // console.log should NOT be captured (library noise is ignored).
  console.log('LOG-MARKER-NOT-CAPTURED');
  try { writeFileSync(join(workDir, 'started.marker'), '1'); } catch (e) {}
  const releasePath = join(workDir, 'release.marker');
  const signal = options.signal;
  await new Promise(function (resolve, reject) {
    function check() {
      if (existsSync(releasePath)) { resolve(undefined); return true; }
      if (signal && signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return true; }
      return false;
    }
    if (check()) return;
    const iv = setInterval(function () { if (check()) clearInterval(iv); }, 5);
  });
}
`;

const LOGGER_FAIL_SOURCE = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function run(taskPrompt, options) {
  const workDir = options.workDir;
  try { mkdirSync(workDir, { recursive: true }); } catch (e) {}
  if (options.onStatus && options.onStatus.onWorkflowStart) {
    options.onStatus.onWorkflowStart({ taskPrompt: taskPrompt, resumed: false, workDir: workDir });
  }
  console.warn('WARN-BEFORE-FAIL');
  console.error('ERROR-BEFORE-FAIL');
  console.info('INFO-BEFORE-FAIL');
  console.log('LOG-BEFORE-FAIL-NOT-CAPTURED');
  try { writeFileSync(join(workDir, 'started.marker'), '1'); } catch (e) {}
  throw new Error('logger workflow exploded');
}
`;

// ─── Generic async helpers ──────────────────────────────────────────────────

/** Poll `fn` until it returns a truthy value (or throw after `timeout` ms). */
async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeout?: number; interval?: number } = {}): Promise<T> {
  const timeout = opts.timeout ?? 8000;
  const interval = opts.interval ?? 10;
  const start = Date.now();
  for (;;) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      // keep polling until timeout
    }
    if (Date.now() - start >= timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Minimal mock of a Bun ServerWebSocket that records every sent payload. */
function makeMockWs(): { ws: any; sent: any[] } {
  const sent: any[] = [];
  const ws = {
    // 1 === OPEN
    readyState: 1,
    send: (data: string | ArrayBuffer | Uint8Array) => {
      const str = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
      try {
        sent.push(JSON.parse(str));
      } catch {
        sent.push(str);
      }
    },
    close: () => {
      /* no-op */
    },
  };
  return { ws, sent };
}

/** Read events.jsonl and return the records whose type is `log`. */
async function readLogEvents(
  workDir: string,
): Promise<Array<{ seq: number; type: string; data: Record<string, unknown> }>> {
  const logPath = join(workDir, 'events.jsonl');
  const content = await readFile(logPath, 'utf-8');
  const records: Array<{ seq: number; type: string; data: Record<string, unknown> }> = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    const rec = JSON.parse(line);
    if (rec.type === 'log') records.push(rec);
  }
  return records;
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('RunManager — console capture', () => {
  const { getDir } = useTempDir();

  let savedXdg: string | undefined;
  // Safety net: save/restore console methods so a run left in progress when a
  // test finishes cannot leak an override into sibling tests.
  let savedWarn: typeof console.warn;
  let savedError: typeof console.error;
  let savedInfo: typeof console.info;
  let cwd: string;
  let globalWorkflowDir: string;
  const managers: RunManager[] = [];

  beforeEach(async () => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedWarn = console.warn;
    savedError = console.error;
    savedInfo = console.info;

    const base = getDir();
    process.env.XDG_CONFIG_HOME = join(base, 'global');
    cwd = join(base, 'local');
    await mkdir(cwd, { recursive: true });

    globalWorkflowDir = join(base, 'global', 'engin', 'workflows');
    await mkdir(join(globalWorkflowDir, 'logger'), { recursive: true });
    await writeFile(join(globalWorkflowDir, 'logger', 'main.ts'), LOGGER_SOURCE);
    await mkdir(join(globalWorkflowDir, 'logger-fail'), { recursive: true });
    await writeFile(join(globalWorkflowDir, 'logger-fail', 'main.ts'), LOGGER_FAIL_SOURCE);

    clearWorkflowCache();
    managers.length = 0;
  });

  afterEach(async () => {
    for (const m of managers) {
      try {
        await m.shutdownAll();
      } catch {
        // best-effort teardown
      }
    }
    console.warn = savedWarn;
    console.error = savedError;
    console.info = savedInfo;
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  // ─── shared helpers bound to this describe's state ───────────────────────

  function createManager(): { manager: RunManager; calls: number[] } {
    const calls: number[] = [];
    const manager = new RunManager(() => calls.push(Date.now()));
    managers.push(manager);
    return { manager, calls };
  }

  function makeWorkDir(label: string): string {
    return join(getDir(), 'work', label);
  }

  // ─── capture: warn ───────────────────────────────────────────────────────

  describe('capture', () => {
    it('captures console.warn as a log event with level warn in the store', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('cap-warn');
      await mkdir(workDir, { recursive: true });
      const { ws, sent } = makeMockWs();

      // Pre-place the release marker so the controllable workflow resolves
      // immediately — the console calls happen synchronously before the
      // marker check, so they are already captured by completion.
      await writeFile(join(workDir, 'release.marker'), '1');
      const result = await manager.startRun({ workflowName: 'logger', taskPrompt: 't', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      // The projection runLog (snapshot) contains the captured entry,
      // proving the store → evolve → projection pipeline.
      manager.handleResync(ws, result.runId);
      const snap = sent.filter((m) => m.type === 'snapshot').at(-1);
      expect(snap).toBeDefined();
      const warnEntry = snap.state.runLog.find((e: any) => e.content === 'WARN-MARKER');
      expect(warnEntry).toBeDefined();

      // Durability: the log event is persisted in events.jsonl with level warn.
      const logEvents = await readLogEvents(workDir);
      const warnEvt = logEvents.find((e) => e.data.level === 'warn' && e.data.message === 'WARN-MARKER');
      expect(warnEvt).toBeDefined();
      expect(warnEvt!.type).toBe('log');
    });

    it('captures console.error as a log event with level error in the store', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('cap-error');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'logger', taskPrompt: 't', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const logEvents = await readLogEvents(workDir);
      const errorEvt = logEvents.find((e) => e.data.level === 'error' && e.data.message === 'ERROR-MARKER');
      expect(errorEvt).toBeDefined();
      expect(errorEvt!.type).toBe('log');
    });

    it('captures console.info as a log event with level info in the store', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('cap-info');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'logger', taskPrompt: 't', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const logEvents = await readLogEvents(workDir);
      const infoEvt = logEvents.find((e) => e.data.level === 'info' && e.data.message === 'INFO-MARKER');
      expect(infoEvt).toBeDefined();
      expect(infoEvt!.type).toBe('log');
    });

    it('does NOT capture console.log (library noise is ignored)', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('cap-log');
      await mkdir(workDir, { recursive: true });
      const { ws, sent } = makeMockWs();

      const result = await manager.startRun({ workflowName: 'logger', taskPrompt: 't', cwd, workDir } as any);
      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      // The projection runLog must not contain the console.log message.
      manager.handleResync(ws, result.runId);
      const snap = sent.filter((m) => m.type === 'snapshot').at(-1);
      expect(snap).toBeDefined();
      const logEntry = snap.state.runLog.find((e: any) => e.content === 'LOG-MARKER-NOT-CAPTURED');
      expect(logEntry).toBeUndefined();

      // No persisted log event carries the console.log message either.
      const logEvents = await readLogEvents(workDir);
      const stray = logEvents.find((e) => String(e.data.message).includes('LOG-MARKER-NOT-CAPTURED'));
      expect(stray).toBeUndefined();
    });

    it('captures all three levels in a single run', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('cap-all');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'logger', taskPrompt: 't', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const logEvents = await readLogEvents(workDir);
      const levels = logEvents.map((e) => String(e.data.level)).sort();
      expect(levels).toEqual(['error', 'info', 'warn']);
    });
  });

  // ─── original passthrough ────────────────────────────────────────────────

  describe('original passthrough', () => {
    it('still invokes the original console.warn/error/info alongside the capture', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('passthrough');
      await mkdir(workDir, { recursive: true });

      // Install spies that record their arguments AND delegate to the real
      // methods. The implementation captures these spies as the "originals"
      // and wraps them, so a workflow console call reaches the spy.
      const warnCalls: string[][] = [];
      const errorCalls: string[][] = [];
      const infoCalls: string[][] = [];
      const realWarn = console.warn;
      const realError = console.error;
      const realInfo = console.info;
      console.warn = (...args: unknown[]) => {
        warnCalls.push(args.map(String));
        realWarn.apply(console, args as any[]);
      };
      console.error = (...args: unknown[]) => {
        errorCalls.push(args.map(String));
        realError.apply(console, args as any[]);
      };
      console.info = (...args: unknown[]) => {
        infoCalls.push(args.map(String));
        realInfo.apply(console, args as any[]);
      };

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'logger', taskPrompt: 't', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      // The originals were called with the workflow's marker messages.
      expect(warnCalls.some((a) => a.includes('WARN-MARKER'))).toBe(true);
      expect(errorCalls.some((a) => a.includes('ERROR-MARKER'))).toBe(true);
      expect(infoCalls.some((a) => a.includes('INFO-MARKER'))).toBe(true);
    });
  });

  // ─── restoration ─────────────────────────────────────────────────────────

  describe('restoration', () => {
    it('restores the original console methods after a successful run', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('restore-ok');
      await mkdir(workDir, { recursive: true });

      const origWarn = console.warn;
      const origError = console.error;
      const origInfo = console.info;

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'logger', taskPrompt: 't', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      // The finally block restored the exact original references.
      expect(console.warn).toBe(origWarn);
      expect(console.error).toBe(origError);
      expect(console.info).toBe(origInfo);
    });

    it('restores the original console methods after a failed run', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('restore-fail');
      await mkdir(workDir, { recursive: true });

      const origWarn = console.warn;
      const origError = console.error;
      const origInfo = console.info;

      await manager.startRun({ workflowName: 'logger-fail', taskPrompt: 't', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'failed');

      // Even on error the finally block restored the originals.
      expect(console.warn).toBe(origWarn);
      expect(console.error).toBe(origError);
      expect(console.info).toBe(origInfo);
    });

    it('restores the original console methods after cancellation (abort)', async () => {
      const { manager } = createManager();
      const workDir = makeWorkDir('restore-abort');
      await mkdir(workDir, { recursive: true });

      const origWarn = console.warn;
      const origError = console.error;
      const origInfo = console.info;

      const result = await manager.startRun({ workflowName: 'logger', taskPrompt: 't', cwd, workDir } as any);
      // Wait until the workflow has made its console calls.
      await waitFor(() => existsSync(join(workDir, 'started.marker')));

      manager.cancelRun(result.runId);
      await waitFor(() => manager.listRuns()[0]?.status === 'failed');

      // Even on abort the finally block restored the originals.
      expect(console.warn).toBe(origWarn);
      expect(console.error).toBe(origError);
      expect(console.info).toBe(origInfo);
    });
  });
});
