// ─── RunManager — renderer registry wiring ──────────────────────────────────
//
// Test-first specification for the RendererRegistry integration added to
// `RunManager.executeWorkflow` (the async IIFE body that runs the workflow).
//
// Contract under test (see task spec):
//
//   Before building the WorkflowRunOptions object, executeWorkflow must:
//     1. Create a fresh registry:  const rendererRegistry = new RendererRegistry()
//     2. If the workflow module exports `registerRenderers`, call it with that
//        registry:  workflow.registerRenderers(rendererRegistry)
//     3. Pass the registry through to the workflow via the options object:
//        options.rendererRegistry = rendererRegistry
//
//   When the workflow does NOT export `registerRenderers`, an empty registry
//   is still created and passed; all render() calls then return undefined
//   (the correct default behaviour).
//
// The fixture workflows live on disk (created per-test under a temp dir) and
// are loaded through the real loadWorkflow() machinery, mirroring
// run-manager.test.ts. Each fixture probes `options.rendererRegistry` from
// inside run() and records its findings to a `registry.marker` file so the
// test can assert against the observable behaviour end-to-end.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { clearWorkflowCache } from '../../packages/engine/src/core/workflow-loader.js';
import { RunManager } from '../../packages/engine/src/server/run-manager.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Fixture workflow sources ───────────────────────────────────────────────
//
// `renderer` — a workflow that exports BOTH `run` and `registerRenderers`.
//   * registerRenderers captures the registry it receives and registers a
//     render function for the 'developer' profile.
//   * run() probes `options.rendererRegistry` and writes a `registry.marker`
//     describing what it observed, then blocks until release.marker or abort.
//
// `plain` — a workflow that exports ONLY `run` (no registerRenderers). run()
//   probes `options.rendererRegistry` the same way so we can verify the
//   engine still hands over an (empty) registry.

const RENDERER_SOURCE = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Captured by registerRenderers so run() can prove it received the SAME
// registry instance that the hook was invoked with.
let hookRegistry = null;
let hookCalled = false;

export function registerRenderers(registry) {
  hookCalled = true;
  hookRegistry = registry;
  registry.register('developer', function (data) {
    return 'RENDERED:' + JSON.stringify(data);
  });
}

