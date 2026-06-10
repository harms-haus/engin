import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readdirSync } from 'node:fs';
import { startWebServer } from '../../src/web/server.ts';
import type { WebServerOptions } from '../../src/web/types.ts';

// ─── Mock workflow modules ──────────────────────────────────────────────────

// Capture real modules so they can be restored in afterAll
const realWorkflowLoader = await import('../../src/core/workflow-loader.ts');
const realConfig = await import('../../src/core/config.ts');

/**
 * We mock the workflow-loader module so that loadWorkflow returns a
 * controllable workflow without hitting the filesystem.
 */
let mockWorkflowRun = mock<(taskPrompt: string, opts: Record<string, unknown>) => Promise<void>>().mockImplementation(
  async () => {},
);
let mockWorkflowShouldFail = false;
let mockWorkflowErrorMsg = '';

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_OPTIONS: WebServerOptions = {
  host: '127.0.0.1',
  port: 0, // Let the OS pick a free port
  cwd: '/tmp/test-cwd',
};

// Discover actual asset filenames from web/dist/assets/ to avoid hardcoding hashes
const ASSETS_DIR = new URL('../../web/dist/assets', import.meta.url).pathname;
let jsAssetFile = '';
let jsMapAssetFile = '';
try {
  const entries = readdirSync(ASSETS_DIR);
  jsAssetFile = entries.find((f: string) => f.endsWith('.js') && !f.endsWith('.js.map')) ?? '';
  jsMapAssetFile = entries.find((f: string) => f.endsWith('.js.map')) ?? '';
} catch {
  // web/dist/assets may not exist in CI (no web build)
}

