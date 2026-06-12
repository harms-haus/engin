import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWebServer } from '../../src/web/server.ts';
import type { WebServerDependencies, WebServerOptions } from '../../src/web/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildDeps(): WebServerDependencies {
  return {
    loadWorkflow: mock<WebServerDependencies['loadWorkflow']>().mockImplementation(async () => ({
      run: mock<(taskPrompt: string, opts: Record<string, unknown>) => Promise<void>>().mockImplementation(
        async () => {},
      ),
    })),
    getDefaultWorkDir: mock<WebServerDependencies['getDefaultWorkDir']>().mockImplementation(
      (cwd: string) => `${cwd}/.engin/work/test-workflow`,
    ),
    scanPastRuns: mock<WebServerDependencies['scanPastRuns']>().mockResolvedValue([]),
    listWorkflows: mock<WebServerDependencies['listWorkflows']>().mockResolvedValue([]),
  };
}

const TEST_OPTIONS: WebServerOptions = {
  host: '127.0.0.1',
  port: 0,
  cwd: '/tmp/test-cwd',
};

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('server error handling (silent catch fixes)', () => {
  let activeServer: Bun.Server | undefined;

  afterEach(() => {
    activeServer?.stop(true);
    activeServer = undefined;
  });

  async function startServer(deps?: WebServerDependencies): Promise<string> {
    const srv = await startWebServer(TEST_OPTIONS, deps ?? buildDeps());
    activeServer = srv;
    return `http://${srv.hostname}:${srv.port}`;
  }

  async function connectWs(): Promise<{ ws: WebSocket; initMsg: any }> {
    const ws = new WebSocket(`ws://${activeServer!.hostname}:${activeServer!.port}/ws`);
    const initMsg = await new Promise<any>((resolve, reject) => {
      ws.addEventListener('message', (event) => {
        try {
          resolve(JSON.parse(event.data as string));
        } catch (e) {
          reject(e);
        }
      });
      setTimeout(() => reject(new Error('Timeout waiting for init')), 2000);
    });
    return { ws, initMsg };
  }

  // ─── Fix #1: loadSessionLogs outer catch ───────────────────────────

  describe('loadSessionLogs outer catch – non-ENOENT errors propagate', () => {
    it('re-throws ENOTDIR from sessions readdir instead of silently swallowing', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'engin-test-'));
      try {
        // Valid state file with agent having a taskId
        writeFileSync(
          join(tmpDir, '.engin-state.json'),
          JSON.stringify({
            currentPhase: 'done',
            completedPhases: ['scouting'],
            spawnedAgents: [{ agentId: 'a-1', profile: 'coder', phase: 'scouting', taskId: 'task-1' }],
          }),
        );

        // Create sessions directory, but put a FILE where the taskId subdirectory
        // should be — this causes readdir to throw ENOTDIR (not ENOENT).
        mkdirSync(join(tmpDir, 'sessions'));
        writeFileSync(join(tmpDir, 'sessions', 'task-1'), 'not a directory');

        const deps = buildDeps();
        deps.scanPastRuns = mock<WebServerDependencies['scanPastRuns']>().mockResolvedValue([
          {
            dirName: 'enotdir-run',
            fullPath: tmpDir,
            workflowName: 'test-wf',
            timestamp: 1000,
            hasStateFile: true,
          },
        ]);

        await startServer(deps);
        const { ws } = await connectWs();

        ws.send(JSON.stringify({ type: 'select_workflow', workflowId: 'enotdir-run' }));

        // Listen for any load_past_run messages
        let receivedLoadPastRun = false;
        const handler = (event: MessageEvent) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'load_past_run') receivedLoadPastRun = true;
          } catch {
            // ignore
          }
        };
        ws.addEventListener('message', handler);

        await tick();
        await tick();
        await tick();

        // After fix #1: ENOTDIR is not ENOENT, so loadSessionLogs re-throws.
        // The select_workflow catch (fix #4) logs a warning, and no
        // load_past_run message is sent because the error propagated out
        // of the state-loading try block.
        expect(receivedLoadPastRun).toBe(false);

        ws.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('still returns empty logs for ENOENT (sessions directory does not exist)', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'engin-test-'));
      try {
        writeFileSync(
          join(tmpDir, '.engin-state.json'),
          JSON.stringify({
            currentPhase: 'done',
            completedPhases: [],
            spawnedAgents: [{ agentId: 'a-1', profile: 'coder', phase: 'scouting', taskId: 'nonexistent-task' }],
          }),
        );
        // Intentionally do NOT create sessions directory → ENOENT

        const deps = buildDeps();
        deps.scanPastRuns = mock<WebServerDependencies['scanPastRuns']>().mockResolvedValue([
          {
            dirName: 'enoent-run',
            fullPath: tmpDir,
            workflowName: 'test-wf',
            timestamp: 2000,
            hasStateFile: true,
          },
        ]);

        await startServer(deps);
        const { ws } = await connectWs();

        ws.send(JSON.stringify({ type: 'select_workflow', workflowId: 'enoent-run' }));

        const loadMsg = await new Promise<any>((resolve, reject) => {
          ws.addEventListener('message', (event) => {
            try {
              const msg = JSON.parse(event.data as string);
              if (msg.type === 'load_past_run') resolve(msg);
            } catch (e) {
              reject(e);
            }
          });
          setTimeout(() => reject(new Error('Timeout waiting for load_past_run')), 2000);
        });

        // ENOENT is handled gracefully — load_past_run is sent with empty logs
        expect(loadMsg.type).toBe('load_past_run');
        expect(loadMsg.agents).toHaveLength(1);
        expect(loadMsg.agents[0].log).toEqual([]);

        ws.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ─── Fix #4: select_workflow catch logging ─────────────────────────

  describe('select_workflow catch logging', () => {
    it('logs warning via console.warn when state file is missing', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'engin-test-'));
      try {
        // No .engin-state.json file — readFile will throw ENOENT
        const deps = buildDeps();
        deps.scanPastRuns = mock<WebServerDependencies['scanPastRuns']>().mockResolvedValue([
          {
            dirName: 'missing-state',
            fullPath: tmpDir,
            workflowName: 'test-wf',
            timestamp: 3000,
            hasStateFile: false,
          },
        ]);

        await startServer(deps);

        const originalWarn = console.warn;
        const warnCalls: unknown[][] = [];
        console.warn = (...args: unknown[]) => {
          warnCalls.push(args);
        };

        const { ws } = await connectWs();
        ws.send(JSON.stringify({ type: 'select_workflow', workflowId: 'missing-state' }));

        await tick();
        await tick();
        await tick();

        console.warn = originalWarn;

        // After fix #4: console.warn should be called with the workflowId
        expect(warnCalls.length).toBeGreaterThanOrEqual(1);
        const lastCall = warnCalls[warnCalls.length - 1];
        expect(lastCall[0]).toBe('Failed to load past run state for workflow');
        expect(lastCall[1]).toBe('missing-state');

        ws.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('logs warning via console.warn when state file contains invalid JSON', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'engin-test-'));
      try {
        writeFileSync(join(tmpDir, '.engin-state.json'), 'not valid json {');

        const deps = buildDeps();
        deps.scanPastRuns = mock<WebServerDependencies['scanPastRuns']>().mockResolvedValue([
          {
            dirName: 'corrupt-state',
            fullPath: tmpDir,
            workflowName: 'test-wf',
            timestamp: 4000,
            hasStateFile: true,
          },
        ]);

        await startServer(deps);

        const originalWarn = console.warn;
        const warnCalls: unknown[][] = [];
        console.warn = (...args: unknown[]) => {
          warnCalls.push(args);
        };

        const { ws } = await connectWs();
        ws.send(JSON.stringify({ type: 'select_workflow', workflowId: 'corrupt-state' }));

        await tick();
        await tick();
        await tick();

        console.warn = originalWarn;

        expect(warnCalls.length).toBeGreaterThanOrEqual(1);
        const lastCall = warnCalls[warnCalls.length - 1];
        expect(lastCall[0]).toBe('Failed to load past run state for workflow');
        expect(lastCall[1]).toBe('corrupt-state');

        ws.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ─── Fix #6: GET /api/workflows catch logging ─────────────────────

  describe('GET /api/workflows error logging', () => {
    it('logs error to console.error before returning 500 response', async () => {
      const fsError = new Error('Permission denied');
      const deps = buildDeps();
      deps.listWorkflows = mock<WebServerDependencies['listWorkflows']>().mockRejectedValue(fsError);

      const baseUrl = await startServer(deps);

      const originalError = console.error;
      const errorCalls: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        errorCalls.push(args);
      };

      const res = await fetch(`${baseUrl}/api/workflows`);

      console.error = originalError;

      // Response should still be 500 with the expected body
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('Failed to list workflows');

      // After fix #6: console.error should be called with the error object
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);
      const lastCall = errorCalls[errorCalls.length - 1];
      expect(lastCall[0]).toBe('Failed to list workflows:');
      expect(lastCall[1]).toBe(fsError);
    });
  });

  // ─── Worktree field passthrough ────────────────────────────────────

  describe('POST /api/runs worktree field passthrough', () => {
    it('accepts worktree: true without error and returns runId', async () => {
      const baseUrl = await startServer();

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowName: 'test-workflow',
          taskPrompt: 'Do something',
          worktree: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string };
      expect(body.runId).toBeDefined();
      expect(typeof body.runId).toBe('string');
      expect(body.runId.length).toBeGreaterThan(0);
    });

    it('logs warning via console.warn when worktree is true', async () => {
      const baseUrl = await startServer();

      const originalWarn = console.warn;
      const warnCalls: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnCalls.push(args);
      };

      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowName: 'test-workflow',
          taskPrompt: 'Do something',
          worktree: true,
        }),
      });

      console.warn = originalWarn;

      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      const worktreeWarning = warnCalls.find((call) => typeof call[0] === 'string' && call[0].includes('worktree'));
      expect(worktreeWarning).toBeDefined();
      expect(worktreeWarning![0]).toBe('Warning: --worktree is not supported via the web API. Ignoring.');
    });

    it('does not log worktree warning when worktree is false', async () => {
      const baseUrl = await startServer();

      const originalWarn = console.warn;
      const warnCalls: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnCalls.push(args);
      };

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowName: 'test-workflow',
          taskPrompt: 'Do something',
          worktree: false,
        }),
      });

      console.warn = originalWarn;

      // Should succeed without worktree warning
      expect(res.status).toBe(200);
      const worktreeWarning = warnCalls.find((call) => typeof call[0] === 'string' && call[0].includes('worktree'));
      expect(worktreeWarning).toBeUndefined();
    });

    it('does not log worktree warning when worktree is absent', async () => {
      const baseUrl = await startServer();

      const originalWarn = console.warn;
      const warnCalls: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnCalls.push(args);
      };

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowName: 'test-workflow',
          taskPrompt: 'Do something',
        }),
      });

      console.warn = originalWarn;

      // Should succeed without worktree warning
      expect(res.status).toBe(200);
      const worktreeWarning = warnCalls.find((call) => typeof call[0] === 'string' && call[0].includes('worktree'));
      expect(worktreeWarning).toBeUndefined();
    });

    it('accepts worktree with other optional fields (maxConcurrent) and returns runId', async () => {
      const baseUrl = await startServer();

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowName: 'test-workflow',
          taskPrompt: 'Do something',
          maxConcurrent: 5,
          worktree: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string };
      expect(body.runId).toBeDefined();
    });

    it('still returns 400 when worktree is provided but required fields are missing', async () => {
      const baseUrl = await startServer();

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          worktree: true,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('workflowName');
    });

    it('warning is logged before the response when worktree is true', async () => {
      const baseUrl = await startServer();

      const originalWarn = console.warn;
      const warnCalls: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnCalls.push(args);
      };

      // Make the request and await the response
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowName: 'test-workflow',
          taskPrompt: 'Test ordering',
          worktree: true,
        }),
      });

      // The response should already be successful
      expect(res.status).toBe(200);

      // And the warning should already have been logged (synchronously before the response)
      console.warn = originalWarn;

      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      const worktreeWarning = warnCalls.find((call) => typeof call[0] === 'string' && call[0].includes('worktree'));
      expect(worktreeWarning).toBeDefined();
    });
  });
});