export async function run(taskPrompt, options) {
  const workDir = options.workDir;
  try { mkdirSync(workDir, { recursive: true }); } catch (e) {}
  if (options.onStatus && options.onStatus.onWorkflowStart) {
    options.onStatus.onWorkflowStart({ taskPrompt: taskPrompt, resumed: false, workDir: workDir });
  }

  // Probe the registry handed to run() and record findings on disk.
  const reg = options.rendererRegistry;
  const rendered = reg ? reg.render('developer', { msg: taskPrompt }) : undefined;
  const missing = reg ? reg.render('never-registered', { x: 1 }) : undefined;

  const info = {
    present: reg != null,
    ctor: reg ? reg.constructor.name : null,
    hasRegister: reg ? typeof reg.register === 'function' : false,
    hasGet: reg ? typeof reg.get === 'function' : false,
    hasRender: reg ? typeof reg.render === 'function' : false,
    hookCalled: hookCalled,
    sameRef: hookRegistry != null && reg === hookRegistry,
    rendered: rendered === undefined ? '<UNDEFINED>' : rendered,
    missingIsUndefined: missing === undefined,
  };
  try { writeFileSync(join(workDir, 'registry.marker'), JSON.stringify(info)); } catch (e) {}

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

const PLAIN_SOURCE = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// NOTE: this workflow intentionally does NOT export registerRenderers.

export async function run(taskPrompt, options) {
  const workDir = options.workDir;
  try { mkdirSync(workDir, { recursive: true }); } catch (e) {}
  if (options.onStatus && options.onStatus.onWorkflowStart) {
    options.onStatus.onWorkflowStart({ taskPrompt: taskPrompt, resumed: false, workDir: workDir });
  }

  const reg = options.rendererRegistry;
  const missing = reg ? reg.render('developer', { msg: taskPrompt }) : undefined;

  const info = {
    present: reg != null,
    ctor: reg ? reg.constructor.name : null,
    hasRegister: reg ? typeof reg.register === 'function' : false,
    hasGet: reg ? typeof reg.get === 'function' : false,
    hasRender: reg ? typeof reg.render === 'function' : false,
    missingIsUndefined: missing === undefined,
  };
  try { writeFileSync(join(workDir, 'registry.marker'), JSON.stringify(info)); } catch (e) {}

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

/** Read and parse the registry.marker written by a fixture workflow. */
async function readRegistryMarker(workDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(workDir, 'registry.marker'), 'utf-8');
  return JSON.parse(raw);
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('RunManager — renderer registry wiring', () => {
  const { getDir } = useTempDir();

  let savedXdg: string | undefined;
  let cwd: string;
  let globalWorkflowDir: string;
  // Every manager created during a test, so afterEach can tear them down.
  const managers: RunManager[] = [];

  beforeEach(async () => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    const base = getDir();

    // Point the global config dir at our temp tree so the global workflow
    // directory resolves under it (mirrors run-manager.test.ts).
    process.env.XDG_CONFIG_HOME = join(base, 'global');
    cwd = join(base, 'local');
    await mkdir(cwd, { recursive: true });

    globalWorkflowDir = join(base, 'global', 'engin', 'workflows');
    await mkdir(join(globalWorkflowDir, 'renderer'), { recursive: true });
    await writeFile(join(globalWorkflowDir, 'renderer', 'main.ts'), RENDERER_SOURCE);
    await mkdir(join(globalWorkflowDir, 'plain'), { recursive: true });
    await writeFile(join(globalWorkflowDir, 'plain', 'main.ts'), PLAIN_SOURCE);

    clearWorkflowCache();
    managers.length = 0;
  });

  afterEach(async () => {
    // Abort any still-running fixtures so their polling intervals clear and
    // nothing leaks across tests. shutdownAll() is idempotent.
    for (const m of managers) {
      try {
        await m.shutdownAll();
      } catch {
        // best-effort teardown
      }
    }
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  // ─── shared helpers bound to this describe's state ───────────────────────

  function createManager(): RunManager {
    const manager = new RunManager(() => {});
    managers.push(manager);
    return manager;
  }

  function makeWorkDir(label: string): string {
    return join(getDir(), 'work', label);
  }

  // ─── when the workflow exports registerRenderers ─────────────────────────

  describe('when the workflow exports registerRenderers', () => {
    it('passes a RendererRegistry instance as options.rendererRegistry', async () => {
      const manager = createManager();
      const workDir = makeWorkDir('rr-present');
      await mkdir(workDir, { recursive: true });

      // Pre-place the release marker so the controllable workflow resolves
      // immediately after writing its probe marker.
      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'renderer', taskPrompt: 'paint the fence', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const info = await readRegistryMarker(workDir);

      // options.rendererRegistry is populated with a real RendererRegistry.
      expect(info.present).toBe(true);
      expect(info.ctor).toBe('RendererRegistry');
      // The full RendererRegistry surface is available.
      expect(info.hasRegister).toBe(true);
      expect(info.hasGet).toBe(true);
      expect(info.hasRender).toBe(true);
    });

    it('invokes workflow.registerRenderers with the registry before run() executes', async () => {
      const manager = createManager();
      const workDir = makeWorkDir('rr-hook');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'renderer', taskPrompt: 'hook test', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const info = await readRegistryMarker(workDir);

      // The registerRenderers hook was actually invoked.
      expect(info.hookCalled).toBe(true);
    });

    it('makes renderers registered via the hook usable inside run()', async () => {
      const manager = createManager();
      const workDir = makeWorkDir('rr-render');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'renderer', taskPrompt: 'garden path', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const info = await readRegistryMarker(workDir);

      // The 'developer' renderer registered in registerRenderers was already
      // installed by the time run() called render(), and produced the exact
      // formatted output. This also proves the hook ran BEFORE run().
      const expected = 'RENDERED:' + JSON.stringify({ msg: 'garden path' });
      expect(info.rendered).toBe(expected);
    });

    it('passes the same registry instance to registerRenderers and options.rendererRegistry', async () => {
      const manager = createManager();
      const workDir = makeWorkDir('rr-sameref');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'renderer', taskPrompt: 'identity check', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const info = await readRegistryMarker(workDir);

      // The registry reference captured in registerRenderers is the very same
      // object handed to run() via options.rendererRegistry.
      expect(info.sameRef).toBe(true);
    });

    it('returns undefined when rendering a profile that was never registered', async () => {
      const manager = createManager();
      const workDir = makeWorkDir('rr-missing');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'renderer', taskPrompt: 'absent profile', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const info = await readRegistryMarker(workDir);

      // An unregistered profile yields undefined (the default behaviour).
      expect(info.missingIsUndefined).toBe(true);
    });
  });

  // ─── when the workflow does NOT export registerRenderers ──────────────────

  describe('when the workflow does not export registerRenderers', () => {
    it('still passes a RendererRegistry instance as options.rendererRegistry', async () => {
      const manager = createManager();
      const workDir = makeWorkDir('rr-plain');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'plain', taskPrompt: 'no hook', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const info = await readRegistryMarker(workDir);

      // Even without a registerRenderers hook, an empty registry is handed over.
      expect(info.present).toBe(true);
      expect(info.ctor).toBe('RendererRegistry');
      expect(info.hasRegister).toBe(true);
      expect(info.hasGet).toBe(true);
      expect(info.hasRender).toBe(true);
    });

    it('the empty registry returns undefined for any profile render()', async () => {
      const manager = createManager();
      const workDir = makeWorkDir('rr-empty');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      await manager.startRun({ workflowName: 'plain', taskPrompt: 'empty registry', cwd, workDir } as any);
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');

      const info = await readRegistryMarker(workDir);

      // Nothing was registered, so render() returns undefined.
      expect(info.missingIsUndefined).toBe(true);
    });

    it('does not throw and completes the run normally', async () => {
      const manager = createManager();
      const workDir = makeWorkDir('rr-nohook-ok');
      await mkdir(workDir, { recursive: true });

      await writeFile(join(workDir, 'release.marker'), '1');
      const result = await manager.startRun({ workflowName: 'plain', taskPrompt: 'smooth', cwd, workDir } as any);

      // The run reaches 'complete' without the engine choking on the missing hook.
      await waitFor(() => manager.getRun(result.runId)?.status === 'complete');
      expect(manager.getRun(result.runId)?.status).toBe('complete');
    });
  });

  // ─── the probe marker is written before the workflow blocks ───────────────

  describe('probe timing', () => {
    it('writes the registry probe while the run is still running (before completion)', async () => {
      const manager = createManager();
      const workDir = makeWorkDir('rr-timing');
      await mkdir(workDir, { recursive: true });

      // Do NOT pre-place the release marker: the workflow writes its probe
      // marker then blocks, so the probe must be observable while 'running'.
      await manager.startRun({ workflowName: 'renderer', taskPrompt: 'timing', cwd, workDir } as any);
      await waitFor(() => existsSync(join(workDir, 'registry.marker')));
      expect(manager.listRuns()[0]?.status).toBe('running');

      const info = await readRegistryMarker(workDir);
      expect(info.present).toBe(true);
      expect(info.ctor).toBe('RendererRegistry');

      // Release + await completion (cleanup).
      await writeFile(join(workDir, 'release.marker'), '1');
      await waitFor(() => manager.listRuns()[0]?.status === 'complete');
    });
  });
});