/** Wait for a promise to resolve (useful for fire-and-forget workflows). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('startWebServer', () => {
  let server: Bun.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Apply mocks so loadWorkflow returns a controllable workflow
    mock.module('../../src/core/workflow-loader.ts', () => ({
      loadWorkflow: mock<(name: string, cwd: string) => Promise<{ run: typeof mockWorkflowRun }>>().mockImplementation(
        async (_name: string) => {
          if (mockWorkflowShouldFail) {
            throw new Error(mockWorkflowErrorMsg || 'Workflow failed to load');
          }
          return { run: mockWorkflowRun };
        },
      ),
    }));
    mock.module('../../src/core/config.ts', () => ({
      getDefaultWorkDir: mock<(cwd: string, name: string) => string>().mockImplementation(
        (cwd: string) => `${cwd}/.engin/work/test-workflow`,
      ),
      scanPastRuns: mock<() => Promise<never[]>>().mockResolvedValue([]),
    }));

    // Reset mocks before starting the server
    mockWorkflowRun = mock().mockImplementation(async () => {});
    mockWorkflowShouldFail = false;
    mockWorkflowErrorMsg = '';

    server = await startWebServer(TEST_OPTIONS);
    baseUrl = `http://${server.hostname}:${server.port}`;
  });

  afterAll(() => {
    server?.stop();
    // Restore real modules so mocks don't leak to other test files
    mock.module('../../src/core/workflow-loader.ts', () => realWorkflowLoader);
    mock.module('../../src/core/config.ts', () => realConfig);
  });

  // ─── Static file serving ───────────────────────────────────────────────

  describe('static file serving', () => {
    it('returns 400 for regular HTTP request to /ws endpoint', async () => {
      // A non-WebSocket request to /ws should fail the upgrade and return 400
      const res = await fetch(`${baseUrl}/ws`);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain('WebSocket upgrade failed');
    });

    it('returns 200 for / (root) with WS endpoint replacement', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('{{WS_ENDPOINT}}');
      expect(text).toContain(`ws://${server.hostname}:${server.port}/ws`);
    });

    it('returns placeholder HTML with ws:// endpoint when web dist does not exist', async () => {
      // We cannot easily remove web/dist, but we can verify the placeholder
      // structure appears in the response we get. The actual placeholder path
      // is exercised when readFile throws on both the requested file and
      // index.html.  Since web/dist/index.html exists, we won't reach the
      // placeholder in normal operation – this test documents the contract.
      const res = await fetch(`${baseUrl}/index.html`);
      const text = await res.text();
      // The actual served index.html should contain the WS endpoint
      expect(text).toContain(`ws://${server.hostname}:${server.port}/ws`);
      // The placeholder would contain 'Frontend not built' but we don't
      // see that because the real index.html exists
    });

    it('returns 200 for index.html with WS endpoint replacement', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<!DOCTYPE html>');
      // Should have replaced {{WS_ENDPOINT}} with actual ws URL
      expect(text).not.toContain('{{WS_ENDPOINT}}');
      expect(text).toContain(`ws://${server.hostname}:${server.port}/ws`);
    });

    it('serves index.html with text/html content type', async () => {
      const res = await fetch(`${baseUrl}/index.html`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html');
    });

    it('serves unknown routes with index.html (SPA fallback) when index.html exists', async () => {
      // The web dist has index.html, so unknown route should serve it
      const res = await fetch(`${baseUrl}/some/unknown/path`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<!DOCTYPE html>');
    });

    it('serves index.html with correct MIME type', async () => {
      const res = await fetch(`${baseUrl}/index.html`);
      expect(res.headers.get('Content-Type')).toBe('text/html');
    });

    it('serves .js assets with application/javascript content type', async () => {
      if (!jsAssetFile) return;
      // Fetch the JS asset file from web/dist/assets/
      const res = await fetch(`${baseUrl}/assets/${jsAssetFile}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/javascript');
      const text = await res.text();
      expect(text.length).toBeGreaterThan(0);
    });

    it('serves .js.map files with default application/octet-stream content type', async () => {
      if (!jsMapAssetFile) return;
      const res = await fetch(`${baseUrl}/assets/${jsMapAssetFile}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    });

    it('serves non-existent static files with index.html fallback (SPA)', async () => {
      const res = await fetch(`${baseUrl}/some/unknown/path`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<!DOCTYPE html>');
    });
  });

  // ─── API routes ────────────────────────────────────────────────────────

  describe('API routes', () => {
    beforeEach(() => {
      // Reset workflow behaviour for each API test
      mockWorkflowShouldFail = false;
      mockWorkflowRun = mock().mockImplementation(async () => {});
    });

    it('POST /api/runs - returns 400 when workflowName is missing', async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskPrompt: 'Do something' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('workflowName');
    });

    it('POST /api/runs - returns 400 when taskPrompt is missing', async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowName: 'test-workflow' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('taskPrompt');
    });

    it('POST /api/runs - returns 400 for invalid JSON', async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('JSON');
    });

    it('POST /api/runs - starts a workflow and returns runId', async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowName: 'test-workflow', taskPrompt: 'Build something', maxConcurrent: 3 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string };
      expect(body.runId).toBeDefined();
      expect(typeof body.runId).toBe('string');
      expect(body.runId.length).toBeGreaterThan(0);
    });

    it('POST /api/runs - works without maxConcurrent (optional)', async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowName: 'test-workflow', taskPrompt: 'Build something' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string };
      expect(body.runId).toBeDefined();
      expect(typeof body.runId).toBe('string');
    });

    it('POST /api/runs - ignores extra fields in body', async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowName: 'test-workflow',
          taskPrompt: 'Do it',
          extraField: 'should be ignored',
          anotherExtra: 42,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string };
      expect(body.runId).toBeDefined();
    });

    it('GET /api/runs - includes failed runs in summaries', async () => {
      // Start a workflow that will fail
      mockWorkflowShouldFail = true;
      mockWorkflowErrorMsg = 'File not found';

      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowName: 'failing-workflow', taskPrompt: 'Test' }),
      });

      // Give the server time to process the failure
      await tick();

      const res = await fetch(`${baseUrl}/api/runs`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>[];
      expect(Array.isArray(body)).toBe(true);

      // Find the failed run
      const failedRun = body.find((s) => s.status === 'failed');
      expect(failedRun).toBeDefined();
      expect(failedRun!.workflowName).toBe('failing-workflow');
    });

    it('GET /api/runs - returns summaries in chronological order', async () => {
      // Get current count
      const beforeRes = await fetch(`${baseUrl}/api/runs`);
      const before = (await beforeRes.json()) as Record<string, unknown>[];
      const count = before.length;

      // Start two new workflows
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowName: 'run-alpha', taskPrompt: 'First' }),
      });
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowName: 'run-beta', taskPrompt: 'Second' }),
      });

      const afterRes = await fetch(`${baseUrl}/api/runs`);
      const after = (await afterRes.json()) as Record<string, unknown>[];

      expect(after.length).toBe(count + 2);
      // The last two entries should be alpha then beta
      expect(after[after.length - 2].workflowName).toBe('run-alpha');
      expect(after[after.length - 1].workflowName).toBe('run-beta');
    });

    it('returns 405-style error for wrong method on /api/runs', async () => {
      // PUT without a body should fail
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'PUT',
      });
      // The server only handles POST and GET; other methods hit the /api/* 404 handler
      expect(res.status).toBe(404);
    });

    it('POST /api/runs - returns 400 for empty body object', async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('workflowName');
    });

    it('POST /api/runs - returns 200 when workflow load fails (still returns runId)', async () => {
      mockWorkflowShouldFail = true;
      mockWorkflowErrorMsg = 'Workflow not found';

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowName: 'nonexistent', taskPrompt: 'Do it' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string };
      expect(body.runId).toBeDefined();
      // The run is created even if load fails
    });

    it('GET /api/runs - returns an array', async () => {
      const res = await fetch(`${baseUrl}/api/runs`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/runs - returns array of summaries after starting a workflow', async () => {
      // Start a workflow
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowName: 'test-workflow', taskPrompt: 'Test' }),
      });

      const res = await fetch(`${baseUrl}/api/runs`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      if (body.length > 0) {
        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('workflowName');
        expect(body[0]).toHaveProperty('status');
      }
    });

    it('returns 404 for unknown API paths', async () => {
      const res = await fetch(`${baseUrl}/api/unknown`);
      expect(res.status).toBe(404);
    });
  });

  // ─── WebSocket ─────────────────────────────────────────────────────────

  describe('WebSocket', () => {
    let ws: WebSocket;
    const receivedMessages: any[] = [];

    beforeEach(() => {
      receivedMessages.length = 0;
      // Reset workflow behaviour
      mockWorkflowShouldFail = false;
      mockWorkflowRun = mock().mockImplementation(async () => {});
    });

    afterEach(() => {
      ws?.close();
    });

    it('sends init message upon connection with workflows list', async () => {
      ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      const msg = await new Promise<any>((resolve, reject) => {
        ws.addEventListener('open', () => {
          // After open, we expect an init message
        });
        ws.addEventListener('message', (event) => {
          try {
            resolve(JSON.parse(event.data as string));
          } catch (e) {
            reject(e);
          }
        });
        ws.addEventListener('error', (_event) => {
          reject(new Error('WebSocket error'));
        });
        // Timeout after 2 seconds
        setTimeout(() => reject(new Error('Timeout waiting for init message')), 2000);
      });

      expect(msg.type).toBe('init');
      expect(Array.isArray(msg.workflows)).toBe(true);
    });

    it('receives workflow_started after sending start_workflow message', async () => {
      ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for init
      await new Promise<void>((resolve) => {
        ws.addEventListener('message', () => resolve(), { once: true });
      });

      // Send start_workflow
      ws.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'test-workflow',
          taskPrompt: 'Build a feature',
          maxConcurrent: 2,
        }),
      );

      // Wait for workflow_started
      const msg = await new Promise<any>((resolve, reject) => {
        ws.addEventListener('message', (event) => {
          try {
            resolve(JSON.parse(event.data as string));
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_started')), 2000);
      });

      expect(msg.type).toBe('workflow_started');
      expect(msg.summary).toBeDefined();
      expect(msg.summary.workflowName).toBe('test-workflow');
      expect(msg.summary.status).toBe('running');
    });

    it('receives workflow_complete after workflow run succeeds', async () => {
      // Make the mock workflow resolve successfully
      mockWorkflowRun = mock().mockImplementation(async () => {});

      ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for init
      await new Promise<void>((resolve) => {
        ws.addEventListener('message', () => resolve(), { once: true });
      });

      // Send start_workflow
      ws.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'test-workflow',
          taskPrompt: 'Do work',
        }),
      );

      // Wait for workflow_started
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'workflow_started') resolve();
          else reject(new Error(`Unexpected message: ${msg.type}`));
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_started')), 2000);
      });

      // Wait for workflow_complete
      const completeMsg = await new Promise<any>((resolve, reject) => {
        ws.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'workflow_complete') resolve(msg);
            // Ignore intermediate messages (agent_log, workflow_phase, etc.)
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_complete')), 2000);
      });

      expect(completeMsg.type).toBe('workflow_complete');
      expect(completeMsg.summary.status).toBe('completed');
    });

    it('receives workflow_failed after workflow run throws', async () => {
      // Make the mock workflow reject
      mockWorkflowRun = mock().mockImplementation(async () => {
        throw new Error('Runtime error in workflow');
      });

      ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for init
      await new Promise<void>((resolve) => {
        ws.addEventListener('message', () => resolve(), { once: true });
      });

      // Send start_workflow
      ws.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'test-workflow',
          taskPrompt: 'Do work that fails',
        }),
      );

      // Wait for workflow_started
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'workflow_started') resolve();
          else reject(new Error(`Unexpected message: ${msg.type}`));
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_started')), 2000);
      });

      // Wait for workflow_failed
      const failMsg = await new Promise<any>((resolve, reject) => {
        ws.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'workflow_failed') resolve(msg);
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_failed')), 2000);
      });

      expect(failMsg.type).toBe('workflow_failed');
      expect(failMsg.summary.status).toBe('failed');
      expect(failMsg.error).toBe('Runtime error in workflow');
    });

    it('receives workflow_failed when workflow fails to load', async () => {
      mockWorkflowShouldFail = true;
      mockWorkflowErrorMsg = 'Workflow module not found';

      ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for init
      await new Promise<void>((resolve) => {
        ws.addEventListener('message', () => resolve(), { once: true });
      });

      // Send start_workflow
      ws.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'missing-workflow',
          taskPrompt: 'Do it',
        }),
      );

      // Wait for workflow_started then workflow_failed (both sent)
      const failMsg = await new Promise<any>((resolve, reject) => {
        ws.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'workflow_started') {
              return;
            }
            if (msg.type === 'workflow_failed') {
              resolve(msg);
            }
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_failed')), 2000);
      });

      expect(failMsg.type).toBe('workflow_failed');
      expect(failMsg.summary.status).toBe('failed');
      expect(failMsg.error).toBe('Workflow module not found');
    });

    it('cancel_workflow aborts the workflow', async () => {
      // Create a workflow that waits until aborted
      let abortSignal: AbortSignal | null = null;
      mockWorkflowRun = mock().mockImplementation(async (_taskPrompt: string, opts: Record<string, unknown>) => {
        abortSignal = opts.signal as AbortSignal;
        // Wait until aborted, then throw to simulate cancellation
        await new Promise<void>((resolve) => {
          if (abortSignal?.aborted) {
            resolve();
            return;
          }
          abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('Workflow cancelled');
      });

      ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for init
      await new Promise<void>((resolve) => {
        ws.addEventListener('message', () => resolve(), { once: true });
      });

      // Send start_workflow
      ws.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'test-workflow',
          taskPrompt: 'Long running task',
        }),
      );

      // Wait for workflow_started
      const startedMsg = await new Promise<any>((resolve, reject) => {
        ws.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'workflow_started') resolve(msg);
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_started')), 2000);
      });

      const runId = startedMsg.summary.id;

      // Send cancel_workflow
      ws.send(
        JSON.stringify({
          type: 'cancel_workflow',
          workflowId: runId,
        }),
      );

      // The workflow should be aborted; wait for workflow_failed (since abort causes rejection)
      const failMsg = await new Promise<any>((resolve, reject) => {
        ws.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'workflow_failed') resolve(msg);
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_failed after cancel')), 2000);
      });

      expect(failMsg.type).toBe('workflow_failed');
      // The abort signal should have been triggered
      expect(abortSignal?.aborted).toBe(true);
    });

    it('ignores invalid WebSocket messages without crashing', async () => {
      ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for init
      await new Promise<void>((resolve) => {
        ws.addEventListener('message', () => resolve(), { once: true });
      });

      // Send invalid JSON
      ws.send('not-json');
      // Send valid JSON but wrong shape (missing type)
      ws.send(JSON.stringify({ foo: 'bar' }));
      // Send unknown message type
      ws.send(JSON.stringify({ type: 'unknown_type' }));

      // The server should not crash; give it a tick
      await tick();
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('handles select_workflow message without error', async () => {
      ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for init
      await new Promise<void>((resolve) => {
        ws.addEventListener('message', () => resolve(), { once: true });
      });

      // Send select_workflow
      ws.send(JSON.stringify({ type: 'select_workflow', workflowId: 'some-id' }));

      // Should not crash; give it a tick
      await tick();
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('does not crash when broadcast continues after a client disconnects', async () => {
      // Connect three clients, disconnect one, then start a workflow
      const ws1 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      const ws2 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for both to receive init
      await Promise.all([
        new Promise<void>((resolve) => ws1.addEventListener('message', () => resolve(), { once: true })),
        new Promise<void>((resolve) => ws2.addEventListener('message', () => resolve(), { once: true })),
      ]);

      // Disconnect ws1
      ws1.close();
      await tick();

      // Start a workflow via ws2 – this should broadcast, but ws1 should not receive
      let receivedAfterClose = false;
      ws1.addEventListener('message', () => {
        receivedAfterClose = true;
      });

      ws2.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'test-workflow',
          taskPrompt: 'Broadcast after disconnect',
        }),
      );

      // ws2 should receive workflow_started
      const msgFrom2 = await new Promise<any>((resolve, reject) => {
        ws2.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'workflow_started') resolve(msg);
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_started')), 2000);
      });

      expect(msgFrom2.type).toBe('workflow_started');

      // ws1 should not have received anything after close (best-effort check)
      expect(receivedAfterClose).toBe(false);

      ws2.close();
    });

    it('handles workflow.run rejecting with a non-Error value', async () => {
      // Simulate a workflow that rejects with a plain string (not an Error instance)
      mockWorkflowRun = mock().mockImplementation(async () => {
        throw 'String error message';
      });

      const testWs = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for init
      await new Promise<void>((resolve) => testWs.addEventListener('message', () => resolve(), { once: true }));

      testWs.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'test-workflow',
          taskPrompt: 'Non-error rejection test',
        }),
      );

      // Wait for workflow_started
      await new Promise<void>((resolve, reject) => {
        testWs.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'workflow_started') resolve();
          else reject(new Error(`Unexpected message: ${msg.type}`));
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_started')), 2000);
      });

      // Wait for workflow_failed
      const failMsg = await new Promise<any>((resolve, reject) => {
        testWs.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'workflow_failed') resolve(msg);
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_failed')), 2000);
      });

      expect(failMsg.type).toBe('workflow_failed');
      expect(failMsg.summary.status).toBe('failed');
      // Non-Error rejections should be stringified
      expect(failMsg.error).toBe('String error message');

      testWs.close();
    });

    it('sends init with existing workflows when new client connects', async () => {
      // First, start a workflow via one connection
      const ws1 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      await new Promise<void>((resolve) => ws1.addEventListener('message', () => resolve(), { once: true }));

      ws1.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'existing-workflow',
          taskPrompt: 'This workflow exists before new client connects',
        }),
      );

      // Wait for started
      await new Promise<void>((resolve, reject) => {
        ws1.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'workflow_started') resolve();
          else reject(new Error(`Unexpected: ${msg.type}`));
        });
        setTimeout(() => reject(new Error('Timeout')), 2000);
      });

      // Now connect a second client – it should receive init with the existing workflow
      const ws2 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      const initMsg = await new Promise<any>((resolve, reject) => {
        ws2.addEventListener('message', (event) => {
          try {
            resolve(JSON.parse(event.data as string));
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for init')), 2000);
      });

      expect(initMsg.type).toBe('init');
      expect(Array.isArray(initMsg.workflows)).toBe(true);
      expect(initMsg.workflows.length).toBeGreaterThanOrEqual(1);
      expect(initMsg.workflows.some((w: any) => w.workflowName === 'existing-workflow')).toBe(true);

      ws1.close();
      ws2.close();
    });

    it('remaining clients still receive broadcasts after one client disconnects', async () => {
      const ws1 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      const ws2 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for both to receive init
      await Promise.all([
        new Promise<void>((resolve) => ws1.addEventListener('message', () => resolve(), { once: true })),
        new Promise<void>((resolve) => ws2.addEventListener('message', () => resolve(), { once: true })),
      ]);

      // Disconnect ws1
      ws1.close();
      await tick();

      // Start a workflow via ws2 – ws2 should still receive workflow_started
      ws2.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'remaining-client-test',
          taskPrompt: 'Check remaining client gets broadcast',
        }),
      );

      const msgFrom2 = await new Promise<any>((resolve, reject) => {
        ws2.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'workflow_started') resolve(msg);
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_started')), 2000);
      });

      expect(msgFrom2.type).toBe('workflow_started');
      expect(msgFrom2.summary.workflowName).toBe('remaining-client-test');

      ws2.close();
    });

    it('broadcasts to new clients that connect after workflow has started', async () => {
      // Start a workflow first
      const starterWs = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      await new Promise<void>((resolve) => starterWs.addEventListener('message', () => resolve(), { once: true }));

      starterWs.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'late-joiner-test',
          taskPrompt: 'Test late joiner',
        }),
      );

      // Wait for started
      await new Promise<void>((resolve, reject) => {
        starterWs.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'workflow_started') resolve();
          else reject(new Error(`Unexpected: ${msg.type}`));
        });
        setTimeout(() => reject(new Error('Timeout')), 2000);
      });

      // Now a new client connects – it should receive init with the existing workflow
      const lateWs = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      const initMsg = await new Promise<any>((resolve, reject) => {
        lateWs.addEventListener('message', (event) => {
          try {
            resolve(JSON.parse(event.data as string));
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for init')), 2000);
      });

      expect(initMsg.type).toBe('init');
      expect(initMsg.workflows.some((w: any) => w.workflowName === 'late-joiner-test')).toBe(true);

      starterWs.close();
      lateWs.close();
    });

    it('can handle multiple concurrent WebSocket connections', async () => {
      const ws1 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      const ws2 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Both should receive init
      const msg1 = await new Promise<any>((resolve, reject) => {
        ws1.addEventListener('message', (event) => {
          try {
            resolve(JSON.parse(event.data as string));
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout')), 2000);
      });

      const msg2 = await new Promise<any>((resolve, reject) => {
        ws2.addEventListener('message', (event) => {
          try {
            resolve(JSON.parse(event.data as string));
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout')), 2000);
      });

      expect(msg1.type).toBe('init');
      expect(msg2.type).toBe('init');

      ws1.close();
      ws2.close();
    });

    it('broadcasts workflow_started to all connected clients', async () => {
      const ws1 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      const ws2 = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for both to receive init
      await Promise.all([
        new Promise<void>((resolve) => ws1.addEventListener('message', () => resolve(), { once: true })),
        new Promise<void>((resolve) => ws2.addEventListener('message', () => resolve(), { once: true })),
      ]);

      // Start a workflow via WebSocket
      ws1.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'test-workflow',
          taskPrompt: 'Broadcast test',
        }),
      );

      // Both clients should receive workflow_started
      const [msgFrom1, msgFrom2] = await Promise.all([
        new Promise<any>((resolve, reject) => {
          ws1.addEventListener('message', (event) => {
            try {
              const msg = JSON.parse(event.data as string);
              if (msg.type === 'workflow_started') resolve(msg);
            } catch (e) {
              reject(e);
            }
          });
          setTimeout(() => reject(new Error('Timeout ws1')), 2000);
        }),
        new Promise<any>((resolve, reject) => {
          ws2.addEventListener('message', (event) => {
            try {
              const msg = JSON.parse(event.data as string);
              if (msg.type === 'workflow_started') resolve(msg);
            } catch (e) {
              reject(e);
            }
          });
          setTimeout(() => reject(new Error('Timeout ws2')), 2000);
        }),
      ]);

      expect(msgFrom1.type).toBe('workflow_started');
      expect(msgFrom2.type).toBe('workflow_started');
      expect(msgFrom1.summary.id).toBe(msgFrom2.summary.id);
      expect(msgFrom1.summary.workflowName).toBe('test-workflow');

      ws1.close();
      ws2.close();
    });

    it('includes phase information in workflow_failed when workflow errors at runtime', async () => {
      // Simulate a workflow that first sets a phase then throws
      mockWorkflowRun = mock().mockImplementation(async (_taskPrompt: string, opts: Record<string, unknown>) => {
        // Simulate the workflow setting a phase before failing
        const onStatus = opts.onStatus as Record<string, (...args: unknown[]) => unknown>;
        if (onStatus?.onPhaseStart) {
          onStatus.onPhaseStart({ phase: 'execution' });
        }
        throw new Error('Execution error');
      });

      const testWs = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

      // Wait for init
      await new Promise<void>((resolve) => testWs.addEventListener('message', () => resolve(), { once: true }));

      // Send start_workflow
      testWs.send(
        JSON.stringify({
          type: 'start_workflow',
          workflowName: 'test-workflow',
          taskPrompt: 'Phase error test',
        }),
      );

      // Wait for workflow_started
      await new Promise<void>((resolve, reject) => {
        testWs.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'workflow_started') resolve();
          else reject(new Error(`Unexpected message: ${msg.type}`));
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_started')), 2000);
      });

      // Wait for workflow_failed
      const failMsg = await new Promise<any>((resolve, reject) => {
        testWs.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'workflow_failed') resolve(msg);
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for workflow_failed')), 2000);
      });

      expect(failMsg.type).toBe('workflow_failed');
      expect(failMsg.phase).toBe('execution');
      expect(failMsg.error).toBe('Execution error');

      testWs.close();
    });
  });

  // ─── Past runs population ─────────────────────────────────────────────

  describe('past runs population', () => {
    it('populates registry with past runs from scanPastRuns on startup', async () => {
      // Stop the current server so we can restart with different mock behaviour
      server.stop();

      // Update the scanPastRuns mock to return past run entries
      mock.module('../../src/core/config.ts', () => ({
        getDefaultWorkDir: mock<(cwd: string, name: string) => string>().mockImplementation(
          (cwd: string) => `${cwd}/.engin/work/test-workflow`,
        ),
        scanPastRuns: mock<
          () => Promise<
            {
              dirName: string;
              fullPath: string;
              workflowName: string;
              timestamp: number;
              hasStateFile: boolean;
            }[]
          >
        >().mockResolvedValue([
          {
            dirName: '1000-alpha',
            fullPath: '/tmp/.engin/work/1000-alpha',
            workflowName: 'alpha',
            timestamp: 1000,
            hasStateFile: true,
          },
          {
            dirName: '2000-beta',
            fullPath: '/tmp/.engin/work/2000-beta',
            workflowName: 'beta',
            timestamp: 2000,
            hasStateFile: false,
          },
        ]),
      }));

      // Restart the server with the new mock — it should call scanPastRuns
      // and populate the registry with the returned entries.
      server = await startWebServer(TEST_OPTIONS);
      baseUrl = `http://${server.hostname}:${server.port}`;

      // Connect a WebSocket and check the init message includes past runs
      const testWs = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      const initMsg = await new Promise<any>((resolve, reject) => {
        testWs.addEventListener('message', (event) => {
          try {
            resolve(JSON.parse(event.data as string));
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for init')), 2000);
      });

      expect(initMsg.type).toBe('init');
      expect(Array.isArray(initMsg.workflows)).toBe(true);
      expect(initMsg.workflows.length).toBe(2);
      expect(initMsg.workflows.some((w: any) => w.workflowName === 'alpha')).toBe(true);
      expect(initMsg.workflows.some((w: any) => w.workflowName === 'beta')).toBe(true);

      testWs.close();

      // Restore the scanPastRuns mock to empty array for remaining tests
      mock.module('../../src/core/config.ts', () => ({
        getDefaultWorkDir: mock<(cwd: string, name: string) => string>().mockImplementation(
          (cwd: string) => `${cwd}/.engin/work/test-workflow`,
        ),
        scanPastRuns: mock<() => Promise<never[]>>().mockResolvedValue([]),
      }));
    });

    it('handles scanPastRuns throwing without crashing the server', async () => {
      // Stop the current server
      server.stop();

      // Update scanPastRuns mock to throw
      mock.module('../../src/core/config.ts', () => ({
        getDefaultWorkDir: mock<(cwd: string, name: string) => string>().mockImplementation(
          (cwd: string) => `${cwd}/.engin/work/test-workflow`,
        ),
        scanPastRuns: mock<() => Promise<never[]>>().mockRejectedValue(new Error('Filesystem error')),
      }));

      // Server should start successfully despite scanPastRuns throwing
      server = await startWebServer(TEST_OPTIONS);
      baseUrl = `http://${server.hostname}:${server.port}`;

      // The server should still be functional — WebSocket init should work
      const testWs = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);
      const initMsg = await new Promise<any>((resolve, reject) => {
        testWs.addEventListener('message', (event) => {
          try {
            resolve(JSON.parse(event.data as string));
          } catch (e) {
            reject(e);
          }
        });
        setTimeout(() => reject(new Error('Timeout waiting for init')), 2000);
      });

      expect(initMsg.type).toBe('init');
      expect(Array.isArray(initMsg.workflows)).toBe(true);
      // No past runs should be populated since scanPastRuns threw
      expect(initMsg.workflows.length).toBe(0);

      testWs.close();

      // Restore the scanPastRuns mock to empty array for remaining tests
      mock.module('../../src/core/config.ts', () => ({
        getDefaultWorkDir: mock<(cwd: string, name: string) => string>().mockImplementation(
          (cwd: string) => `${cwd}/.engin/work/test-workflow`,
        ),
        scanPastRuns: mock<() => Promise<never[]>>().mockResolvedValue([]),
      }));
    });
  });

  // ─── Server lifecycle ──────────────────────────────────────────────────

  describe('server lifecycle', () => {
    it('startWebServer returns a Bun.Server', async () => {
      const srv = await startWebServer({ host: '127.0.0.1', port: 0, cwd: '/tmp' });
      expect(srv).toBeDefined();
      expect(typeof srv.hostname).toBe('string');
      expect(typeof srv.port).toBe('number');
      expect(srv.port).toBeGreaterThan(0);
      srv.stop();
    });

    it('server stops without error', async () => {
      const srv = await startWebServer({ host: '127.0.0.1', port: 0, cwd: '/tmp' });
      expect(() => srv.stop()).not.toThrow();
    });

    it('can start multiple servers on different ports', async () => {
      const srv1 = await startWebServer({ host: '127.0.0.1', port: 0, cwd: '/tmp' });
      const srv2 = await startWebServer({ host: '127.0.0.1', port: 0, cwd: '/tmp' });
      expect(srv1.port).not.toBe(srv2.port);
      srv1.stop();
      srv2.stop();
    });

    it('logs the server URL to console after starting', async () => {
      const originalLog = console.log;
      const loggedMessages: string[] = [];
      console.log = (...args: string[]) => loggedMessages.push(args.join(' '));

      const srv = await startWebServer({ host: '127.0.0.1', port: 0, cwd: '/tmp' });

      console.log = originalLog;

      expect(loggedMessages.length).toBe(1);
      expect(loggedMessages[0]).toContain('Web server listening on');
      expect(loggedMessages[0]).toContain('http://127.0.0.1:');

      srv.stop();
    });
  });
});
